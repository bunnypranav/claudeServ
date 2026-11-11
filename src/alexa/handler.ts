import type { AlexaConfig } from '../config.ts';
import prefixes from './intents.json' with { type: 'json' };

/*
 * Phase 1 spike: answers every verified Alexa request with an echo of what was
 * heard, so the interaction model, the carrier-word rebuild and the round-trip
 * time can be checked before Claude is wired in.
 */

const PREFIX: Record<string, string> = prefixes;
const CONTINUE = new Set(['ContinueIntent', 'AMAZON.YesIntent', 'AMAZON.NextIntent', 'AMAZON.ResumeIntent']);

export interface AlexaReply {
  status: 200 | 400;
  body?: object;
}

function speak(text: string, opts: { end?: boolean; reprompt?: string } = {}): AlexaReply {
  const response: Record<string, unknown> = {
    outputSpeech: { type: 'PlainText', text },
    shouldEndSession: opts.end ?? false,
  };
  if (opts.reprompt && !opts.end) response.reprompt = { outputSpeech: { type: 'PlainText', text: opts.reprompt } };
  return { status: 200, body: { version: '1.0', response } };
}

/** The text the user said: the carrier words Alexa swallowed, put back in front of the slot value. */
export function rebuild(intent: string, query: string | undefined): string | null {
  if (!(intent in PREFIX)) return null;
  return [PREFIX[intent], (query ?? '').trim()].filter(Boolean).join(' ');
}

export class AlexaHandler {
  private cfg: AlexaConfig;
  private log: (msg: string) => void;
  private seenUnknown = new Set<string>();

  constructor(cfg: AlexaConfig, log: (msg: string) => void) {
    this.cfg = cfg;
    this.log = log;
  }

  /** `body` has already passed signature verification. */
  handle(body: any, received: number): AlexaReply {
    const system = body?.context?.System;
    const appId = system?.application?.applicationId ?? body?.session?.application?.applicationId;
    if (appId !== this.cfg.skillId) {
      this.log('ALEXA: request for another skill refused');
      return { status: 400 };
    }
    const req = body.request ?? {};
    const userId: string = system?.user?.userId ?? body?.session?.user?.userId ?? '';
    // how long Alexa's cloud took to reach us (its clock vs ours, so only a rough figure)
    const lag = received - Date.parse(req.timestamp);
    const what = req.type === 'IntentRequest' ? `intent ${req.intent?.name}` : req.type;

    if (!this.cfg.userIds.includes(userId)) {
      if (!this.seenUnknown.has(userId)) {
        this.seenUnknown.add(userId);
        // Enrollment: copy this id into ALEXA_USER_IDS to allow the account.
        this.log(`ALEXA: user not on the allowlist: ${userId}`);
      }
      if (req.type === 'SessionEndedRequest') return { status: 200, body: { version: '1.0', response: {} } };
      return speak("This skill isn't set up yet.", { end: true });
    }

    const reply = this.route(req, received);
    this.log(`ALEXA: ${what}, lag ${lag} ms, handled in ${Date.now() - received} ms`);
    return reply;
  }

  private route(req: any, received: number): AlexaReply {
    switch (req.type) {
      case 'LaunchRequest':
        return speak("Hi, what's your question?", { reprompt: 'What would you like to ask?' });

      case 'SessionEndedRequest':
        if (req.reason === 'ERROR') this.log(`ALEXA: session error ${req.error?.type}: ${req.error?.message}`);
        else this.log(`ALEXA: session ended (${req.reason})`);
        return { status: 200, body: { version: '1.0', response: {} } };

      case 'IntentRequest': {
        const name: string = req.intent?.name ?? '';
        const text = rebuild(name, req.intent?.slots?.query?.value);
        if (text !== null) {
          return speak(`You said: ${text}. That took ${Date.now() - received} milliseconds.`, { reprompt: 'Anything else?' });
        }
        if (CONTINUE.has(name)) return speak('Continue heard. There is nothing waiting yet.', { reprompt: 'Anything else?' });
        if (name === 'AMAZON.StopIntent' || name === 'AMAZON.CancelIntent' || name === 'AMAZON.NavigateHomeIntent') {
          return speak('Okay.', { end: true });
        }
        if (name === 'AMAZON.HelpIntent') {
          return speak('Ask me anything, starting with words like what, how, or tell me. Say continue to hear more of a long answer, or stop to finish.', {
            reprompt: 'What would you like to ask?',
          });
        }
        if (name === 'AMAZON.FallbackIntent') this.log('ALEXA: fallback (heard something that matched no carrier)');
        return speak('Sorry, I missed that. Try starting with what, how, or tell me.', { reprompt: 'What would you like to ask?' });
      }

      default:
        return { status: 200, body: { version: '1.0', response: {} } };
    }
  }
}
