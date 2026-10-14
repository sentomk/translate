import type { State } from './state.ts';
import type { DeepseekUsage, GlossaryEntry, Summary } from './types.ts';

export interface SummarizerOptions {
  state: State;
  apiKey: string;
  model: string;
  baseUrl?: string;
  topic?: string | undefined;
  glossary?: GlossaryEntry[] | undefined;
  context?: string | undefined;
  enabled?: boolean;
  /** Update once this many new lines have accumulated */
  everySentences?: number;
  /** Or when there is new content and this long has passed since the last update */
  intervalMs?: number;
  /** Most new lines to send in one request */
  batchSize?: number;
  requestTimeoutMs?: number;
  /** Minimum wait before retrying after a failure */
  retryGapMs?: number;
  fetch?: typeof fetch;
  now?: () => number;
  /** Called after each successful response, to track cost */
  onUsage?: (usage: DeepseekUsage | undefined) => void;
}

const FATAL_STATUS = new Set([401, 402, 403]);

export function buildSummaryPrompt(o: { topic?: string | undefined; glossary?: GlossaryEntry[] | undefined; context?: string | undefined }): string {
  const lines = [
    'You are a note-taking assistant for a lecture. The teacher speaks English. You keep receiving the sentences he has just finished (English source + Chinese captions). Update the existing summary and output the complete, latest summary for students to read while they listen. Write all summary text in Simplified Chinese.',
    '',
    'Fields:',
    '1. topic: one sentence on what the whole lesson is about, at most 25 Chinese characters. With little content, give the most likely topic so far and refine it later.',
    '2. current: what the teacher is covering right now, one sentence, at most 30 Chinese characters.',
    '3. points: the key points so far, at most 8, each one sentence of at most 40 Chinese characters. A point is a conclusion or a concept, not a retelling of each sentence: merge related sentences into one point; fold analogies and examples into the concept they illustrate instead of listing them separately; do not repeat what topic already says and do not write "this lesson covered...". Keep teaching order. Keep the wording of existing points unless new content requires fixing, merging or extending them. With very little content, 1-2 points is fine.',
    '4. terms: important terms that appeared, at most 12, each like {"en":"English","zh":"Chinese meaning"}; follow the glossary.',
    '5. Use only the given content. Do not add outside knowledge and do not invent things the teacher did not say.',
  ];
  if (o.topic) lines.push('', `Lecture topic: ${o.topic}`);
  if (o.glossary?.length) {
    lines.push('', 'Glossary:');
    for (const { term, zh } of o.glossary) lines.push(zh ? `- ${term} → ${zh}` : `- ${term} (keep in English)`);
  }
  if (o.context) lines.push('', `Background: ${o.context}`);
  lines.push(
    '',
    'The input is a json object: {"previous":{"topic":"...","current":"...","points":["..."],"terms":[{"en":"...","zh":"..."}]} or null,"new":[{"id":1,"en":"...","zh":"..."}]}',
    'Output a single json object and nothing else: {"topic":"...","current":"...","points":["..."],"terms":[{"en":"...","zh":"..."}]}',
  );
  return lines.join('\n');
}

function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** Validate and normalize the summary the model returned; null if the fields are invalid. */
export function parseSummary(content: string): Pick<Summary, 'topic' | 'current' | 'points' | 'terms'> | null {
  let raw: any;
  try {
    raw = JSON.parse(content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, ''));
  } catch {
    return null;
  }
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.points)) return null;
  const points = raw.points.map((p: unknown) => str(p, 120)).filter(Boolean).slice(0, 10);
  const terms = (Array.isArray(raw.terms) ? raw.terms : [])
    .map((t: any) => ({ en: str(t?.en, 60), zh: str(t?.zh, 60) }))
    .filter((t: { en: string; zh: string }) => t.en && t.zh)
    .slice(0, 12);
  const topic = str(raw.topic, 80);
  if (!topic && !points.length) return null;
  return { topic, current: str(raw.current, 100), points, terms };
}

/**
 * Rolling summary: whenever enough new lines have accumulated (or enough time has passed), send "previous summary + new lines"
 * to DeepSeek and get back the complete new summary. It is independent of the polish queue; failures only affect the sidebar.
 */
export class Summarizer {
  /** Why the circuit breaker tripped: no more requests after 401/402/403 */
  fatal: string | null = null;

  private readonly o: SummarizerOptions;
  private readonly now: () => number;
  private readonly fetchFn: typeof fetch;
  private readonly url: string;
  private readonly systemPrompt: string;
  private upto = 0;
  private lastRun: number;
  private nextAllowed = 0;
  private running: Promise<void> | null = null;
  private current: Summary | null = null;
  private lastError: string | undefined;

