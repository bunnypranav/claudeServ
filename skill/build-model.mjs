#!/usr/bin/env node
// Generates, from carriers.json:
//   skill/interaction-model.en-IN.json   uploaded to Alexa
//   src/alexa/intents.json               intent name -> the carrier words the handler puts back
// AMAZON.SearchQuery drops the carrier words from the slot value, so every carrier
// gets its own intent and the handler rebuilds the text as prefix + " " + query.
// Run after editing carriers.json:  node skill/build-model.mjs
import { readFileSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const src = JSON.parse(readFileSync(new URL('carriers.json', here), 'utf8'));

/** Intent names may only hold letters and underscores. */
export const intentName = (carrier) => 'Q_' + carrier.toLowerCase().replace(/'/g, '').replace(/[^a-z]+/g, '_');

export function build(c = src) {
  const slot = [{ name: 'query', type: 'AMAZON.SearchQuery' }];
  const prefixes = {};
  const intents = [];
  for (const carrier of c.carriers) {
    const name = intentName(carrier);
    if (name in prefixes) throw new Error(`two carriers map to ${name}`);
    prefixes[name] = carrier;
    intents.push({ name, slots: slot, samples: [`${carrier} {query}`] });
  }
  prefixes.Q_plain = '';
  intents.push({ name: 'Q_plain', slots: slot, samples: c.plain.map((p) => `${p} {query}`) });
  intents.push({ name: 'ContinueIntent', slots: [], samples: c.continue });
  for (const name of c.builtins) intents.push({ name, samples: [] });
  const model = { interactionModel: { languageModel: { invocationName: c.invocationName, intents, types: [] } } };
  return { model, prefixes };
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('build-model.mjs')) {
  const { model, prefixes } = build();
  writeFileSync(new URL(`interaction-model.${src.locale}.json`, here), JSON.stringify(model, null, 2) + '\n');
  writeFileSync(new URL('../src/alexa/intents.json', here), JSON.stringify(prefixes, null, 2) + '\n');
  console.log(`${model.interactionModel.languageModel.intents.length} intents, ${Object.keys(prefixes).length} with a query`);
}
