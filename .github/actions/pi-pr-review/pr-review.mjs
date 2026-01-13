#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
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
  // pi should return strict JSON, but be defensive.
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error(`Model did not return JSON. Output:\n${text}`);
  }
  const candidate = text.slice(first, last + 1);
  return JSON.parse(candidate);
}

function positionForNewLine(patch, targetLine) {
  if (!patch) return null;

  // GitHub's `position` is 1-based index into the `patch` string lines.
  const lines = patch.split("\n");
  let position = 0;
  let newLine = 0;

  for (const raw of lines) {
    const line = raw.replace(/\r$/, "");
    position++;

    if (line.startsWith("@@")) {
      // @@ -a,b +c,d @@
      const m = /\+([0-9]+)(?:,([0-9]+))?/.exec(line);
      if (m) {
        newLine = Number(m[1]) - 1;
      }
      continue;
    }

    // Skip file header markers if present (usually not included in API patch).
    if (line.startsWith("+++ ") || line.startsWith("--- ")) {
      continue;
    }

    if (line.startsWith("+")) {
      newLine++;
      if (newLine === targetLine) return position;
      continue;
    }

    if (line.startsWith("-")) {
      // deletion: does not advance newLine
      continue;
    }

    // context line (starts with space). Ignore trailing empty line from split().
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

function readPromptFile(maxComments) {
  const promptPath = new URL("./prompt.txt", import.meta.url);
  const raw = fs.readFileSync(promptPath, "utf-8");
  return raw.replaceAll("${PI_MAX_COMMENTS}", String(maxComments));
}

async function main() {
  const token = mustEnv("GITHUB_TOKEN");
  const provider = process.env.PI_PROVIDER || "openrouter";
  const model = process.env.PI_MODEL || "minimax/minimax-m2.1";
  const maxComments = Math.max(0, Number(process.env.PI_MAX_COMMENTS || "20") || 20);

  // Fail fast if the provider key isn't present.
  if (provider === "openrouter") {
    mustEnv("OPENROUTER_API_KEY");
  }

  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf-8"));

  const pr = payload.pull_request;
  if (!pr) throw new Error("Not a pull_request_target event payload");

  const prNumber = pr.number;
  const baseSha = pr.base.sha;
  const headSha = pr.head.sha;

  console.log(`ai-pr-review: PR #${prNumber} using ${provider}/${model}`);

  const repoFull = mustEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repoFull.split("/");

  // Create separate worktree for PR head.
  const prDir = path.resolve(".ai-pr-worktree");

  // Best-effort cleanup from previous runs.
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

  // refs/pull/<id>/head is available on GitHub for PRs (including forks).
  sh("git", ["fetch", "--no-tags", "origin", `+refs/pull/${prNumber}/head:refs/remotes/origin/pr-${prNumber}`]);
  sh("git", ["worktree", "add", "--detach", prDir, `refs/remotes/origin/pr-${prNumber}`]);

  // Build context files inside the PR worktree.
  const ctxDir = path.join(prDir, ".ai-review");
  fs.mkdirSync(ctxDir, { recursive: true });

  const diffText = sh("git", ["-C", prDir, "diff", "--patch", "--unified=3", `${baseSha}...${headSha}`]);
  const logText = sh("git", ["-C", prDir, "log", "--oneline", "--no-decorate", `${baseSha}..${headSha}`]);
  const nameStatus = sh("git", ["-C", prDir, "diff", "--name-status", `${baseSha}...${headSha}`]);

  const diffFile = path.join(ctxDir, "pr.diff");
  const logFile = path.join(ctxDir, "pr.log");
  const filesFile = path.join(ctxDir, "pr.files");

  fs.writeFileSync(diffFile, diffText);
  fs.writeFileSync(logFile, logText);
  fs.writeFileSync(filesFile, nameStatus);

  const extPath = new URL("./ci-sandbox.ts", import.meta.url);
  const prompt = readPromptFile(maxComments);

  const piArgs = [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "-e",
    path.resolve(fileURLToPath(extPath)),
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
  const review = safeJsonParse(modelOut);

  const summary = typeof review.summary === "string" ? review.summary : "(no summary)";
  const commentsIn = Array.isArray(review.comments) ? review.comments : [];

  // Fetch PR file patches for inline comment mapping.
  const prFiles = await listPullFiles(owner, repo, prNumber, token);
  const patchByPath = new Map();
  for (const f of prFiles) {
    patchByPath.set(f.filename, f.patch);
  }

  // Best-effort inline comment mapping.
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

  const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
  const payloadBody = {
    commit_id: headSha,
    event: "COMMENT",
    body: summary,
    ...(comments.length > 0 ? { comments } : {}),
  };

  await ghPostJson(url, token, payloadBody);

  // Cleanup worktree
  try {
    sh("git", ["worktree", "remove", "--force", prDir]);
  } catch {
    // ignore
  }
}

main().catch((err) => {
  console.error(err?.stack || String(err));
  process.exit(1);
});
