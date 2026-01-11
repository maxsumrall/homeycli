# Output contract (JSON)

This CLI is designed to be called by agents. When `--json` is set:

- **Success** outputs JSON to **stdout**.
- **Errors** output JSON to **stdout** in a stable shape (see below).
- Text output (without `--json`) is intended for humans and may change.

## Error JSON (stable)

All errors use this envelope:

```json
{
  "error": {
    "code": "AMBIGUOUS",
    "message": "...",
    "details": {
      "candidates": [{"id": "...", "name": "..."}]
    }
  }
}
```

Notes:
- `details` is optional.
- When present, `details.candidates` is an array of `{ id, name }` objects.

Exit codes are documented in `docs/errors.md`.

## Success JSON (stable fields)

### `homeycli auth status --json`

```json
{
  "tokenPresent": true,
  "source": "env",
  "path": "/Users/.../.homey/config.json"
}
```

### `homeycli auth set-token ... --json`

```json
{
  "saved": true,
  "source": "config",
  "path": "/Users/.../.homey/config.json"
}
```

### `homeycli status --json`

```json
{
  "name": "Homey",
  "platform": "...",
  "platformVersion": "...",
  "hostname": "...",
  "cloudId": "...",
  "connected": true
}
```

### `homeycli zones --json`

Array of zones:

- `id` (string)
- `name` (string)
- `parent` (string|null)
- `icon` (string|null)

### `homeycli devices --json` / `homeycli device <id> ... --json`

Array of devices (or a single device depending on command). Stable fields per device:

- `id` (string)
- `name` (string)
- `zoneId` (string|null)
- `zoneName` (string|null)
- `zone` (string|null) – convenience display field
- `class` (string)
- `capabilities` (string[])
- `capabilitiesObj` (object) – Homey capability metadata + latest values
- `values` (object) – `{ [capabilityId]: value }`
- `available` (boolean)
- `ready` (boolean)

### `homeycli flows --json`

Array of flows:

- `id` (string)
- `name` (string)
- `enabled` (boolean)
- `folder` (string|null)

### `homeycli flow trigger <idOrName> --json`

Returns the triggered flow object (same shape as flows above).

### `homeycli snapshot --json`

```json
{
  "status": { /* same as status */ },
  "zones": [ /* same as zones */ ],
  "devices": [ /* same as devices */ ],
  "flows": [ /* optional; same as flows */ ]
}
```

## `--raw` (intentionally unstable)

When `--raw` is set, responses may include a `raw` field containing the underlying Homey API object.

- `raw` is **very verbose** and may change at any time.
- Agents should not depend on `raw` fields for core behavior.
