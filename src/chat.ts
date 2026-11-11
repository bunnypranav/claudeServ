import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import type { Config, Model, Profile } from './config.ts';

export type ErrorKind = 'rate_limit' | 'auth' | 'overloaded' | 'busy' | 'not_found' | 'bad_request' | 'server';

/** What a chat reports to the watch. The server adds `chatId` on the way out. */
export type ChatEvent =
  | { type: 'start' }
  | { type: 'status'; text: string }
  | { type: 'delta'; text: string }
  | { type: 'done'; ms: number; cancelled?: boolean }
  | { type: 'error'; kind: ErrorKind; message: string; resetsAt?: number };

type Listener = (e: ChatEvent) => void;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const TOOL_STATUS: Record<string, string> = {
  WebSearch: 'Searching the web…',
  web_search: 'Searching the web…',
  WebFetch: 'Reading a page…',
  web_fetch: 'Reading a page…',
};

/**
 * One conversation, backed by one long-lived `claude -p` process speaking
 * stream-json on stdin/stdout. The process is started lazily, stopped when
 * idle, and brought back with --resume, so a chat outlives its process.
 */
export class Chat {
  readonly id: string;
  readonly profile: Profile;
  model: Model;
  lastUsed = Date.now();
  busy = false;
  /** text of the current or latest turn, replayed when the watch reconnects mid-turn */
  turnText = '';
  turnDone = true;
  /** turns accepted so far; lets a reconnecting watch tell whether its last message arrived */
  turnCount = 0;
  /** how the latest turn failed, for a client that wasn't listening when it did (Alexa) */
  turnError: Extract<ChatEvent, { type: 'error' }> | null = null;
  /** latest status of the running turn ("Searching the web…") */
  turnStatus = '';

  private cfg: Config;
  private proc: ChildProcessWithoutNullStreams | null = null;
  /** a transcript exists on disk, so the next spawn must --resume rather than --session-id */
  private persisted: boolean;
  private listener: Listener | null = null;
  private turnStart = 0;
  private cancelled = false;
  private textBlocks = 0;
  private resetsAt: number | undefined;
  private idleTimer: NodeJS.Timeout | null = null;
  private requestSeq = 0;
  private initModel = '';

  constructor(cfg: Config, profile: Profile, id: string, model: Model, persisted: boolean) {
    this.cfg = cfg;
    this.profile = profile;
    this.id = id;
    this.model = model;
    this.persisted = persisted;
  }

  get alive(): boolean {
    return this.proc !== null;
  }

  /** Route events to `fn` (the latest connection wins). Returns a detach function. */
  attach(fn: Listener): () => void {
    this.listener = fn;
    return () => {
      if (this.listener === fn) this.listener = null;
    };
  }

  send(text: string): void {
    if (this.busy) {
      this.emit({ type: 'error', kind: 'busy', message: 'Still answering the last message.' });
      return;
    }
    this.clearIdle();
    this.turnCount++;
    this.busy = true;
    this.turnText = '';
    this.turnDone = false;
    this.turnError = null;
    this.turnStatus = '';
    this.cancelled = false;
    this.textBlocks = 0;
    this.turnStart = Date.now();
    this.lastUsed = this.turnStart;
    this.emit({ type: 'start' });
    this.write({ type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null });
  }

  /** Answer locally without calling Claude (used for relay commands like model switching). */
  reply(text: string): void {
    this.turnCount++;
    this.lastUsed = Date.now();
    this.turnText = text;
    this.turnDone = true;
    this.turnError = null;
    this.emit({ type: 'start' });
    this.emit({ type: 'delta', text });
    this.emit({ type: 'done', ms: 0 });
  }

  cancel(): void {
    if (!this.busy || !this.proc) return;
    this.cancelled = true;
    this.write({ type: 'control_request', request_id: `int-${++this.requestSeq}`, request: { subtype: 'interrupt' } });
  }

  /** Start the process ahead of the first message, so that message doesn't wait for it. */
  warm(): void {
    if (this.proc || this.busy) return;
    this.spawn();
    this.armIdle();
  }

  /** Takes effect on the next turn: the process restarts with --resume and the new model. */
  setModel(model: Model): void {
    this.model = model;
    if (!this.busy) this.stop();
  }

  /** End the process gracefully; the conversation stays resumable. */
  stop(): void {
    const p = this.proc;
    if (!p) return;
    this.clearIdle();
    // Detach now: a message arriving while this one winds down gets a fresh process.
    this.proc = null;
    p.stdin.end();
    setTimeout(() => {
      if (p.exitCode === null && p.signalCode === null) p.kill('SIGTERM');
    }, 5_000).unref();
  }

