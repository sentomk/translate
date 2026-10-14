import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:http';
import { afterEach, describe, it } from 'node:test';
import { runApp, type AppOptions } from '../src/app.ts';
import { collectSse, makeWav, startMockDeepseek, startMockSoniox, type MockDeepseek, type MockSoniox } from './helpers.ts';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'subs-'));
}

async function mocks(opts: { ignoreEnd?: boolean; delayMs?: number; deepseek: Parameters<typeof startMockDeepseek>[0] }) {
  const soniox = await startMockSoniox({ ignoreEnd: opts.ignoreEnd ?? false });
  const deepseek = await startMockDeepseek(opts.deepseek, opts.delayMs);
  cleanups.push(() => soniox.close(), () => deepseek.close());
  return { soniox, deepseek };
}

function baseOptions(soniox: MockSoniox, deepseek: MockDeepseek, wavSeconds = 1): AppOptions {
  const dir = tmp();
  const wav = join(dir, 'in.wav');
  writeFileSync(wav, makeWav({ samples: 16000 * wavSeconds }));
  return {
    sonioxKey: 'sx-key',
    deepseekKey: 'ds-key',
    source: 'en',
    topic: 'Machine learning',
    glossary: [{ term: 'gradient descent', zh: '梯度下降' }],
    model: 'deepseek-flash',
    sonioxModel: 'stt-rt-v5',
    port: 0,
    host: '127.0.0.1',
    noBrowser: true,
    summary: false,
    wav,
    outDir: join(dir, 'transcripts'),
    sonioxUrl: soniox.url,
    deepseekUrl: deepseek.url,
    pace: 0,
    log: () => {},
    timings: { settleMs: 50, retryDelayMs: 5, finishMs: 3000, refineMs: 3000 },
  };
}

/** DeepSeek usage per call (mocked) */
const USAGE = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 };

const SUMMARY = { topic: '梯度下降入门', current: '讲学习率', points: ['梯度下降用于训练神经网络', '学习率决定步长'], terms: [{ en: 'learning rate', zh: '学习率' }] };
const isSummaryRequest = (body: any) => body.messages[0].content.includes('note-taking assistant');
/** Polish requests go to revisingDeepseek; summary requests get a fixed summary */
const deepseekWithSummary = (body: any) => (isSummaryRequest(body) ? { content: SUMMARY, usage: USAGE } : revisingDeepseek(body));

/** Default DeepSeek mock: translates each line to `译：<English>`; on the second batch it also revises line 1. */
function revisingDeepseek(body: any) {
  const input = JSON.parse(body.messages[1].content);
  const ids: number[] = input.new.map((n: any) => n.id);
  const revisions = input.context.length ? [{ id: input.context[0].id, zh: '修订后：你好，大家。' }] : [];
  return {
    content: { new: input.new.map((n: any) => ({ id: n.id, zh: `译：${n.en}` })), revisions: ids.length ? revisions : [] },
    usage: USAGE,
  };
}

