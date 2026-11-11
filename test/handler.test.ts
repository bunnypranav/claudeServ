import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { ChatEvent, ErrorKind } from '../src/chat.ts';
import type { AlexaConfig, Model } from '../src/config.ts';
import { AlexaHandler, type AlexaChat, type Progressive } from '../src/alexa/handler.ts';

const SKILL = 'amzn1.ask.skill.test';
const USER = 'amzn1.ask.account.TEST';
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const CFG: AlexaConfig = {
  skillId: SKILL,
  userIds: [USER],
  profile: { name: 'alexa', token: '', promptFile: 'alexa.md', workDir: '.', idleMs: 60_000 },
  model: 'haiku',
  deadlineMs: 150,
  progressiveAfterMs: 40,
  chunkChars: 80,
  pickupMs: 60_000,
};

/** Stands in for a Chat: `plan` runs when a question is sent and plays out Claude's side. */
class FakeChat implements AlexaChat {
  static seq = 0;
  readonly id = `chat-${++FakeChat.seq}`;
  model: Model = 'haiku';
  busy = false;
  turnText = '';
  turnDone = true;
  turnError: Extract<ChatEvent, { type: 'error' }> | null = null;
  turnStatus = '';
  sent: string[] = [];
  cancels = 0;
  warmed = 0;
  /** an interrupt is honoured unless this is set */
  stuck = false;
  plan: (c: FakeChat, text: string) => void = () => {};
  private listener: ((e: ChatEvent) => void) | null = null;

  attach(fn: (e: ChatEvent) => void): () => void {
    this.listener = fn;
    return () => {
      if (this.listener === fn) this.listener = null;
    };
  }
  send(text: string): void {
    this.sent.push(text);
    this.busy = true;
    this.turnText = '';
    this.turnDone = false;
    this.turnError = null;
    this.turnStatus = '';
    this.plan(this, text);
  }
  cancel(): void {
    this.cancels++;
    if (this.busy && !this.stuck) setTimeout(() => this.finish(true), 5);
  }
  setModel(model: Model): void {
    this.model = model;
  }
  warm(): void {
    this.warmed++;
  }
  // Claude's side
  delta(text: string): void {
    this.turnText += text;
    this.listener?.({ type: 'delta', text });
  }
  status(text: string): void {
    this.turnStatus = text;
    this.listener?.({ type: 'status', text });
  }
  finish(cancelled = false): void {
    this.busy = false;
    this.turnDone = true;
    this.listener?.({ type: 'done', ms: 0, cancelled });
  }
  fail(kind: ErrorKind, resetsAt?: number): void {
    this.busy = false;
    this.turnDone = true;
    this.turnError = { type: 'error', kind, message: 'x', resetsAt };
    this.listener?.(this.turnError);
  }
}

function setup(plan: FakeChat['plan'] = () => {}, cfg: Partial<AlexaConfig> = {}) {
  const logs: string[] = [];
  const chats: FakeChat[] = [];
  const progressives: Progressive[] = [];
  const state = { turnsLeft: 100 };
  const handler = new AlexaHandler(
    { ...CFG, ...cfg },
    {
      log: (m) => logs.push(m),
      createChat: () => {
        const c = new FakeChat();
        c.plan = plan;
        chats.push(c);
        return c;
      },
      getChat: (id) => chats.find((c) => c.id === id) ?? null,
      makeRoom: () => {},
      takeTurn: () => state.turnsLeft-- > 0,
      progressive: (p) => progressives.push(p),
    },
  );
  let attributes: object | undefined;
  /** Send one request the way Alexa would, echoing back the session attributes of the last response. */
  const send = async (request: object, opts: { session?: string; isNew?: boolean; user?: string; skill?: string } = {}) => {
    const body = {
      version: '1.0',
      // a new session starts without attributes
      session: { sessionId: opts.session ?? 'S1', new: opts.isNew ?? false, attributes: opts.isNew ? undefined : attributes },
      context: { System: { application: { applicationId: opts.skill ?? SKILL }, user: { userId: opts.user ?? USER }, apiEndpoint: 'https://api.eu.amazonalexa.com', apiAccessToken: 'tok' } },
      request: { requestId: 'R1', timestamp: new Date().toISOString(), ...request },
    };
    const started = Date.now();
    const reply = await handler.handle(body, started);
    const r = (reply.body as any)?.response ?? {};
    if ((reply.body as any)?.sessionAttributes) attributes = (reply.body as any).sessionAttributes;
    return {
      status: reply.status,
      said: (r.outputSpeech?.ssml ?? r.outputSpeech?.text ?? '') as string,
      reprompt: (r.reprompt?.outputSpeech?.text ?? '') as string,
      ends: r.shouldEndSession as boolean | undefined,
      attributes: (reply.body as any)?.sessionAttributes,
      ms: Date.now() - started,
    };
  };
  const ask = (intent: string, query: string, opts = {}) => send({ type: 'IntentRequest', intent: { name: intent, slots: { query: { value: query } } } }, opts);
  const intent = (name: string, opts = {}) => send({ type: 'IntentRequest', intent: { name } }, opts);
  return { handler, logs, chats, progressives, state, send, ask, intent };
}