  private write(msg: object): void {
    if (!this.proc) this.spawn();
    this.proc!.stdin.write(JSON.stringify(msg) + '\n');
  }

  private spawn(): void {
    const c = this.cfg;
    const pr = this.profile;
    const args = [
      '-p',
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--system-prompt-file', pr.promptFile,
      // WebSearch runs on Anthropic's side. WebFetch is left out on purpose: it
      // fetches from this machine, so it could be pointed at localhost services.
      '--tools', 'WebSearch',
      '--allowedTools', 'WebSearch',
      '--disallowedTools', 'WebFetch',
      '--strict-mcp-config',
      '--setting-sources', '',
      '--model', this.model,
      ...(this.persisted ? ['--resume', this.id] : ['--session-id', this.id]),
    ];
    const p = spawn(c.claudeBin, args, { cwd: pr.workDir, stdio: ['pipe', 'pipe', 'pipe'] });
    this.proc = p;
    log(this, `spawned pid ${p.pid} (${this.persisted ? 'resume' : 'new'}, ${this.model})`);

    createInterface({ input: p.stdout }).on('line', (line) => {
      if (this.proc !== p || !line.trim()) return;
      let e: any;
      try {
        e = JSON.parse(line);
      } catch {
        log(this, `unparsed stdout: ${line.slice(0, 200)}`);
        return;
      }
      this.onEvent(e);
    });
    let stderr = '';
    p.stderr.on('data', (d) => {
      stderr = (stderr + d).slice(-2_000);
    });
    // A process that never started emits 'error' and no 'exit'; don't leave the turn hanging.
    p.on('error', (err) => {
      log(this, `spawn error: ${err.message}`);
      if (this.proc !== p) return;
      this.proc = null;
      if (this.busy) {
        this.busy = false;
        this.turnDone = true;
        this.emit({ type: 'error', kind: 'server', message: "Couldn't start Claude on the server." });
      }
    });
    // Writing to a process that just died raises EPIPE here; unhandled, it would crash the relay.
    p.stdin.on('error', (err) => log(this, `stdin error: ${err.message}`));
    p.on('exit', (code, signal) => {
      log(this, `process ${p.pid} exited (${signal ?? code})${stderr ? ': ' + stderr.trim().slice(-300) : ''}`);
      if (this.proc !== p) return; // already replaced by stop()
      this.proc = null;
      this.clearIdle();
      if (this.busy) {
        this.busy = false;
        this.turnDone = true;
        this.emit({ type: 'error', kind: 'server', message: 'Claude stopped unexpectedly. Try again.' });
      }
    });
  }

  private onEvent(e: any): void {
    switch (e.type) {
      case 'stream_event':
        this.onStreamEvent(e.event);
        break;
      case 'rate_limit_event':
        this.resetsAt = findResetsAt(e) ?? this.resetsAt;
        break;
      case 'system':
        if (e.subtype === 'init' && e.model !== this.initModel) {
          this.initModel = e.model;
          log(this, `claude reports model ${e.model}`);
        }
        if (e.subtype === 'api_retry' && this.busy) {
          const why = e.error === 'rate_limit' ? 'Rate limited' : e.error === 'overloaded' ? 'Claude is busy' : 'Connection problem';
          this.emit({ type: 'status', text: `${why}, retrying…` });
        }
        break;
      case 'result':
        this.onResult(e);
        break;
    }
  }

  private onStreamEvent(ev: any): void {
    if (!this.busy || !ev) return;
    if (ev.type === 'content_block_start') {
      const block = ev.content_block ?? {};
      if (block.type === 'thinking') {
        this.emit({ type: 'status', text: 'Thinking…' });
      } else if (block.type === 'tool_use' || block.type === 'server_tool_use') {
        this.emit({ type: 'status', text: TOOL_STATUS[block.name] ?? 'Working…' });
      } else if (block.type === 'text' && this.textBlocks++ > 0 && this.turnText) {
        // a later text block (e.g. after a search) starts a new paragraph
        this.delta('\n\n');
      }
    } else if (ev.type === 'content_block_delta' && ev.delta?.type === 'text_delta') {
      this.delta(ev.delta.text);
    }
  }

  private delta(text: string): void {
    this.turnText += text;
    this.emit({ type: 'delta', text });
  }

  private onResult(e: any): void {
    if (!this.busy) return;
    this.busy = false;
    this.turnDone = true;
    this.persisted = true;
    const ms = Date.now() - this.turnStart;
    const u = e.usage ?? {};
    log(this, `turn ${e.subtype} in ${ms} ms, ${this.turnText.length} chars, in=${u.input_tokens ?? '?'} cache_read=${u.cache_read_input_tokens ?? '?'} out=${u.output_tokens ?? '?'}`);

    if (this.cancelled) {
      this.emit({ type: 'done', ms, cancelled: true });
    } else if (e.is_error) {
      this.emit(classify(String(e.result ?? e.errors?.join('; ') ?? e.subtype), this.resetsAt));
    } else {
      this.emit({ type: 'done', ms });
    }
    this.armIdle();
  }

