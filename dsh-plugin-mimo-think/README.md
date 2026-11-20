# dsh-plugin-mimo-think

> The **reasoning/thinking enhancer** for Xiaomi MiMo on [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness): a *predictive* effort boost that reads the difficulty of every incoming prompt, plus an on-demand `mimo_think` deep-reasoning tool that runs a read-only MiMo Pro thinker and returns a structured verdict.

Part of the [mimo-agent-pipeline](../README.md) alongside [`dsh-plugin-mimo-escalator`](../dsh-plugin-mimo-escalator/) (reactive Flash→Pro tiering) and [`dsh-plugin-mimo-relay`](../dsh-plugin-mimo-relay/) (Planner→Builder→Verifier).

## What it does

| Capability | Mechanism | Why it makes reasoning stronger |
|---|---|---|
| **Proactive thinking boost** | `agent/inbox/inserted` fires *before* step preparation → the plugin scores the prompt and calls `agent.model.select({reasoningEffort})` | Hard prompts get `high` thinking on the very first request instead of escalating only after failures |
| **Work re-assertion** | `tools/result` + the escalator's discovery/work split | An active boost survives the escalator's thinking-off-on-discovery dips, but discovery reads still save tokens |
| **`mimo_think` tool** | `subagents.startActivation` (proven relay pattern): a `thinker` preset child pinned to `mimo-v2.6-pro` @ `high`, read-only, structured output | Deep, grounded analysis on demand: design decisions, root-cause, trade-offs — with `{analysis, answer, confidence, risks}` enforced by the spawn backend |
| **`mthink_status` tool** | Per-workspace `mimo-think-state.json` metrics | Boost counters, think pass/fail history, store diagnostics |

### Division of labor (no overlap with the escalator, by design)

- **Escalator = reactive, owns the model tier**: 2 failed verification rounds → Pro, hysteresis back to Flash, plus thinking-off-on-discovery.
- **Think = predictive, owns the effort level of the current model**: it never switches models, never touches a selection it did not create, and never counts verification rounds. A release that finds a foreign model (manual `/model`, escalator transition) forgets quietly instead of stomping it.

## Configuration (`cordis.patch.yml`)

| Field | Default | Meaning |
|---|---|---|
| `thinkModel` | `mimo-v2.6-pro` | tier the `mimo_think` child runs on |
| `thinkReasoningEffort` | `high` | effort of the thinking child |
| `boostEffort` | `high` | effort applied to the session on a hard prompt |
| `boostThreshold` | `4` | prompt score at which the boost activates |
| `releaseThreshold` | `1` | score at or below which a release is allowed (must be < boostThreshold) |
| `boostTtlMinutes` | `30` | a trivial release additionally requires this long since the last hard prompt |
| `boostPresets` | `main` | `main` = only default sessions boost; `all` includes preset children |
| `statePath` | `mimo-think-state.json` | per-workspace metrics file (gitignored); `''` disables persistence |
| `stateTtlHours` | `72` | prune idle metric entries |
| `thinkTimeoutMs` | `600000` | per-attempt deadline for the thinking child |
| `thinkRetries` | `1` | recovery retries (quota cool-off + recovery prompt) |
| `thinkReadOnly` | `true` | fail-soft tool scoping of thinker children |

### Prompt scoring signals

Length ladder (3/2/1 by word count) + weighted patterns: **design/architecture** (+2), **debug/root-cause** (+2), **analysis/trade-offs/optimization** (+2), **security** (+2), **code fences** (+2), **why/explain** (+1), **failure words** (+1), **file references** (+1), **numbered steps** (+1), **multi-question** (+1), **3+ bullets** (+1), and **constraint words** (capped at +2). Trivial prompts ("hi", "thanks", "ok") score 0.

## Interplay rules (tested)

1. **Hysteresis** — boost at ≥ 4, release at ≤ 1, nothing in between.
2. **TTL** — a trivial message inside `boostTtlMinutes` of the last hard message keeps the boost ("continue" mid-task does not drop thinking).
3. **Never downgrade** — an unknown/higher effort level is left alone.
4. **Never stomp** — restore only applies while the selection is still the one the boost created.
5. **Recursion guards** — one think pass per process (`busy`), thinker children are denied `mimo_think`/`mimo_relay`, and the prompt forbids spawning.

