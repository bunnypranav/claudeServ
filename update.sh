#!/usr/bin/env bash
# Runs on Nest, as root, inside the clone at /srv/claudeserv/claudeServ:
# pull the latest commit, install production deps, restart the service, check it.
# The clone is owned by root (root holds the GitHub key); the service user only reads it.
set -euo pipefail
cd "$(dirname "$(readlink -f "$0")")"
git pull --ff-only
npm ci --omit=dev --no-audit --no-fund --silent
if ! cmp -s claudeserv.service /etc/systemd/system/claudeserv.service; then
  install -m 644 claudeserv.service /etc/systemd/system/claudeserv.service
  systemctl daemon-reload
  systemctl enable --quiet claudeserv
fi
systemctl restart claudeserv
sleep 2
echo "commit:  $(git log --oneline -1)"
echo "service: $(systemctl is-active claudeserv)"
curl -s http://127.0.0.1:8787/health; echo
