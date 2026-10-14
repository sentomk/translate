import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CostTracker, DEFAULT_PRICING, formatCost, formatUsd, type CostReport } from './cost.ts';
import { createMicSource, createWavSource, parseWav, type AudioSource } from './audio.ts';
import { Pipeline } from './pipeline.ts';
import { Refiner } from './refiner.ts';
import { Segmenter } from './segmenter.ts';
import { SubtitleServer } from './server.ts';
import { SonioxClient } from './soniox.ts';
import { State } from './state.ts';
import { Summarizer } from './summarizer.ts';
import { saveSession } from './transcript.ts';
import type { GlossaryEntry, Segment, Summary } from './types.ts';

export interface AppOptions {
  sonioxKey: string;
  deepseekKey: string;
  source: string;
  topic?: string | undefined;
  glossary?: GlossaryEntry[] | undefined;
  context?: string | undefined;
  /** DeepSeek model */
  model: string;
  sonioxModel: string;
  port: number;
  host: string;
  noBrowser?: boolean | undefined;
  device?: number | undefined;
  wav?: string | undefined;
  /** Start without listening; wait for "Start listening" on the page */
  paused?: boolean | undefined;
  /** Whether to generate the sidebar summary, default true */
  summary?: boolean | undefined;
  /** Soniox real-time price in USD per hour, default 0.12 */
  sonioxRate?: number | undefined;
  /** Output directory (transcript .txt and summary .md), default ./output */
  outDir?: string | undefined;

  // Test hooks
  /** Clock used to decide DeepSeek peak hours */
  clock?: (() => Date) | undefined;
  sonioxUrl?: string | undefined;
  deepseekUrl?: string | undefined;
  onListening?: ((info: { port: number; url: string }) => void) | undefined;
  /** WAV playback speed multiplier; 0 or Infinity means no waiting */
  pace?: number | undefined;
  /** Second Ctrl+C: stop waiting, save what we have and return immediately */
  forceSignal?: AbortSignal | undefined;
  log?: ((message: string) => void) | undefined;
  timings?: {
    /** Longest wait for Soniox "finished" after the end frame, default 15 s */
    finishMs?: number;
    /** Longest wait for the polish queue to drain, default 25 s */
    refineMs?: number;
    /** Longest wait for the final summary, default 20 s */
    summaryMs?: number;
    /** Time for the page to receive the last push, default 0.5 s */
    settleMs?: number;
    retryDelayMs?: number;
    summaryEvery?: number;
    summaryIntervalMs?: number;
  };
}

export interface AppResult {
  transcriptPath: string | undefined;
  summaryPath: string | undefined;
  segments: Segment[];
  summary: Summary | null;
  cost: CostReport;
  port: number;
}

function openBrowser(url: string): void {
  const [cmd, args]: [string, string[]] =
    process.platform === 'darwin'
      ? ['open', [url]]
      : process.platform === 'win32'
        ? ['cmd', ['/c', 'start', '', url]]
        : ['xdg-open', [url]];
  try {
    const child = spawn(cmd, args, { stdio: 'ignore', detached: true });
    child.on('error', () => {});
    child.unref();
  } catch {
    // If it will not open, the user can click the link
  }
}

