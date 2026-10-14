import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Segmenter } from '../src/segmenter.ts';

const ens = (s: { en: string }[]) => s.map((x) => x.en);

describe('Segmenter', () => {
  it('splits at terminal punctuation + whitespace + more text', () => {
    const seg = new Segmenter();
    seg.pushEn('Hello there. How are you', 0);
    assert.deepEqual(ens(seg.poll(0)), ['Hello there.']);
    assert.deepEqual(ens(seg.flush()), ['How are you']);
  });

  it('splits every sentence when several arrive at once', () => {
    const seg = new Segmenter();
    seg.pushEn('One. Two! Three? Four', 0);
    assert.deepEqual(ens(seg.poll(0)), ['One.', 'Two!', 'Three?']);
  });

  it('still splits when closing quotes or brackets follow the punctuation', () => {
    const seg = new Segmenter();
    seg.pushEn('He said "stop." Then left', 0);
    assert.deepEqual(ens(seg.poll(0)), ['He said "stop."']);
  });

  it('does not split after abbreviations', () => {
    const seg = new Segmenter();
    seg.pushEn('See e.g. the book, i.e. chapter two, etc. for more. Next one', 0);
    assert.deepEqual(ens(seg.poll(0)), ['See e.g. the book, i.e. chapter two, etc. for more.']);
  });

  it('does not split after extended abbreviations (Prof. / U.S.)', () => {
    const seg = new Segmenter();
    seg.pushEn('Prof. Smith lives in the U.S. now. Next', 0);
    assert.deepEqual(ens(seg.poll(0)), ['Prof. Smith lives in the U.S. now.']);
  });

  it('does not split on a decimal point with no space after it', () => {
    const seg = new Segmenter();
    seg.pushEn('It costs 3.5 dollars. Fine', 0);
    assert.deepEqual(ens(seg.poll(0)), ['It costs 3.5 dollars.']);
  });

  it('last sentence ending in terminal punctuation: emitted after 0.8 s idle', () => {
    const seg = new Segmenter();
    seg.pushEn('That is all.', 1000);
    assert.deepEqual(seg.poll(1799), []);
    assert.deepEqual(ens(seg.poll(1800)), ['That is all.']);
  });

  it('ending in an abbreviation: not emitted at 0.8 s, waits until 6 s', () => {
    const seg = new Segmenter();
    seg.pushEn('as in e.g.', 0);
    assert.deepEqual(seg.poll(1000), []);
    assert.deepEqual(ens(seg.poll(6000)), ['as in e.g.']);
  });

  it('no punctuation: emitted after a 6 s pause', () => {
    const seg = new Segmenter();
    seg.pushEn('and then we', 0);
    assert.deepEqual(seg.poll(5999), []);
    assert.deepEqual(ens(seg.poll(6000)), ['and then we']);
  });

  it('new text resets the idle timer', () => {
    const seg = new Segmenter();
    seg.pushEn('and then', 0);
    seg.pushEn(' we go', 5000);
    assert.deepEqual(seg.poll(6000), []);
    assert.deepEqual(ens(seg.poll(11000)), ['and then we go']);
  });

  it('forces an emit at 450 characters', () => {
    const seg = new Segmenter();
    seg.pushEn('word '.repeat(90), 0);
    const out = seg.poll(0);
    assert.equal(out.length, 1);
    assert.ok(out[0]!.en.length >= 440);
  });

  it('emits everything at the end', () => {
    const seg = new Segmenter();
    seg.pushEn('half a sentence', 0);
    assert.deepEqual(ens(seg.flush()), ['half a sentence']);
    assert.deepEqual(seg.flush(), []);
  });

  it('splits the Chinese draft along with the English, at a sentence end', () => {
    const seg = new Segmenter();
    seg.pushEn(' Hello everyone. Today we talk about gradient descent.', 0);
    seg.pushZh('你好，大家。今天我们讲梯度下降。');
    const first = seg.poll(0);
    assert.deepEqual(first, [{ en: 'Hello everyone.', zh: '你好，大家。' }]);
    assert.deepEqual(seg.flush(), [{ en: 'Today we talk about gradient descent.', zh: '今天我们讲梯度下降。' }]);
  });
});
