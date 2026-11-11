# claudeServ

A small relay that lets thin clients (the Wear OS watch app, the car app, and
soon an Alexa skill) talk to Claude through the official Claude Code CLI,
signed in with a Claude Pro account. It runs on Hack Club Nest as the systemd
service `claudeserv` and is published at `claude.bunnyorg.in` through the
Cloudflare tunnel `nest` (`claude.bunnyorg.in` -> `http://localhost:8787`).

Each chat is one long-lived `claude -p` process speaking stream-json. Clients
connect over a WebSocket at `/ws` with `Authorization: Bearer <token>`; the
token decides which profile (system prompt, working directory) they get. The
protocol is described at the top of `src/server.ts`, the protections in
`src/guard.ts`.

## Layout on Nest

| Thing | Where |
|---|---|
| Service | `claudeserv.service`, user and group `claudeserv` |
| Code | `/srv/claudeserv/claudeServ` (a clone of this repo, owned by root) |
| Env file | `/srv/claudeserv/claudeserv.env` (`root:claudeserv`, mode 640, not in git) |
| Claude login and binary | `/srv/claudeserv/.claude`, `/srv/claudeserv/.local/bin/claude` |
| Chat working dirs | `/srv/claudeserv/work`, `/srv/claudeserv/work-car` |
| Listens on | `127.0.0.1:8787`, reached from outside only through `cloudflared` |

## Environment variables

| Variable | Default | Meaning |
|---|---|---|
| `RELAY_TOKEN` | required | Watch client's bearer token (at least 32 characters) |
| `RELAY_TOKEN_CAR` | unset | Car client's token; the car profile exists only when this is set |
| `DEFAULT_MODEL` | `sonnet` | `haiku`, `sonnet` or `opus` |
| `IDLE_MINUTES` / `CAR_IDLE_MINUTES` | `10` / `5` | Stop a chat's process after this long without a turn |
| `MAX_LIVE` | `2` | Most `claude` processes running at once |
| `MAX_TURNS_PER_HOUR` | `60` | Hourly cap on turns across all clients |
| `RELAY_HOST` / `RELAY_PORT` | `127.0.0.1` / `8787` | Listen address |
| `CLAUDE_BIN` | `~/.local/bin/claude` | Claude Code binary |
| `CLAUDE_PROMPT_FILE` / `CAR_PROMPT_FILE` | `watch.md` / `car.md` | System prompts |
| `CLAUDE_WORKDIR` / `CAR_WORKDIR` | `/srv/claudeserv/work` / `/srv/claudeserv/work-car` | Empty directories the chats run in |
| `ALEXA_SKILL_ID` | unset | Enables `POST /alexa`; requests for any other skill get 400 |
| `ALEXA_USER_IDS` | empty | Comma-separated `amzn1.ask.account.…` ids allowed to use the skill. While empty, the relay logs each caller's id once so it can be copied here |

Generate a token with `openssl rand -hex 32`.

## Deploy

Commit and push, then on Nest run `/srv/claudeserv/claudeServ/update.sh`
(`git pull`, `npm ci`, restart, health check). From the laptop, `./deploy.sh`
does the same over one SSH connection. Use SSH remotes only
(`git@github.com:bunnypranav/claudeServ.git`).

Every restart drops the clients' sockets; they reconnect on their own.

## Test

```
RELAY_TOKEN=... node client.mjs --url wss://<host>/ws "ask:what is 2+2" "ask:and doubled?"
```

`client.mjs` has no dependencies; see its header for the other steps (cancel,
drop and resume). `smoke.sh` runs one headless turn on Nest and reports timings.
`npm run check` type-checks the sources (Node runs the `.ts` files directly).

## Alexa skill

The custom skill "My Claude" (invocation name "my claude", locale `en-IN`) stays
in the Development stage and is never published. Its manifest is
`skill/skill.json`; the endpoint is `https://claude.bunnyorg.in/alexa` with the
wildcard certificate type (the Cloudflare edge cert covers `*.bunnyorg.in`).

Skill ID: `amzn1.ask.skill.f938a639-6ee2-4f52-99dd-790466416012`

Update the manifest with the ASK CLI (`npm i -g ask-cli`, `ask configure`):

```
ask smapi update-skill-manifest --skill-id <id> --stage development --manifest file:skill/skill.json
```
