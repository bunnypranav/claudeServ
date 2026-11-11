#!/usr/bin/env bash
# Deploy = commit and push, then have Nest pull and restart.
#   on the laptop:  ./deploy.sh
#   on Nest:        ./update.sh
# One SSH connection only: Nest tends to drop a second one opened right after the first.
set -euo pipefail
HOST="${NEST_HOST:-bunnypranav@hackclub.app}"
if [ -n "$(git status --porcelain)" ] || [ -n "$(git log origin/main..HEAD --oneline 2>/dev/null)" ]; then
  echo "commit and push first: Nest deploys what is on GitHub" >&2
  exit 1
fi
ssh "$HOST" 'bash /srv/claudeserv/claudeServ/update.sh'