describe('questions against the deadline', () => {
  it('speaks a finished answer in one response, with the carrier word put back', async () => {
    const t = setup((c) => setTimeout(() => (c.delta('Canberra is the capital of Australia.'), c.finish()), 10));
    const r = await t.ask('Q_what', 'is the capital of Australia');
    assert.deepEqual(t.chats[0].sent, ['what is the capital of Australia']);
    assert.equal(r.said, '<speak>Canberra is the capital of Australia.</speak>');
    assert.equal(r.reprompt, 'Anything else?');
    assert.equal(r.ends, false);
    assert.ok(r.ms < CFG.deadlineMs, `answered in ${r.ms} ms`);
    assert.equal(t.progressives.length, 0);
    assert.deepEqual(r.attributes, { chatId: t.chats[0].id, at: 37 });
  });

  it('at the deadline speaks the complete sentences, then the rest on Continue', async () => {
    const t = setup((c) => setTimeout(() => c.delta('The first sentence is ready. The second is half wr'), 10));
    const r = await t.ask('Q_why', 'is the sky blue');
    assert.equal(r.said, '<speak>The first sentence is ready.<break time="300ms"/>Say continue for the rest.</speak>');
    assert.equal(r.reprompt, 'Say continue to hear the rest.');
    assert.ok(r.ms >= CFG.deadlineMs - 10 && r.ms < CFG.deadlineMs + 100, `took ${r.ms} ms`);

    // the turn kept running while Alexa was speaking
    t.chats[0].delta('itten now. And a third.');
    t.chats[0].finish();
    const more = await t.intent('ContinueIntent');
    assert.equal(more.said, '<speak>The second is half written now. And a third.</speak>');
    assert.equal(more.reprompt, 'Anything else?');
    assert.ok(more.ms < 50);
    assert.equal((await t.intent('AMAZON.YesIntent')).said, "That's everything.");
  });

  it('says it is still searching when nothing is ready, after a progressive response', async () => {
    const t = setup((c) => setTimeout(() => c.status('Searching the web…'), 10));
    const r = await t.ask('Q_who', 'won the race');
    assert.equal(r.said, 'Still searching. Say continue in a moment.');
    assert.equal(r.reprompt, 'Say continue to hear the rest.');
    assert.deepEqual(t.progressives.map((p) => p.text), ['Searching the web.']);
    assert.equal(t.progressives[0].endpoint, 'https://api.eu.amazonalexa.com');
  });

  it('says one moment when no text has come after a while, and still thinking at the deadline', async () => {
    const t = setup();
    const r = await t.ask('Q_how', 'does it work');
    assert.equal(r.said, 'Still thinking. Say continue in a moment.');
    assert.deepEqual(t.progressives.map((p) => p.text), ['One moment.']);
  });

  it('sends no progressive response once text is flowing', async () => {
    const t = setup((c) => setTimeout(() => c.delta('Starting to ans'), 10));
    await t.ask('Q_how', 'does it work');
    assert.equal(t.progressives.length, 0);
  });

  it('reads a long answer in chunks with a shorter cue after the first', async () => {
    const answer = 'Sentence number one is here. Sentence number two is here. Sentence number three is here. Sentence number four is here. Sentence number five is here.';
    const t = setup((c) => setTimeout(() => (c.delta(answer), c.finish()), 5));
    const a = await t.ask('Q_tell_me', 'a long story');
    assert.equal(a.said, '<speak>Sentence number one is here. Sentence number two is here.<break time="300ms"/>Say continue for more.</speak>');
    const b = await t.intent('ContinueIntent');
    assert.equal(b.said, '<speak>Sentence number three is here. Sentence number four is here.<break time="300ms"/>Say continue.</speak>');
    const c = await t.intent('AMAZON.NextIntent');
    assert.equal(c.said, '<speak>Sentence number five is here.</speak>');
    assert.equal(c.reprompt, 'Anything else?');
  });

  it('strips markdown and escapes SSML in what it speaks', async () => {
    const t = setup((c) => setTimeout(() => (c.delta('**AT&T** is a <big> company.'), c.finish()), 5));
    assert.equal((await t.ask('Q_what', 'is AT and T')).said, '<speak>AT&amp;T is a &lt;big&gt; company.</speak>');
  });
});

