/*
 * Turning Claude's text into something Alexa can say: find where sentences end
 * (so a half-streamed answer is only spoken up to a complete sentence), strip
 * markdown, and wrap the result as SSML. Pure functions.
 */

/** Alexa refuses more than about 8,000 characters of SSML; stay well under. */
export const SSML_LIMIT = 7_500;

// a full stop after one of these doesn't end the sentence
const ABBREVIATIONS = new Set(['dr', 'mr', 'mrs', 'ms', 'st', 'vs', 'e.g', 'i.e', 'etc', 'rs', 'no', 'approx', 'prof', 'sr', 'jr', 'mt', 'fig']);
const CLOSERS = new Set(['"', "'", '”', '’', ')', ']', '*', '_']);
const STARTS_SENTENCE = /[\p{Lu}\p{Lo}\p{N}"'“‘(\[*_#₹$-]/u;

/**
 * Offsets in `text` just past each complete sentence. While the text is still
 * streaming (`final` false) the last sentence only counts once the start of
 * the next one has arrived, since "3." may yet become "3.14".
 */
export function sentenceEnds(text: string, final: boolean): number[] {
  const ends: number[] = [];
  let start = 0; // where the current sentence began
  const push = (at: number) => {
    if (text.slice(start, at).trim() !== '') ends.push(at);
    start = at;
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\n') {
      push(i);
      continue;
    }
    if (ch !== '.' && ch !== '!' && ch !== '?') continue;
    let j = i + 1;
    while (j < text.length && ('.!?'.includes(text[j]) || CLOSERS.has(text[j]))) j++;
    if (j >= text.length) break; // decided at the end, below
    if (!/\s/.test(text[j])) continue; // 3.14, example.com
    let k = j;
    let newline = false;
    while (k < text.length && /\s/.test(text[k])) {
      if (text[k] === '\n') newline = true;
      k++;
    }
    if (k >= text.length && !final && !newline) break;
    if (!newline && k < text.length) {
      if (!STARTS_SENTENCE.test(text[k])) continue;
      if (ch === '.' && j === i + 1) {
        const before = text.slice(start, i);
        const word = /([\p{L}][\p{L}.]*)$/u.exec(before)?.[1] ?? '';
        if (ABBREVIATIONS.has(word.toLowerCase())) continue;
        if (word.length === 1 && word === word.toUpperCase()) continue; // an initial: A. P. J. Abdul Kalam
        if (/^\s*\d+$/.test(before)) continue; // "1." opening a numbered item
      }
    }
    push(j);
    i = j - 1;
  }
  if (final) push(text.length);
  return ends;
}

export interface Chunk {
  /** speak text.slice(from, end); equal to `from` when nothing is ready */
  end: number;
  /** something is left after `end`, or may still arrive */
  more: boolean;
}

/**
 * The next piece to speak, starting at `from`: whole sentences, at most about
 * `limit` characters. A turn that isn't `done` only gives up complete sentences.
 */
export function nextChunk(text: string, from: number, done: boolean, limit: number): Chunk {
  const rest = text.slice(from);
  const ends = sentenceEnds(rest, done);
  let cut = 0;
  for (const e of ends) {
    if (e > limit) break;
    cut = e;
  }
  if (cut === 0 && ends.length > 0) {
    // one sentence longer than the limit: break it at a space
    const space = rest.lastIndexOf(' ', limit);
    cut = Math.min(ends[0], space > limit / 2 ? space : limit);
  }
  const end = from + cut;
  return { end, more: !done || text.slice(end).trim() !== '' };
}

/** Markdown to plain sentences. Paragraphs come back separated by a blank line. */
export function toSpeech(markdown: string): string {
  let t = markdown.replace(/\r/g, '');
  t = t.replace(/```[a-z]*\n?/gi, '').replace(/`/g, '');
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1'); // [text](url)
  t = t.replace(/\[\d+\]/g, ''); // [1] citations
  t = t.replace(/<?https?:\/\/[^\s>)]+>?/g, '').replace(/\bwww\.\S+/g, '');
  t = t.replace(/[\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu, '');
  t = t.replace(/[\u0000-\u0009\u000B-\u001F\u007F]/g, ' ');

  const paragraphs: string[] = [];
  let current: string[] = [];
  const flush = () => {
    if (current.length) paragraphs.push(current.join(' '));
    current = [];
  };
  for (const raw of t.split('\n')) {
    let l = raw.trim();
    if (l === '') {
      flush();
      continue;
    }
    if (/^[-*_]{3,}$/.test(l) || /^\|?[\s:|-]*-[\s:|-]*\|?$/.test(l)) continue; // rules and table separators
    // headings, bullets, numbered items and quotes become sentences of their own
    const item = /^(#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+|>\s*)/.test(l);
    l = l.replace(/^(#{1,6}\s+|[-*+•]\s+|\d+[.)]\s+|>\s*)/, '');
    if (l.includes('|')) l = l.split('|').map((c) => c.trim()).filter(Boolean).join(', ');
    l = l.replace(/\*\*|__|~~/g, '').replace(/\*/g, '');
    l = l.replace(/(^|[\s(])_([^_]+)_(?=[\s).,!?;:]|$)/g, '$1$2');
    l = l.replace(/\s+/g, ' ').replace(/\s+([.,!?;:])/g, '$1').trim();
    if (l === '') continue;
    if (item && !/[.!?:;,]$/.test(l)) l += '.';
    current.push(l);
  }
  flush();
  return paragraphs.join('\n\n');
}

export function escapeSsml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

/** Plain speech text (as from toSpeech) to an SSML document, with a short pause between paragraphs. */
export function toSsml(speech: string): string {
  const wrap = (s: string) => `<speak>${s.split(/\n{2,}/).map((p) => escapeSsml(p.trim())).filter(Boolean).join('<break time="300ms"/>')}</speak>`;
  let out = wrap(speech);
  // escaping can lengthen the text; trim whole words until it fits
  while (out.length > SSML_LIMIT) {
    speech = speech.slice(0, Math.max(0, speech.length - (out.length - SSML_LIMIT) - 1));
    speech = speech.slice(0, Math.max(0, speech.lastIndexOf(' ')));
    out = wrap(speech);
  }
  return out;
}
