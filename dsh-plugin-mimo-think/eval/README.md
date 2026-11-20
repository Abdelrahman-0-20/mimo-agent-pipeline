# mimo-think eval harness

Measures the prompt scorer (`src/score.js`) and the boost policy (`src/boost.js`) against a frozen, labeled golden set — and gates CI so thresholds, weights, the set, or the scorer cannot drift without a recorded, reviewed baseline. Design contract: [DESIGN.md](DESIGN.md).

## Quick start

```bash
node eval/run.mjs                    # human report (signal breakdown first)
node eval/run.mjs --json             # machine JSON on stdout, human report on stderr
node eval/run.mjs --help
```

| Exit | Meaning |
|---|---|
| `0` | gate passed (or baseline recorded) |
| `1` | regression / stale baseline / sequence violation / append-only breach |
| `2` | infrastructure error — the message names the cause **and** the fix |

## What a run does

1. **Signal breakdown** (always first — a diagnosable scorer, not a black box).
2. **Cost-weighted confusion** over both contexts: fresh session (`boost | none`) and boosted post-TTL (`restore | none | boost`), priced by [costs.json](costs.json) (RCU weights, PROVISIONAL with provenance; asymmetry floor enforced by test).
3. **Sequence simulation** — the label-derived message/tool streams run through the *real* `BoostPolicy` with an injected clock. Zero violations tolerated (hysteresis, TTL, re-assert, model-change-forget, adapter-default release).
4. **Worst offenders**, seeded bootstrap CI, weight sensitivity (diagnostics).
5. **Gate** against [baseline.json](baseline.json).

## Recording a baseline

```bash
node eval/run.mjs --record --rationale "why this change is intentional"
```

- Requires `--rationale` (stored in baseline.json as the audit trail).
- **δ guard:** cost over *previously-known* example ids may not regress by more than `delta` (0.05); appends are excluded, removals are refused.
- Refuses to record with any sequence violation or append-only breach.
- The baseline pins: golden-set hash, scorer fingerprint (`score.js` + `boost.js` bytes), thresholds, cost weights, protocol version. Any drift makes normal runs exit 1 until you consciously re-record.

## Adding examples (append-only)

1. Draft texts (never shown to labelers with ids that hint the answer, never with scores).
2. **Two independent blind passes** + a blind adjudication pass for disagreements — labelers see only texts and the rubric, never the scorer, never outcomes.
3. Assemble: additions only, ids immutable, recompute `provenance.hash`, update `composition`, append `signals_expected` (strong-signal prediction, diagnostic-only).
4. `node eval/run.mjs` green (sequences) → `--record --rationale "append N examples"` → commit set + baseline together.
5. CI enforces additions-only vs the base branch (needs `fetch-depth: 0`).

## Files

| File | Role |
|---|---|
| `golden_set.json` | frozen prompts + labels + sequences + provenance hash |
| `costs.json` | RCU weights, δ, provenance, re-derivation triggers |
| `baseline.json` | pinned measured state (the audit trail) |
| `run.mjs` | the harness (pure functions exported for `node --test`) |
| `DESIGN.md` | the approved design contract (5-part blueprint) |

## CI

The `plugin` job runs `node eval/run.mjs --json > eval-artifact.json` after the unit tests and uploads the artifact; on pull requests a second invocation adds `--append-only-ref` with the base ref. `eval/**` is covered by the repo-wide secret scan.
