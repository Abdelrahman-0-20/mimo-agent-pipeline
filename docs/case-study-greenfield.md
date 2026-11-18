# Case study — the pipeline builds an MLOps project from zero (v1.0)

**Date:** 2026-11-18 · **Target:** `breast-cancer-mlops` (new local repo, `~/Desktop`) · **Verdict: PASS** — from an empty directory to a committed, gated, documented MLOps project in four milestones, every phase independently verified.

> This is the second half of the v1.0 proof: [the pricing case study](case-study-pricing.md) showed the pipeline *reviewing and fixing* a mature codebase; this one shows it *building one from nothing*. Both ran on the same session — per-role escalator keys kept the workspaces' state separate, effort toggles followed every child, and the relay's contract caught real mistakes both times.

## 1. The charter (M0 — human spec, relay build)

An empty git repo plus [its README](https://github.com/Abdelrahman-0-20/breast-cancer-mlops): 10 requirements (seed-42 data layer, training with byte-identical determinism, model registry with sha256 provenance, a holdout evaluation gate, PSI drift monitoring with an exit-0/exit-3 auto-retrain API, unified CLI, ≥30 tests, CI, two ADRs), one gate script (`./verify.sh`), and three milestones. No code — the relay supplies all of it. Dataset: sklearn's built-in breast-cancer data (zero network by construction).

## 2. Milestones — each one relay run, each one commit

| Milestone | Scope | Tests | Commit |
|---|---|---|---|
| M1 | data + training + registry | **70** | `40b69fa` |
| M2 | evaluate gate + drift + auto-retrain | **117** (70+47) | `864f9eb` |
| M3 | unified CLI + CI workflow + README + 2 ADRs | **133** (charter wanted ≥130) | `249fb1a` |

Every milestone ended with `./verify.sh` exit 0, a passing independent verification (`defects: []`), and a clean tree. The M2 verifier independently re-ran the entire exit-code API (evaluate 0/1, drift clean/perturbed, retrain 0/3) in a scratch directory; the M3 verifier cross-checked every ADR number against `config.py` and pinned the HEAD hash.

## 3. The three interruptions (all caught by the process, all honest)

1. **API quota killed M1's first builder mid-flight** (`429 quota exhausted` at step 10, after real work: 4 writes + 4 edits). The continuation relay inspected the partials against the charter, found them correct, wrote the missing 70-test suite, and committed. *Evidence: the case study records quota as an operational dependency, not a code failure.*
2. **M2's first build hit the 20-minute phase timeout** — the log showed three ~5-minute single-step stalls from quota-retry backoffs (278 s / 353 s / 285 s). Fixed structurally: phase budget raised 20 → 30 min; the continuation finished all 47 M2 tests inside the new budget.
3. **M3's builder committed everything correctly but sent `status: ""`** in its handoff — the contract rejected the handoff and the verify phase *refused to run on an unclean signal*. A review-only continuation then verified all of M3 independently: `defects: []`. *The gate failed exactly where it should: on the protocol, not the work.*

## 4. Metrics captured (in the project's `mimo-escalator-state.json`)

- **Escalations: 0 / Demotions: 0** — every milestone passed first try (the two failures were infrastructure, not quality); the hysteresis machinery simply never needed to fire.
- **Effort policy (thinking-off-on-discovery):** planner `off/on = 9/9`, builder `8/8`, verifier `4/4` — 42 toggles, **42 samples**, `baselineKind: usage` for planner/verifier (real `cacheReadTokens` recorded, e.g. 9,984 → 11,456), one honest `estimated` sample for the builder.
- **Verification rounds:** verifier's testPlans counted **2 passing rounds** (its chains end in pytest — the last segment *is* verification); builders' chains end in scope assertions, so the conservative last-segment rule counted none (by design).
- **Tool-schema cuts held:** planner **43** · builder **9** · verifier **32** — identical to the pricing run, i.e. the scoping is stable across workspaces.
- **Timeline (commit anchors):** charter20:48 → M1 21:32 (44 min incl. the quota retry) → M2 22:48 (76 min incl. timeout + continuation) → M3 23:21 (33 min incl. contract rejection) → independent M3 verification 23:43. **≈3 hours end-to-end**, two of them blocked by real-world friction the pipeline surfaced rather than hid.

## 5. What the two studies together prove

| | Pricing repo (review-fix) | breast-cancer-mlops (greenfield) |
|---|---|---|
| Starting state | mature,189 tests, working code | empty directory |
| Pipeline's job | find what's broken, fix docs, keep gates green | build10 requirements →133 tests → commits |
| Verifier caught | stale counts contradicting the new baseline | a malformed handoff (`status: ""`) — protocol failure |
| Escalations fired | 0 | 0 (first-try green; infra failures ≠ quality failures) |
| Artifacts | uncommitted diff for human review | four-milestone commit history as evidence |

The thesis of mimo-agent-pipeline — *cheap-by-default routing, verification gates that refuse to lie, and a relay that plans, builds, and independently verifies* — now has both halves demonstrated on real work.

## 6. Honest limitations

- The builder/verify phases depend on the MiMo API quota; two of three interruptions were quota-related (the pipeline fails loudly and resumes cleanly, but it cannot out-run a depleted token plan).
- Handoff capture relies on the child calling `structured_output` with valid values; the empty-status incident shows the contract *rejects* bad captures but the fix is a re-run, not auto-repair.
- `&&`-chains whose final segment is a scope assertion are intentionally not counted as verification rounds (never a false pass, but the builder's real pytest runs go uncounted — a conservative miss).
- All timings include agent-interaction overhead of this session (diagnoses between runs), not just pure relay execution.
