#!/usr/bin/env bash
# Copy the relay to Nest, install production deps, (re)start the service.
# Run from the relay/ directory: ./deploy.sh
# One SSH connection only: Nest tends to drop a second one opened right after the first.
set -euo pipefail
HOST="${NEST_HOST:-bunnypranav@hackclub.app}"
DEST=/srv/claudewatch/relay

tar czf - package.json package-lock.json src watch.md car.md smoke.sh client.mjs claudewatch-relay.service remote-setup.sh |
  ssh "$HOST" "mkdir -p $DEST && tar xzf - --no-same-owner -C $DEST && bash $DEST/remote-setup.sh"
