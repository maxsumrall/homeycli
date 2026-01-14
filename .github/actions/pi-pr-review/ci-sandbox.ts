import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

function isWithin(root: string, target: string) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function resolveAndRealpath(cwd: string, p: string) {
  const abs = path.isAbsolute(p) ? path.resolve(p) : path.resolve(cwd, p);

  // If it exists, resolve symlinks too (prevents ../../ escape via symlink)
  try {
    if (fs.existsSync(abs)) return fs.realpathSync(abs);
  } catch {
    // ignore
  }

  return abs;
}

function parseAllowlist(raw: string): string[] {
  return raw
    .split(/\r?\n|,/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .filter((s) => !s.startsWith("#"));
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchWildcard(pattern: string, text: string): boolean {
  // Only `*` wildcard. Full-string match.
  // Disallow a pattern of exactly "*" (too broad).
  if (pattern === "*") return false;
  if (pattern.startsWith("*")) return false;

  const re = new RegExp(`^${pattern.split("*").map(escapeRegex).join(".*")}$`);
  return re.test(text);
}

function containsShellOperators(command: string): boolean {
  // Detect shell control operators OUTSIDE of quotes.
  // This avoids false positives for commit messages like: git commit -m "a && b".
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < command.length; i++) {
    const ch = command[i];

    if (ch === "\\") {
      // Skip escaped char
      i++;
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (inSingle || inDouble) continue;

    // newline
    if (ch === "\n" || ch === "\r") return true;

    // multi-char ops
    const two = command.slice(i, i + 2);
    if (two === "&&" || two === "||" || two === "$(") return true;

    // single-char ops
    if (ch === ";" || ch === "|" || ch === ">" || ch === "<" || ch === "`" || ch === "&") return true;
  }

  return false;
}

function splitArgs(cmd: string): string[] {
  // Minimal shell-like splitter for our validation.
  // Handles single/double quotes and backslash escapes.
  const out: string[] = [];
  let cur = "";
  let inSingle = false;
  let inDouble = false;

  for (let i = 0; i < cmd.length; i++) {
    const ch = cmd[i];

    if (ch === "\\") {
      // Preserve escaped characters
      if (i + 1 < cmd.length) {
        cur += cmd[i + 1];
        i++;
      }
      continue;
    }

    if (!inDouble && ch === "'") {
      inSingle = !inSingle;
      continue;
    }
    if (!inSingle && ch === '"') {
      inDouble = !inDouble;
      continue;
    }

    if (!inSingle && !inDouble && /\s/.test(ch)) {
      if (cur.length) {
        out.push(cur);
        cur = "";
      }
      continue;
    }

    cur += ch;
  }

  if (cur.length) out.push(cur);
  return out;
}

function validateGitPush(command: string, expectedBranch: string, allowForce: boolean) {
  const args = splitArgs(command);
  if (args.length < 3) throw new Error("Blocked: git push must specify a remote and refspec");
  if (args[0] !== "git" || args[1] !== "push") return;

  // Basic flag filtering.
  const forbiddenFlags = new Set([
    "--all",
    "--mirror",
    "--tags",
    "--follow-tags",
    "--delete",
    "--prune",
  ]);

  let i = 2;
  let seenForceWithLease = false;
  let seenForce = false;

  while (i < args.length && args[i].startsWith("-")) {
    const a = args[i];
    if (forbiddenFlags.has(a)) throw new Error(`Blocked: forbidden git push flag ${a}`);
    if (a === "--force-with-lease") seenForceWithLease = true;
    if (a === "--force") seenForce = true;
    i++;
  }

  if (seenForce && !allowForce) {
    throw new Error("Blocked: --force is not allowed (use --force-with-lease)");
  }

  // We allow --force-with-lease always.
  // Remote
  const remote = args[i++];
  if (remote !== "origin") throw new Error("Blocked: git push remote must be 'origin'");

  // Exactly one refspec
  const refspec = args[i++];
  if (i !== args.length) throw new Error("Blocked: git push must use exactly one refspec");

  // Accept either:
  // - HEAD:<branch>
  // - <branch>
  if (refspec === expectedBranch) return;
  if (refspec === `HEAD:${expectedBranch}`) return;

  throw new Error(`Blocked: git push refspec must target the current PR branch (${expectedBranch})`);
}

function scrubEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  // Defense-in-depth: child process doesn't need LLM keys or GitHub token.
  const out: NodeJS.ProcessEnv = { ...env };
  delete out.OPENROUTER_API_KEY;
  delete out.ANTHROPIC_API_KEY;
  delete out.OPENAI_API_KEY;
  delete out.GEMINI_API_KEY;
  delete out.MISTRAL_API_KEY;
  delete out.XAI_API_KEY;
  delete out.CEREBRAS_API_KEY;
  delete out.GITHUB_TOKEN;
  delete out.GH_TOKEN;
  delete out.ACTIONS_RUNTIME_TOKEN;
  return out;
}

async function runRestrictedBash(command: string, cwd: string, timeoutSeconds?: number, signal?: AbortSignal) {
  return new Promise<{ exitCode: number; output: string; truncated: boolean }>((resolve, reject) => {
    const child = spawn("bash", ["-lc", command], {
      cwd,
      env: scrubEnv(process.env),
      stdio: ["ignore", "pipe", "pipe"],
    });

    let timedOut = false;
    let truncated = false;
    const MAX_BYTES = 50 * 1024;
    const chunks: Buffer[] = [];
    let total = 0;

    const onData = (b: Buffer) => {
      total += b.length;
      chunks.push(b);
      // Keep only the tail.
      while (chunks.length > 0 && Buffer.concat(chunks).length > MAX_BYTES) {
        chunks.shift();
        truncated = true;
      }
    };

    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);

    let timeoutHandle: NodeJS.Timeout | undefined;
    if (timeoutSeconds && timeoutSeconds > 0) {
      timeoutHandle = setTimeout(() => {
        timedOut = true;
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
      }, timeoutSeconds * 1000);
    }

    const onAbort = () => {
      try {
        child.kill("SIGKILL");
      } catch {
        // ignore
      }
    };
    if (signal) {
      if (signal.aborted) onAbort();
      else signal.addEventListener("abort", onAbort, { once: true });
    }

    child.on("error", (e) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);
      reject(e);
    });

    child.on("close", (code) => {
      if (timeoutHandle) clearTimeout(timeoutHandle);
      signal?.removeEventListener("abort", onAbort);

      if (timedOut) {
        reject(new Error(`Blocked: bash timeout after ${timeoutSeconds}s`));
        return;
      }

      const output = Buffer.concat(chunks).toString("utf-8").trimEnd();
      resolve({ exitCode: code ?? 1, output, truncated });
    });
  });
}

