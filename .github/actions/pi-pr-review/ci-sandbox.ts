import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
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

export default function (pi: ExtensionAPI) {
  pi.on("tool_call", async (event, ctx) => {
    // In CI we run pi with cwd set to a separate worktree containing the PR head.
    // Restrict all filesystem tools to that directory.
    const allowedRoot = path.resolve(process.env.PI_REVIEW_ROOT ?? ctx.cwd);

    const input: any = event.input ?? {};

    const p =
      event.toolName === "read" ? input.path :
      event.toolName === "grep" ? input.path :
      event.toolName === "find" ? input.path :
      event.toolName === "ls" ? input.path :
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
