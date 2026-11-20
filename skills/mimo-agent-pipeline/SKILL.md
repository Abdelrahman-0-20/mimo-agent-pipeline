---
name: 'mimo-agent-pipeline'
description: 'Run and recover the mimo-agent-pipeline in DeepSeek Harness: mimo_relay (Planner→Builder→Verifier), mimo_think (deep-reasoning pass), mescal_status/mthink_status (escalation and thinking metrics), the auto-escalator rules, verification gates, and the continuation pattern for failed runs.'
whenToUse: 'A task involves mimo_relay or mescal_status, an escalation/effort notice appears, or the working repo contains dsh-plugin-mimo-escalator / dsh-plugin-mimo-relay / dsh-plugin-mimo-think.'
---

# mimo-agent-pipeline

You are working inside (or with) an autonomous engineering pipeline: a cheap-by-default MiMo model router with automatic escalation, a predictive thinking boost, a three-role relay, and verification gates that refuse to say "done" until they exit 0.

## The three tools

- **`mimo_relay({task})`** runs one Planner → Builder → Verifier cycle in the current working directory. Returns `{ok, phase, reason, report}`; `ok: true` means the *independent verifier* passed (`report.verify.defects: []`). A plan-only read task still runs all three phases.
- **`mescal_status()`** returns this session's escalation state, per-role persisted metrics (rounds, transitions, effort-toggle token samples), and `diagnostics.lastSkip` — **why the most recent tool result was not counted** as a verification round.
- **`mimo_think({question, context?, focus?})`** runs one deep-reasoning pass: a read-only `mimo-v2.6-pro` thinker at `high` effort returns `{ok, reason, result: {analysis, answer, confidence, risks}, attempts, model, durationMs}`. Use it before hard decisions (design, root cause, trade-offs). `mthink_status()` reports the boost state and think metrics.

## Automatic behavior (no action needed)

- **Tier escalator:** 2 consecutive failed verification rounds → `mimo-v2.6-pro` (high reasoning); 2 consecutive passes → back to `mimo-v2.6-flash`. State is per `<workspace>:<role>` in `mimo-escalator-state.json` (72 h TTL) — a builder's failures never escalate the planner.
- **Effort policy:** 3+ consecutive read-only tools (read/grep/docs lookups) → `reasoningEffort: off`; the first work command (bash/edit/write) restores the saved effort immediately. Samples with cache-read tokens are recorded for measurement.
- **Thinking boost (predictive):** every incoming prompt is scored; a score ≥ 4 (design/debug/analysis/security/code signals + length) raises `reasoningEffort` to `high` until a trivial prompt (≤ 1) arrives 30 minutes after the last hard one. Work tool results re-assert an active boost; discovery reads never do, so effort still goes `off` during read streaks. The boost never switches models and never overrides a manual `/model`.

## Eval gate (the scorer is measured, not guessed)

The think-boost thresholds are CI-enforced by `node eval/run.mjs` (exit 0 pass · 1 regression/stale/violation · 2 infra fail-closed):

- **Never tune thresholds or patterns directly.** Changing `cordis.patch.yml` thresholds, `eval/costs.json` weights, `eval/golden_set.json`, or `src/score.js`/`src/boost.js` makes the baseline stale → exit 1 until you re-record: `node eval/run.mjs --record --rationale "<why>"` — δ-guarded (cost over previously-known example ids may not regress >5%; removals refused).
- **Golden set is append-only**: additions only, ids immutable, recompute `provenance.hash`; labels come from two independent blind passes (never the scorer, never outcomes) plus a blind adjudication pass; commit set + baseline together.
- **Sequence violations are exact** (hysteresis / TTL / re-assert / model-forget invariants): zero tolerance, the gate names sequence and step.
- Contract: `dsh-plugin-mimo-think/eval/DESIGN.md` · usage: `eval/README.md`.

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
