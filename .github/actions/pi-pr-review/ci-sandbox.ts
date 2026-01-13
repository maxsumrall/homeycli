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
  // If you need complex shell scripts, this action isn't the right layer.
  // Allowlist is for single commands with args.
  const bad = [
    "\n",
    "\r",
    ";",
    "&&",
    "||",
    "|",
    ">",
    "<",
    "`",
    "$(",
  ];
  return bad.some((b) => command.includes(b));
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
