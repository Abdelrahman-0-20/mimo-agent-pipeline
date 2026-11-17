#!/usr/bin/env bash
# mimo-agent-pipeline installer — plugins + pinned memory MCP server
set -euo pipefail

PROFILE="${DSH_PROFILE:-web}"
REG="https://registry.npmjs.org/"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

log()  { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL:\033[0m %s\n' "$*" >&2; exit 1; }

# locate the dsh CLI: PATH, then DSH_CLI override
if command -v dsh >/dev/null 2>&1; then DSH_BIN=dsh
elif [ -n "${DSH_CLI:-}" ]; then DSH_BIN="$DSH_CLI"
else fail "dsh not found on PATH — install DeepSeek Harness or export DSH_CLI=/path/to/dsh"
fi

log "Installing plugins into profile '$PROFILE'"
"$DSH_BIN" plugin --profile "$PROFILE" add @michengai/dsh-agency-agents@latest --registry="$REG"
"$DSH_BIN" plugin --profile "$PROFILE" add @michengai/dsh-code-review@latest  --registry="$REG"
"$DSH_BIN" plugin --profile "$PROFILE" add @michengai/dsh-simplify@latest     --registry="$REG"

log "Installing local escalator bundle (dsh-plugin-mimo-escalator)"
"$DSH_BIN" plugin --profile "$PROFILE" add "$SCRIPT_DIR/dsh-plugin-mimo-escalator"

log "Installing pinned memory MCP server (@modelcontextprotocol/server-memory@2026.7.4)"
npm install -g @modelcontextprotocol/server-memory@2026.7.4

log "Next steps:"
cat <<'EOF'
  1. Merge config/cordis.patch.yml.example into $DSH_HOME/profiles/<profile>/cordis.patch.yml
  2. Export MIMO_API_KEY (direct route) and GITHUB_TOKEN (GitHub MCP) on the host
  3. Run ./verify.sh   — must exit 0
  4. Restart dsh web, hard-refresh the browser
EOF
