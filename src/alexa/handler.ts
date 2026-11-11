import type { ChatEvent } from '../chat.ts';
import { MODEL_COMMAND, type AlexaConfig, type Model } from '../config.ts';
import prefixes from './intents.json' with { type: 'json' };
import { nextChunk, toSpeech, toSsml } from './speech.ts';

/*
 * The Alexa skill's brain. Alexa gives a skill about 8 seconds to answer, and
 * Claude often needs longer, so every question runs against a budget: when the
 * deadline comes, Alexa speaks the sentences that are ready and the user says
 * "continue" for the rest. The turn keeps running inside its Chat in between.
 */

const PREFIX: Record<string, string> = prefixes;
const CONTINUE = new Set(['ContinueIntent', 'AMAZON.YesIntent', 'AMAZON.NextIntent', 'AMAZON.ResumeIntent']);
const STOP = new Set(['AMAZON.StopIntent', 'AMAZON.CancelIntent', 'AMAZON.NavigateHomeIntent', 'AMAZON.NoIntent']);
/** after the first complete sentence arrives on a Continue, wait this much longer for the rest */
const SETTLE_MS = 1_500;
const PROGRESSIVE_MAX = 2;

export interface AlexaReply {
  status: 200 | 400;
  body?: object;
}

/** The part of a Chat the handler uses (a fake stands in for it in tests). */
export interface AlexaChat {
  readonly id: string;
  model: Model;
  busy: boolean;
  turnText: string;
  turnDone: boolean;
  turnError: Extract<ChatEvent, { type: 'error' }> | null;
  turnStatus: string;
  attach(fn: (e: ChatEvent) => void): () => void;
  send(text: string): void;
  cancel(): void;
  setModel(model: Model): void;
  warm(): void;
}

export interface Progressive {
  endpoint: string;
  token: string;
  requestId: string;
  text: string;
}

export interface AlexaDeps {
  log: (msg: string) => void;
  createChat: () => AlexaChat;
  /** a chat from an earlier request, also after a relay restart; null if it is gone */
  getChat: (id: string) => AlexaChat | null;
  /** called before a chat's process may start, to stay under the process cap */
  makeRoom: (chat: AlexaChat) => void;
  /** take one turn from the hourly budget shared with the other clients */
  takeTurn: () => boolean;
  /** say something while the answer is still being worked on; defaults to Alexa's directives API */
  progressive?: (p: Progressive) => void;
}

interface Session {
  id: string;
  userId: string;
  chat: AlexaChat | null;
  /** how much of chat.turnText has been spoken */
  spoken: number;
  /** a question has been put to the chat in this session */
  asked: boolean;
  /** the long "say continue" cue has been given once; later ones are short */
  cued: boolean;
  last: number;
}

interface Said {
  reply: AlexaReply;
  chars: number;
  outcome: string;
}

/** The text the user said: the carrier words Alexa swallowed, put back in front of the slot value. */
export function rebuild(intent: string, query: string | undefined): string | null {
  if (!(intent in PREFIX)) return null;
  return [PREFIX[intent], (query ?? '').trim()].filter(Boolean).join(' ');
}

/** Lets a request sleep until its chat reports something or a time is reached. */
class Signal {
  private waiting: (() => void)[] = [];

  notify(): void {
    const w = this.waiting;
    this.waiting = [];
    for (const fn of w) fn();
  }

  async until(pred: () => boolean, deadline: number): Promise<boolean> {
    while (!pred()) {
      const left = deadline - Date.now();
      if (left <= 0) return false;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiting.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    return true;
  }
}

function sendProgressive(p: Progressive, log: (msg: string) => void): void {
  let url: URL;
  try {
    url = new URL('/v1/directives', p.endpoint);
  } catch {
    return;
  }
  if (url.protocol !== 'https:' || !url.hostname.endsWith('.amazonalexa.com')) return;
  fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${p.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ header: { requestId: p.requestId }, directive: { type: 'VoicePlayer.Speak', speech: p.text } }),
    signal: AbortSignal.timeout(1_500),
  }).then(
    (r) => {
      if (!r.ok) log(`ALEXA: progressive response refused (${r.status})`);
    },
    (e) => log(`ALEXA: progressive response failed (${(e as Error).name})`),
  );
}

function istTime(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: 'numeric', minute: '2-digit', hour12: true });
}

export class AlexaHandler {
  private cfg: AlexaConfig;
  private deps: AlexaDeps;
  private log: (msg: string) => void;
  private sessions = new Map<string, Session>();
  private seenUnknown = new Set<string>();

  constructor(cfg: AlexaConfig, deps: AlexaDeps) {
    this.cfg = cfg;
    this.deps = deps;
    this.log = deps.log;
  }