describe('end to end (mock Soniox + mock DeepSeek)', () => {
  it('WAV → draft → polish → revision → wrap-up and save; the page (SSE) receives every change', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: revisingDeepseek, delayMs: 100 });
    let sse: Awaited<ReturnType<typeof collectSse>> | undefined;
    const opts = baseOptions(soniox, deepseek);
    opts.pace = 5; // keep the draft after chunk 1 around for a moment so the page can receive "speaking now"
    opts.onListening = ({ url }) => {
      void collectSse(`${url}events`).then((s) => (sse = s));
    };

    const result = await runApp(opts, new AbortController().signal);

    // Soniox handshake: config frame + auth header
    assert.equal(soniox.configs.length, 1);
    assert.deepEqual(soniox.configs[0], {
      api_key: 'sx-key',
      model: 'stt-rt-v5',
      audio_format: 'pcm_s16le',
      sample_rate: 16000,
      num_channels: 1,
      language_hints: ['en'],
      translation: { type: 'one_way', target_language: 'zh' },
    });
    assert.deepEqual(soniox.authHeaders, ['Bearer sx-key']);
    assert.equal(soniox.endFrames(), 1, 'one empty frame is sent at the end');
    assert.equal(soniox.audioChunks(), 9, '1 second of audio = 9 chunks of 120 ms');

    // Lines and polishing
    assert.deepEqual(result.segments.map((s) => s.en), ['Hello everyone.', 'Today we talk about gradient descent.']);
    assert.equal(result.segments[0]!.revised, true);
    assert.equal(result.segments[0]!.zh, '修订后：你好，大家。');
    assert.equal(result.segments[1]!.zh, '译：Today we talk about gradient descent.');
    assert.ok(deepseek.requests.every((r) => r.auth === 'Bearer ds-key'));
    assert.match(deepseek.requests[0]!.body.messages[0].content, /梯度下降/);
    assert.match(deepseek.requests[0]!.body.messages[0].content, /Machine learning/);

    // The saved transcript
    assert.ok(result.transcriptPath);
    const text = readFileSync(result.transcriptPath!, 'utf8');
    assert.match(text, /修订后：你好，大家。/);
    assert.match(text, /Today we talk about gradient descent\./);

    // SSE client: the second push for the same line id has a higher rev, and the end status arrives last
    await sse!.done;
    const first = sse!.messages.flatMap((m) => m.segments ?? []).filter((s: any) => s.id === 1);
    assert.ok(first.length >= 2, 'line 1 is pushed at least twice (first draft + revision)');
    assert.ok(first.at(-1).rev > first[0].rev);
    assert.equal(first.at(-1).revised, true);
    assert.match(sse!.messages.at(-1).status, /^Done · about \$0\.\d+$/);
    assert.ok(sse!.messages.some((m) => m.draft || m.draftEn), 'the page receives the live "speaking now" content');
  });

  it('cost: priced by usage and time tier; Soniox estimated from audio time and output tokens; written out with the files', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: deepseekWithSummary });
    const logs: string[] = [];
    const opts = baseOptions(soniox, deepseek);
    opts.log = (m) => logs.push(m);
    opts.clock = () => new Date(Date.UTC(2026, 9, 14, 2, 0)); // Wednesday 02:00 UTC: peak
    const result = await runApp({ ...opts, summary: true }, new AbortController().signal);

    const { cost } = result;
    const calls = deepseek.requests.filter((r) => !isSummaryRequest(r.body)).length;
    assert.ok(calls >= 2);
    assert.equal(cost.deepseek.refine.calls, calls);
    assert.equal(cost.deepseek.refine.hit, 400 * calls);
    assert.equal(cost.deepseek.refine.miss, 600 * calls);
    assert.equal(cost.deepseek.refine.out, 100 * calls);
    assert.ok(Math.abs(cost.deepseek.refine.usd - calls * 302.4e-6) < 1e-12, 'peak price: (400×0.006 + 600×0.3 + 100×1.2) / 1e6');
    // Soniox: the mock server reports 9 chunks × 120 ms; 5 finalized tokens (<end>/<fin> not counted)
    assert.equal(cost.soniox.audioSeconds, 1.08);
    assert.equal(cost.soniox.outputTokens, 5);
    assert.ok(Math.abs(cost.soniox.usd - (1.08 / 3600) * 0.12 - 5 * 4e-6) < 1e-12);
    assert.ok(Math.abs(cost.totalUsd - (cost.soniox.usd + cost.deepseek.refine.usd + cost.deepseek.summary.usd)) < 1e-12);

    assert.match(logs.join('\n'), /Cost estimate[\s\S]*Soniox: 1 s of audio[\s\S]*DeepSeek polish: \d+ calls[\s\S]*Total ≈ \$/);
    for (const file of [result.transcriptPath!, result.summaryPath!]) {
      assert.match(readFileSync(file, 'utf8'), /Cost estimate[\s\S]*Total ≈ \$/, file);
    }
  });

  it('polish 401: breaker trips, no more requests, the transcript falls back to the Soniox draft', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: () => ({ status: 401, json: { error: 'bad key' } }) });
    const result = await runApp(baseOptions(soniox, deepseek), new AbortController().signal);

    assert.equal(deepseek.requests.length, 1);
    assert.ok(result.segments.every((s) => s.status === 'error'));
    assert.equal(result.segments[0]!.zh, '你好，大家。');
    const text = readFileSync(result.transcriptPath!, 'utf8');
    assert.match(text, /\[draft\] 你好，大家。/);
    assert.doesNotMatch(text, /Polishing failed/);
  });

  it('Ctrl+C (signal): stops audio, sends the end frame, waits for the last part, saves', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: revisingDeepseek });
    const opts = baseOptions(soniox, deepseek, 30);
    opts.pace = 1; // play 30 s of audio in real time
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 900);

    const started = Date.now();
    const result = await runApp(opts, controller.signal);

    assert.ok(Date.now() - started < 5000, 'should not play all 30 s');
    assert.ok(soniox.audioChunks() < 20);
    assert.equal(soniox.endFrames(), 1);
    assert.ok(result.transcriptPath);
    assert.equal(result.segments.length, 2);
  });

  it('second Ctrl+C: stops waiting for Soniox, saves and returns at once', async () => {
    const { soniox, deepseek } = await mocks({ ignoreEnd: true, deepseek: revisingDeepseek });
    const opts = baseOptions(soniox, deepseek, 30);
    opts.pace = 1;
    opts.timings = { ...opts.timings, finishMs: 60_000 };
    const stop = new AbortController();
    const force = new AbortController();
    opts.forceSignal = force.signal;
    setTimeout(() => stop.abort(), 800);
    setTimeout(() => force.abort(), 1100);

    const started = Date.now();
    const result = await runApp(opts, stop.signal);

    assert.ok(Date.now() - started < 3000, `should return at once, took ${Date.now() - started} ms`);
    assert.ok(result.transcriptPath, 'what we already have is still saved');
  });

  it('bad WAV format: fails before connecting and shows the conversion command', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: revisingDeepseek });
    const opts = baseOptions(soniox, deepseek);
    writeFileSync(opts.wav!, makeWav({ rate: 44100 }));
    await assert.rejects(runApp(opts, new AbortController().signal), /ffmpeg/);
    assert.equal(soniox.configs.length, 0);
  });

  it('cannot reach Soniox: reports it and closes the page server that was already started', async () => {
    const soniox = await startMockSoniox();
    cleanups.push(() => soniox.close());
    const deepseek = await startMockDeepseek(revisingDeepseek);
    cleanups.push(() => deepseek.close());
    const opts = baseOptions(soniox, deepseek);
    opts.sonioxUrl = 'ws://127.0.0.1:1';
    await assert.rejects(runApp(opts, new AbortController().signal), /Could not connect to Soniox/);
  });

  it('summary: writes summary_*.md and transcript_*.txt at the end, and the transcript has no summary in it', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: deepseekWithSummary });
    const opts = { ...baseOptions(soniox, deepseek), summary: true };
    let sse: Awaited<ReturnType<typeof collectSse>> | undefined;
    opts.onListening = ({ url }) => void collectSse(`${url}events`).then((s) => (sse = s));
    const result = await runApp(opts, new AbortController().signal);

    assert.equal(result.summary!.topic, '梯度下降入门');
    assert.ok(result.cost.deepseek.summary.calls >= 1, 'DeepSeek usage for the summary is counted too');
    assert.match(readFileSync(result.summaryPath!, 'utf8'), /## Cost estimate\n\n- Soniox: /);
    assert.ok(result.summaryPath!.endsWith('.md'));
    const md = readFileSync(result.summaryPath!, 'utf8');
    assert.match(md, /^# 梯度下降入门/);
    assert.match(md, /## Key points\n\n1\. 梯度下降用于训练神经网络\n2\. 学习率决定步长/);
    assert.match(md, /- \*\*learning rate\*\* — 学习率/);
    assert.match(md, /2 lines/);
    const txtName = result.transcriptPath!.split('/').pop()!;
    assert.match(md, new RegExp(`Transcript: ${txtName}`));
    assert.equal(result.summaryPath!.replace(/summary_|\.md/g, ''), result.transcriptPath!.replace(/transcript_|\.txt/g, ''), 'both files share the timestamp');
    const txt = readFileSync(result.transcriptPath!, 'utf8');
    assert.doesNotMatch(txt, /Key points|梯度下降入门/);

    await sse!.done;
    const views = sse!.messages.map((m) => m.summary).filter(Boolean);
    assert.ok(views.some((v) => v.data?.topic === '梯度下降入门'), 'the page received the summary');
  });

  it('a failed summary does not affect captions: no summary.md, the transcript is still saved', async () => {
    const { soniox, deepseek } = await mocks({
      deepseek: (body) => (body.messages[0].content.includes('note-taking assistant') ? { status: 500, json: {} } : revisingDeepseek(body)),
    });
    const result = await runApp({ ...baseOptions(soniox, deepseek), summary: true }, new AbortController().signal);
    assert.ok(result.transcriptPath);
    assert.equal(result.summaryPath, undefined);
  });
});

