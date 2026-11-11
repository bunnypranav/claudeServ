# Server notes moved from the watch project's PLAN.md

*Written 2026-10-15 while building the relay for the watch app; kept for the reasoning behind the design. Names and paths are updated to the claudeserv layout; README.md is the current reference.*

### 2.1 Helper service (on Nest)
- **Runtime:** Node 24 + TypeScript as a systemd service. You're root on the container and systemd 257 is available. Node and Claude Code still need installing. The container is 2 CPU / 2 GB RAM with about 1.6 GB free. Each `claude` process uses roughly 300 MB, so the helper **keeps at most 2 chats alive** and closes a chat after 10 min idle. A closed chat comes back with `--resume` if you reopen it from history.
- **Auth to Anthropic:** run `claude auth login` once on Nest. You open the printed URL in your browser and paste the code back. The alternative is `claude setup-token`, which issues a 1-year token stored as `CLAUDE_CODE_OAUTH_TOKEN` in the service's environment. Either way it's Anthropic's own flow and the token never leaves Nest. **Never use `--bare`**, because bare mode ignores subscription logins.
- **How it drives Claude:** one persistent child process per chat:
  `claude -p --input-format stream-json --output-format stream-json --verbose --include-partial-messages --system-prompt-file watch.md --tools "WebSearch,WebFetch" --allowedTools "WebSearch,WebFetch" --strict-mcp-config --setting-sources "" --model sonnet --session-id <uuid>`
  - Run it from an empty working directory (`/srv/claudeserv/work`) so no project files or CLAUDE.md get loaded.
  - Keeping the process alive avoids CLI startup cost on each turn, and prompt caching keeps follow-ups fast.
  - Switch models with a spoken command ("use Haiku" / "use Opus"), which sends `/model <name>` to that chat's process.
- **System prompt (`watch.md`), a first draft:**
  > You are Claude, replying on a small round smartwatch screen. The user speaks; their message is speech-recognized and may contain recognition errors, so interpret charitably. Reply in plain text only: no markdown, no headings, no bullet symbols, no tables, no code blocks, no emoji. Keep replies to 1–3 short sentences unless the user asks for more detail. Use metric units (°C, km, kg). Use web search when the question needs current information, and say briefly what you found rather than listing sources. If the request is ambiguous, ask one short clarifying question.
- **Protocol to the watch:**
  - WebSocket at `wss://claude.bunnyorg.in/ws`, with `Authorization: Bearer <token>`.
  - Watch → helper: `{type:"new"}` returns `{type:"chat", chatId}`. Then `{type:"user", chatId, text}`. Also `{type:"cancel", chatId}` (sends SIGINT so the turn ends cleanly) and `{type:"resume", chatId}`.
  - Helper → watch: `{type:"delta", text}`, `{type:"status", text:"Searching the web…"}` (shown while a tool runs), `{type:"done"}`, and `{type:"error", kind:"rate_limit"|"auth"|"server"|"overloaded", message, resetsAt?}`.
  - `GET /health`, which also runs `claude auth status` so the watch can say when the login has expired.
- **Exposure:** in the Cloudflare Zero Trust dashboard you add a **public hostname** `claude.bunnyorg.in` → `http://localhost:8787` on the tunnel that's already running on Nest. WebSockets pass through by default. The helper binds to `127.0.0.1:8787` only.
- **Logs:** journald, plus one line per turn with latency and token usage.

## 5b. Phase 1 status (2026-10-15)
- **Relay is live on Nest** as `claudeserv.service`. Source is this repo; redeploy with `deploy.sh`, which uses a single SSH connection because Nest drops a second one opened right after the first. The token is in `/srv/claudeserv/claudeserv.env`.
- **Verified with `client.mjs` on Nest:**
  - Streaming works: first text after about 1–1.7 s for plain chat, about 10 s with web search.
  - Context carries across turns.
  - Cancel mid-reply works, and the next message works in the same process.
  - "Thinking…" and "Searching the web…" statuses come through.
  - "use haiku" switches the model; Claude reports `claude-haiku-5-5`.
  - A connection dropped mid-turn reconnects, replays, and continues live.
  - A chat resumes after a relay restart (back on the default model).
  - Missing or wrong tokens get 401.
- **Security hardening** (`src/guard.ts`), all verified on Nest:
  - The token is accepted **only** in the `Authorization: Bearer` header. A token in the URL gets 401. The token is 256-bit random, compared in constant time, and stored in `relay.env` (root:claudeserv 640).
  - **Lockout:** 5 bad tokens from one IP within 10 min blocks that IP for 30 min (429), and blocked IPs aren't checked even with the right token. The IP comes from `CF-Connecting-IP`; only cloudflared can reach the loopback port.
  - **Hourly cap:** 60 turns per rolling hour (`MAX_TURNS_PER_HOUR`), so even a leaked token can't burn through your Pro limits.
  - **`/health`:** without the token it returns only `{ok:true}`. The login and process details need the token.
  - **No server access for Claude:** the only tool is **WebSearch**, which runs at Anthropic. WebFetch is disabled because it fetches from Nest and could be aimed at `localhost` services such as uptime-kuma. There's no shell, no file tools and no MCP.
  - **Failed starts:** if Claude can't start, the watch gets an error instead of hanging, and a dead process can't crash the relay.
- **Optional extra layer: Cloudflare Access with a service token.** Requests without the two `CF-Access-Client-*` headers get rejected at Cloudflare and never reach Nest. The watch app will send them if they're set in `watch/local.properties`.
- **Public end-to-end test (laptop → Cloudflare → Nest), passed:**
  - Chat, context, cancel, a connection dropped mid-search with replay, and resume all work at `wss://claude.bunnyorg.in/ws`. Cloudflare adds about 0.2 s.
  - Missing, wrong and URL tokens are rejected; the right header token connects.
  - Quirk found: the tunnel retries each rejected upgrade once, about 0.5 s later. The guard counts failures from one IP within 2 s as a single attempt, so 4 spaced bad tries don't trigger a block.
  - Cloudflare Access was skipped (your choice). The relay's own token, lockout and cap protect it.
- The relay URL and token for the watch build are in `watch/local.properties` (git-ignored) as `relayUrl` / `relayToken`.
- **Phase 1 is complete.**

