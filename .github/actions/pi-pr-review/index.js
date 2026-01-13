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

function warn(msg) {
  console.log(`::warning::${msg}`);
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

async function ghRequestJson(url, token, method, body) {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`GitHub API ${method} error ${res.status} for ${url}: ${text}`);
  }

  return text ? JSON.parse(text) : {};
}

async function ghPostJson(url, token, body) {
  return ghRequestJson(url, token, "POST", body);
}

async function ghPatchJson(url, token, body) {
  return ghRequestJson(url, token, "PATCH", body);
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

async function getUserPermission(owner, repo, username, token) {
  const url = `https://api.github.com/repos/${owner}/${repo}/collaborators/${encodeURIComponent(username)}/permission`;
  const res = await ghFetchJson(url, token);
  return String(res?.permission || "none");
}

function hasWriteAccess(permission) {
  return permission === "admin" || permission === "maintain" || permission === "write";
}

function stripHtmlComments(content) {
  return String(content || "").replace(/<!--[\s\S]*?-->/g, "");
}

function stripInvisibleCharacters(content) {
  content = content.replace(/[\u200B\u200C\u200D\uFEFF]/g, "");
  content = content.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, "");
  content = content.replace(/\u00AD/g, "");
  content = content.replace(/[\u202A-\u202E\u2066-\u2069]/g, "");
  return content;
}

function stripMarkdownImageAltText(content) {
  return content.replace(/!\[[^\]]*\]\(/g, "![](");
}

function stripMarkdownLinkTitles(content) {
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+"[^"]*"/g, "$1");
  content = content.replace(/(\[[^\]]*\]\([^)]+)\s+'[^']*'/g, "$1");
  return content;
}

function stripHiddenAttributes(content) {
  content = content.replace(/\salt\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\salt\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\stitle\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\stitle\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\saria-label\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\saria-label\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\sdata-[a-zA-Z0-9-]+\s*=\s*[^\s>]+/gi, "");
  content = content.replace(/\splaceholder\s*=\s*["'][^"']*["']/gi, "");
  content = content.replace(/\splaceholder\s*=\s*[^\s>]+/gi, "");
  return content;
}

function normalizeHtmlEntities(content) {
  content = content.replace(/&#(\d+);/g, (_, dec) => {
    const num = parseInt(dec, 10);
    if (num >= 32 && num <= 126) return String.fromCharCode(num);
    return "";
  });
  content = content.replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => {
    const num = parseInt(hex, 16);
    if (num >= 32 && num <= 126) return String.fromCharCode(num);
    return "";
  });
  return content;
}

function sanitizeUserText(content) {
  content = stripHtmlComments(String(content || ""));
  content = stripInvisibleCharacters(content);
  content = stripMarkdownImageAltText(content);
  content = stripMarkdownLinkTitles(content);
  content = stripHiddenAttributes(content);
  content = normalizeHtmlEntities(content);
  return content.trim();
}

function extractUserRequest(commentBody, triggerPhrase) {
  const body = String(commentBody || "");
  const idx = body.indexOf(triggerPhrase);
  if (idx === -1) return undefined;

  // Take the substring after the trigger phrase and trim typical separators.
  let rest = body.slice(idx + triggerPhrase.length);
  rest = rest.replace(/^\s*[:,-]?\s*/, "");
  const cleaned = sanitizeUserText(rest);
  return cleaned.length > 0 ? cleaned : undefined;
}

async function listIssueComments(owner, repo, issueNumber, token) {
  const out = [];
  let page = 1;
  for (;;) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments?per_page=100&page=${page}`;
    const batch = await ghFetchJson(url, token);
    out.push(...batch);
    if (batch.length < 100) break;
    page++;
  }
  return out;
}

async function upsertStickyComment(owner, repo, issueNumber, token, marker, body) {
  const comments = await listIssueComments(owner, repo, issueNumber, token);

  // Prefer a comment authored by github-actions[bot] containing the marker.
  const mine = comments.find((c) => c?.user?.login === "github-actions[bot]" && String(c?.body || "").includes(marker));
  if (mine) {
    const url = `https://api.github.com/repos/${owner}/${repo}/issues/comments/${mine.id}`;
    return ghPatchJson(url, token, { body });
  }

  const url = `https://api.github.com/repos/${owner}/${repo}/issues/${issueNumber}/comments`;
  return ghPostJson(url, token, { body });
}

function readPromptFile(actionDir, maxComments) {
  const raw = fs.readFileSync(path.join(actionDir, "prompt.txt"), "utf-8");
  return raw.replaceAll("${PI_MAX_COMMENTS}", String(maxComments));
}

