# claudeServ

A small relay that lets thin clients (the Wear OS watch app, the car app, and
an Alexa skill) talk to Claude through the official Claude Code CLI,
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
| Chat working dirs | `/srv/claudeserv/work`, `/srv/claudeserv/work-car`, `/srv/claudeserv/work-alexa` (each owned by `claudeserv`) |
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
| `ALEXA_MODEL` | `haiku` | Model of a new Alexa chat ("use sonnet" switches mid-chat) |
| `ALEXA_PROMPT_FILE` | `alexa.md` | Voice system prompt |
| `ALEXA_WORKDIR` | `/srv/claudeserv/work-alexa` | Empty directory the Alexa chats run in |
| `ALEXA_IDLE_MINUTES` | `3` | Stop an Alexa chat's process after this long without a turn |
| `ALEXA_DEADLINE_MS` | `6500` | The response leaves this long after the request arrived (Alexa gives up at about 8 s) |
| `ALEXA_PROGRESSIVE_AFTER_MS` | `2000` | Say "One moment" if no text has arrived by then |
| `ALEXA_CHUNK_CHARS` | `900` | Most characters spoken in one response before "say continue" |
| `ALEXA_PICKUP_MINUTES` | `10` | How long an unheard answer can be picked up with "ask my cloud to continue" |

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

The custom skill "My Claude" (invocation name "my cloud", locale `en-IN`) stays
in the Development stage and is never published. Its manifest is
`skill/skill.json`; the endpoint is `https://claude.bunnyorg.in/alexa` with the
wildcard certificate type (the Cloudflare edge cert covers `*.bunnyorg.in`).

Skill ID: `amzn1.ask.skill.f938a639-6ee2-4f52-99dd-790466416012`

Update the manifest with the ASK CLI (`npm i -g ask-cli`, `ask configure`):

```
ask smapi update-skill-manifest --skill-id <id> --stage development --manifest file:skill/skill.json
```

The interaction model is generated: edit `skill/carriers.json`, run
`npm run model`, then upload it and wait for the build:

```
ask smapi set-interaction-model --skill-id <id> --stage development --locale en-IN --interaction-model file:skill/interaction-model.en-IN.json
ask smapi get-skill-status --skill-id <id>
```

How it behaves (`src/alexa/handler.ts`):

- Opening the skill starts a new chat and starts its `claude` process ahead of
  the first question. Follow-ups in the same session keep the context.
- Alexa hands over free speech only after a carrier word (what, how, tell me,
  ...), and without that word. There is one intent per carrier, and the handler
  puts the word back before sending the text to Claude.
- Every question runs against `ALEXA_DEADLINE_MS`. If the answer is finished it
  is spoken; otherwise Alexa speaks the complete sentences so far (or "Still
  searching") and the user says "continue" for the rest. The turn keeps running
  in between. Long answers are read `ALEXA_CHUNK_CHARS` at a time.
- If the session times out before the answer was heard, "Alexa, ask my cloud
  to continue" picks it up for `ALEXA_PICKUP_MINUTES`.
- `/alexa` has no bearer token. It is guarded by Amazon's request signature
  (`src/alexa/verify.ts`), the skill ID, the account allowlist and the shared
  hourly cap. Logs hold request types and timings, never the words.

Measured on 2026-11-11, and known limits:

- Alexa to relay and back adds 0.1 to 0.6 s, so a 6500 ms deadline leaves over
  a second under Alexa's 8 s limit. No response in the test runs left later.
- Haiku answers a plain question in 1 to 2 s. A web search takes 15 to 20 s, so
  it always needs one "continue". A long answer can take about 6 s to start.
- "Ask my cloud about / for / if ..." lands in Fallback: Alexa drops the
  connecting word and nothing is left to act as the carrier. "Ask my cloud
  what ...", "... to write ..." and "... tell me about ..." work.
- If the Echo is moved to Alexa+, run the voice tests again.

Test through Alexa's cloud, without talking:

```
node skill/try.mjs nlu                      # which intent each carrier resolves to
node skill/try.mjs say "open my cloud" "why is the sky blue" continue stop
npm test                                    # unit tests, no network
```