  /** `body` has already passed signature verification. `received` is when the request arrived. */
  async handle(body: any, received: number): Promise<AlexaReply> {
    const system = body?.context?.System;
    const appId = system?.application?.applicationId ?? body?.session?.application?.applicationId;
    if (appId !== this.cfg.skillId) {
      this.log('ALEXA: request for another skill refused');
      return { status: 400 };
    }
    const req = body.request ?? {};
    const userId: string = system?.user?.userId ?? body?.session?.user?.userId ?? '';
    const what = req.type === 'IntentRequest' ? `intent ${req.intent?.name}` : String(req.type);

    if (!this.cfg.userIds.includes(userId)) {
      if (!this.seenUnknown.has(userId)) {
        this.seenUnknown.add(userId);
        // Enrollment: copy this id into ALEXA_USER_IDS to allow the account.
        this.log(`ALEXA: user not on the allowlist: ${userId}`);
      }
      if (req.type === 'SessionEndedRequest') return this.empty();
      return this.plain("This skill isn't set up yet.", { end: true });
    }

    this.sweep(received);
    const stats = { firstText: 0 };
    let said: Said;
    try {
      said = await this.route(body, req, userId, received, stats);
    } catch (err) {
      this.log(`ALEXA: handler error: ${(err as Error).message}`);
      said = { reply: this.plain('Something went wrong on the server. Try again.', { reprompt: 'Anything else?' }), chars: 0, outcome: 'handler error' };
    }
    const took = Date.now() - received;
    const first = stats.firstText ? `${stats.firstText - received} ms` : '-';
    this.log(`ALEXA: ${what}, first text ${first}, responded ${took} ms, ${said.chars} chars, ${said.outcome}${took > this.cfg.deadlineMs + 300 ? ' (LATE)' : ''}`);
    return said.reply;
  }

  private async route(body: any, req: any, userId: string, received: number, stats: { firstText: number }): Promise<Said> {
    const sid: string = body?.session?.sessionId ?? '';
    switch (req.type) {
      case 'LaunchRequest': {
        // opening the skill always starts a new chat, whose process is started ahead of the first question
        const s = this.fresh(sid, userId, received);
        s.chat = this.deps.createChat();
        this.deps.makeRoom(s.chat);
        s.chat.warm();
        return { reply: this.plain("Hi, what's your question?", { reprompt: 'What would you like to ask?', session: s }), chars: 0, outcome: 'new chat' };
      }

      case 'SessionEndedRequest': {
        const s = this.sessions.get(sid);
        let outcome = `session ended (${req.reason})`;
        if (req.reason === 'ERROR') outcome = `session error ${req.error?.type}: ${req.error?.message}`;
        if (req.reason === 'USER_INITIATED') {
          if (s?.chat?.busy) outcome += ', turn cancelled';
          s?.chat?.cancel();
          this.sessions.delete(sid);
        }
        // otherwise the turn is left running, so "ask … to continue" can pick the answer up
        return { reply: this.empty(), chars: 0, outcome };
      }

      case 'IntentRequest': {
        const name: string = req.intent?.name ?? '';
        const s = this.session(body, sid, userId, received);
        const text = rebuild(name, req.intent?.slots?.query?.value);
        if (text !== null && text !== '') return this.ask(s, text, body, received, stats);
        if (CONTINUE.has(name)) return this.next(s, body, received, stats);
        if (STOP.has(name)) {
          const busy = !!s.chat?.busy;
          s.chat?.cancel();
          this.sessions.delete(sid);
          return { reply: this.plain('Okay.', { end: true }), chars: 0, outcome: busy ? 'stopped, turn cancelled' : 'stopped' };
        }
        if (name === 'AMAZON.HelpIntent') {
          const help = 'Ask me anything, starting with words like what, how, or tell me. Say continue to hear more of a long answer, or stop to finish.';
          return { reply: this.plain(help, { reprompt: 'What would you like to ask?', session: s }), chars: 0, outcome: 'help' };
        }
        // Fallback: Alexa heard something that matched no carrier, and doesn't pass the words on.
        return {
          reply: this.plain('Sorry, I missed that. Try starting with what, how, or tell me.', { reprompt: 'What would you like to ask?', session: s }),
          chars: 0,
          outcome: name === 'AMAZON.FallbackIntent' ? 'fallback' : 'unhandled intent',
        };
      }

      default:
        return { reply: this.empty(), chars: 0, outcome: 'ignored' };
    }
  }

