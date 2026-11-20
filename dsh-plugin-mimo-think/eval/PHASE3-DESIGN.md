# 🎯 Phase 3 — Confidence Loop (v0.2b) — DESIGN DRAFT, AWAITING APPROVAL

> **Status: DRAFT. No code written.** Build starts only on explicit approval (same flow as Phase 1 → 2).
> Handoff conditions from Appendix C are all met: gate green in CI (run 44730279731) · baseline recorded (meanCost 1.2644) · this design adds its own append-only slice.
> Inputs available: the measured scorer (baseline), the 87-example golden set, and the running **effort A/B** (flash × off/low/medium/high × 13 tasks) which prices the effort tiers this loop moves between.

## 1. 🎓 The idea (first principles)

The v1 scorer makes a **binary** decision (boost / hold / release) from one integer score. But the score carries more information than the binary: **distance from the decision boundary is confidence**. A prompt scoring 9 is unambiguously hard; a prompt scoring exactly 4 just crossed the line — we are guessing. The measured v1 data shows this matters: the single false boost (`p-062`) scored **exactly 4**, and the misses cluster at 2–3 (just below).

The loop (this is why it is a *loop* and not a flag):

1. **Decide tentatively** — a boundary boost (score within `confidenceMargin` of the threshold) activates at a *cheaper* effort level instead of full `high`.
2. **Observe real behavior** — while the boost is live, **work tool results** (edits, tests, bash) are evidence the task is real; discovery reads are not.
3. **Confirm or let go** — after `confirmWorkSteps` work results, escalate to full `high`. A trivial prompt after the TTL releases as before. On the release side, a boundary-easy prompt (score exactly at `releaseThreshold`) **holds** instead of releasing: a wrong release mid-task costs 12 RCU, a held boost costs at most one TTL of medium effort.

Crucially: **no model calls, no labels from outcomes, no threshold changes.** The confidence value is computed deterministically from the same score — the loop's only new input is observed tool activity, which is exactly the evidence type the escalator already treats as real (verification rounds). The selective-labels trap stays avoided: tool activity never becomes a *label*, only a within-session state transition.

## 2. 🔍 Red team (what could break)

