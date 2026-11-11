#!/usr/bin/env bash
# Phase 0 check: one headless turn on the Pro login, with the watch prompt and
# web search, reporting time to first text and total time.
# Usage (as claudeserv): ~/claudeServ/smoke.sh "what's the weather in Hyderabad today?"
set -euo pipefail
cd /srv/claudeserv/work
prompt="${1:-In one sentence, what are you?}"
start=$(date +%s%3N)
first=""
claude -p "$prompt" \
  --system-prompt-file /srv/claudeserv/claudeServ/watch.md \
  --tools "WebSearch" --allowedTools "WebSearch" --disallowedTools "WebFetch" \
  --strict-mcp-config --setting-sources "" --model sonnet \
  --no-session-persistence \
  --output-format stream-json --verbose --include-partial-messages < /dev/null |
while IFS= read -r line; do
  case "$line" in
    *'"text_delta"'*)
      if [ -z "$first" ]; then first=1; echo "[first text after $(( $(date +%s%3N) - start )) ms]" >&2; fi
      printf '%s' "$(jq -rj '.event.delta.text' <<<"$line")" ;;
    *'"type":"result"'*)
      echo; jq -r '"[done in \(.duration_ms) ms, api \(.duration_api_ms) ms, is_error=\(.is_error), turns=\(.num_turns)]"' <<<"$line" >&2 ;;
  esac
done