function readCommentPromptFile(actionDir, userRequest) {
  const raw = fs.readFileSync(path.join(actionDir, "prompt-comment.txt"), "utf-8");
  return raw.replaceAll("${PI_USER_REQUEST}", userRequest || "(empty)");
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
  const modeInput = getInput("mode", "auto");
  const triggerPhrase = getInput("trigger-phrase", "@pi-bot");
  const useStickyComment = getInput("use-sticky-comment", "true") !== "false";
  const stickyMarker = getInput("sticky-comment-marker", "<!-- pi-bot -->");

  const piVersion = getInput("pi-version", "latest");
  const provider = getInput("provider", process.env.PI_PROVIDER || "openrouter");
  const model = getInput("model", process.env.PI_MODEL || "minimax/minimax-m2.1");
  const toolsRaw = getInput("tools", "read,grep,find,ls");
  const bashAllowlist = getInput("bash-allowlist", "");
  const maxComments = Math.max(0, Number(getInput("max-comments", process.env.PI_MAX_COMMENTS || "20")) || 20);

  const tools = toolsRaw
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean)
    .join(",");

  const hasBash = tools.split(",").includes("bash");
  if (hasBash && !bashAllowlist.trim()) {
    fail("tools includes 'bash' but bash-allowlist is empty. Provide an allowlist (newline or comma separated). ");
  }

  if (provider === "openrouter") {
    mustEnv("OPENROUTER_API_KEY");
  }

  // Ensure repo is checked out
  await group("Validate git checkout", async () => {
    sh("git", ["rev-parse", "--git-dir"]);
  });

  const eventPath = mustEnv("GITHUB_EVENT_PATH");
  const payload = JSON.parse(fs.readFileSync(eventPath, "utf-8"));

  const repoFull = mustEnv("GITHUB_REPOSITORY");
  const [owner, repo] = repoFull.split("/");

  // Determine execution mode
  // - PR events (pull_request_target): payload.pull_request present
  // - Comment mode: issue_comment on a PR: payload.issue.pull_request present
  const isPrEvent = !!payload.pull_request;
  const isIssueCommentOnPr = !!payload.issue?.pull_request && !!payload.comment;

  let mode = String(modeInput || "auto");
  if (mode === "auto") {
    mode = isIssueCommentOnPr ? "comment" : "pr-review";
  }

  // Access control like claude-code-action: only allow users with write-ish permissions.
  // For PR events, the opener check is usually done in the workflow. For comment mode we must check here.
  const actor = payload.sender?.login || payload.comment?.user?.login || "";
  if (mode === "comment") {
    if (!actor) {
      warn("comment mode: cannot determine actor; skipping");
      return;
    }
    const perm = await getUserPermission(owner, repo, actor, token);
    if (!hasWriteAccess(perm)) {
      warn(`comment mode: ignoring trigger from ${actor} (permission=${perm})`);
      return;
    }
  }

  // Resolve PR metadata
  let prNumber;
  let baseSha;
  let headSha;

  if (isPrEvent) {
    const pr = payload.pull_request;
    prNumber = pr.number;
    baseSha = pr.base.sha;
    headSha = pr.head.sha;
  } else if (isIssueCommentOnPr) {
    prNumber = payload.issue.number;
    const pr = await ghFetchJson(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, token);
    baseSha = pr.base.sha;
    headSha = pr.head.sha;
  } else {
    warn(`Unsupported event payload (mode=${mode}, event=${payload?.action || "?"}); skipping`);
    return;
  }

  info(`pi-action: mode=${mode} PR #${prNumber} using ${provider}/${model} (pi ${piVersion})`);
  info(`pi-action: tools=${tools || "(none)"}${hasBash ? " (restricted bash enabled)" : ""}`);

  await group("Install pi", async () => {
    sh("npm", ["i", "-g", `@mariozechner/pi-coding-agent@${piVersion}`]);

    // Ensure global npm bin is on PATH for subsequent spawnSync("pi").
    const npmBin = sh("npm", ["bin", "-g"]).trim();
    if (npmBin && !process.env.PATH.split(":").includes(npmBin)) {
      process.env.PATH = `${npmBin}:${process.env.PATH}`;
    }

    sh("pi", ["--version"]);
  });

  // Comment-mode trigger check (after access control, before any heavy work)
  let userRequest;
  if (mode === "comment") {
    userRequest = extractUserRequest(payload.comment?.body, triggerPhrase);
    if (!userRequest) {
      warn(`comment mode: trigger phrase '${triggerPhrase}' not found or empty request; skipping`);
      return;
    }
  }

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
  const prompt = mode === "comment"
    ? readCommentPromptFile(actionDir, userRequest)
    : readPromptFile(actionDir, maxComments);

  const piArgs = [
    "-p",
    "--no-session",
    "--no-extensions",
    "--no-skills",
    "-e",
    extPath,
    "--tools",
    tools,
    "--provider",
    provider,
    "--model",
    model,
    `@${path.relative(prDir, diffFile)}`,
    `@${path.relative(prDir, logFile)}`,
    `@${path.relative(prDir, filesFile)}`,
    prompt,
  ];

  const piOutput = await group("Run pi", async () => {
    const piRes = spawnSync("pi", piArgs, {
      cwd: prDir,
      encoding: "utf-8",
      env: {
        ...process.env,
        PI_REVIEW_ROOT: prDir,
        PI_BASH_ALLOWLIST: bashAllowlist,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    if (piRes.status !== 0) {
      throw new Error(`pi failed (exit ${piRes.status}):\n${piRes.stderr || piRes.stdout}`);
    }

    return (piRes.stdout || "").trim();
  });

  if (mode === "comment") {
    const marker = stickyMarker;
    const body = `${marker}\n\n${piOutput}`;

    appendStepSummary(`## pi-action (comment mode)\n\nModel: \`${provider}/${model}\`\n\nTools: \`${tools}\`\n\nTrigger: \`${triggerPhrase}\``);

    await group("Post comment", async () => {
      if (useStickyComment) {
        await upsertStickyComment(owner, repo, prNumber, token, marker, body);
      } else {
        const url = `https://api.github.com/repos/${owner}/${repo}/issues/${prNumber}/comments`;
        await ghPostJson(url, token, { body });
      }
    });

    // Done.
  } else {
    const review = safeJsonParse(piOutput);
    const summary = typeof review.summary === "string" ? review.summary : "(no summary)";
    const commentsIn = Array.isArray(review.comments) ? review.comments : [];

    appendStepSummary(`## pi-pr-review (comment-only)\n\nModel: \`${provider}/${model}\`\n\nTools: \`${tools}\`\n\n${summary}`);

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
  }

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
