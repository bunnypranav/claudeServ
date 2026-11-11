import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { AlexaHandler, rebuild } from '../src/alexa/handler.ts';
// @ts-expect-error plain .mjs without types
import { build } from '../skill/build-model.mjs';

const read = (p: string) => JSON.parse(readFileSync(new URL(p, import.meta.url), 'utf8'));

describe('interaction model', () => {
  const { model, prefixes } = build();
  const intents: { name: string; samples: string[]; slots?: unknown[] }[] = model.interactionModel.languageModel.intents;

  it('matches the generated files (run `npm run model` after editing carriers.json)', () => {
    assert.deepEqual(read('../skill/interaction-model.en-IN.json'), model);
    assert.deepEqual(read('../src/alexa/intents.json'), prefixes);
  });

  it('has exactly one prefix per query intent', () => {
    const withQuery = intents.filter((i) => i.samples.some((s) => s.includes('{query}'))).map((i) => i.name).sort();
    assert.deepEqual(withQuery, Object.keys(prefixes).sort());
  });

  it('follows the AMAZON.SearchQuery rules', () => {
    for (const i of intents) {
      assert.match(i.name, /^(AMAZON\.[A-Za-z]+|[A-Za-z_]+)$/);
      for (const s of i.samples) {
        if (!s.includes('{query}')) continue;
        assert.ok(s.endsWith(' {query}') && s.length > ' {query}'.length, `"${s}" needs a carrier phrase before the slot`);
        assert.equal(s.match(/\{/g)!.length, 1, `"${s}" may hold only the query slot`);
      }
    }
  });
});

describe('echo handler', () => {
  it('puts the carrier words back', () => {
    assert.equal(rebuild('Q_why', 'is the sky blue'), 'why is the sky blue');
    assert.equal(rebuild('Q_whats', 'the time in Tokyo'), "what's the time in Tokyo");
    assert.equal(rebuild('Q_tell_me', 'a joke'), 'tell me a joke');
    assert.equal(rebuild('Q_plain', 'the capital of France'), 'the capital of France');
    assert.equal(rebuild('ContinueIntent', undefined), null);
  });

  const SKILL = 'amzn1.ask.skill.test';
  const USER = 'amzn1.ask.account.TEST';
  const request = (request: object, userId = USER, applicationId = SKILL) => ({
    version: '1.0',
    context: { System: { application: { applicationId }, user: { userId } } },
    request: { timestamp: new Date().toISOString(), ...request },
  });
  const said = (r: { body?: any }) => r.body?.response?.outputSpeech?.text as string;

  it('refuses other skills, and holds unknown users at the door while logging their id once', () => {
    const logs: string[] = [];
    const h = new AlexaHandler({ skillId: SKILL, userIds: [USER] }, (m) => logs.push(m));
    assert.equal(h.handle(request({ type: 'LaunchRequest' }, USER, 'amzn1.ask.skill.other'), Date.now()).status, 400);
    for (let n = 0; n < 2; n++) {
      const r = h.handle(request({ type: 'LaunchRequest' }, 'amzn1.ask.account.STRANGER'), Date.now());
      assert.match(said(r), /isn't set up/);
      assert.equal((r.body as any).response.shouldEndSession, true);
    }
    assert.equal(logs.filter((l) => l.includes('amzn1.ask.account.STRANGER')).length, 1);
  });

  it('echoes questions and never logs their text', () => {
    const logs: string[] = [];
    const h = new AlexaHandler({ skillId: SKILL, userIds: [USER] }, (m) => logs.push(m));
    const r = h.handle(request({ type: 'IntentRequest', intent: { name: 'Q_why', slots: { query: { value: 'is the sky blue' } } } }), Date.now());
    assert.match(said(r), /^You said: why is the sky blue\./);
    assert.equal((r.body as any).response.shouldEndSession, false);
    assert.ok(!logs.join('\n').includes('sky'));
    assert.equal((h.handle(request({ type: 'IntentRequest', intent: { name: 'AMAZON.StopIntent' } }), Date.now()).body as any).response.shouldEndSession, true);
    assert.match(said(h.handle(request({ type: 'IntentRequest', intent: { name: 'AMAZON.FallbackIntent' } }), Date.now())), /missed that/);
  });
});
