# pi-pr-review (local action)

Runs the [`pi`](https://github.com/badlogic/pi-mono) coding agent in GitHub Actions to generate a **comment-only** PR review (summary + best-effort inline comments).

This action is intentionally conservative:
- Uses **read-only tools** by default (`read,grep,find,ls`)
- Optional restricted `bash` tool (allowlist enforced)
- Blocks file access outside the PR worktree via a sandbox extension
- Posts a **COMMENT** review only (no approvals / no request-changes)

## Required workflow permissions

```yaml
permissions:
  contents: read
  pull-requests: write
```

## Required secrets

- `OPENROUTER_API_KEY` (when using `provider: openrouter`)

If you enable `bash` in `tools`, you must also provide `bash-allowlist`.

### bash allowlist format

Keep it simple: provide one pattern per line (or comma-separated). `*` is the only wildcard.

Examples:

```text
git status
git diff *
npm test
npm run lint
```

Notes:
- Patterns are matched against the *entire* command string.
- Commands containing shell control operators like `;`, `&&`, `||`, pipes, redirects, backticks, or `$(` are blocked.
- The action strips common secret env vars from the bash subprocess environment (defense-in-depth).

## Example usage

```yaml
- uses: actions/checkout@v4
  with:
    ref: ${{ github.event.pull_request.base.sha }}
    fetch-depth: 0

- uses: ./.github/actions/pi-pr-review
  with:
    pi-version: latest
    provider: openrouter
    model: minimax/minimax-m2.1
    tools: read,grep,find,ls
    # To enable restricted bash:
    # tools: read,grep,find,ls,bash
    # bash-allowlist: |
    #   git diff *
    #   npm test
    #   npm run lint
    max-comments: 20
  env:
    OPENROUTER_API_KEY: ${{ secrets.OPENROUTER_API_KEY }}
    GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }}
    PI_SKIP_VERSION_CHECK: "1"
```

## Notes

- Inline comments are **best effort**: GitHub omits `patch` for large diffs/binary files, which prevents line→position mapping.
- This action expects to run on `pull_request_target` events so it can access secrets.