| Risk | Mitigation |
|---|---|
| Medium boosts quietly weaken the measured policy (an unmeasured second policy — the thing we swore not to stack) | The **v1 gated metric is untouched** (cells are still boost/none/restore — effort tiers do not enter `costModel`), so the baseline stays comparable; the loop is gated by **new behavioral sequences** (exact, zero-tolerance) plus a *diagnostic* tier-cost report. Primary tier pricing becomes possible only after the effort A/B lands real token deltas → then `costs.json` gains provisional tier factors with provenance, same protocol as v1 |
| Escalator interplay: discovery-off lowers effort under us; re-assert must not blindly re-assert `high` over a deliberate `medium` | Re-assert restores **the policy's current tier** (medium until confirmed, high after), never a fixed value; discovery results still never re-assert |
| Escalator tier change (model switch) mid-boost | The existing model-change **forget** path clears policy state including tier/confirm counters — no stomp, no stale tier |
| Boundary flapping (score 4/5 messages toggling tiers) | Tier moves only two ways: medium → high (monotone confirm counter per boost) and → none (release/forget). No high → downgrades within one boost; the counter resets only on a new boost or restore |
| Release-side hold keeps a wrong boost alive longer | Hold applies only when score == `releaseThreshold` (boundary); score 0 still releases after TTL; TTL cap unchanged; the tier-cost diagnostic reports held-boost exposure |
| Existing gate breaks (behavior changed → fingerprint stale) | Expected and by design: `boost.js`/`index.js` edits make the baseline stale → `--record --rationale` with δ-guard; per-id v1 costs are unchanged (by the metric's construction), so the δ comparison is apples-to-apples |
| Config drift | New keys validated by the existing schema (ranges + unknown-key rejection); `confidenceMargin: 0` is the exact-v1 kill switch (boundary band empty → identical behavior, covered by an equivalence test) |

**Forbidden this phase:** threshold changes · pattern changes · label changes · outcome-derived labels · model calls in the loop · touching escalator or relay · tier weights in the gated metric before the A/B data exists.

## 3. 🗺️ Design

### Policy (src/boost.js)

- New per-boost state: `tier: 'medium' | 'high'`, `workStreak: number` (confirmation counter).
- `confidenceOf(score, th, margin)`: boost side — `'high'` if score ≥ th.boostThreshold + margin, `'boundary'` if within [threshold, threshold+margin); release side — score < th.releaseThreshold → high, == threshold → boundary.
- Boost decision gains `effort`: boundary → `lowConfidenceEffort` (default `medium`), high confidence → `boostEffort` (`high`). `first` semantics unchanged (metrics count transitions, not tiers).
- Work-tool observation while active at medium: `workStreak++`; at `confirmWorkSteps` (default 2) → decision `{action:'boost', effort:'high', confirm:true}` (select high; not counted as a new boost in metrics). Discovery → no counter.
- Release: boundary score → no decision (hold). High confidence (score below threshold) → `restore` as today.
- `stateOf()` gains `tier` and `workStreak` (the status tool shows them).

### Application (src/index.js)

- `applyDecision` selects `decision.effort ?? config.boostEffort` for boosts; the confirm path selects `boostEffort`.
- Everything else (model-change forget, persistence, scoping, metrics) unchanged.

### Config

| Key | Default | Meaning |
|---|---|---|
| `confidenceMargin` | `2` | score points above the threshold that count as "boundary" (0 disables the loop → exact v1 behavior) |
| `lowConfidenceEffort` | `medium` | effort for a boundary boost |
| `confirmWorkSteps` | `2` | work results needed to escalate medium → high |

### Eval (append-only, per Appendix C condition 3)

- `runSequence` gains optional per-step `expectEffort` (asserts the effort *after* the step; absent = action-only, so **all 11 existing sequences stay valid unchanged**).
- **New sequences (appended, ids `seq-confidence-*`):**
  1. boundary hard (score 4–5, e.g. `p-005`) → `['boost']` + `expectEffort 'medium'`
  2. same + 2 work tools → effort `'high'` (confirmation); a following discovery tool stays `'high'`
  3. boundary-easy (score == releaseThreshold) after TTL → `['none']` (hold); a score-0 easy after TTL → `['restore']`
  4. high-confidence hard (≥ threshold+margin) → `['boost']` + `expectEffort 'high'` (v1 equivalence check)
- Diagnostic (never gates): **tier-cost report** with provisional factors (`medium = 0.4 × high` pending the effort A/B), labeled PROVISIONAL with the re-derivation trigger pointing at `benchmark/results-effort.json`.
- Golden set: **sequences only** — no new prompts needed (boundary examples already exist: `p-005`=4, `p-062`=4, `p-064`=3). Hash changes → `--record --rationale`.

### Tests

BoostPolicy: boundary vs high confidence, confirm streak (2 work → high; discovery ignored; counter resets on restore), release hold at boundary, margin 0 ≡ v1 equivalence, model-change clears tier. run.mjs: `expectEffort` pass/fail + old sequences unaffected. All existing 71 tests stay green (decision shape is additive).

## 4. 🧪 Validation

1. `npm test` (think suite grows; all prior green) · sibling suites · `./verify.sh` 11 PASS · js-yaml · secret scan.
2. Gate: `node eval/run.mjs` green (old + new sequences) → `--record --rationale "phase 3 confidence loop: tiered boost, work-confirmation, boundary-hold"` → δ-guard proves per-id v1 costs unchanged.
3. Mutation demos (temp files only): margin 0 vs 1 behavior; `confirmWorkSteps` mis-set → sequence violation caught; `expectEffort` mismatch → exit 1.
4. CI green after push (Phase 3's definition of done).

## 5. 🔄 Rollback

`git revert` of the phase removes policy + sequences + config together (the gate returns to the recorded v1 baseline, which still verifies because baseline + golden set revert in the same commit range). `confidenceMargin: 0` is the in-place kill switch: exact v1 behavior, gate stays green (documented equivalence test).

---

*Approve (or amend) to start the build. The effort A/B results feed only the *diagnostic* tier factors — they do not block this design.*
