#!/usr/bin/env node
// Test client for the relay. No dependencies (Node 22+ has WebSocket built in).
//
//   RELAY_TOKEN=... node client.mjs [--url wss://host/ws] step [step ...]
//
// Steps run in order; each one that talks to Claude waits for done/error.
//   new                 start a chat (also done implicitly before the first ask)
//   ask:<text>          send a message
//   cancel@<ms>:<text>  send a message and cancel it after <ms>
//   drop@<ms>:<text>    send a message, disconnect after <ms>, reconnect, resume
//   resume              resume the current chat on a fresh connection
//   chat:<id>           switch to an existing chat id (e.g. after a relay restart)

const args = process.argv.slice(2);
let url = 'ws://127.0.0.1:8787/ws';
if (args[0] === '--url') { url = args[1]; args.splice(0, 2); }
const token = process.env.RELAY_TOKEN;
if (!token) { console.error('set RELAY_TOKEN'); process.exit(1); }

const t0 = Date.now();
const ts = () => `${((Date.now() - t0) / 1000).toFixed(1)}s`.padStart(6);
let ws, chatId, firstDelta;
const waiters = [];

function connect() {
  return new Promise((resolve, reject) => {
    // Node's built-in WebSocket (undici) accepts headers in its init object;
    // the relay only takes the token from the Authorization header.
    ws = new WebSocket(url, { headers: { Authorization: `Bearer ${token}` } });
    ws.onopen = () => resolve();
    ws.onerror = (e) => reject(new Error(e.message ?? 'connect failed'));
    ws.onmessage = (m) => onMessage(JSON.parse(m.data));
  });
}

function onMessage(e) {
  switch (e.type) {
    case 'chat': chatId = e.chatId; console.log(`${ts()} chat ${e.chatId} model=${e.model} busy=${e.busy}`); notify('chat'); break;
    case 'start': firstDelta = true; console.log(`${ts()} start`); break;
    case 'status': console.log(`${ts()} status: ${e.text}`); break;
    case 'delta':
      if (firstDelta) { process.stdout.write(`${ts()} text: `); firstDelta = false; }
      process.stdout.write(e.text); break;
    case 'replay': console.log(`${ts()} replay (done=${e.done}): ${JSON.stringify(e.text)}`); if (e.done) notify('done'); else firstDelta = true; break;
    case 'done': console.log(`\n${ts()} done in ${e.ms} ms${e.cancelled ? ' (cancelled)' : ''}`); notify('done'); break;
    case 'error': console.log(`\n${ts()} ERROR ${e.kind}: ${e.message}${e.resetsAt ? ` (resets ${new Date(e.resetsAt * 1000).toLocaleString()})` : ''}`); notify('done'); break;
    default: console.log(`${ts()}`, e);
  }
}

const until = (what) => new Promise((resolve) => waiters.push({ what, resolve }));
function notify(got) {
  for (let i = waiters.length - 1; i >= 0; i--) if (waiters[i].what === got) waiters.splice(i, 1)[0].resolve();
}
const send = (o) => ws.send(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function ensureChat() {
  if (chatId) return;
  const p = until('chat'); send({ type: 'new' }); await p;
}

async function reconnectAndResume() {
  await connect();
  const p = until('chat'); send({ type: 'resume', chatId }); await p;
}

await connect();
for (const step of args) {
  const [, verb, ms, text] = /^(\w+)(?:@(\d+))?(?::([\s\S]*))?$/.exec(step) ?? [];
  console.log(`${ts()} --- ${step}`);
  if (verb === 'new') { chatId = null; await ensureChat(); }
  else if (verb === 'chat') { chatId = text; }
  else if (verb === 'ask') { await ensureChat(); const p = until('done'); send({ type: 'user', chatId, text }); await p; }
  else if (verb === 'cancel') {
    await ensureChat(); const p = until('done'); send({ type: 'user', chatId, text });
    await sleep(Number(ms)); console.log(`\n${ts()} >> cancel`); send({ type: 'cancel', chatId }); await p;
  } else if (verb === 'drop') {
    await ensureChat(); send({ type: 'user', chatId, text });
    await sleep(Number(ms)); console.log(`\n${ts()} >> dropping connection`); ws.onmessage = null; ws.close();
    await sleep(500); const p = until('done'); await reconnectAndResume(); await p;
  } else if (verb === 'resume') { ws.close(); await sleep(300); await reconnectAndResume(); }
  else { console.error(`unknown step ${step}`); }
}
ws.close();