describe('the listening switch on the page', () => {
  function post(url: string, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; json: any }> {
    return new Promise((resolve, reject) => {
      const u = new URL(url);
      const req = request(
        { host: u.hostname, port: u.port, path, method: 'POST', headers: { 'Content-Type': 'application/json', ...headers } },
        (res) => {
          let raw = '';
          res.on('data', (c) => (raw += c));
          res.on('end', () => resolve({ status: res.statusCode!, json: raw ? JSON.parse(raw) : {} }));
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify(body));
    });
  }
  const until = async (cond: () => boolean, ms = 3000) => {
    const end = Date.now() + ms;
    while (!cond()) {
      if (Date.now() > end) throw new Error('Timed out waiting');
      await new Promise((r) => setTimeout(r, 10));
    }
  };

  it('--paused does not connect at first; Start connects; Pause ends the round; Start again resumes with nothing lost or repeated; the session ends when the WAV does', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: revisingDeepseek });
    const opts = baseOptions(soniox, deepseek, 2);
    opts.paused = true;
    opts.pace = 4; // one chunk per 30 ms
    let url = '';
    opts.onListening = (info) => (url = info.url);
    const done = runApp(opts, new AbortController().signal);
    await until(() => url !== '');

    await new Promise((r) => setTimeout(r, 100));
    assert.equal(soniox.configs.length, 0, 'starting paused does not connect to Soniox');
    assert.equal(soniox.audioChunks(), 0);

    let r = await post(url, '/api/mic', { on: true });
    assert.equal(r.status, 200);
    assert.equal(r.json.mic.state, 'on');
    await until(() => soniox.audioChunks() >= 3);

    r = await post(url, '/api/mic', { on: false });
    assert.equal(r.json.mic.state, 'off');
    assert.equal(soniox.endFrames(), 1, 'pausing ends this round of the connection');
    const stopped = soniox.audioChunks();
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(soniox.audioChunks(), stopped, 'no audio is sent while paused');

    r = await post(url, '/api/mic', { on: true });
    assert.equal(r.json.mic.state, 'on');
    assert.equal(soniox.configs.length, 2, 'starting again reconnects');

    const result = await done; // the WAV finished, so the session wraps up by itself
    assert.equal(soniox.audioChunks(), 17, '2 s of WAV = 17 chunks; nothing lost or repeated across the pause');
    assert.equal(soniox.endFrames(), 2);
    assert.ok(result.segments.length > 0);
  });

  it('Ctrl+C while paused still wraps up and saves normally', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: revisingDeepseek });
    const opts = baseOptions(soniox, deepseek);
    opts.paused = true;
    const stop = new AbortController();
    setTimeout(() => stop.abort(), 100);
    const result = await runApp(opts, stop.signal);
    assert.equal(result.segments.length, 0);
    assert.equal(result.transcriptPath, undefined);
  });

  it('security: only same-origin JSON requests from this machine are accepted', async () => {
    const { soniox, deepseek } = await mocks({ deepseek: revisingDeepseek });
    const opts = baseOptions(soniox, deepseek);
    opts.paused = true;
    let url = '';
    opts.onListening = (info) => (url = info.url);
    const stop = new AbortController();
    const done = runApp(opts, stop.signal);
    await until(() => url !== '');
    const host = new URL(url).host;

    // A request from another site (different Origin)
    assert.equal((await post(url, '/api/mic', { on: true }, { Origin: 'http://evil.example' })).status, 403);
    // DNS rebinding: the Host is not a local name
    assert.equal((await post(url, '/api/mic', { on: true }, { Host: `evil.example:${new URL(url).port}` })).status, 403);
    // A cross-site form can only send "simple" types such as text/plain or form data
    assert.equal((await post(url, '/api/mic', { on: true }, { 'Content-Type': 'text/plain' })).status, 403);
    assert.equal(soniox.configs.length, 0, 'rejected requests do not start listening');
    // A same-origin request is allowed
    assert.equal((await post(url, '/api/mic', { on: false }, { Origin: `http://${host}` })).status, 200);
    // Invalid parameters
    assert.equal((await post(url, '/api/mic', { on: 'yes' })).status, 400);
    assert.equal((await post(url, '/api/nope', {})).status, 404);

    stop.abort();
    await done;
  });
});