  /** A question: run it against the deadline and speak what is ready. */
  private async ask(s: Session, text: string, body: any, received: number, stats: { firstText: number }): Promise<Said> {
    const switchTo = MODEL_COMMAND.exec(text)?.[1]?.toLowerCase() as Model | undefined;
    if (switchTo) {
      s.chat ??= this.deps.createChat();
      s.chat.setModel(switchTo);
      const line = `Switched to ${switchTo[0].toUpperCase()}${switchTo.slice(1)}.`;
      return { reply: this.plain(line, { reprompt: 'Anything else?', session: s }), chars: line.length, outcome: `model ${switchTo}` };
    }
    if (!this.deps.takeTurn()) {
      return { reply: this.plain("That's the hourly limit for this relay. Try again later.", { reprompt: 'Anything else?', session: s }), chars: 0, outcome: 'hourly cap' };
    }

    let chat = (s.chat ??= this.deps.createChat());
    const signal = new Signal();
    if (chat.busy) {
      // the user moved on: drop the answer still being written
      const detach = chat.attach(() => signal.notify());
      chat.cancel();
      const stopped = await signal.until(() => !chat.busy, Date.now() + 1_000);
      detach();
      if (!stopped) {
        this.log('ALEXA: the previous turn did not stop in time; starting a new chat');
        chat = s.chat = this.deps.createChat();
      }
    }
    this.deps.makeRoom(chat);
    s.spoken = 0;
    s.asked = true;

    const system = body?.context?.System ?? {};
    let progressives = 0;
    let waiting = true;
    const progressive = (line: string) => {
      if (!waiting || progressives >= PROGRESSIVE_MAX || !system.apiEndpoint || !system.apiAccessToken) return;
      progressives++;
      const p: Progressive = { endpoint: system.apiEndpoint, token: system.apiAccessToken, requestId: body.request.requestId, text: line };
      if (this.deps.progressive) this.deps.progressive(p);
      else sendProgressive(p, this.log);
    };
    let searching = false;
    const detach = chat.attach((e) => {
      if (e.type === 'delta' && !stats.firstText) stats.firstText = Date.now();
      if (e.type === 'status' && e.text.startsWith('Searching') && !searching) {
        searching = true;
        progressive('Searching the web.');
      }
      signal.notify();
    });
    chat.send(text);
    const nudge = setTimeout(() => {
      if (!stats.firstText && !searching && !chat.turnDone) progressive('One moment.');
    }, Math.max(0, received + this.cfg.progressiveAfterMs - Date.now()));

    await signal.until(() => chat.turnDone, received + this.cfg.deadlineMs);
    waiting = false;
    clearTimeout(nudge);
    detach(); // the turn keeps running inside the chat and buffers for the next Continue
    return this.speak(s);
  }

  /** "Continue": the next piece of the answer, waiting for it if it isn't written yet. */
  private async next(s: Session, body: any, received: number, stats: { firstText: number }): Promise<Said> {
    if (!s.asked && body?.session?.new) this.pickUp(s, received);
    const chat = s.chat;
    if (!chat || !s.asked) {
      return { reply: this.plain("There's nothing waiting. What's your question?", { reprompt: 'What would you like to ask?', session: s }), chars: 0, outcome: 'nothing to continue' };
    }
    const ready = () => chat.turnDone || nextChunk(chat.turnText, s.spoken, false, this.cfg.chunkChars).end > s.spoken;
    if (!ready()) {
      const deadline = received + this.cfg.deadlineMs;
      const signal = new Signal();
      const detach = chat.attach((e) => {
        if (e.type === 'delta' && !stats.firstText) stats.firstText = Date.now();
        signal.notify();
      });
      if (await signal.until(ready, deadline)) {
        // a sentence is ready; give the rest of the answer a moment to arrive with it
        await signal.until(() => chat.turnDone, Math.min(deadline, Date.now() + SETTLE_MS));
      }
      detach();
    }
    return this.speak(s);
  }

  /** Adopt this user's most recent answer that was never heard to the end (the session timed out first). */
  private pickUp(s: Session, now: number): void {
    let best: Session | null = null;
    for (const o of this.sessions.values()) {
      if (o === s || o.userId !== s.userId || !o.chat || !o.asked || now - o.last > this.cfg.pickupMs) continue;
      const unheard = !o.chat.turnDone || o.chat.turnText.slice(o.spoken).trim() !== '';
      if (unheard && (!best || o.last > best.last)) best = o;
    }
    if (!best) return;
    s.chat = best.chat;
    s.spoken = best.spoken;
    s.asked = true;
    s.cued = best.cued;
    this.sessions.delete(best.id);
    this.log('ALEXA: picked up an unheard answer from an earlier session');
  }

