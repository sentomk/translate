import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Refiner } from '../src/refiner.ts';
import { State } from '../src/state.ts';

interface Call {
  body: any;
  headers: Record<string, string>;
}

function chat(content: unknown): Response {
  return Response.json({ choices: [{ message: { content: typeof content === 'string' ? content : JSON.stringify(content) } }] });
}

function setup(responses: Array<(call: Call) => Response>) {
  const state = new State();
  const calls: Call[] = [];
  const sleeps: number[] = [];
  const fetchFn = (async (_url: string, init: RequestInit) => {
    const call = { body: JSON.parse(init.body as string), headers: init.headers as Record<string, string> };
    calls.push(call);
    const respond = responses[Math.min(calls.length - 1, responses.length - 1)]!;
    return respond(call);
  }) as unknown as typeof fetch;
  const refiner = new Refiner({
    state,
    apiKey: 'k',
    model: 'deepseek-flash',
    fetch: fetchFn,
    sleep: async (ms) => void sleeps.push(ms),
  });
  const add = (en: string, draft = `草稿:${en}`) => state.addSegment(en, draft).id;
  return { state, refiner, calls, sleeps, add };
}

describe('Refiner', () => {
  it('polishes a line and sends the request DeepSeek expects', async () => {
    const { state, refiner, calls, add } = setup([() => chat({ new: [{ id: 1, zh: '你好。' }], revisions: [] })]);
    refiner.enqueue(add('Hello.'));
    assert.equal(await refiner.idle(), true);
    assert.equal(state.get(1)!.zh, '你好。');
    assert.equal(state.get(1)!.status, 'refined');
    const { body, headers } = calls[0]!;
    assert.equal(headers.Authorization, 'Bearer k');
    assert.deepEqual(body.thinking, { type: 'disabled' });
    assert.deepEqual(body.response_format, { type: 'json_object' });
    assert.equal(body.temperature, 0.2);
    assert.equal(body.max_tokens, 1500);
    assert.equal(body.stream, false);
    assert.match(body.messages[0].content, /json/);
    assert.deepEqual(JSON.parse(body.messages[1].content), { context: [], new: [{ id: 1, en: 'Hello.', draft_zh: '草稿:Hello.' }] });
  });

  it('lines enqueued at the same moment are processed FIFO, 4 per batch', async () => {
    const batches: number[][] = [];
    const { refiner, add } = setup([
      ({ body }) => {
        const ids = JSON.parse(body.messages[1].content).new.map((n: any) => n.id);
        batches.push(ids);
        return chat({ new: ids.map((id: number) => ({ id, zh: `译${id}` })), revisions: [] });
      },
    ]);
    for (let i = 0; i < 6; i++) refiner.enqueue(add(`S${i}.`));
    await refiner.idle();
    assert.deepEqual(batches, [[1, 2, 3, 4], [5, 6]]);
  });

  it('context is the last 6 earlier lines', async () => {
    const { state, refiner, calls } = setup([
      ({ body }) => {
        const ids = JSON.parse(body.messages[1].content).new.map((n: any) => n.id);
        return chat({ new: ids.map((id: number) => ({ id, zh: `译${id}` })), revisions: [] });
      },
    ]);
    for (let i = 0; i < 9; i++) state.addSegment(`S${i}.`, `d${i}`);
    for (let i = 1; i <= 8; i++) state.setRefined(i, `译${i}`);
    refiner.enqueue(9);
    await refiner.idle();
    const sent = JSON.parse(calls[0]!.body.messages[1].content);
    assert.deepEqual(sent.context.map((c: any) => c.id), [3, 4, 5, 6, 7, 8]);
  });

  it('a later line revises an earlier one: the context line is revised and flagged', async () => {
    const { state, refiner, add } = setup([
      () => chat({ new: [{ id: 1, zh: '它很快。' }], revisions: [] }),
      () => chat({ new: [{ id: 2, zh: '所以要用 GPU。' }], revisions: [{ id: 1, zh: '它（模型）很快。' }] }),
    ]);
    refiner.enqueue(add('It is fast.'));
    await refiner.idle();
    const before = state.get(1)!.rev;
    refiner.enqueue(add('So we use a GPU.'));
    await refiner.idle();
    assert.equal(state.get(1)!.zh, '它（模型）很快。');
    assert.equal(state.get(1)!.revised, true);
    assert.ok(state.get(1)!.rev > before);
  });

  it('ignores revisions that point outside the context', async () => {
    const { state, refiner, add } = setup([
      () =>
        chat({
          new: [{ id: 1, zh: '一' }],
          revisions: [{ id: 99, zh: '不存在' }, { id: 1, zh: '本批新句子不能走修订通道' }],
        }),
    ]);
    refiner.enqueue(add('One.'));
    await refiner.idle();
    assert.equal(state.get(1)!.zh, '一');
    assert.equal(state.get(1)!.revised, false);
  });

  it('401 does not retry and trips the breaker: later lines are not requested', async () => {
    const { state, refiner, calls, sleeps, add } = setup([() => new Response('unauthorized', { status: 401 })]);
    refiner.enqueue(add('One.', '草稿一'));
    await refiner.idle();
    assert.equal(calls.length, 1);
    assert.deepEqual(sleeps, []);
    assert.equal(state.get(1)!.status, 'error');
    assert.equal(state.get(1)!.zh, '草稿一');
    assert.match(refiner.fatal!, /401/);
    assert.match(state.getStatus(), /disabled.*401/);

    refiner.enqueue(add('Two.', '草稿二'));
    await refiner.idle();
    assert.equal(calls.length, 1, 'no more requests after the breaker trips');
    assert.equal(state.get(2)!.status, 'error');
    assert.equal(state.get(2)!.zh, '草稿二');
  });

  it('402 / 403 trip the breaker too', async () => {
    for (const status of [402, 403]) {
      const { refiner, calls, add } = setup([() => new Response('x', { status })]);
      refiner.enqueue(add('One.'));
      await refiner.idle();
      assert.equal(calls.length, 1);
      assert.ok(refiner.fatal);
    }
  });

  it('500 is retried once, 0.5 s later', async () => {
    const { state, refiner, calls, sleeps, add } = setup([
      () => new Response('boom', { status: 500 }),
      () => chat({ new: [{ id: 1, zh: '好' }], revisions: [] }),
    ]);
    refiner.enqueue(add('One.'));
    await refiner.idle();
    assert.equal(calls.length, 2);
    assert.deepEqual(sleeps, [500]);
    assert.equal(state.get(1)!.zh, '好');
    assert.equal(refiner.fatal, null);
  });

  it('after 2 failures the line is marked error and the status bar says why', async () => {
    const { state, refiner, calls, add } = setup([() => new Response('boom', { status: 500 })]);
    refiner.enqueue(add('One.', '草稿一'));
    await refiner.idle();
    assert.equal(calls.length, 2);
    assert.equal(state.get(1)!.status, 'error');
    assert.match(state.get(1)!.error!, /500/);
    assert.match(state.getStatus(), /Polishing failed/);
    assert.equal(refiner.fatal, null, '500 is not fatal; later lines are still requested');
  });

  it('bad JSON is retried', async () => {
    const { state, refiner, calls, add } = setup([
      () => chat('this is not json'),
      () => chat({ new: [{ id: 1, zh: '好' }], revisions: [] }),
    ]);
    refiner.enqueue(add('One.'));
    await refiner.idle();
    assert.equal(calls.length, 2);
    assert.equal(state.get(1)!.zh, '好');
  });

  it('empty content is retried', async () => {
    const { state, refiner, calls, add } = setup([
      () => chat(''),
      () => chat({ new: [{ id: 1, zh: '好' }], revisions: [] }),
    ]);
    refiner.enqueue(add('One.'));
    await refiner.idle();
    assert.equal(calls.length, 2);
    assert.equal(state.get(1)!.zh, '好');
  });

  it('JSON wrapped in a markdown code fence still parses', async () => {
    const { state, refiner, add } = setup([() => chat('```json\n{"new":[{"id":1,"zh":"好"}],"revisions":[]}\n```')]);
    refiner.enqueue(add('One.'));
    await refiner.idle();
    assert.equal(state.get(1)!.zh, '好');
  });

  it('a response missing an id: only the missing line is retried, and marked error if still missing', async () => {
    const { state, refiner, calls, add } = setup([() => chat({ new: [{ id: 1, zh: '一' }], revisions: [] })]);
    refiner.enqueue(add('One.'));
    refiner.enqueue(add('Two.', '草稿二'));
    await refiner.idle();
    assert.equal(state.get(1)!.status, 'refined');
    assert.equal(state.get(2)!.status, 'error');
    assert.equal(state.get(2)!.zh, '草稿二');
    const retried = JSON.parse(calls[1]!.body.messages[1].content).new.map((n: any) => n.id);
    assert.deepEqual(retried, [2]);
  });

  it('in later requests a failed line is sent with an empty Chinese string in the context', async () => {
    const { refiner, calls, add } = setup([
      () => new Response('boom', { status: 500 }),
      () => new Response('boom', { status: 500 }),
      ({ body }) => {
        const ids = JSON.parse(body.messages[1].content).new.map((n: any) => n.id);
        return chat({ new: ids.map((id: number) => ({ id, zh: `译${id}` })), revisions: [] });
      },
    ]);
    refiner.enqueue(add('One.', '占位草稿'));
    await refiner.idle();
    refiner.enqueue(add('Two.'));
    await refiner.idle();
    const sent = JSON.parse(calls[2]!.body.messages[1].content);
    assert.deepEqual(sent.context, [{ id: 1, en: 'One.', zh: '' }]);
  });

  it('idle() supports a timeout', async () => {
    const { refiner, add } = setup([() => new Response(null)]);
    const never = new Promise<Response>(() => {});
    (refiner as any).fetchFn = () => never;
    refiner.enqueue(add('One.'));
    assert.equal(await refiner.idle(30), false);
  });
});
