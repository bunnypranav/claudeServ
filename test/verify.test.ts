import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createSign, X509Certificate } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';
import { AlexaVerifier, certUrl, VerifyError } from '../src/alexa/verify.ts';

// A throwaway root and signing certificates, made with the openssl CLI so no key lives in git.
let haveOpenssl = true;
try {
  execFileSync('openssl', ['version'], { stdio: 'ignore' });
} catch {
  haveOpenssl = false;
}

const URL_OK = 'https://s3.amazonaws.com/echo.api/echo-api-cert.pem';
const dir = mkdtempSync(join(tmpdir(), 'alexa-verify-'));
const f = (name: string) => join(dir, name);
const ssl = (...args: string[]) => execFileSync('openssl', args, { cwd: dir, stdio: 'ignore' });

let root: X509Certificate;
let chainPem = '';
let noSanPem = '';
let strayPem = '';

function makeLeaf(name: string, caCert: string, caKey: string, san: string | null): string {
  ssl('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.csr`, '-subj', '/CN=echo-api.amazon.com');
  writeFileSync(f(`${name}.ext`), san ? `subjectAltName=${san}\n` : 'basicConstraints=CA:FALSE\n');
  ssl('x509', '-req', '-in', `${name}.csr`, '-CA', caCert, '-CAkey', caKey, '-CAcreateserial', '-out', `${name}.pem`, '-days', '30', '-extfile', `${name}.ext`);
  return readFileSync(f(`${name}.pem`), 'utf8');
}

function makeRoot(name: string): string {
  ssl('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', `${name}.key`, '-out', `${name}.pem`, '-subj', `/CN=${name}`, '-days', '60', '-addext', 'basicConstraints=critical,CA:TRUE');
  return readFileSync(f(`${name}.pem`), 'utf8');
}

function sign(body: Buffer, keyFile = 'leaf.key'): string {
  return createSign('RSA-SHA256').update(body).sign(readFileSync(f(keyFile), 'utf8'), 'base64');
}

// a minute ahead, so certificates made during setup are already valid
const NOW = Date.now() + 60_000;
const bodyAt = (ms: number) => Buffer.from(JSON.stringify({ version: '1.0', request: { type: 'LaunchRequest', timestamp: new Date(ms).toISOString() } }));

function verifier(pem: () => string, now = NOW) {
  let fetches = 0;
  const v = new AlexaVerifier({
    now: () => now,
    roots: [root],
    fetchChain: async () => {
      fetches++;
      return pem();
    },
  });
  return { v, fetches: () => fetches };
}

describe('certUrl', () => {
  it('accepts the forms Amazon documents', () => {
    assert.equal(certUrl('https://s3.amazonaws.com/echo.api/echo-api-cert.pem'), URL_OK);
    assert.equal(certUrl('https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem'), URL_OK);
    assert.equal(certUrl('https://s3.amazonaws.com/echo.api/../echo.api/echo-api-cert.pem'), URL_OK);
    assert.equal(certUrl('HTTPS://S3.AMAZONAWS.COM/echo.api/echo-api-cert.pem'), URL_OK);
  });
  it('refuses everything else', () => {
    for (const bad of [
      undefined,
      '',
      'not a url',
      'http://s3.amazonaws.com/echo.api/echo-api-cert.pem',
      'https://notamazon.com/echo.api/echo-api-cert.pem',
      'https://s3.amazonaws.com.evil.example/echo.api/echo-api-cert.pem',
      'https://s3.amazonaws.com/EcHo.aPi/echo-api-cert.pem',
      'https://s3.amazonaws.com/invalid.path/echo-api-cert.pem',
      'https://s3.amazonaws.com/echo.api/../echo-api-cert.pem',
      'https://s3.amazonaws.com:8443/echo.api/echo-api-cert.pem',
      'https://user@s3.amazonaws.com/echo.api/echo-api-cert.pem',
    ]) {
      assert.equal(certUrl(bad), null, String(bad));
    }
  });
});

describe('AlexaVerifier', { skip: haveOpenssl ? false : 'openssl not installed' }, () => {
  before(() => {
    const rootPem = makeRoot('root');
    root = new X509Certificate(rootPem);
    chainPem = makeLeaf('leaf', 'root.pem', 'root.key', 'DNS:echo-api.amazon.com') + rootPem;
    noSanPem = makeLeaf('nosan', 'root.pem', 'root.key', null) + rootPem;
    const otherRoot = makeRoot('other');
    strayPem = makeLeaf('stray', 'other.pem', 'other.key', 'DNS:echo-api.amazon.com') + otherRoot;
  });
  after(() => rmSync(dir, { recursive: true, force: true }));

  const rejects = (p: Promise<unknown>, why: RegExp) => assert.rejects(p, (e: unknown) => e instanceof VerifyError && why.test(e.message));

  it('accepts a correctly signed, fresh request and caches the chain', async () => {
    const { v, fetches } = verifier(() => chainPem);
    const body = bodyAt(NOW);
    const parsed = await v.verify({ certUrl: URL_OK, signature: sign(body), body });
    assert.equal(parsed.request.type, 'LaunchRequest');
    await v.verify({ certUrl: URL_OK, signature: sign(body), body });
    assert.equal(fetches(), 1);
  });

  it('rejects a tampered body', async () => {
    const { v } = verifier(() => chainPem);
    const body = bodyAt(NOW);
    const tampered = Buffer.from(body.toString().replace('LaunchRequest', 'IntentRequest'));
    await rejects(v.verify({ certUrl: URL_OK, signature: sign(body), body: tampered }), /signature/);
  });

  it('rejects a wrong or missing signature', async () => {
    const { v } = verifier(() => chainPem);
    const body = bodyAt(NOW);
    await rejects(v.verify({ certUrl: URL_OK, signature: sign(body, 'nosan.key'), body }), /signature/);
    await rejects(v.verify({ certUrl: URL_OK, signature: 'AAAA', body }), /signature/);
    await rejects(v.verify({ certUrl: URL_OK, signature: undefined, body }), /no signature/);
  });

  it('never downloads from a bad certificate URL', async () => {
    const { v, fetches } = verifier(() => chainPem);
    const body = bodyAt(NOW);
    await rejects(v.verify({ certUrl: 'https://evil.example/echo.api/cert.pem', signature: sign(body), body }), /certificate URL/);
    assert.equal(fetches(), 0);
  });

  it('rejects an expired certificate', async () => {
    const later = NOW + 40 * 86_400_000; // the leaf lasts 30 days
    const { v } = verifier(() => chainPem, later);
    const body = bodyAt(later);
    await rejects(v.verify({ certUrl: URL_OK, signature: sign(body), body }), /not valid now/);
  });

  it('rejects a certificate without the echo-api.amazon.com name', async () => {
    const { v } = verifier(() => noSanPem);
    const body = bodyAt(NOW);
    await rejects(v.verify({ certUrl: URL_OK, signature: sign(body, 'nosan.key'), body }), /echo-api/);
  });

  it('rejects a chain that ends at an untrusted root', async () => {
    const { v } = verifier(() => strayPem);
    const body = bodyAt(NOW);
    await rejects(v.verify({ certUrl: URL_OK, signature: sign(body, 'stray.key'), body }), /trusted root/);
  });

  it('rejects timestamps more than 150 s away, either side', async () => {
    const { v } = verifier(() => chainPem);
    for (const off of [-151_000, 151_000]) {
      const body = bodyAt(NOW + off);
      await rejects(v.verify({ certUrl: URL_OK, signature: sign(body), body }), /timestamp/);
    }
    const edge = bodyAt(NOW - 149_000);
    await v.verify({ certUrl: URL_OK, signature: sign(edge), body: edge });
  });
});
