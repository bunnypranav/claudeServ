import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { rebuild } from '../src/alexa/handler.ts';
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

describe('rebuild', () => {
  it('puts the carrier words back', () => {
    assert.equal(rebuild('Q_why', 'is the sky blue'), 'why is the sky blue');
    assert.equal(rebuild('Q_whats', 'the time in Tokyo'), "what's the time in Tokyo");
    assert.equal(rebuild('Q_tell_me', 'a joke'), 'tell me a joke');
    assert.equal(rebuild('Q_plain', 'the capital of France'), 'the capital of France');
    assert.equal(rebuild('ContinueIntent', undefined), null);
  });
});
