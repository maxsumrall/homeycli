/*
  pi-pr-review GitHub Action (local action)

  - Installs pi (npm global)
  - Runs pi against PR diff + repo (read-only tools)
  - Posts a comment-only PR review with inline comments (best-effort)

  Design goals:
  - No runtime deps (@actions/*). We use workflow commands for grouping/errors.
  - Keep secrets safe: sandbox extension blocks reads outside the PR worktree.
*/

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

function info(msg) {
  console.log(msg);
}

async function group(title, fn) {
  console.log(`::group::${title}`);
  try {
    return await fn();
  } finally {
    console.log("::endgroup::");
  }
}

function error(msg) {
  console.error(`::error::${msg}`);
}

function fail(msg) {
  error(msg);
  process.exit(1);
}

function getInput(name, def) {
  const key = `INPUT_${name.toUpperCase().replace(/-/g, "_")}`;
  const v = process.env[key];
  return v !== undefined && v !== "" ? v : def;
}

function mustEnv(name) {
  const v = process.env[name];
  if (!v) fail(`Missing required env var: ${name}`);
  return v;
}

function sh(cmd, args, opts = {}) {
  const res = spawnSync(cmd, args, {
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
    ...opts,
  });
  if (res.status !== 0) {
    const where = opts.cwd ? ` (cwd: ${opts.cwd})` : "";
    throw new Error(`Command failed${where}: ${cmd} ${args.join(" ")}\n${res.stderr || res.stdout}`);
  }
  return res.stdout;
}

function tryRmDir(dir) {
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    // ignore
  }
}

function safeJsonParse(text) {
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`Model did not return JSON. Output:\n${text}`);
  }
  return JSON.parse(text.slice(first, last + 1));
}

function positionForNewLine(patch, targetLine) {
  if (!patch) return null;

  const lines = patch.split("\n");
  let position = 0;
  let newLine = 0;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    position++;

    if (line.startsWith("@@")) {
      const m = /\+([0-9]+)(?:,([0-9]+))?/.exec(line);
      if (m) newLine = Number(m[1]) - 1;
      continue;
    }

    if (line.startsWith("+++ ") || line.startsWith("--- ")) continue;

    if (line.startsWith("+")) {
      newLine++;
      if (newLine === targetLine) return position;
      continue;
    }

    if (line.startsWith("-")) continue;

    if (line === "") continue;
    newLine++;
    if (newLine === targetLine) return position;
  }

  return null;
}

async function ghFetchJson(url, token) {
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
    },
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`GitHub API error ${res.status} for ${url}: ${text}`);
  }

  return res.json();
}

