---
name: 'dsh-plugin-authoring'
description: 'Build DeepSeek Harness plugins the way mimo-escalator, mimo-relay and mimo-think were built: bundle manifest + cordis patch anatomy, inject/Config/apply, the verified extension points (inbox/inserted, tools/result, startActivation, restrict-throws), fail-soft scoping, test conventions, and the integration gate checklist.'
whenToUse: 'A task creates or modifies a DSH plugin (dsh-plugin-*), a cordis.patch.yml row, an agent preset, or needs a DSH extension point (hooks, tool registration, subagent spawning, model/effort selection).'
---

# dsh-plugin-authoring

You are writing a plugin for DeepSeek Harness (Cordis fibers). Three production plugins in this repo are the reference implementations: `dsh-plugin-mimo-escalator` (reactive model tiering), `dsh-plugin-mimo-relay` (three-role subagent relay), `dsh-plugin-mimo-think` (predictive effort boost + deep-reasoning tool). Follow their anatomy; every rule below was paid for with a real failure.

## 1. Plugin anatomy

| File | Rules |
|---|---|
| `package.json` | `"type": "module"`, zero runtime deps, `"test": "node --test test/*.test.js"`, engines node >=22, and the manifest: `"dsh": { "manifestVersion": 1, "bundle": { "patch": "./cordis.patch.yml" } }` |
| `cordis.patch.yml` | **Top-level YAML array** (no `plugins:` key): `- insert:` rows. Plain values + `!!js <expr>` only — never a secret, only names/thresholds/env-var *names* |
| `src/index.js` | Thin glue: `export const inject = ['tools']`, hand-rolled `export const Config` (synchronous Standard Schema — zero-dep because a profile-linked bundle resolves imports from the checkout), `export function apply(ctx, config)` |
| `src/*.js` | Pure modules (state/policy/orchestrator/store/scoping) with injected clock and spawner — this is where tests live |
| `test/*.test.js` | `node --test`, zero deps, fixture-based, injected clocks; index.js glue is intentionally untested (mirror the siblings) |
| `locale/en.json` + `zh.json`, `icon.svg` | `meta.title` + `meta.description` only; simple SVG |

## 2. Config schema pattern

DEFAULTS object + `issue(path, message)` + typed field validators + **reject unknown keys** + cross-field checks (e.g. release < boost for hysteresis). Return `{ value }` or `{ issues }` from `Config['~standard'].validate`. Never throw for user config errors.

## 3. Verified extension points (timing is the whole game)

- **`agent/inbox/inserted`** — a fresh user message, **before claim/pre-step/step preparation** → the only safe place to `agent.model.select()` so the change governs the upcoming request. Payload: `{ agent, message }`; text lives in `message.content` blocks (`{type:'text', text}`).
- **`tools/result`** — post tool outcomes `{ exec, result }`. An observer must NEVER throw: wrap in try/catch + `console.warn` or you break notification for everyone.
- **`agent.model.select()`** — the ONLY sanctioned model/effort change. **`agent/request` is deprecated for this** and *throws* if a listener proposes a selection differing from the step-prepared one ("proposed ... after step preparation fixed ...").
- **`subagents.startActivation`** — spawn contract: `{ provider:'spawn', label, parent, prompt:[{type:'text',text}], signal, delivery:'caller', agentPreset, agentOptions:{model, provider?, reasoningEffort?}, outputSchema, cwd? }`. Success = `stopReason === 'completed'` + `structured` validated against outputSchema. Race each attempt against its own AbortController deadline and `activation.dispose()` on abort.
- **`agent/created`** — identify children via `ctx.get('agentPresets')?.presetForSession(agent.session)`. **`agentTools.restrict({deny})` THROWS on any unknown global name** (and on `run_code`) — one stale name must not unslice the child: use the parse-and-retry fail-soft wrapper (`dsh-plugin-mimo-think/src/scoping.js`). Restriction requires the *scoped* context: `agent.ctx.get('tools')`.
- **`ctx.get('tools').register`** — `{ name, description, parameters: <JSON Schema>, output: { schema, render }, timeoutMs?, execute(args, exec) }`; `exec.agent`, `exec.signal`.
- **Resolve services at call time, never capture at `apply`** (cold-boot fiber race): `subagents`, `workingDirectory`, `agentPresets`, `tokenMeter`. `inject = ['tools']` only orders the tools row.

## 4. Agent presets (bundle rows)

`@deepseek-ai/dsh-agent-preset` rows (`id/name/description/order/plugins`). Preset children get **no filesystem unless the preset declares it** — mount `@deepseek-ai/dsh-tool-fs` (`read:true, write:false, edit:false`) + `tool-fs-search` for read-only grounding, and `@deepseek-ai/dsh-persona` for the standing role. Host MCP servers ARE inherited — deny them per role (never deny a name your own preset mounts: the preset's scoped copy gets masked too).

## 5. Division of labor (never overlap siblings)

escalator = reactive **model tier** + verification rounds + thinking-off-on-discovery · think = predictive **effort on the current model**, never counts rounds, never touches a selection it did not create (forget quietly on model change) · relay = **three-role orchestration**. State files are per-workspace JSON (gitignored), TTL-pruned, corrupt-loads-as-empty; saves are explicit after mutation.

## 6. Integration gate checklist (every plugin)

1. `npm test` in the plugin (bare command, exit 0) **and** the sibling suites.
2. `cordis.patch.yml` parses: `npx js-yaml <file>` (sandbox: prefix `npm_config_cache=/tmp/npm-cache-dsh`).
3. `install.sh`: add a `dsh plugin add` step · `verify.sh`: add a `check` line (update the README's PASS count) · root README layout row · plugin README.
4. `.gitignore`: the runtime state file · `ci.yml`: js-yaml line + `npm test` step (check dsh/engines pins before touching: michengai plugins enforce `engines.dsh` fail-closed).
5. `skills/mimo-agent-pipeline/SKILL.md`: mention user-facing tools.
6. Full gates: `bash -n install.sh verify.sh`, js-yaml, secret scan, `./verify.sh` (needs `DSH_CLI=.verify-tools/dsh-local` — **/usr/bin/dsh on PATH is Dancer's shell, not the Harness**).
7. Persist non-obvious learnings to memory (mandatory).

## 7. Named failure modes (do not rediscover)

- PATH `dsh` = Dancer's shell → always `DSH_CLI` (source checkout wrapper).
- `tools.restrict` unknown-name throw → fail-soft retry (above).
- Late effort proposals via `agent/request` → rejected; use `select()` before step prep (inbox hook).
- Effort policies fight each other: if your plugin selects effort, coordinate with the escalator's discovery-off policy (re-assert on *work* results only, never on discovery) or they will thrash.
- Generated code: `String.raw` preserves backslashes (quadruple-backslash regex bug), `\${` escapes needed for \${{ }} GitHub expressions in JS templates.
- npm in this sandbox: EROFS on ~/.npm → `npm_config_cache=/tmp/...`.
