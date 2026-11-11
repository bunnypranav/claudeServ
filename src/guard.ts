import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import type { Profile } from './config.ts';

/*
 * Everything that stands between the public internet and the Claude login:
 *
 *  - a 256-bit secret per client, accepted only in the Authorization header (never
 *    in the URL, where proxies and logs would keep it), compared in constant time;
 *  - per-IP lockout after repeated bad tokens, checked before the token is looked at;
 *  - an hourly cap on turns, so even a leaked token can't drain the Pro allowance.
 */

const FAIL_WINDOW_MS = 10 * 60_000;
const FAIL_LIMIT = 5;
const BLOCK_MS = 30 * 60_000;
/** the tunnel retries a rejected upgrade once, ~0.5 s later; count such echoes as one attempt */
const ECHO_MS = 2_000;

interface Failures {
  count: number;
  since: number;
  last: number;
  blockedUntil: number;
}

export class Guard {
  private digests: { profile: Profile; digest: Buffer }[];
  private failures = new Map<string, Failures>();
  private turns: number[] = [];
  private turnsPerHour: number;

  constructor(profiles: Profile[], turnsPerHour: number) {
    this.digests = profiles.map((profile) => ({ profile, digest: sha256(profile.token) }));
    this.turnsPerHour = turnsPerHour;
    setInterval(() => this.sweep(), 10 * 60_000).unref();
  }

  /**
   * The caller's address. cloudflared is the only thing that can reach the
   * relay's loopback port from outside, so its CF-Connecting-IP is trusted.
   */
  static clientIp(req: IncomingMessage): string {
    const cf = req.headers['cf-connecting-ip'];
    return (Array.isArray(cf) ? cf[0] : cf) ?? req.socket.remoteAddress ?? 'unknown';
  }

  blocked(ip: string): boolean {
    const f = this.failures.get(ip);
    return !!f && f.blockedUntil > Date.now();
  }

  /** The client whose bearer token the request carries, or null. */
  check(req: IncomingMessage): Profile | null {
    const header = req.headers.authorization ?? '';
    const given = header.startsWith('Bearer ') ? header.slice(7) : '';
    if (given === '') return null;
    const digest = sha256(given);
    // compare against every profile so the time taken doesn't say which one matched
    let found: Profile | null = null;
    for (const d of this.digests) if (timingSafeEqual(digest, d.digest)) found = d.profile;
    return found;
  }

  /** Record a bad attempt; returns true if this one tipped the IP into a block. */
  fail(ip: string): boolean {
    const now = Date.now();
    let f = this.failures.get(ip);
    if (!f || now - f.since > FAIL_WINDOW_MS) {
      f = { count: 0, since: now, last: 0, blockedUntil: 0 };
      this.failures.set(ip, f);
    }
    if (now - f.last < ECHO_MS) return false;
    f.last = now;
    f.count++;
    if (f.count >= FAIL_LIMIT && f.blockedUntil <= now) {
      f.blockedUntil = now + BLOCK_MS;
      return true;
    }
    return false;
  }

  succeed(ip: string): void {
    this.failures.delete(ip);
  }

  /** Take one turn from the hourly budget; false when it's used up. */
  takeTurn(): boolean {
    const now = Date.now();
    this.turns = this.turns.filter((t) => now - t < 3_600_000);
    if (this.turns.length >= this.turnsPerHour) return false;
    this.turns.push(now);
    return true;
  }

  get turnLimit(): number {
    return this.turnsPerHour;
  }

  private sweep(): void {
    const now = Date.now();
    for (const [ip, f] of this.failures) {
      if (f.blockedUntil <= now && now - f.since > FAIL_WINDOW_MS) this.failures.delete(ip);
    }
  }
}

function sha256(s: string): Buffer {
  return createHash('sha256').update(s).digest();
}
