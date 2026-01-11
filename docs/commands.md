# Command reference

## snapshot

```bash
homeycli snapshot --json
homeycli snapshot --json --include-flows
```

Returns a point-in-time snapshot:
- status
- zones
- devices (including `values` and `capabilitiesObj`)
- flows (optional)

## devices

```bash
homeycli devices --json
homeycli devices --match "kitchen" --json
```

## device

```bash
homeycli device <nameOrId> values --json
homeycli device <nameOrId> inspect --json
homeycli device <nameOrId> get <capability> --json
homeycli device <nameOrId> set <capability> <value> --json
homeycli device <nameOrId> on --json
homeycli device <nameOrId> off --json
```

Resolution order for `<nameOrId>` is deterministic:

1. direct id match
2. exact name match (case-insensitive)
3. substring match (case-insensitive)
4. fuzzy match (Levenshtein) if the best match is unique and within `--threshold` (default: 5)

If `<nameOrId>` matches more than one device at any step, the command fails with `AMBIGUOUS` and returns candidate IDs.

## flows

```bash
homeycli flows --json
homeycli flows --match "good" --json
```

## flow

```bash
homeycli flow trigger <nameOrId> --json
```

`<nameOrId>` resolution uses the same deterministic rules as devices (id → exact → substring → fuzzy within `--threshold`).

## zones

```bash
homeycli zones --json
```

## auth

Recommended (safe; avoids shell history):

```bash
echo "TOKEN" | homeycli auth set-token --stdin
homeycli auth status --json
```

Interactive (hidden input):

```bash
homeycli auth set-token --prompt
```
