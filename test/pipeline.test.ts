import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Pipeline } from '../src/pipeline.ts';
import { Segmenter } from '../src/segmenter.ts';
import { State } from '../src/state.ts';
import type { SonioxToken } from '../src/types.ts';

function setup() {
  const state = new State();
  const queued: number[] = [];
  let now = 0;
  const pipeline = new Pipeline({
    state,
    segmenter: new Segmenter(),
    sink: { enqueue: (id) => queued.push(id) },
    now: () => now,
  });
  return { state, pipeline, queued, advance: (ms: number) => (now += ms) };
}

const en = (text: string, is_final = true): SonioxToken => ({ text, is_final, translation_status: 'original' });
const zh = (text: string, is_final = true): SonioxToken => ({ text, is_final, translation_status: 'translation' });

describe('Pipeline', () => {
  it('non-final translation is replaced on every response, not accumulated', () => {
    const { state, pipeline } = setup();
    pipeline.handleResponse({ tokens: [zh('你', false)] });
    pipeline.handleResponse({ tokens: [zh('你好', false)] });
    assert.equal(state.diff(0)!.draft, '你好');
    pipeline.handleResponse({ tokens: [] });
    assert.equal(state.diff(0)?.draft ?? '', '');
  });

  it('final translation is appended once; stays in "speaking now" until it forms a sentence', () => {
    const { state, pipeline } = setup();
    pipeline.handleResponse({ tokens: [zh('你好。', true), zh('今', false)] });
    assert.equal(state.diff(0)!.draft, '你好。今');
    pipeline.handleResponse({ tokens: [zh('今天。', true)] });
    assert.equal(state.diff(0)!.draft, '你好。今天。');
  });

  it('English being spoken = finalized unfinished text + non-final text; it leaves "speaking now" once it becomes a sentence', () => {
    const { state, pipeline, advance } = setup();
    pipeline.handleResponse({ tokens: [en('Hello there', true), en(' how are', false), zh('你好', false)] });
    assert.equal(state.diff(0)!.draftEn, 'Hello there how are');
    pipeline.handleResponse({ tokens: [en('.', true), en(' Next', false)] });
    advance(1000);
    pipeline.tick();
    assert.equal(state.segments.length, 1);
    assert.equal(state.diff(0)!.draftEn, 'Next');
    pipeline.flush();
    assert.equal(state.diff(0)!.draftEn, '');
    assert.equal(state.diff(0)!.draft, '');
  });

  it('control tokens are filtered out', () => {
    const { state, pipeline, advance } = setup();
    pipeline.handleResponse({ tokens: [en('Hello.'), en('<end>'), zh('你好。'), zh('<fin>')] });
    advance(1000);
    pipeline.tick();
    assert.equal(state.segments.length, 1);
    assert.equal(state.segments[0]!.en, 'Hello.');
    assert.equal(state.segments[0]!.draftZh, '你好。');
  });

  it('final English is added once and goes to the polish queue after a full sentence', () => {
    const { state, pipeline, queued } = setup();
    pipeline.handleResponse({ tokens: [en('Hello there.'), en(' How are', true)] });
    assert.deepEqual(queued, [1]);
    pipeline.handleResponse({ tokens: [en(' you today?', true)] });
    pipeline.flush();
    assert.deepEqual(state.segments.map((s) => s.en), ['Hello there.', 'How are you today?']);
    assert.deepEqual(queued, [1, 2]);
  });

  it('non-final English never becomes a sentence', () => {
    const { state, pipeline } = setup();
    pipeline.handleResponse({ tokens: [en('Maybe this', false)] });
    pipeline.flush();
    assert.equal(state.segments.length, 0);
  });

  it('error response: returns the error and writes it to the status bar', () => {
    const { state, pipeline } = setup();
    const r = pipeline.handleResponse({ error_code: 401, error_message: 'bad key' });
    assert.equal(r.finished, true);
    assert.match(r.error!, /401.*bad key/);
    assert.match(state.diff(0)!.status!, /401/);
  });

  it('passes the finished flag through', () => {
    const { pipeline } = setup();
    assert.equal(pipeline.handleResponse({ tokens: [] }).finished, false);
    assert.equal(pipeline.handleResponse({ tokens: [], finished: true }).finished, true);
  });
});
