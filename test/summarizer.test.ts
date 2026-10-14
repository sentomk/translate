import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { State } from '../src/state.ts';
import { parseSummary, Summarizer } from '../src/summarizer.ts';

const GOOD = { topic: '梯度下降', current: '讲学习率', points: ['要点一', '要点二'], terms: [{ en: 'learning rate', zh: '学习率' }] };

function setup(opts: { responses?: Array<() => Response>; everySentences?: number; intervalMs?: number } = {}) {
  const state = new State();
  const calls: any[] = [];
  let clock = 1_000_000;
  const responses = opts.responses ?? [() => Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }] })];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(init.body as string));
    return responses[Math.min(calls.length - 1, responses.length - 1)]!();
  }) as unknown as typeof fetch;
  const summarizer = new Summarizer({
    state,
    apiKey: 'k',
    model: 'm',
    fetch: fetchFn,
    now: () => clock,
    everySentences: opts.everySentences ?? 3,
    intervalMs: opts.intervalMs ?? 45_000,
    retryGapMs: 15_000,
  });
  const add = (n: number, refined = true) => {
    for (let i = 0; i < n; i++) {
      const s = state.addSegment(`Sentence ${state.segments.length + 1}.`, `草稿${state.segments.length + 1}`);
      if (refined) state.setRefined(s.id, `句子${s.id}`);
    }
  };
  const run = async () => {
    summarizer.tick();
    await (summarizer as any).running; // wait for this round to finish
  };
  return { state, summarizer, calls, add, advance: (ms: number) => (clock += ms), run };
}

describe('parseSummary', () => {
  it('valid JSON is normalized: at most 10 points, terms without zh are dropped', () => {
    const r = parseSummary(
      JSON.stringify({
        topic: ' 主题 ',
        current: '正在讲',
        points: Array.from({ length: 14 }, (_, i) => `点${i}`),
        terms: [{ en: 'a', zh: '甲' }, { en: 'b' }, { zh: '丙' }],
      }),
    );
    assert.equal(r!.topic, '主题');
    assert.equal(r!.points.length, 10);
    assert.deepEqual(r!.terms, [{ en: 'a', zh: '甲' }]);
  });

  it('parses a code-fenced response; missing points or bad JSON return null', () => {
    assert.ok(parseSummary('```json\n{"topic":"t","points":["a"]}\n```'));
    assert.equal(parseSummary('{"topic":"t"}'), null);
    assert.equal(parseSummary('not json'), null);
    assert.equal(parseSummary('{"topic":"","points":[]}'), null);
  });
});

describe('Summarizer', () => {
  it('waits for 3 settled lines before summarizing, then sends both English and Chinese', async () => {
    const { state, summarizer, calls, add, run } = setup();
    add(2);
    await run();
    assert.equal(calls.length, 0);
    add(1);
    await run();
    assert.equal(calls.length, 1);
    const sent = JSON.parse(calls[0].messages[1].content);
    assert.equal(sent.previous, null);
    assert.deepEqual(sent.new.map((n: any) => n.id), [1, 2, 3]);
    assert.equal(sent.new[0].zh, '句子1');
    assert.equal(calls[0].messages[0].role, 'system');
    assert.match(calls[0].messages[0].content, /json/);
    const view = [...[state.diff(0)!.summary!]][0]!;
    assert.equal(view.data!.topic, '梯度下降');
    assert.equal(view.data!.upto, 3);
    assert.equal(view.busy, false);
    assert.equal(summarizer.getSummary()!.points.length, 2);
  });

  it('lines still being polished are excluded; only the consecutive settled prefix is sent', async () => {
    const { state, calls, add, run } = setup({ everySentences: 1 });
    add(1);
    add(1, false); // line 2 is still being polished
    add(1);
    await run();
    const sent = JSON.parse(calls[0].messages[1].content);
    assert.deepEqual(sent.new.map((n: any) => n.id), [1]);
    assert.equal(state.segments.length, 3);
  });

  it('the second update carries the previous summary and only the new lines', async () => {
    const { calls, add, run } = setup({ everySentences: 2 });
    add(2);
    await run();
    add(2);
    await run();
    const second = JSON.parse(calls[1].messages[1].content);
    assert.equal(second.previous.topic, '梯度下降');
    assert.deepEqual(second.new.map((n: any) => n.id), [3, 4]);
  });

  it('fewer than 3 lines but past the interval: new content still triggers an update', async () => {
    const { calls, add, advance, run } = setup({ intervalMs: 30_000 });
    add(1);
    await run();
    assert.equal(calls.length, 0);
    advance(31_000);
    await run();
    assert.equal(calls.length, 1);
  });

  it('refresh() updates right away when there is new content, and does nothing otherwise', async () => {
    const { summarizer, calls, add } = setup();
    summarizer.refresh();
    assert.equal(calls.length, 0);
    add(1);
    summarizer.refresh();
    await (summarizer as any).running;
    assert.equal(calls.length, 1);
  });

  it('401: trips the breaker, no more requests, the sidebar shows why', async () => {
    const { state, summarizer, calls, add, run } = setup({ everySentences: 1, responses: [() => new Response('no', { status: 401 })] });
    add(1);
    await run();
    add(1);
    await run();
    assert.equal(calls.length, 1);
    assert.match(summarizer.fatal!, /401/);
    assert.match(state.diff(0)!.summary!.error!, /Summary disabled/);
  });

  it('bad format: shows an error, retries after the gap, clears the error on success', async () => {
    const bad = () => Response.json({ choices: [{ message: { content: 'oops' } }] });
    const good = () => Response.json({ choices: [{ message: { content: JSON.stringify(GOOD) } }] });
    const { state, calls, add, advance, run } = setup({ everySentences: 1, responses: [bad, good] });
    add(1);
    await run();
    assert.match(state.diff(0)!.summary!.error!, /unexpected format/);
    await run();
    assert.equal(calls.length, 1, 'no retry inside the gap');
    advance(16_000);
    await run();
    assert.equal(calls.length, 2);
    assert.equal(state.diff(0)!.summary!.error, undefined);
    assert.ok(state.diff(0)!.summary!.data);
  });

  it('finalize summarizes whatever is left', async () => {
    const { summarizer, calls, add } = setup();
    add(1);
    await summarizer.finalize(1000);
    assert.equal(calls.length, 1);
    assert.ok(summarizer.getSummary());
  });

  it('when off it makes no requests and the page sees enabled=false', async () => {
    const state = new State();
    const s = new Summarizer({ state, apiKey: 'k', model: 'm', enabled: false, fetch: (() => { throw new Error('should not call'); }) as any });
    state.addSegment('A.', 'a');
    s.tick();
    await s.finalize(100);
    assert.equal(state.diff(0)!.summary!.enabled, false);
  });
});