  /** Build the response from whatever part of the answer is ready and not yet spoken. */
  private speak(s: Session): Said {
    const chat = s.chat!;
    const done = chat.turnDone;
    const chunk = nextChunk(chat.turnText, s.spoken, done, this.cfg.chunkChars);
    const piece = toSpeech(chat.turnText.slice(s.spoken, chunk.end));
    s.spoken = chunk.end;

    if (piece !== '') {
      // an error after some text is reported on the next Continue
      const more = chunk.more || (done && chat.turnError !== null);
      if (!more) return { reply: this.ssml(piece, { reprompt: 'Anything else?', session: s }), chars: piece.length, outcome: 'answer complete' };
      const cue = s.cued ? 'Say continue.' : done ? 'Say continue for more.' : 'Say continue for the rest.';
      s.cued = true;
      return {
        reply: this.ssml(`${piece}\n\n${cue}`, { reprompt: 'Say continue to hear the rest.', session: s }),
        chars: piece.length,
        outcome: done ? 'chunk, more waiting' : 'partial, still running',
      };
    }
    if (!done) {
      const line = `${chat.turnStatus.startsWith('Searching') ? 'Still searching.' : 'Still thinking.'} Say continue in a moment.`;
      return { reply: this.plain(line, { reprompt: 'Say continue to hear the rest.', session: s }), chars: 0, outcome: 'nothing ready yet' };
    }
    const err = chat.turnError;
    if (err) {
      let line = 'Something went wrong on the server. Try again.';
      if (err.kind === 'rate_limit') line = err.resetsAt ? `Claude's usage limit is reached. It resets at ${istTime(err.resetsAt)}.` : "Claude's usage limit is reached. Try again later.";
      else if (err.kind === 'auth') line = 'The Claude login on the server has expired.';
      else if (err.kind === 'overloaded') line = 'Claude is overloaded right now. Try again in a minute.';
      chat.turnError = null; // said once
      if (err.kind === 'auth') {
        this.sessions.delete(s.id);
        return { reply: this.plain(line, { end: true }), chars: 0, outcome: 'error auth' };
      }
      return { reply: this.plain(line, { reprompt: 'Anything else?', session: s }), chars: 0, outcome: `error ${err.kind}` };
    }
    if (chat.turnText.trim() === '') {
      return { reply: this.plain("I didn't get an answer. Try asking again.", { reprompt: 'What would you like to ask?', session: s }), chars: 0, outcome: 'empty answer' };
    }
    return { reply: this.plain("That's everything.", { reprompt: 'Anything else?', session: s }), chars: 0, outcome: 'nothing left' };
  }

  private fresh(id: string, userId: string, now: number): Session {
    const s: Session = { id, userId, chat: null, spoken: 0, asked: false, cued: false, last: now };
    this.sessions.set(id, s);
    return s;
  }

  /** This request's session; after a relay restart it is rebuilt from the attributes Alexa echoes back. */
  private session(body: any, id: string, userId: string, now: number): Session {
    const known = this.sessions.get(id);
    if (known) {
      known.last = now;
      return known;
    }
    const s = this.fresh(id, userId, now);
    const attrs = body?.session?.attributes;
    if (typeof attrs?.chatId === 'string') {
      s.chat = this.deps.getChat(attrs.chatId);
      if (s.chat) {
        s.asked = true;
        const at = Number(attrs.at) || 0;
        s.spoken = at <= s.chat.turnText.length ? at : 0;
      }
    }
    return s;
  }

  private sweep(now: number): void {
    const keep = this.cfg.pickupMs + 5 * 60_000;
    for (const [id, s] of this.sessions) if (now - s.last > keep) this.sessions.delete(id);
  }

  private empty(): AlexaReply {
    return { status: 200, body: { version: '1.0', response: {} } };
  }

  private plain(text: string, opts: { end?: boolean; reprompt?: string; session?: Session } = {}): AlexaReply {
    return this.respond({ type: 'PlainText', text }, opts);
  }

  private ssml(speech: string, opts: { end?: boolean; reprompt?: string; session?: Session } = {}): AlexaReply {
    return this.respond({ type: 'SSML', ssml: toSsml(speech) }, opts);
  }

  private respond(outputSpeech: object, opts: { end?: boolean; reprompt?: string; session?: Session }): AlexaReply {
    const response: Record<string, unknown> = { outputSpeech, shouldEndSession: opts.end ?? false };
    if (opts.reprompt && !opts.end) response.reprompt = { outputSpeech: { type: 'PlainText', text: opts.reprompt } };
    const body: Record<string, unknown> = { version: '1.0', response };
    const s = opts.session;
    if (s?.chat && !opts.end) body.sessionAttributes = { chatId: s.chat.id, at: s.spoken };
    return { status: 200, body };
  }
}