async function ghPostJson(url, token, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API POST error ${res.status} for ${url}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

async function listPullFiles(owner, repo, prNumber, token) {
  const out = [];
  let page = 1;

  for (;;) {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
    const batch = await ghFetchJson(url, token);
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }

  return out;
}

function readPromptFile(actionDir, maxComments) {
  const raw = fs.readFileSync(path.join(actionDir, "prompt.txt"), "utf-8");
  return raw.replaceAll("${PI_MAX_COMMENTS}", String(maxComments));
}

function appendStepSummary(markdown) {
  const p = process.env.GITHUB_STEP_SUMMARY;
  if (!p) return;
  fs.appendFileSync(p, `\n\n${markdown}\n`);
}

async function main() {
  const token = mustEnv("GITHUB_TOKEN");
  const actionDir = mustEnv("GITHUB_ACTION_PATH");

  // Inputs
  const piVersion = getInput("pi-version", "latest");
  const provider = getInput("provider", process.env.PI_PROVIDER || "openrouter");
  const model = getInput("model", process.env.PI_MODEL || "minimax/minimax-m2.1");
  const maxComments = Math.max(0, Number(getInput("max-comments", process.env.PI_MAX_COMMENTS || "20")) || 20);

  if (provider === "openrouter") {
    mustEnv("OPENROUTER_API_KEY");
  }

  // Ensure repo is checked out
  await group("Validate git checkout", async () => {
    sh("git", ["rev-parse", "--git-dir"]);
  });

  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf-8"));
  const pr = payload.pull_request;
  if (!pr) fail("This action must run on pull_request_target events (missing pull_request in event payload)");

  const prNumber = pr.number;
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;

  info(`ai-pr-review: PR #${prNumber} using ${provider}/${model} (pi ${piVersion})`);

  const repoFull = mustEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repoFull.split("/");

  await group("Install pi", async () => {
    sh("npm", ["i", "-g", `@mariozechner/pi-coding-agent@${piVersion}`]);

    // Ensure global npm bin is on PATH for subsequent spawnSync("pi").
    const npmBin = sh("npm", ["bin", "-g"]).trim();
    if (npmBin && !process.env.PATH.split(":").includes(npmBin)) {
      process.env.PATH = `${npmBin}:${process.env.PATH}`;
    }

    sh("pi", ["--version"]);
  });

  // Create separate worktree for PR head.
  const prDir = path.resolve(".ai-pr-worktree");

  await group("Prepare PR worktree", async () => {
    try {
      sh("git", ["worktree", "remove", "--force", prDir]);
    } catch {
      // ignore
    }
    tryRmDir(prDir);
    try {
      sh("git", ["worktree", "prune"]);
    } catch {
      // ignore
    }

    sh("git", ["fetch", "--no-tags", "origin", `+refs/pull/${prNumber}/head:refs/remotes/origin/pr-${prNumber}`]);
    sh("git", ["worktree", "add", "--detach", prDir, `refs/remotes/origin/pr-${prNumber}`]);
  });

  // Build context files inside the PR worktree.
  const ctxDir = path.join(prDir, ".ai-review");
  fs.mkdirSync(ctxDir, { recursive: true });

  await group("Build diff context", async () => {
    const diffText = sh("git", ["-C", prDir, "diff", "--patch", "--unified=3", `${baseSha}...${headSha}`]);
    const logText = sh("git", ["-C", prDir, "log", "--oneline", "--no-decorate", `${baseSha}..${headSha}`]);
    const nameStatus = sh("git", ["-C", prDir, "diff", "--name-status", `${baseSha}...${headSha}`]);

    fs.writeFileSync(path.join(ctxDir, "pr.diff"), diffText);
    fs.writeFileSync(path.join(ctxDir, "pr.log"), logText);
    fs.writeFileSync(path.join(ctxDir, "pr.files"), nameStatus);
  });

  const diffFile = path.join(ctxDir, "pr.diff");
  const logFile = path.join(ctxDir, "pr.log");
  const filesFile = path.join(ctxDir, "pr.files");

  const extPath = path.join(actionDir, "ci-sandbox.ts");
  const prompt = readPromptFile(actionDir, maxComments);

  const piArgs = [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "-e",
    extPath,
    "--tools",
    "read,grep,find,ls",
    "--provider",
    provider,
    "--model",
    model,
    `@${path.relative(prDir, diffFile)}`,
    `@${path.relative(prDir, logFile)}`,
    `@${path.relative(prDir, filesFile)}`,
    prompt,
  ];

  const review = await group("Run pi", async () => {
    const piRes = spawnSync("pi", piArgs, {
      cwd: prDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PI_REVIEW_ROOT: prDir,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (piRes.status !== 0) {
      throw new Error(`pi failed (exit ${piRes.status}):\n${piRes.stderr || piRes.stdout}`);
    }

    const modelOut = (piRes.stdout || "").trim();
    return safeJsonParse(modelOut);
  });

  const summary = typeof review.summary === "string" ? review.summary : "(no summary)";
  const commentsIn = Array.isArray(review.comments) ? review.comments : [];

  appendStepSummary(`## pi-pr-review (comment-only)\n\nModel: \`${provider}/${model}\`\n\n${summary}`);

  // Fetch PR file patches for inline comment mapping.
  const prFiles = await group("Fetch PR file patches", async () => {
    return await listPullFiles(owner, repo, prNumber, token);
  });

  const patchByPath = new Map();
  for (const f of prFiles) patchByPath.set(f.filename, f.patch);

  const comments = [];
  for (const c of commentsIn.slice(0, maxComments)) {
    const p = c?.path;
    const line = c?.line;
    const body = c?.body;
    if (typeof p !== "string" || typeof body !== "string") continue;
    if (typeof line !== "number" || !Number.isFinite(line) || line <= 0) continue;

    const patch = patchByPath.get(p);
    const pos = positionForNewLine(patch, line);
    if (!pos) continue;

    comments.push({ path: p, position: pos, body });
  }

  await group("Create GitHub review", async () => {
    const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
    await ghPostJson(url, token, {
      commit_id: headSha,
      event: "COMMENT",
      body: summary,
      ...(comments.length > 0 ? { comments } : {}),
    });
  });

  await group("Cleanup", async () => {
    try {
      sh("git", ["worktree", "remove", "--force", prDir]);
    } catch {
      // ignore
    }
  });
}

main().catch((e) => {
  fail(e?.stack || String(e));
});
