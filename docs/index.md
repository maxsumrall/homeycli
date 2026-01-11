# homeycli

Control Athom Homey devices from the command line using the Homey Cloud API.

This tool is designed to be called by an LLM/agent (ClawdHub skill), so it prioritizes:

- machine-readable JSON (`--json`)
- returning full device state (multi-sensor friendly)
- safe disambiguation (if a query matches >1 device, it errors and returns candidate IDs)

## Install

```bash
npm install
chmod +x bin/homeycli.js
```

## Auth

Recommended (safe; avoids shell history):

```bash
echo "YOUR_TOKEN" | homeycli auth set-token --stdin
homeycli auth status --json
```

Interactive (hidden input):

```bash
homeycli auth set-token --prompt
```

## Recommended: snapshot

```bash
homeycli snapshot --json
homeycli snapshot --json --include-flows
```

## Devices

```bash
homeycli devices --json
homeycli devices --match "kitchen" --json

homeycli device "Kitchen Light" values --json
homeycli device <device-id> set dim 0.7 --json
```

## Flows

```bash
homeycli flows --json
homeycli flow trigger "Good Night" --json
```

See the README for more.

For agent integrations, also see: `docs/output.md` (stable JSON contract).
