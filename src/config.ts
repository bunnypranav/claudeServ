import { homedir } from 'node:os';
import { join } from 'node:path';

export type Model = 'haiku' | 'sonnet' | 'opus';

export const MODELS: readonly Model[] = ['haiku', 'sonnet', 'opus'];

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

export interface Config {
  profiles: Profile[];
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
      workDir: env('CLAUDE_WORKDIR', '/srv/claudewatch/work'),
      idleMs: idleMinutes * 60_000,
    },
  ];
  const car = token('RELAY_TOKEN_CAR', false);
  if (car) {
    profiles.push({
      name: 'car',
      token: car,
      promptFile: env('CAR_PROMPT_FILE', join(here, 'car.md')),
      workDir: env('CAR_WORKDIR', '/srv/claudewatch/work-car'),
      // drives come in bursts; free the memory sooner
      idleMs: Number(env('CAR_IDLE_MINUTES', '5')) * 60_000,
    });
  }
  if (new Set(profiles.map((p) => p.token)).size !== profiles.length) {
    console.error('every client needs its own token');
    process.exit(1);
  }

  return {
    profiles,
    host: env('RELAY_HOST', '127.0.0.1'),
    port: Number(env('RELAY_PORT', '8787')),
    claudeBin: env('CLAUDE_BIN', join(homedir(), '.local/bin/claude')),
    defaultModel: model,
    maxLive: Number(env('MAX_LIVE', '2')),
    turnsPerHour: Number(env('MAX_TURNS_PER_HOUR', '60')),
  };
}
