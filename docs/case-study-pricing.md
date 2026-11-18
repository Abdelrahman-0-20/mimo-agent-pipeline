# Case study — the pipeline on a real project (v0.7 material)

**Date:** 2026-11-18 · **Target:** `Real-Time Dynamic Pricing & Market Intelligence Engine` (private repo, `~/Desktop`) · **Verdict: PASS** — the pipeline reviewed, fixed, self-verified, and caught its own defect on a mature third-party codebase.

> Status: v0.7 (public launch) is **deliberately deferred** — the user asked for a test first. This document is the launch material's core; the repo stays private until approved.

## 1. The target

A mature Python/ Rust project: 189 tests (5 env-gated), 10 ADRs, 5 JSON-Schema contracts, hexagonal import-linter rules, a p99 latency gate (0.809 ms), an HTTP Pricing API, and a Tauri operator console. Its own gates — not ours — were the acceptance criteria.

## 2. Review findings (cheap probes, before any relay)

| Entry point | Result |
|---|---|
| `pytest -q` | ✅ 189 passed, 5 skipped (8.6 s) |
| `./pricingctl status` / `price explain` | ✅ rich, correct output |
| `python3 benchmarks/latency.py` | ✅ PASS p99 0.809 ms ≤ 50 ms |
| `python3 -m pricing.training.train` | ✅ regret 0.34% |
| console: esbuild + `cargo check` | ✅ 8.7 kb bundle; cargo 0.64 s (warm) |
| **`docker compose up -d`** | ❌ **no compose plugin and no legacy binary** → the flip-on stack can never start |
| **README Quickstart** | ❌ uses `python` — this box only has `python3` → fails at step 1 |
| HTTP API | ⚠️ fail-closed `RuntimeError` without `PRICING_API_KEY` (by design; `PRICING_API_DEV=1` works — `/health` 200) but the Quickstart never mentions it |

The code was healthy; the breakage was **launch friction** — exactly what a fresh user hits.

## 3. Relay run 1 — build green, verification caught a real defect

- **Planner** (Pro/high, read-only): surveyed README, ADRs, contracts, CI, import-linter; emitted `{files: [README.md]}` + a 28-command testPlan (grep assertions for every fix, AST parse, lint-imports, exact baseline `189 passed, 5 skipped`, and a git-scope assertion that only README may change).
- **Builder** (Flash, writer lock): `status: pass` — `python3` everywhere (plus `fastapi uvicorn wsproto` added to the pip line), the fail-closed API block verbatim from `docs/API.md`, and a Troubleshooting section (`docker-compose-plugin`, flip-on env vars). Full testPlan exit 0.
- **Verifier** (read-only, browser lock): **`defects: [1]`** — three pre-existing `165`-test claims (badge, measured-results row, repo map) now *contradicted* the newly added `189 passed, 5 skipped` baseline in the same file. Honest, precise, actionable.

The relay correctly returned `ok: false` at the verify phase with locks released. **The gate caught what a human skimming the diff would likely have missed.**

## 4. Relay run 2 — iterate to green

Task = the verifier's defect. Planner emitted a tight testPlan (`! grep -q '165' README.md`, exact baseline greps, pytest, lint-imports, compileall, `git diff --name-only HEAD` = README only). Builder fixed all three claims (badge → `tests-189_passed,_5_skipped`; measured row → `189 passed, 5 skipped (194 total…)` with the 0-skipped figure honestly marked broker-dependent; repo map → `194 tests`). **Verifier: `defects: []` → `ok: true, phase: done`.**

Nothing was committed in either run — the diff sits uncommitted for human review, per contract.

## 5. Pipeline metrics captured

- **Tool-schema cut (per-role scoping), target workspace:** planner **43**, builder **9** (−89% vs the unsscoped 85), verifier **32** — zero noise leaked; `structured_output` present in all three.
- **Effort policy (thinking-off-on-discovery) on the children:** `off: 8 / on: 8` with **usage-backed** samples. Cache-read *grew* across toggles (13,056 → 26,624 tokens) — in this sample, effort toggling did **not** collapse the prompt cache. This is the "measure before trusting the savings" data the v0.6 lever promised.
- **Timings:** run 1 ≈ 15 min total (plan dominated: Pro/high synthesis steps of 64–128–241 s on a larger repo), run 2 ≈ 11 min. Phase timeout raised 10 → 20 min (tool cap 60 min) after run 1's plan phase hit 600 s — the timeout machinery aborted the child cleanly (`stopReason aborted: parent`) and released every lock.
- **Verification rounds:** testPlans are `&&`-chains whose *final* segment is a scope assertion, so the conservative last-segment rule counted no rounds (by design: it never misattributes a masked exit code; `&&`-chains remain failure-propagating).

## 6. Environment incident fixed en route (v0.7 hardening)

After the user's 12:46 host restart, both plugins showed `fiberPhase: active` with **no tools registered** — `apply()` had run before the `tools` service resolved (cold-boot fiber race; manual remounts in a settled host had masked it). Fix: `export const inject = ['tools']` in both plugins (the documented activation edge) plus lazy `ctx.get(...)` at use sites instead of apply-time captures. Tools restored immediately; **cold-boot survival is now by construction — confirm on the next `dsh web` restart.**

## 7. Honest limitations observed

- Child sessions' **storage** groups under the parent workspace (header `cwd`) while the child's *effective* cwd honors the passed path — cosmetic, but session browsers will show relay children under the pipeline workspace.
- The escalator state file landed **untracked** in the target repo (`mimo-escalator-state.json`) — evidence left in place; gitignore or delete after review.
- The last-segment verification rule undercounts `&&`-chained testPlans (conservative miss, never a false pass).

## 8. What's next (v0.7, pending approval)

With this study as the centerpiece: final secret scan → optional demo GIF (memory recall + one relay run) → GitHub profile README → **then** decide on going public. Nothing has been published.
