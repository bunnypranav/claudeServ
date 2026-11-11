import { execFile } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';
import { ChatPool, log, type Chat, type ChatEvent } from './chat.ts';
import { loadConfig, MODELS, type Model, type Profile } from './config.ts';
import { Guard } from './guard.ts';

/*
 * Protocol (JSON text frames on /ws, authenticated with "Authorization: Bearer <token>" only; see guard.ts).
 * The same for every client; the token decides which profile (prompt, chats) a connection gets.
 *
 *   client → relay                      relay → client
 *   {type:"new", model?}                {type:"chat", chatId, model, busy}
 *   {type:"resume", chatId}             {type:"chat", ...} then {type:"replay", chatId, text, done, turn}
 *   {type:"user", chatId, text}         {type:"start"|"status"|"delta"|"done"|"error", chatId, ...}
 *   {type:"cancel", chatId}             (the running turn ends with done{cancelled:true})
 *   {type:"ping"}                       {type:"pong"}
 *
 * A turn keeps running if the connection drops; reconnecting and sending
 * "resume" replays what has streamed so far and picks up the rest live.
 */

const cfg = loadConfig();
const pool = new ChatPool(cfg);
const guard = new Guard(cfg.profiles, cfg.turnsPerHour);

const MODEL_COMMAND = /^\s*(?:please\s+)?(?:use|switch to|change to)\s+(haiku|sonnet|opus)\b[\s.!]*$/i;

function json(res: ServerResponse, status: number, body: object): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

let authCache: { at: number; loggedIn: boolean; method: string } | null = null;

function authStatus(): Promise<{ loggedIn: boolean; method: string }> {
  if (authCache && Date.now() - authCache.at < 60_000) return Promise.resolve(authCache);
  return new Promise((resolve) => {
    execFile(cfg.claudeBin, ['auth', 'status'], { timeout: 15_000 }, (err, stdout) => {
      let method = 'unknown';
      try {
        method = JSON.parse(stdout).authMethod ?? method;
      } catch {}
      authCache = { at: Date.now(), loggedIn: !err, method };
      resolve(authCache);
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  if (req.method === 'GET' && url.pathname === '/health') {
    // Anyone may learn the relay is up; only a token holder gets the details.
    const profile = guard.blocked(Guard.clientIp(req)) ? null : guard.check(req);
    if (!profile) {
      json(res, 200, { ok: true });
      return;
    }
    const auth = await authStatus();
    json(res, 200, { ok: true, loggedIn: auth.loggedIn, authMethod: auth.method, live: pool.liveCount(), profile: profile.name });
    return;
  }
  json(res, 404, { error: 'not found' });
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

server.on('upgrade', (req, socket, head) => {
  const url = new URL(req.url ?? '/', 'http://relay');
  const ip = Guard.clientIp(req);
  const reject = (status: string) => socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  if (url.pathname !== '/ws') return reject('404 Not Found');
  // A blocked IP is turned away before its token is even compared.
  if (guard.blocked(ip)) return reject('429 Too Many Requests');
  const profile = guard.check(req);
  if (!profile) {
    if (guard.fail(ip)) log(null, `AUTH: blocking ${ip} for 30 min after repeated bad tokens`);
    else log(null, `AUTH: bad or missing token from ${ip}`);
    return reject('401 Unauthorized');
  }
  guard.succeed(ip);
  wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws, req, profile));
});

function onConnection(ws: WebSocket, req: IncomingMessage, profile: Profile): void {
  const who = `${profile.name} from ${Guard.clientIp(req)}`;
  log(null, `connected: ${who}`);
  const detachers = new Map<string, () => void>();
  let alive = true;

  const out = (msg: object) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  const attach = (chat: Chat) => {
    detachers.get(chat.id)?.();
    detachers.set(chat.id, chat.attach((e: ChatEvent) => out({ ...e, chatId: chat.id })));
  };

  const chatInfo = (chat: Chat) => ({ type: 'chat', chatId: chat.id, model: chat.model, busy: chat.busy });

  const lookup = (id: unknown): Chat | null => {
    const chat = typeof id === 'string' ? pool.get(id, profile) : null;
    if (!chat) out({ type: 'error', chatId: id, kind: 'not_found', message: 'That chat no longer exists.' });
    return chat;
  };

  ws.on('message', (data) => {
    let msg: any;
    try {
      msg = JSON.parse(String(data));
    } catch {
      out({ type: 'error', kind: 'bad_request', message: 'Not JSON.' });
      return;
    }
    switch (msg.type) {
      case 'ping':
        out({ type: 'pong' });
        break;

      case 'new': {
        const model: Model = MODELS.includes(msg.model) ? msg.model : cfg.defaultModel;
        const chat = pool.create(profile, model);
        attach(chat);
        out(chatInfo(chat));
        log(chat, `new chat (${model})`);
        break;
      }

      case 'resume': {
        const chat = lookup(msg.chatId);
        if (!chat) break;
        attach(chat);
        out(chatInfo(chat));
        // Always sent, so the watch can settle its state: `turn` tells it whether its
        // last message arrived before the connection dropped (if not, it resends).
        out({ type: 'replay', chatId: chat.id, text: chat.turnText, done: chat.turnDone, turn: chat.turnCount });
        break;
      }

      case 'user': {
        const chat = lookup(msg.chatId);
        if (!chat) break;
        const text = typeof msg.text === 'string' ? msg.text.trim() : '';
        if (!text) {
          out({ type: 'error', chatId: chat.id, kind: 'bad_request', message: 'Empty message.' });
          break;
        }
        attach(chat);
        const switchTo = MODEL_COMMAND.exec(text)?.[1]?.toLowerCase() as Model | undefined;
        if (switchTo) {
          chat.setModel(switchTo);
          chat.reply(`Switched to ${switchTo[0].toUpperCase()}${switchTo.slice(1)}.`);
          log(chat, `model -> ${switchTo}`);
          break;
        }
        if (!guard.takeTurn()) {
          out({ type: 'error', chatId: chat.id, kind: 'rate_limit', message: `Relay safety limit: ${guard.turnLimit} messages per hour.` });
          log(chat, 'turn refused: hourly cap reached');
          break;
        }
        pool.makeRoomFor(chat);
        chat.send(text);
        break;
      }

      case 'cancel':
        lookup(msg.chatId)?.cancel();
        break;

      default:
        out({ type: 'error', kind: 'bad_request', message: `Unknown message type ${msg.type}.` });
    }
  });

  // Cloudflare drops idle WebSockets after ~100 s; ping well inside that.
  ws.on('pong', () => (alive = true));
  const keepalive = setInterval(() => {
    if (!alive) {
      ws.terminate();
      return;
    }
    alive = false;
    ws.ping();
  }, 25_000);

  ws.on('close', () => {
    clearInterval(keepalive);
    for (const detach of detachers.values()) detach();
    log(null, `disconnected: ${who}`);
  });
}

server.listen(cfg.port, cfg.host, () => {
  const clients = cfg.profiles.map((p) => p.name).join(', ');
  log(null, `claudeserv listening on ${cfg.host}:${cfg.port} (clients ${clients}, default model ${cfg.defaultModel}, max ${cfg.maxLive} live)`);
});

for (const sig of ['SIGTERM', 'SIGINT'] as const) {
  process.on(sig, () => {
    log(null, `${sig}, shutting down`);
    pool.stopAll();
    wss.clients.forEach((c) => c.close(1001, 'relay restarting'));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 6_000).unref();
  });
}
