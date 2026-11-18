---
name: 'mimo-agent-pipeline'
description: 'Run and recover the mimo-agent-pipeline in DeepSeek Harness: mimo_relay (Planner→Builder→Verifier), mescal_status (escalation/effort metrics), the auto-escalator rules, verification gates, and the continuation pattern for failed runs.'
whenToUse: 'A task involves mimo_relay or mescal_status, an escalation/effort notice appears, or the working repo contains dsh-plugin-mimo-escalator / dsh-plugin-mimo-relay.'
---

# mimo-agent-pipeline

You are working inside (or with) an autonomous engineering pipeline: a cheap-by-default MiMo model router with automatic escalation, a three-role relay, and verification gates that refuse to say "done" until they exit 0.

## The two tools

- **`mimo_relay({task})`** runs one Planner → Builder → Verifier cycle in the current working directory. Returns `{ok, phase, reason, report}`; `ok: true` means the *independent verifier* passed (`report.verify.defects: []`). A plan-only read task still runs all three phases.
- **`mescal_status()`** returns this session's escalation state, per-role persisted metrics (rounds, transitions, effort-toggle token samples), and `diagnostics.lastSkip` — **why the most recent tool result was not counted** as a verification round.

## Automatic behavior (no action needed)

- **Tier escalator:** 2 consecutive failed verification rounds → `mimo-v2.6-pro` (high reasoning); 2 consecutive passes → back to `mimo-v2.6-flash`. State is per `<workspace>:<role>` in `mimo-escalator-state.json` (72 h TTL) — a builder's failures never escalate the planner.
- **Effort policy:** 3+ consecutive read-only tools (read/grep/docs lookups) → `reasoningEffort: off`; the first work command (bash/edit/write) restores the saved effort immediately. Samples with cache-read tokens are recorded for measurement.

## Critical: how verification rounds count

A round counts only when the **final segment** of the bash command is the verification command itself — because that segment owns the exit code.

- DO run tests bare: `npm test`, `python3 -m pytest -q`, `./verify.sh`.
- NEVER append `; echo "exit=$?"`, `| tail`, or `| cat` — the round is then **ignored** (this mistake has repeatedly looked like "the plugin is broken" when it was correct).
- `&&`-chains whose last segment is a scope check (e.g. `git diff …`) are deliberately not counted — a conservative miss, never a false pass.

## Gates before claiming done

1. The project's own gate must exit 0 (pipeline repo: `./verify.sh`; case-study repos: their `./verify.sh`).
2. Run the full test suite yourself with a bare command; confirm the exit code from the tool result.
3. Review-fix tasks leave changes **uncommitted** for human review unless told otherwise; case-study milestone tasks **commit once** per milestone with the milestone message.

## Recovering a failed relay (the continuation pattern)

- **Contract failure** (`handoff.status must be…`, `no structured handoff`): the work may already be done — run a new `mimo_relay` whose task says *verify-only*: "review committed/partial work against <spec>, fix genuine defects, gates green, handoff status must be exactly pass/fail".
- **Infra failure** (`stopReason=error`, `quota`, `timed out`): inspect `git status` first, then re-run `mimo_relay` with: "Continue <milestone> after an interruption: the previous child died with <reason>; inspect partials against <spec>, complete, gate, commit."
- **`429 quota exhausted`** is the Xiaomi token plan — wait for the window; do not retry-spam. One cool-off retry is the relay's job (auto-resume), not yours.

## Where things live

- Pipeline repo README: roadmap, config tables, benchmark, demo GIF.
- `docs/case-study-pricing.md` (review-fix study) and `docs/case-study-greenfield.md` (build-from-zero study) — worked examples of every rule above.
- `benchmark/run.mjs` — Flash-vs-Pro benchmark (`DSH_CLI=… node benchmark/run.mjs`).
- `mcp-server.mjs` (escalator package) — the same escalation engine as a stdio MCP server for Cursor/Claude Code/VS Code.