## Tools

```text
mimo_think({ question, context?, focus? })
  -> { ok, reason, result: { analysis, answer, confidence, risks } | null,
       attempts, model, durationMs }

mthink_status()
  -> { sessionId, stateKey, role, model, boost, metrics, storePath,
       persistence, diagnostics, config }
```


## Eval gate (v0.2) — the scorer is measured, not guessed

The thresholds this plugin ships (boost 4 / release 1 / TTL 30m) are pinned by a measured claim: an **87-example golden set** labeled by two independent *blind* passes plus one blind adjudication pass (labelers never see the scorer or outcomes), a cost-weighted confusion matrix priced by [eval/costs.json](eval/costs.json), and **11 label-derived policy sequences** run through the real `BoostPolicy` with an injected clock. Current baseline: **meanCost 1.2644 RCU, 11/11 sequences green** ([eval/baseline.json](eval/baseline.json)).

```bash
node eval/run.mjs                          # full report (signal breakdown first); exit 0 = gate green
node eval/run.mjs --record --rationale "…"  # after an intentional change (δ-guarded, refuses regressions)
```

CI runs the gate on every push, uploads the JSON artifact, and on PRs enforces append-only golden-set growth against the base branch. Fail-closed: missing/corrupt eval inputs exit 2. Headline finding so far: **fresh-context recall is the weak spot** — 20 of 35 hard prompts score below the bar (single strong signal = 2–3 < 4) and the colloquial real-world request `p-081` scores 0 — a measured, gated fact instead of a guess. Design contract: [eval/DESIGN.md](eval/DESIGN.md) · usage: [eval/README.md](eval/README.md).
## Install & verify

```bash
./install.sh                     # registers the bundle with the profile
./verify.sh                      # must print 11x PASS and exit 0
cd dsh-plugin-mimo-think && npm test   # 71/71, exit 0 (zero dependencies)
```

## Design notes (extension points verified in the DSH source)

- `agent/inbox/inserted` (`packages/core/agent` runtime-types): a fresh user message *before* claim/pre-step/step preparation — so `agent.model.select()` still governs the upcoming request (`agent/request` is deprecated for effort changes and rejects late proposals).
- `tools/result` + `agent.model.select()`: the escalator's own pair, reused for re-assertion between steps.
- `subagents.startActivation` (`packages/subagent/subagent`): `delivery: 'caller'`, `agentPreset`, `agentOptions`, `outputSchema` — the relay's proven spawn contract; `stopReason === 'completed'` + `structured` validated in `src/think.js`.
- `tools.restrict({deny})` **throws on unknown names** (`packages/core/tools/src/index.ts`), so scoping goes through `restrictWithFallback` (src/scoping.js): parse the unknown names, drop them, retry once — one stale name costs a schema, not the whole scoping pass.
- The `thinker` preset mirrors the relay presets: it declares its own read-only `tool-fs`/`tool-fs-search`, so the child grounds in files without a shell or writers.

## Layout

| Path | Purpose |
|---|---|
| `src/score.js` | prompt scoring, message text extraction, discovery/work classification |
| `src/boost.js` | `BoostPolicy` — pure hysteresis + TTL decisions (clock-injectable) |
| `src/think.js` | prompts, handoff contract, `runThink` retry/timeout orchestration |
| `src/store.js` | per-workspace metrics persistence (corrupt-safe, TTL-pruned, capped) |
| `src/scoping.js` | fail-soft `restrict()` wrapper |
| `src/index.js` | plugin glue: config schema, hooks, `mimo_think`, `mthink_status` |
| `test/` | 71 `node --test` cases (plugin + eval harness), zero dependencies |
| `eval/` | Scored eval harness: 87-example blind-labeled golden set, RCU costs, pinned baseline, CI gate · `node eval/run.mjs` |
