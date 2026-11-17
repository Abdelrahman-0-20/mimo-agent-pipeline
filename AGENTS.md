# AGENTS.md

## Mandatory Workflow
1. **Recall First:** Before modifying architecture or debugging recurring issues, query `mcp__memory__search_nodes` for prior decisions.
2. **Verify Before Done:** Never mark a task complete until you run the project's test suite, linter, and typechecker via shell and confirm exit code `0`.
3. **Persist Learnings:** Whenever you resolve a non-obvious bug or add a new dependency/schema, record an entity in `mcp__memory__create_entities`.

## Guardrails
- Never read, print, or commit `.env` files or API keys.
- Keep diffs minimal; do not refactor unrelated modules unless explicitly asked.
