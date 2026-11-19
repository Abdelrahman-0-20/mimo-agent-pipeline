# dsh-plugin-mimo-escalator

**Auto-escalate LLM agents when they keep failing** — two consecutive failed verification rounds flip `mimo-v2.6-flash` → `mimo-v2.6-pro` (high reasoning); two consecutive passes demote it back. Hysteresis means no oscillating on a single fluke, and every transition is recorded with usage-backed token samples.

Ships as **two things from one package**:

1. **A standalone, zero-dependency stdio MCP server** (`mimo-escalator-mcp`) — works with Claude Code, Cursor, VS Code, or any MCP client.
2. **A DeepSeek Harness plugin** (this repo's own stack) — see [mimo-agent-pipeline](https://github.com/Abdelrahman-0-20/mimo-agent-pipeline).

## Install

```bash
npm install -g dsh-plugin-mimo-escalator     # provides the `mimo-escalator-mcp` bin
# or run it ad hoc:
npx -y dsh-plugin-mimo-escalator
```

> The published binary is `mimo-escalator-mcp` (also runnable as `node mcp-server.mjs` from an install).

## Connect an MCP client

**Claude Code**

```bash
claude mcp add mescal -- npx -y dsh-plugin-mimo-escalator
```

**Cursor** (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "mescal": { "command": "npx", "args": ["-y", "dsh-plugin-mimo-escalator"] }
  }
}
```

**Any other MCP client** — start `npx -y dsh-plugin-mimo-escalator` and speak newline-delimited JSON-RPC over stdio (`initialize`, `tools/list`, `tools/call`, `ping`).

## Tools

| Tool | What it does |
|---|---|
| `mescal_status` | Read persisted strikes, role metrics, transitions, and effort samples for a workspace. Read-only. |
| `mescal_record_round` | Record one verification round for `<workspace>:<role>` (`failed: true\|false`) and get back the hysteresis decision: `escalate`, `demote`, or `none` — plus strike counts and persisted metrics. Optional `fromModel`/`toModel` annotate the switch the decision implies. |

The state file is a plain JSON document (default `./mimo-escalator-state.json`) with a documented `v2` shape: per-key strike counters, transition history, and capped effort-toggle samples.

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `MIMO_ESCALATOR_STATE` | `./mimo-escalator-state.json` | State file path (one file serves every workspace keyed inside it) |
| `MIMO_ESCALATOR_THRESHOLD` | `2` | Consecutive failed rounds before `escalate` |
| `MIMO_ESCALATOR_DEMOTE_THRESHOLD` | `2` | Consecutive passed rounds before `demote` |
| `MIMO_ESCALATOR_TTL_HOURS` | `72` | Entries idle longer than this are pruned (`0` = keep forever) |

## Example session

```json
{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"demo","version":"1.0"}}}
{"jsonrpc":"2.0","id":2,"method":"tools/call","params":{"name":"mescal_record_round","arguments":{"workspace":"/repo","role":"verifier","failed":true}}}
```

The reply carries `decision`, `strikes`, and the persisted entry — no network, no telemetry, your state file stays local.

## Why hysteresis?

A single failure might be noise; two in a row is a pattern — escalate only on the pattern, and require the same evidence to come back down. That asymmetry is the whole trick, and it is the same engine the [mimo-agent-pipeline](https://github.com/Abdelrahman-0-20/mimo-agent-pipeline) relay uses in production.

## License

MIT — see [LICENSE](https://github.com/Abdelrahman-0-20/mimo-agent-pipeline/blob/main/LICENSE).

[![](https://img.shields.io/badge/powered_by-dsh-4D6BFE?style=flat-square&logo=deepseek&logoColor=white)](https://github.com/deepseek-ai/deepseek-harness)