export default function (pi: ExtensionAPI) {
  // ---------------------------------------------------------------------------
  // GitHub tools (safe, repo-scoped)
  // ---------------------------------------------------------------------------

  function mustEnv(name: string): string {
    const v = process.env[name];
    if (!v) throw new Error(`Blocked: missing required env var: ${name}`);
    return v;
  }

  async function ghRequest(method: string, url: string, body?: any) {
    const token = mustEnv("GITHUB_TOKEN");
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
    if (!res.ok) throw new Error(`GitHub API ${method} error ${res.status} for ${url}: ${text}`);
    return text ? JSON.parse(text) : {};
  }

  function positionForNewLine(patch: string | undefined, targetLine: number): number | null {
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

  async function listPullFiles(owner: string, repo: string, prNumber: string): Promise<any[]> {
    const out: any[] = [];
    let page = 1;
    for (;;) {
      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/files?per_page=100&page=${page}`;
      const batch = await ghRequest("GET", url);
      out.push(...batch);
      if (batch.length < 100) break;
      page++;
    }
    return out;
  }

  pi.registerTool({
    name: "github_create_pr_review",
    label: "github_create_pr_review",
    description:
      "Create a PR review (COMMENT-only) on the current PR. " +
      "Optionally includes inline comments by file path + new-line number. " +
      "This tool is repo-scoped and PR-scoped.",
    parameters: Type.Object({
      body: Type.String({ description: "Review summary markdown" }),
      comments: Type.Optional(
        Type.Array(
          Type.Object({
            path: Type.String({ description: "File path in repo" }),
            line: Type.Number({ description: "Line number in the new file (RIGHT side)" }),
            body: Type.String({ description: "Inline comment markdown" }),
          }),
        ),
      ),
    }),
    async execute(_toolCallId, params) {
      const owner = mustEnv("PI_GH_OWNER");
      const repo = mustEnv("PI_GH_REPO");
      const prNumber = mustEnv("PI_PR_NUMBER");
      const headSha = mustEnv("PI_PR_HEAD_SHA");

      const summary = String((params as any).body ?? "").trim();
      if (!summary) throw new Error("Blocked: review body is empty");

      const commentsIn = Array.isArray((params as any).comments) ? (params as any).comments : [];

      // Fetch PR file patches for mapping line -> position.
      const prFiles = await listPullFiles(owner, repo, prNumber);
      const patchByPath = new Map<string, string | undefined>();
      for (const f of prFiles) patchByPath.set(String(f.filename), f.patch);

      const comments: Array<{ path: string; position: number; body: string }> = [];
      for (const c of commentsIn.slice(0, 50)) {
        const p = String(c?.path ?? "");
        const body = String(c?.body ?? "");
        const line = Number(c?.line);
        if (!p || !body) continue;
        if (!Number.isFinite(line) || line <= 0) continue;

        const patch = patchByPath.get(p);
        const pos = positionForNewLine(patch, line);
        if (!pos) continue;

        comments.push({ path: p, position: pos, body });
      }

      const url = `https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/reviews`;
      const res = await ghRequest("POST", url, {
        commit_id: headSha,
        event: "COMMENT",
        body: summary,
        ...(comments.length > 0 ? { comments } : {}),
      });

      return {
        content: [
          {
            type: "text",
            text: `Created PR review${res?.html_url ? `: ${res.html_url}` : "."}`,
          },
        ],
        details: { reviewId: res?.id, url: res?.html_url, inlineComments: comments.length },
      };
    },
  });

  // ---------------------------------------------------------------------------
  // Restricted bash tool
  // ---------------------------------------------------------------------------

  // Override the built-in bash tool with a restricted version.
  // Only active if the caller includes `bash` in --tools.
  pi.registerTool({
    name: "bash",
    label: "bash",
    description:
      "Execute a restricted bash command (allowlist enforced by PI_BASH_ALLOWLIST). " +
      "Commands containing shell control operators (;, &&, ||, pipes, redirects, backticks, $() etc.) are blocked.",
    parameters: Type.Object({
      command: Type.String({ description: "Bash command to execute" }),
      timeout: Type.Optional(Type.Number({ description: "Timeout in seconds" })),
    }),
    async execute(_toolCallId, params, _onUpdate, ctx, signal) {
      const allowlist = parseAllowlist(process.env.PI_BASH_ALLOWLIST || "");
      if (allowlist.length === 0) {
        throw new Error("Blocked: bash is enabled but PI_BASH_ALLOWLIST is empty");
      }

      const command = String((params as any).command ?? "").trim();
      const timeout = (params as any).timeout;

      if (!command) throw new Error("Blocked: empty bash command");
      if (containsShellOperators(command)) {
        throw new Error("Blocked: shell operators are not allowed in restricted bash");
      }

      const expectedBranch = process.env.PI_PR_HEAD_REF || "";
      const allowForce = process.env.PI_ALLOW_FORCE === "true";

      if (command.startsWith("git push ") || command === "git push" || command.startsWith("git push-")) {
        if (!expectedBranch) throw new Error("Blocked: PI_PR_HEAD_REF is not set for git push validation");
        validateGitPush(command, expectedBranch, allowForce);
      }

      const ok = allowlist.some((p) => matchWildcard(p, command));
      if (!ok) {
        throw new Error(`Blocked: bash command not in allowlist: ${command}`);
      }

      const { exitCode, output, truncated } = await runRestrictedBash(command, ctx.cwd, timeout, signal);
      const suffix = truncated ? "\n\n[output truncated]" : "";
      const text = (output ? output : "(no output)") + suffix + `\n[exitCode=${exitCode}]`;

      return {
        content: [{ type: "text", text }],
        details: { exitCode, truncated },
      };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    // In CI we run pi with cwd set to a separate worktree containing the PR head.
    // Restrict all filesystem tools to that directory.
    const allowedRoot = path.resolve(process.env.PI_REVIEW_ROOT ?? ctx.cwd);

    const input: any = event.input ?? {};

    // Extra defense: even if someone enables the built-in bash tool instead of our override,
    // still enforce the allowlist here.
    if (event.toolName === "bash") {
      const command = typeof input.command === "string" ? input.command.trim() : "";
      const allowlist = parseAllowlist(process.env.PI_BASH_ALLOWLIST || "");

      if (!command) return { block: true, reason: "Blocked: empty bash command" };
      if (allowlist.length === 0) return { block: true, reason: "Blocked: PI_BASH_ALLOWLIST is empty" };
      if (containsShellOperators(command)) return { block: true, reason: "Blocked: shell operators not allowed" };

      const expectedBranch = process.env.PI_PR_HEAD_REF || "";
      const allowForce = process.env.PI_ALLOW_FORCE === "true";
      if (command.startsWith("git push")) {
        if (!expectedBranch) return { block: true, reason: "Blocked: PI_PR_HEAD_REF is not set" };
        try {
          validateGitPush(command, expectedBranch, allowForce);
        } catch (e: any) {
          return { block: true, reason: e?.message || "Blocked: invalid git push" };
        }
      }

      const ok = allowlist.some((p) => matchWildcard(p, command));
      if (!ok) return { block: true, reason: "Blocked: bash command not in allowlist" };

      return;
    }

    const p =
      event.toolName === "read" ? input.path :
      event.toolName === "grep" ? input.path :
      event.toolName === "find" ? input.path :
      event.toolName === "ls" ? input.path :
      event.toolName === "edit" ? input.path :
      event.toolName === "write" ? input.path :
      undefined;

    if (p === undefined) return;
    if (typeof p !== "string") return { block: true, reason: "Blocked: invalid path" };

    // Keep CI simple: disallow ~ expansion.
    if (p.includes("~")) {
      return { block: true, reason: "Blocked: ~ paths not allowed in CI" };
    }

    // Avoid reading git metadata (not needed for review, reduces prompt-injection surface).
    if (p === ".git" || p.startsWith(".git/") || p.includes("/.git/") || p.endsWith("/.git")) {
      return { block: true, reason: "Blocked: .git access not allowed in CI" };
    }

    const resolved = resolveAndRealpath(ctx.cwd, p);
    if (!isWithin(allowedRoot, resolved)) {
      return { block: true, reason: `Blocked: path outside allowed root (${resolved})` };
    }
  });
}