/** Wait for a promise for at most ms milliseconds, or until force fires. */
async function waitFor(promise: Promise<unknown>, ms: number, force?: AbortSignal): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  let onAbort: (() => void) | undefined;
  await Promise.race([
    promise,
    new Promise<void>((resolve) => {
      timer = setTimeout(resolve, ms);
    }),
    new Promise<void>((resolve) => {
      if (!force) return;
      onAbort = () => resolve();
      if (force.aborted) resolve();
      else force.addEventListener('abort', onAbort, { once: true });
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (onAbort) force?.removeEventListener('abort', onAbort);
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const errText = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** One listening round: one Soniox connection + one audio source. A pause ends the round; starting again builds a new one. */
interface Listening {
  soniox: SonioxClient;
  audio: AudioSource;
  feed: Promise<void>;
  /** Soniox sent finished, reported an error or the connection closed */
  ended: Promise<void>;
  stopping: boolean;
  /** Usage reported for this round: audio milliseconds processed and finalized output tokens */
  stats: { audioMs: number; tokens: number };
}

export async function runApp(options: AppOptions, signal: AbortSignal): Promise<AppResult> {
  const log = options.log ?? ((m: string) => console.log(m));
  const t = options.timings ?? {};
  const force = options.forceSignal;
  const source = options.wav ? 'wav' : 'mic';

  // Parse the WAV first, so a bad format fails before connecting to anything
  const wavData = options.wav ? parseWav(readFileSync(options.wav)).data : undefined;
  let wavOffset = 0;

  const cost = new CostTracker(
    { ...DEFAULT_PRICING, ...(options.sonioxRate !== undefined ? { sonioxPerHour: options.sonioxRate } : {}) },
    options.clock,
  );
  const state = new State();
  const segmenter = new Segmenter();
  const refiner = new Refiner({
    state,
    apiKey: options.deepseekKey,
    model: options.model,
    ...(options.deepseekUrl ? { baseUrl: options.deepseekUrl } : {}),
    topic: options.topic,
    glossary: options.glossary,
    context: options.context,
    ...(t.retryDelayMs !== undefined ? { retryDelayMs: t.retryDelayMs } : {}),
    onUsage: (usage) => cost.addDeepseek('refine', usage),
  });
  const summarizer = new Summarizer({
    state,
    apiKey: options.deepseekKey,
    model: options.model,
    ...(options.deepseekUrl ? { baseUrl: options.deepseekUrl } : {}),
    topic: options.topic,
    glossary: options.glossary,
    context: options.context,
    enabled: options.summary !== false,
    ...(t.summaryEvery !== undefined ? { everySentences: t.summaryEvery } : {}),
    ...(t.summaryIntervalMs !== undefined ? { intervalMs: t.summaryIntervalMs } : {}),
    ...(t.retryDelayMs !== undefined ? { retryGapMs: t.retryDelayMs } : {}),
    onUsage: (usage) => cost.addDeepseek('summary', usage),
  });
  const pipeline = new Pipeline({ state, segmenter, sink: refiner });
  const server = new SubtitleServer(state, { host: options.host, port: options.port });
  state.setMic({ state: 'off', source });

  let listening: Listening | null = null;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => {
    finish = resolve;
  });

  // Toggle operations run one after another, so rapid clicks cannot open duplicate connections
  let chain: Promise<unknown> = Promise.resolve();
  const serialize = <T>(fn: () => Promise<T>): Promise<T> => {
    const next = chain.then(fn, fn);
    chain = next.catch(() => {});
    return next;
  };

  async function startListening(): Promise<void> {
    if (listening) return;
    state.setMic({ state: 'starting', source });
    state.setStatus('Connecting to Soniox…');
    let markEnded!: () => void;
    const ended = new Promise<void>((resolve) => {
      markEnded = resolve;
    });
    let sessionError: string | undefined;
    const stats = { audioMs: 0, tokens: 0 };
    const soniox = new SonioxClient({
      url: options.sonioxUrl,
      apiKey: options.sonioxKey,
      model: options.sonioxModel,
      source: options.source,
      onResponse(res) {
        if (typeof res.total_audio_proc_ms === 'number') stats.audioMs = Math.max(stats.audioMs, res.total_audio_proc_ms);
        for (const tok of res.tokens ?? []) {
          if (tok.is_final && tok.text && tok.text !== '<end>' && tok.text !== '<fin>') stats.tokens++;
        }
        const result = pipeline.handleResponse(res);
        if (result.error) {
          sessionError = result.error;
          log(`[error] ${result.error}`);
        }
        if (result.finished) markEnded();
      },
      onClose(reason) {
        if (!sessionError) log(`[connection] ${reason}`);
        markEnded();
        // We did not end it: the connection dropped. Go back to "paused" so the user can start again
        if (listening?.soniox === soniox && !listening.stopping) {
          void serialize(() => stopListening(sessionError ?? 'Connection lost. Click "Start listening" to reconnect'));
        }
      },
    });

    try {
      await soniox.connect();
    } catch (err) {
      soniox.close();
      state.setMic({ state: 'off', source });
      throw new Error(`Could not connect to Soniox: ${errText(err)}`);
    }

    let audio: AudioSource;
    try {
      audio = wavData
        ? createWavSource(wavData, { pace: options.pace, startOffset: wavOffset })
        : createMicSource(options.device);
    } catch (err) {
      soniox.close();
      state.setMic({ state: 'off', source });
      throw new Error(`Could not open the microphone: ${errText(err)}`);
    }

    const session: Listening = { soniox, audio, ended, stopping: false, stats, feed: Promise.resolve() };
    session.feed = (async () => {
      try {
        for await (const chunk of audio.chunks) soniox.sendAudio(chunk);
      } catch (err) {
        log(`[audio] Audio error: ${errText(err)}`);
        if (!session.stopping) void serialize(() => stopListening(`Audio error: ${errText(err)}`));
        return;
      }
      // The WAV played to the end: the whole session is over
      if (audio.exhausted?.()) finish();
    })();
    listening = session;
    state.setMic({ state: 'on', source });
    state.setStatus(wavData ? `Playing ${options.wav}` : 'Listening…');
    log(wavData ? 'Playing the WAV.' : 'Listening.');
  }

  async function stopListening(reason?: string): Promise<void> {
    const session = listening;
    if (!session) return;
    session.stopping = true;
    state.setMic({ state: 'stopping', source });
    state.setStatus('Wrapping up, waiting for the last translation…');
    session.audio.stop();
    await waitFor(session.feed, 2000, force);
    if (session.soniox.isOpen) {
      session.soniox.endAudio();
      await waitFor(session.ended, t.finishMs ?? 15_000, force);
    }
    session.soniox.close();
    // Prefer the audio duration counted by the server; otherwise use the bytes actually sent (16 kHz × 16-bit = 32 bytes per ms)
    cost.addAudio(session.stats.audioMs || session.soniox.bytesSent / 32);
    cost.addSonioxTokens(session.stats.tokens);
    wavOffset = session.audio.position?.() ?? wavOffset;
    listening = null;
    pipeline.flush();
    state.setMic({ state: 'off', source });
    state.setStatus(reason ?? 'Paused. Click "Start listening" to continue');
  }

  const { port, url } = await server.listen();
  server.controls = {
    async setMic(on) {
      if (on) {
        await serialize(async () => {
          try {
            await startListening();
          } catch (err) {
            state.setStatus(errText(err));
            log(`[error] ${errText(err)}`);
            throw err;
          }
        });
      } else {
        await serialize(() => stopListening());
      }
    },
    refreshSummary: () => summarizer.refresh(),
  };
  log(`Captions page: ${url}`);
  options.onListening?.({ port, url });
  if (!options.noBrowser) openBrowser(url);

  const ticker = setInterval(() => {
    pipeline.tick();
    summarizer.tick();
  }, 200);

  if (options.paused) {
    state.setStatus('Paused. Click "Start listening" (or press Space) to begin');
    log('Paused: click "Start listening" on the page.');
  } else {
    try {
      await serialize(startListening);
    } catch (err) {
      clearInterval(ticker);
      await server.close();
      throw err;
    }
  }

  const aborted = new Promise<void>((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener('abort', () => resolve(), { once: true });
  });
  await Promise.race([aborted, finished]);

  // ---- Wrap up: stop audio -> end frame -> wait for finished -> flush the segmenter -> wait for polish -> final summary -> let the page settle -> save ----
  await serialize(() => stopListening());
  clearInterval(ticker);
  pipeline.flush();
  state.setStatus('Wrapping up, waiting for polish and summary…');
  await refiner.idle(t.refineMs ?? 25_000, force);
  await summarizer.finalize(t.summaryMs ?? 20_000, force);
  const report = cost.report();
  state.setStatus(
    (refiner.fatal ? 'Done (polishing disabled; some lines are Soniox drafts)' : 'Done') + ` · about ${formatUsd(report.totalUsd)}`,
  );
  if (!force?.aborted) await sleep(t.settleMs ?? 500);

  const summary = summarizer.getSummary();
  const saved = saveSession(options.outDir ?? join(process.cwd(), 'output'), state.segments, summary, { cost: report });
  await server.close();
  if (saved) {
    log(`Saved transcript: ${saved.transcriptPath}`);
    if (saved.summaryPath) log(`Saved summary: ${saved.summaryPath}`);
  } else {
    log('Nothing was transcribed, nothing saved.');
  }
  log(['', 'Cost estimate (USD; an estimate, your invoice is the source of truth)', ...formatCost(report).map((l) => `  ${l}`)].join('\n'));
  return { transcriptPath: saved?.transcriptPath, summaryPath: saved?.summaryPath, segments: state.segments, summary, cost: report, port };
}
