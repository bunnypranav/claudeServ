#!/usr/bin/env node
// Test helpers that go through Alexa's cloud with the ASK CLI (`ask configure` first).
//
//   node skill/try.mjs nlu                     which intent every carrier and Continue phrase resolves to
//   node skill/try.mjs nlu "tell me more"      the same for the given utterances
//   node skill/try.mjs say "open my robot" "why is the sky blue" stop
//                                              a real conversation: signed requests to the live relay
//
// `say` starts a new session with the first utterance and continues it with the rest.
import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const here = new URL('.', import.meta.url);
const SKILL = process.env.ALEXA_SKILL_ID ?? /amzn1\.ask\.skill\.[0-9a-f-]+/.exec(readFileSync(new URL('../README.md', here), 'utf8'))?.[0];
const carriers = JSON.parse(readFileSync(new URL('carriers.json', here), 'utf8'));
const LOCALE = carriers.locale;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ask(args) {
  const out = execSync(`ask smapi ${args}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  return JSON.parse(out.slice(out.indexOf('{')));
}
const q = (s) => `"${s.replace(/"/g, '\\"')}"`;

function nlu(utterance) {
  const r = ask(`profile-nlu --skill-id ${SKILL} --stage development --locale ${LOCALE} --utterance ${q(utterance)}`);
  const intent = r.selectedIntent ?? {};
  return { intent: intent.name, query: intent.slots?.query?.value };
}

async function say(utterance, fresh) {
  const started = Date.now();
  const sim = ask(
    `simulate-skill --skill-id ${SKILL} --stage development --device-locale ${LOCALE} --input-content ${q(utterance)}` +
      (fresh ? ' --session-mode FORCE_NEW_SESSION' : ''),
  );
  let r = sim;
  while (r.status === 'IN_PROGRESS') {
    await sleep(1000);
    r = ask(`get-skill-simulation --skill-id ${SKILL} --stage development --simulation-id ${sim.id}`);
  }
  const inv = r.result?.skillExecutionInfo?.invocations?.[0];
  const req = inv?.invocationRequest?.body?.request ?? {};
  return {
    status: r.status,
    error: r.result?.error?.message,
    request: req.type === 'IntentRequest' ? req.intent?.name : req.type,
    query: req.intent?.slots?.query?.value,
    spoken: (r.result?.alexaExecutionInfo?.alexaResponses ?? []).map((a) => a.content?.caption).join(' | '),
    ends: inv?.invocationResponse?.body?.response?.shouldEndSession,
    skillMs: inv?.metrics?.skillExecutionTimeInMilliseconds,
    totalMs: Date.now() - started,
  };
}

const [mode, ...rest] = process.argv.slice(2);
if (mode === 'nlu') {
  const sample = 'the tallest mountain in india';
  const list = rest.length
    ? rest
    : [...carriers.carriers.map((c) => `${c} ${sample}`), ...carriers.plain.map((c) => `${c} ${sample}`), ...carriers.continue, 'stop', 'help', 'banana'];
  for (const u of list) {
    const r = nlu(u);
    console.log(`${u.padEnd(48)} -> ${String(r.intent).padEnd(22)} ${r.query === undefined ? '' : JSON.stringify(r.query)}`);
  }
} else if (mode === 'say') {
  let fresh = true;
  for (const u of rest) {
    const r = await say(u, fresh);
    fresh = false;
    console.log(`> ${u}`);
    console.log(`  ${r.status}${r.error ? ' ' + r.error : ''}: ${r.request ?? '(no request)'}${r.query === undefined ? '' : ' ' + JSON.stringify(r.query)}`);
    console.log(`  says: ${r.spoken || '(nothing)'}`);
    console.log(`  ends session: ${r.ends}, skill ${r.skillMs} ms, simulation ${r.totalMs} ms`);
  }
} else {
  console.error('usage: node skill/try.mjs nlu [utterance ...] | say <utterance> [utterance ...]');
  process.exit(1);
}
