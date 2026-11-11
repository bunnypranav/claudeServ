#!/usr/bin/env bash
# Runs on Nest (as root) after deploy.sh unpacks the relay into /srv/claudewatch/relay.
set -euo pipefail
cd /srv/claudewatch/relay
chown -R claudewatch:claudewatch .
su claudewatch -c "npm ci --omit=dev --no-audit --no-fund --silent"
chmod +x smoke.sh client.mjs

# first deploy only: generate the shared secret the watch will send
if [ ! -f /srv/claudewatch/relay.env ]; then
  (umask 077; echo "RELAY_TOKEN=$(openssl rand -hex 32)" > /srv/claudewatch/relay.env)
  echo "generated /srv/claudewatch/relay.env"
fi
# the car app (ClaudeCar) gets its own token, so either client can be revoked alone
if ! grep -q '^RELAY_TOKEN_CAR=' /srv/claudewatch/relay.env; then
  echo "RELAY_TOKEN_CAR=$(openssl rand -hex 32)" >> /srv/claudewatch/relay.env
  echo "added RELAY_TOKEN_CAR to /srv/claudewatch/relay.env"
fi
chown root:claudewatch /srv/claudewatch/relay.env
chmod 640 /srv/claudewatch/relay.env

# each client's chats live in their own (empty) working directory
install -d -o claudewatch -g claudewatch /srv/claudewatch/work /srv/claudewatch/work-car

install -m 644 claudewatch-relay.service /etc/systemd/system/claudewatch-relay.service
systemctl daemon-reload
systemctl enable --quiet claudewatch-relay
systemctl restart claudewatch-relay
sleep 2
echo "service: $(systemctl is-active claudewatch-relay)"
curl -s http://127.0.0.1:8787/health; echo
