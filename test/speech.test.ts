import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { escapeSsml, nextChunk, sentenceEnds, SSML_LIMIT, toSpeech, toSsml } from '../src/alexa/speech.ts';

const sentences = (text: string, final = true) => {
  let from = 0;
  return sentenceEnds(text, final).map((end) => {
    const s = text.slice(from, end).trim();
    from = end;
    return s;
  });
};

describe('sentenceEnds', () => {
  it('splits on full stops, question marks and exclamation marks', () => {
    assert.deepEqual(sentences('The sky is blue. Why? Because of scattering! Done.'), ['The sky is blue.', 'Why?', 'Because of scattering!', 'Done.']);
  });

  it('keeps abbreviations, initials and decimals together', () => {
    assert.deepEqual(sentences('Dr. Rao met Mr. Singh vs. the board. It cost Rs. 500 approx. 3.14 times more.'), [
      'Dr. Rao met Mr. Singh vs. the board.',
      'It cost Rs. 500 approx. 3.14 times more.',
    ]);
    assert.deepEqual(sentences('A. P. J. Abdul Kalam was president. He wrote books, e.g. Wings of Fire.'), ['A. P. J. Abdul Kalam was president.', 'He wrote books, e.g. Wings of Fire.']);
  });

  it('handles rupee amounts and quotes', () => {
    assert.deepEqual(sentences('It costs ₹1,500.50 today. ₹200 is the fee. He said "stop." Then left.'), ['It costs ₹1,500.50 today.', '₹200 is the fee.', 'He said "stop."', 'Then left.']);
  });

  it('treats line breaks as sentence ends and numbered items as one sentence each', () => {
    assert.deepEqual(sentences('Three things:\n1. Apples are red\n2. Bananas\n\nThat is all'), ['Three things:', '1. Apples are red', '2. Bananas', 'That is all']);
  });

  it('holds back the last sentence while the text is still streaming', () => {
    assert.deepEqual(sentences('First one. Second one.', false), ['First one.']);
    assert.deepEqual(sentences('First one. Second one. ', false), ['First one.']);
    assert.deepEqual(sentences('First one. Second one. T', false), ['First one.', 'Second one.']);
    assert.deepEqual(sentences('Pi is 3.', false), []);
    assert.deepEqual(sentences('No full stop yet', false), []);
    assert.deepEqual(sentences('No full stop yet', true), ['No full stop yet']);
  });
});

describe('nextChunk', () => {
  const text = 'One is short. Two is also short. Three is the third sentence. Four ends it.';

  it('takes everything when it fits', () => {
    assert.deepEqual(nextChunk(text, 0, true, 900), { end: text.length, more: false });
  });

  it('stops at the last sentence inside the limit and carries on from there', () => {
    const a = nextChunk(text, 0, true, 40);
    assert.equal(text.slice(0, a.end), 'One is short. Two is also short.');
    assert.equal(a.more, true);
    const b = nextChunk(text, a.end, true, 40);
    assert.equal(text.slice(a.end, b.end).trim(), 'Three is the third sentence.');
    const c = nextChunk(text, b.end, true, 40);
    assert.equal(text.slice(b.end, c.end).trim(), 'Four ends it.');
    assert.equal(c.more, false);
  });

  it('gives only complete sentences of an unfinished answer', () => {
    const partial = 'One is short. Two is also sh';
    const c = nextChunk(partial, 0, false, 900);
    assert.equal(partial.slice(0, c.end), 'One is short.');
    assert.equal(c.more, true);
    assert.deepEqual(nextChunk('Nothing complete', 0, false, 900), { end: 0, more: true });
  });

  it('breaks an over-long sentence at a space', () => {
    const long = 'word '.repeat(60).trim() + '.';
    const c = nextChunk(long, 0, true, 100);
    assert.ok(c.end > 50 && c.end <= 100);
    assert.equal(long[c.end], ' ');
    assert.equal(c.more, true);
  });
});

describe('toSpeech', () => {
  it('strips markdown', () => {
    assert.equal(toSpeech('## Heading\n\n**Bold** and *italic* and `code` and _under_ text.'), 'Heading.\n\nBold and italic and code and under text.');
  });

  it('drops links, URLs, citations and emoji', () => {
    assert.equal(toSpeech('See [the docs](https://example.com/a) or https://example.com/b for more [1]. 🎉 Done ✅'), 'See the docs or for more. Done');
  });

  it('turns list items into sentences', () => {
    assert.equal(toSpeech('Fruits:\n- Apples\n- Bananas are yellow.\n1. First\n2) Second'), 'Fruits: Apples. Bananas are yellow. First. Second.');
  });

  it('flattens tables and rules', () => {
    assert.equal(toSpeech('| City | Temp |\n|---|---|\n| Delhi | 30 |\n\n---\n\nEnd.'), 'City, Temp Delhi, 30\n\nEnd.');
  });

  it('keeps snake_case and arithmetic readable', () => {
    assert.equal(toSpeech('Use max_turns_per_hour. 2 * 3 is 6.'), 'Use max_turns_per_hour. 2 3 is 6.');
  });
});

describe('toSsml', () => {
  it('escapes the characters that break SSML', () => {
    assert.equal(escapeSsml(`Tom & Jerry <b> "quoted" it's`), 'Tom &amp; Jerry &lt;b&gt; &quot;quoted&quot; it&apos;s');
    assert.equal(toSsml('AT&T is < Google.'), '<speak>AT&amp;T is &lt; Google.</speak>');
  });

  it('puts a pause between paragraphs', () => {
    assert.equal(toSsml('One.\n\nTwo.'), '<speak>One.<break time="300ms"/>Two.</speak>');
  });

  it('never exceeds the SSML limit', () => {
    const out = toSsml("it's & ".repeat(2000));
    assert.ok(out.length <= SSML_LIMIT);
    assert.ok(out.startsWith('<speak>') && out.endsWith('</speak>'));
    assert.ok(!/&(?!amp;|apos;|lt;|gt;|quot;)/.test(out), 'no cut-off entity');
  });
});