  constructor(o: SummarizerOptions) {
    this.o = o;
    this.now = o.now ?? Date.now;
    this.lastRun = this.now();
    this.fetchFn = o.fetch ?? fetch;
    this.url = `${(o.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`;
    this.systemPrompt = buildSummaryPrompt(o);
    this.publish(false);
  }

  get enabled(): boolean {
    return this.o.enabled !== false;
  }

  /** Call on a timer: start an update when the conditions are met. */
  tick(): void {
    if (!this.enabled || this.fatal || this.running) return;
    const now = this.now();
    if (now < this.nextAllowed) return;
    const n = this.available().length;
    if (!n) return;
    if (n >= (this.o.everySentences ?? 3) || now - this.lastRun >= (this.o.intervalMs ?? 45_000)) this.start();
  }

  /** The viewer clicked "Refresh": update right away if there is new content. */
  refresh(): void {
    if (!this.enabled || this.fatal || this.running || !this.available().length) return;
    this.nextAllowed = 0;
    this.start();
  }

  /** At the end of the session: summarize whatever is left. */
  async finalize(timeoutMs: number, abort?: AbortSignal): Promise<void> {
    if (!this.enabled || this.fatal) return;
    let timer: NodeJS.Timeout | undefined;
    const limit = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, timeoutMs);
      abort?.addEventListener('abort', () => resolve(), { once: true });
      if (abort?.aborted) resolve();
    });
    const work = (async () => {
      for (let i = 0; i < 4; i++) {
        if (this.running) await this.running;
        if (this.fatal || !this.available().length) return;
        this.nextAllowed = 0;
        this.start();
        await this.running;
        if (this.lastError) return;
      }
    })();
    await Promise.race([work, limit]);
    if (timer) clearTimeout(timer);
  }

  getSummary(): Summary | null {
    return this.current;
  }

  /** Consecutive lines after upto that are no longer being polished. */
  private available() {
    const out = [];
    for (const seg of this.o.state.segments.slice(this.upto)) {
      if (seg.status === 'pending') break;
      out.push(seg);
      if (out.length >= (this.o.batchSize ?? 40)) break;
    }
    return out;
  }

  private start(): void {
    this.running = this.run().finally(() => {
      this.running = null;
    });
  }

  private publish(busy: boolean): void {
    this.o.state.setSummary({
      enabled: this.enabled,
      busy,
      ...(this.lastError ? { error: this.lastError } : {}),
      data: this.current,
    });
  }

  private async run(): Promise<void> {
    const batch = this.available();
    if (!batch.length) return;
    this.lastError = undefined;
    this.publish(true);
    try {
      const parsed = await this.request(batch.map((s) => ({ id: s.id, en: s.en, zh: s.zh })));
      this.current = { ...parsed, upto: batch[batch.length - 1]!.id, updatedAt: this.now() };
      this.upto = batch[batch.length - 1]!.id;
      this.lastError = undefined;
    } catch (err) {
      this.lastError = err instanceof Error ? err.message : String(err);
      this.nextAllowed = this.now() + (this.o.retryGapMs ?? 15_000);
      if (err instanceof FatalSummaryError) {
        this.fatal = this.lastError;
        this.lastError = `Summary disabled: ${this.lastError}`;
      }
    }
    this.lastRun = this.now();
    this.publish(false);
  }

  private async request(batch: Array<{ id: number; en: string; zh: string }>) {
    const prev = this.current && {
      topic: this.current.topic,
      current: this.current.current,
      points: this.current.points,
      terms: this.current.terms,
    };
    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.o.apiKey}` },
        body: JSON.stringify({
          model: this.o.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: JSON.stringify({ previous: prev ?? null, new: batch }) },
          ],
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
          temperature: 0.3,
          max_tokens: 1500,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.o.requestTimeoutMs ?? 40_000),
      });
    } catch (err) {
      throw new Error(`Request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (!res.ok) {
      const msg = `HTTP ${res.status}`;
      throw FATAL_STATUS.has(res.status) ? new FatalSummaryError(msg) : new Error(msg);
    }
    const payload = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: DeepseekUsage;
    } | null;
    this.o.onUsage?.(payload?.usage);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('The model returned empty content');
    const parsed = parseSummary(content);
    if (!parsed) throw new Error('The summary has an unexpected format');
    return parsed;
  }
}

class FatalSummaryError extends Error {}