  private armIdle(): void {
    this.clearIdle();
    this.idleTimer = setTimeout(() => {
      log(this, 'idle, stopping process');
      this.stop();
    }, this.profile.idleMs);
    this.idleTimer.unref();
  }

  private clearIdle(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
  }

  private emit(e: ChatEvent): void {
    if (e.type === 'error' && e.kind !== 'busy') this.turnError = e;
    else if (e.type === 'status') this.turnStatus = e.text;
    this.listener?.(e);
  }
}

/** Keeps chats by id and caps how many `claude` processes run at once. */
export class ChatPool {
  private cfg: Config;
  private chats = new Map<string, Chat>();

  constructor(cfg: Config) {
    this.cfg = cfg;
  }

  create(profile: Profile, model: Model): Chat {
    const chat = new Chat(this.cfg, profile, randomUUID(), model, false);
    this.chats.set(chat.id, chat);
    return chat;
  }

  /**
   * Find one of `profile`'s chats in memory, or rebuild it from its transcript
   * after a relay restart. Another client's chat is reported as missing.
   */
  get(id: string, profile: Profile, model: Model = this.cfg.defaultModel): Chat | null {
    const found = this.chats.get(id);
    if (found) return found.profile === profile ? found : null;
    if (!UUID.test(id) || !existsSync(this.transcriptPath(id, profile))) return null;
    const chat = new Chat(this.cfg, profile, id, model, true);
    this.chats.set(id, chat);
    return chat;
  }

  /** Call before a turn: stops the least recently used idle process if at the cap. */
  makeRoomFor(chat: Chat): void {
    if (chat.alive) return;
    const live = [...this.chats.values()].filter((c) => c.alive);
    if (live.length < this.cfg.maxLive) return;
    const victim = live.filter((c) => !c.busy).sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (victim) {
      log(victim, 'stopping to stay under MAX_LIVE');
      victim.stop();
    }
  }

  liveCount(): number {
    return [...this.chats.values()].filter((c) => c.alive).length;
  }

  stopAll(): void {
    for (const c of this.chats.values()) c.stop();
  }

  private transcriptPath(id: string, profile: Profile): string {
    // Claude Code stores transcripts under ~/.claude/projects/<cwd with non-alphanumerics as '-'>/
    const project = profile.workDir.replace(/[^a-zA-Z0-9]/g, '-');
    return join(homedir(), '.claude', 'projects', project, `${id}.jsonl`);
  }
}

function classify(message: string, resetsAt: number | undefined): ChatEvent {
  const m = message.toLowerCase();
  if (/usage limit|rate limit|hit your limit|limit reached|429/.test(m)) {
    return { type: 'error', kind: 'rate_limit', message: 'Claude Pro usage limit reached.', resetsAt: resetsAt ?? epochIn(message) };
  }
  if (/log ?in|auth|401|403|oauth|credential/.test(m)) {
    return { type: 'error', kind: 'auth', message: 'Claude login on the server has expired.' };
  }
  if (/overloaded|529/.test(m)) {
    return { type: 'error', kind: 'overloaded', message: 'Claude is overloaded right now. Try again shortly.' };
  }
  return { type: 'error', kind: 'server', message: message.slice(0, 200) || 'Something went wrong.' };
}

/** Pull a reset time (epoch seconds) out of a rate_limit_event, whatever its exact shape. */
function findResetsAt(e: any): number | undefined {
  const seen = new Set<object>();
  const walk = (o: any): number | undefined => {
    if (!o || typeof o !== 'object' || seen.has(o)) return undefined;
    seen.add(o);
    for (const [k, v] of Object.entries(o)) {
      if (/^resets?_?at$/i.test(k) && typeof v === 'number') return v > 1e12 ? Math.round(v / 1000) : v;
      const inner = walk(v);
      if (inner !== undefined) return inner;
    }
    return undefined;
  };
  return walk(e);
}

/** Older CLI versions report "Claude AI usage limit reached|<epoch seconds>". */
function epochIn(message: string): number | undefined {
  const n = /\|(\d{10})\b/.exec(message)?.[1];
  return n ? Number(n) : undefined;
}

export function log(chat: Chat | null, msg: string): void {
  console.log(chat ? `[${chat.profile.name} ${chat.id.slice(0, 8)}] ${msg}` : msg);
}
