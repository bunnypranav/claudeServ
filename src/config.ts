import { homedir } from 'node:os';
import { join } from 'node:path';

export type Model = 'haiku' | 'sonnet' | 'opus';

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus'];

/** "use sonnet", "switch to opus": answered by the relay itself, on every client */
export const MODEL_COMMAND = /^\s*(?:please\s+)?(?:use|switch to|change to)\s+(haiku|sonnet|opus)\b[\s.!]*$/i;

/**
 * One kind of client. Each has its own token, system prompt and working
 * directory; the working directory decides where Claude Code keeps the
 * transcripts, so a profile can only ever resume its own chats.
 */
export interface Profile {
  name: string;
  token: string;
  promptFile: string;
  workDir: string;
  /** a chat's process is stopped after this long without a turn; it resumes on demand */
  idleMs: number;
}

/** The Alexa skill's route; it has no bearer token, so it is guarded by Amazon's request signature and these ids. */
export interface AlexaConfig {
  /** amzn1.ask.skill.…; requests for any other skill are refused */
  skillId: string;
  /** amzn1.ask.account.… ids allowed to use the skill; empty means nobody yet (enrollment) */
  userIds: string[];
  /** prompt, work directory and idle time of Alexa chats; its empty token is never offered to the guard */
  profile: Profile;
  /** model of a new Alexa chat */
  model: Model;
  /** the response must leave this long after the request arrived (Alexa gives up at about 8 s) */
  deadlineMs: number;
  /** say "One moment" if no text has arrived by then */
  progressiveAfterMs: number;
  /** most characters spoken in one response before "say continue" */
  chunkChars: number;
  /** how long an unheard answer can be picked up from a new session */
  pickupMs: number;
}

export interface Config {
  profiles: Profile[];
  /** null unless ALEXA_SKILL_ID is set */
  alexa: AlexaConfig | null;
  host: string;
  port: number;
  claudeBin: string;
  defaultModel: Model;
  /** most `claude` processes kept running at once, across all profiles; Nest has 2 GB for everything */
  maxLive: number;
  /** blast-radius cap: most turns accepted per rolling hour, across all profiles */
  turnsPerHour: number;
}

function env(name: string, fallback?: string): string {
  const v = process.env[name] ?? fallback;
  if (v === undefined || v === '') {
    console.error(`missing required environment variable ${name}`);
    process.exit(1);
  }
  return v;
}

function token(name: string, required: boolean): string | null {
  const v = process.env[name];
  if (!v) {
    if (required) env(name);
    return null;
  }
  if (v.length < 32) {
    console.error(`${name} must be at least 32 characters`);
    process.exit(1);
  }
  return v;
}

export function loadConfig(): Config {
  const here = new URL('..', import.meta.url).pathname;
  const model = env('DEFAULT_MODEL', 'sonnet') as Model;
  if (!MODELS.includes(model)) {
    console.error(`DEFAULT_MODEL must be one of ${MODELS.join(', ')}`);
    process.exit(1);
  }
  const idleMinutes = Number(env('IDLE_MINUTES', '10'));

  // The watch keeps the original RELAY_TOKEN; other clients are optional.
  const profiles: Profile[] = [
    {
      name: 'watch',
      token: token('RELAY_TOKEN', true)!,
      promptFile: env('CLAUDE_PROMPT_FILE', join(here, 'watch.md')),
      workDir: env('CLAUDE_WORKDIR', '/srv/claudeserv/work'),
      idleMs: idleMinutes * 60_000,
    },
  ];
  const car = token('RELAY_TOKEN_CAR', false);
  if (car) {
    profiles.push({
      name: 'car',
      token: car,
      promptFile: env('CAR_PROMPT_FILE', join(here, 'car.md')),
      workDir: env('CAR_WORKDIR', '/srv/claudeserv/work-car'),
      // drives come in bursts; free the memory sooner
      idleMs: Number(env('CAR_IDLE_MINUTES', '5')) * 60_000,
    });
  }
  if (new Set(profiles.map((p) => p.token)).size !== profiles.length) {
    console.error('every client needs its own token');
    process.exit(1);
  }

  const skillId = process.env.ALEXA_SKILL_ID ?? '';
  const alexaModel = env('ALEXA_MODEL', 'haiku') as Model;
  if (!MODELS.includes(alexaModel)) {
    console.error(`ALEXA_MODEL must be one of ${MODELS.join(', ')}`);
    process.exit(1);
  }
  const alexa: AlexaConfig | null = skillId
    ? {
        skillId,
        userIds: (process.env.ALEXA_USER_IDS ?? '').split(',').map((s) => s.trim()).filter(Boolean),
        profile: {
          name: 'alexa',
          token: '',
          promptFile: env('ALEXA_PROMPT_FILE', join(here, 'alexa.md')),
          workDir: env('ALEXA_WORKDIR', '/srv/claudeserv/work-alexa'),
          // sessions are short; the answer text outlives the process, so pickup still works
          idleMs: Number(env('ALEXA_IDLE_MINUTES', '3')) * 60_000,
        },
        model: alexaModel,
        deadlineMs: Number(env('ALEXA_DEADLINE_MS', '6500')),
        progressiveAfterMs: Number(env('ALEXA_PROGRESSIVE_AFTER_MS', '2000')),
        chunkChars: Number(env('ALEXA_CHUNK_CHARS', '900')),
        pickupMs: Number(env('ALEXA_PICKUP_MINUTES', '10')) * 60_000,
      }
    : null;

  return {
    profiles,
    alexa,
    host: env('RELAY_HOST', '127.0.0.1'),
    port: Number(env('RELAY_PORT', '8787')),
    claudeBin: env('CLAUDE_BIN', join(homedir(), '.local/bin/claude')),
    defaultModel: model,
    maxLive: Number(env('MAX_LIVE', '2')),
    turnsPerHour: Number(env('MAX_TURNS_PER_HOUR', '60')),
  };
}
