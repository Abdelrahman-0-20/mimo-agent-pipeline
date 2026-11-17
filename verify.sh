#!/usr/bin/env bash
# verify.sh — exit-code-0 gate for the whole pipeline
set -uo pipefail

PROFILE="${DSH_PROFILE:-web}"
if command -v dsh >/dev/null 2>&1; then DSH_BIN=dsh
elif [ -n "${DSH_CLI:-}" ]; then DSH_BIN="$DSH_CLI"
else echo "FAIL: dsh not found on PATH (or set DSH_CLI)"; exit 1; fi

DUMP="$("$DSH_BIN" --profile "$PROFILE" --dump-config 2>/dev/null)" || { echo "FAIL: dsh --dump-config errored"; exit 1; }

pass=0; failed=0
check() { # $1=grep pattern  $2=human label
  if grep -q "$1" <<<"$DUMP"; then echo "PASS  $2"; pass=$((pass+1));
  else echo "FAIL  $2"; failed=$((failed+1)); fi
}

check "agency-agents"         "Agency Agents plugin (331 experts)"
check "michengai-code-review" "/review independent code review"
check "michengai-simplify"    "/simplify git-scoped cleanup"
check "xiaomi-mimo"           "MiMo direct route (Pro/Flash + reasoning levels)"
check "serverName: memory"    "MCP memory server"
check "serverName: github"    "MCP github server"
check "serverName: playwright" "MCP playwright server"

echo "----"
echo "$pass passed, $failed failed"
[ "$failed" -eq 0 ] || exit 1
exit 0