describe('continue', () => {
  it('waits for the next sentences when none are ready yet', async () => {
    const t = setup((c) => setTimeout(() => c.delta('One is done. Two is'), 10));
    await t.ask('Q_why', 'x');
    setTimeout(() => (t.chats[0].delta(' done as well.'), t.chats[0].finish()), 40);
    const r = await t.intent('ContinueIntent');
    assert.equal(r.said, '<speak>Two is done as well.</speak>');
    assert.ok(r.ms >= 30 && r.ms < CFG.deadlineMs, `took ${r.ms} ms`);
  });

  it('gives up at the deadline if still nothing is ready', async () => {
    const t = setup();
    await t.ask('Q_why', 'x');
    const r = await t.intent('ContinueIntent');
    assert.equal(r.said, 'Still thinking. Say continue in a moment.');
    assert.ok(r.ms >= CFG.deadlineMs - 10);
  });

  it('has nothing to continue before any question', async () => {
    const t = setup();
    await t.send({ type: 'LaunchRequest' }, { isNew: true });
    assert.equal((await t.intent('ContinueIntent')).said, "There's nothing waiting. What's your question?");
  });
});

describe('moving on, stopping and session ends', () => {
  it('cancels the running turn when a new question comes', async () => {
    const t = setup((c, text) => {
      if (text.startsWith('what')) setTimeout(() => (c.delta('Second answer.'), c.finish()), 10);
    });
    await t.ask('Q_why', 'is it slow');
    const r = await t.ask('Q_what', 'about this');
    assert.equal(t.chats.length, 1);
    assert.equal(t.chats[0].cancels, 1);
    assert.deepEqual(t.chats[0].sent, ['why is it slow', 'what about this']);
    assert.equal(r.said, '<speak>Second answer.</speak>');
  });

  it('starts a new chat if the old turn will not stop', async () => {
    // waiting for the old turn to stop takes a second out of the budget
    const t = setup(
      (c) => {
        if (c.stuck) return;
        setTimeout(() => (c.delta('Fresh answer.'), c.finish()), 10);
      },
      { deadlineMs: 1_400 },
    );
    await t.send({ type: 'LaunchRequest' }, { isNew: true });
    t.chats[0].stuck = true;
    await t.ask('Q_why', 'is it stuck');
    const r = await t.ask('Q_what', 'now');
    assert.equal(t.chats.length, 2);
    assert.equal(r.said, '<speak>Fresh answer.</speak>');
  });

  it('cancels the turn and ends the session on Stop', async () => {
    const t = setup();
    await t.ask('Q_why', 'x');
    const r = await t.intent('AMAZON.StopIntent');
    assert.equal(r.said, 'Okay.');
    assert.equal(r.ends, true);
    assert.equal(t.chats[0].cancels, 1);
    assert.ok(t.logs.some((l) => l.includes('turn cancelled')));
  });

  it('picks up an unheard answer after the session timed out', async () => {
    const t = setup((c) => setTimeout(() => c.delta('Part one is here. Part two is'), 10));
    await t.ask('Q_tell_me', 'something', { session: 'A' });
    const ended = await t.send({ type: 'SessionEndedRequest', reason: 'EXCEEDED_MAX_REPROMPTS' }, { session: 'A' });
    assert.equal(ended.said, '');
    assert.equal(t.chats[0].cancels, 0, 'the turn is left running');
    t.chats[0].delta(' here too.');
    t.chats[0].finish();

    const r = await t.intent('ContinueIntent', { session: 'B', isNew: true });
    assert.equal(r.said, '<speak>Part two is here too.</speak>');
    assert.equal(t.chats.length, 1);
    // and it is a normal session from here on
    assert.equal((await t.intent('ContinueIntent', { session: 'B' })).said, "That's everything.");
  });

  it('has nothing to pick up after the user ended the session, or for another user', async () => {
    const t = setup((c) => setTimeout(() => c.delta('Part one is here. Part two is'), 10));
    await t.ask('Q_tell_me', 'something', { session: 'A' });
    assert.match((await t.intent('ContinueIntent', { session: 'X', isNew: true, user: 'amzn1.ask.account.OTHER' })).said, /isn't set up/);
    await t.send({ type: 'SessionEndedRequest', reason: 'USER_INITIATED' }, { session: 'A' });
    assert.equal(t.chats[0].cancels, 1);
    assert.equal((await t.intent('ContinueIntent', { session: 'B', isNew: true })).said, "There's nothing waiting. What's your question?");
  });

  it('does not pick up an answer older than the pickup window', async () => {
    const t = setup((c) => setTimeout(() => c.delta('Part one is here. Part two is'), 5), { pickupMs: 20, deadlineMs: 30 });
    await t.ask('Q_tell_me', 'something', { session: 'A' });
    await sleep(40);
    assert.equal((await t.intent('ContinueIntent', { session: 'B', isNew: true })).said, "There's nothing waiting. What's your question?");
  });

  it('finds its chat again from the session attributes after a restart', async () => {
    const t = setup((c) => setTimeout(() => (c.delta('An answer.'), c.finish()), 5));
    await t.ask('Q_what', 'is this');
    // a second handler has no sessions in memory, like the relay after a restart
    (t.handler as any).sessions.clear();
    await t.ask('Q_and', 'then', {});
    assert.equal(t.chats.length, 1, 'the follow-up went to the same chat');
  });
});

describe('errors and limits', () => {
  const failing = (kind: ErrorKind, resetsAt?: number) => setup((c) => setTimeout(() => c.fail(kind, resetsAt), 5));

  it('speaks each error kind', async () => {
    assert.equal((await failing('overloaded').ask('Q_why', 'x')).said, 'Claude is overloaded right now. Try again in a minute.');
    assert.equal((await failing('server').ask('Q_why', 'x')).said, 'Something went wrong on the server. Try again.');
    assert.equal((await failing('rate_limit').ask('Q_why', 'x')).said, "Claude's usage limit is reached. Try again later.");
    // 2026-11-11 10:00 UTC is 3:30 pm in India
    const limited = await failing('rate_limit', Date.UTC(2026, 10, 11, 10, 0) / 1000).ask('Q_why', 'x');
    assert.match(limited.said, /^Claude's usage limit is reached\. It resets at 3:30 pm\.$/i);
    assert.equal(limited.ends, false);
    assert.equal(limited.reprompt, 'Anything else?');
  });

  it('ends the session when the Claude login has expired', async () => {
    const r = await failing('auth').ask('Q_why', 'x');
    assert.equal(r.said, 'The Claude login on the server has expired.');
    assert.equal(r.ends, true);
  });

  it('refuses a question past the hourly cap without calling Claude', async () => {
    const t = setup();
    t.state.turnsLeft = 0;
    const r = await t.ask('Q_why', 'x');
    assert.equal(r.said, "That's the hourly limit for this relay. Try again later.");
    assert.equal(t.chats.length, 0);
  });

  it('switches model without using a turn', async () => {
    const t = setup();
    await t.send({ type: 'LaunchRequest' }, { isNew: true });
    t.state.turnsLeft = 0;
    assert.equal((await t.ask('Q_use', 'sonnet')).said, 'Switched to Sonnet.');
    assert.equal(t.chats[0].model, 'sonnet');
    assert.equal((await t.ask('Q_switch', 'to opus')).said, 'Switched to Opus.');
    assert.equal(t.chats[0].sent.length, 0);
  });
});

describe('the door', () => {
  it('refuses other skills, and holds unknown users back while logging their id once', async () => {
    const t = setup();
    assert.equal((await t.send({ type: 'LaunchRequest' }, { skill: 'amzn1.ask.skill.other' })).status, 400);
    for (let n = 0; n < 2; n++) {
      const r = await t.send({ type: 'LaunchRequest' }, { user: 'amzn1.ask.account.STRANGER' });
      assert.match(r.said, /isn't set up/);
      assert.equal(r.ends, true);
    }
    assert.equal(t.logs.filter((l) => l.includes('amzn1.ask.account.STRANGER')).length, 1);
    assert.equal(t.chats.length, 0);
  });

  it('starts and warms a new chat on launch', async () => {
    const t = setup();
    const r = await t.send({ type: 'LaunchRequest' }, { isNew: true });
    assert.equal(r.said, "Hi, what's your question?");
    assert.equal(t.chats[0].warmed, 1);
    await t.send({ type: 'LaunchRequest' }, { session: 'S2', isNew: true });
    assert.equal(t.chats.length, 2, 'opening the skill again is a new chat');
  });

  it('answers help, fallback and no', async () => {
    const t = setup();
    assert.match((await t.intent('AMAZON.HelpIntent')).said, /^Ask me anything/);
    assert.match((await t.intent('AMAZON.FallbackIntent')).said, /missed that/);
    const no = await t.intent('AMAZON.NoIntent');
    assert.equal(no.said, 'Okay.');
    assert.equal(no.ends, true);
  });

  it('never logs what was asked or answered', async () => {
    const t = setup((c) => setTimeout(() => (c.delta('Rayleigh scattering does it.'), c.finish()), 5));
    await t.ask('Q_why', 'is the sky blue');
    const all = t.logs.join('\n');
    assert.ok(!/sky|Rayleigh/.test(all));
    assert.match(all, /ALEXA: intent Q_why, first text \d+ ms, responded \d+ ms, 28 chars, answer complete/);
  });
});
