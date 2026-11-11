import { X509Certificate, verify as verifySignature } from 'node:crypto';
import { rootCertificates } from 'node:tls';

/*
 * Proof that a POST to /alexa really came from Alexa (there is no bearer token
 * on this route; Alexa can't send one). Follows Amazon's "Host a Custom Skill
 * as a Web Service":
 *
 *  - the SignatureCertChainUrl header must point at s3.amazonaws.com/echo.api/ over https;
 *  - the certificate chain there must be valid now, name echo-api.amazon.com and end at a trusted root;
 *  - the Signature-256 header must be that certificate's RSA-SHA256 signature of the raw body;
 *  - request.timestamp must be within 150 s of now (stops replays).
 */

const TOLERANCE_MS = 150_000;
const MAX_CHAIN_BYTES = 64 * 1024;
const SIGNING_NAME = 'DNS:echo-api.amazon.com';

export class VerifyError extends Error {}

export interface VerifyDeps {
  now?: () => number;
  /** trusted roots; the Node bundle by default */
  roots?: X509Certificate[];
  /** downloads the PEM chain; only ever called with a URL that passed certUrl() */
  fetchChain?: (url: string) => Promise<string>;
}

export interface SignedRequest {
  certUrl: string | undefined;
  signature: string | undefined;
  body: Buffer;
}

/** The normalized certificate URL if it is one Alexa would use, else null. */
export function certUrl(raw: string | undefined): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw); // resolves ../ and lowercases scheme and host
  } catch {
    return null;
  }
  if (u.protocol !== 'https:' || u.hostname !== 's3.amazonaws.com') return null;
  if (u.port !== '' && u.port !== '443') return null;
  if (u.username || u.password || !u.pathname.startsWith('/echo.api/')) return null;
  return `https://s3.amazonaws.com${u.pathname}`;
}

let defaultRoots: X509Certificate[] | null = null;
function bundledRoots(): X509Certificate[] {
  defaultRoots ??= rootCertificates.map((pem) => new X509Certificate(pem));
  return defaultRoots;
}

async function download(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5_000), redirect: 'error' });
  if (!res.ok) throw new VerifyError(`cert download: HTTP ${res.status}`);
  const text = await res.text();
  if (text.length > MAX_CHAIN_BYTES) throw new VerifyError('cert chain too large');
  return text;
}

export function parseChain(pem: string): X509Certificate[] {
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g) ?? [];
  return blocks.map((b) => new X509Certificate(b));
}

/** Throws unless `chain` (leaf first) is a currently valid Alexa signing chain. */
export function checkChain(chain: X509Certificate[], roots: X509Certificate[], now: number): void {
  if (chain.length === 0) throw new VerifyError('no certificate');
  for (const c of chain) {
    if (now < c.validFromDate.getTime() || now > c.validToDate.getTime()) throw new VerifyError('certificate not valid now');
  }
  const leaf = chain[0];
  if (!(leaf.subjectAltName ?? '').split(/,\s*/).includes(SIGNING_NAME)) throw new VerifyError('certificate is not for echo-api.amazon.com');
  for (let i = 0; i + 1 < chain.length; i++) {
    const issuer = chain[i + 1];
    if (!issuer.ca || !chain[i].checkIssued(issuer) || !chain[i].verify(issuer.publicKey)) throw new VerifyError('broken certificate chain');
  }
  const top = chain[chain.length - 1];
  const anchored = roots.some((r) => r.fingerprint256 === top.fingerprint256 || (top.checkIssued(r) && top.verify(r.publicKey)));
  if (!anchored) throw new VerifyError('certificate chain has no trusted root');
}

export class AlexaVerifier {
  private deps: VerifyDeps;
  /** validated chains by URL, kept until the first certificate in them expires */
  private cache = new Map<string, { leaf: X509Certificate; expires: number }>();

  constructor(deps: VerifyDeps = {}) {
    this.deps = deps;
  }

  /** Returns the parsed request body, or throws VerifyError. */
  async verify(req: SignedRequest): Promise<any> {
    const now = (this.deps.now ?? Date.now)();
    const url = certUrl(req.certUrl);
    if (!url) throw new VerifyError('bad certificate URL');
    if (!req.signature) throw new VerifyError('no signature');

    const leaf = await this.leafFor(url, now);
    let ok = false;
    try {
      ok = verifySignature('RSA-SHA256', req.body, leaf.publicKey, Buffer.from(req.signature, 'base64'));
    } catch {}
    if (!ok) throw new VerifyError('signature mismatch');

    let body: any;
    try {
      body = JSON.parse(req.body.toString('utf8'));
    } catch {
      throw new VerifyError('body is not JSON');
    }
    const stamp = Date.parse(body?.request?.timestamp ?? '');
    if (!Number.isFinite(stamp) || Math.abs(now - stamp) > TOLERANCE_MS) throw new VerifyError('stale timestamp');
    return body;
  }

  private async leafFor(url: string, now: number): Promise<X509Certificate> {
    const hit = this.cache.get(url);
    if (hit && hit.expires > now) return hit.leaf;
    this.cache.delete(url);
    const chain = parseChain(await (this.deps.fetchChain ?? download)(url));
    checkChain(chain, this.deps.roots ?? bundledRoots(), now);
    // Amazon rotates between a handful of URLs; anything more is someone probing.
    if (this.cache.size >= 20) this.cache.clear();
    this.cache.set(url, { leaf: chain[0], expires: Math.min(...chain.map((c) => c.validToDate.getTime())) });
    return chain[0];
  }
}
