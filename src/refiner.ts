import type { State } from './state.ts';
import type { DeepseekUsage, GlossaryEntry } from './types.ts';
import { buildSystemPrompt } from './prompt.ts';

export interface RefinerOptions {
  state: State;
  apiKey: string;
  model: string;
  /** Defaults to https://api.deepseek.com */
  baseUrl?: string;
  topic?: string | undefined;
  glossary?: GlossaryEntry[] | undefined;
  context?: string | undefined;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
  maxAttempts?: number;
  retryDelayMs?: number;
  batchSize?: number;
  contextSize?: number;
  requestTimeoutMs?: number;
  /** Called after each successful response, to track cost */
  onUsage?: (usage: DeepseekUsage | undefined) => void;
}

/** 401/402/403 and the like: retrying is pointless, so trip the circuit breaker. */
class FatalError extends Error {}

const FATAL_STATUS = new Set([401, 402, 403]);

interface ModelItem {
  id?: unknown;
  zh?: unknown;
}

function asId(value: unknown): number | null {
  const n = typeof value === 'string' ? Number(value) : value;
  return typeof n === 'number' && Number.isInteger(n) ? n : null;
}

function parseModelJson(content: string): unknown {
  const text = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  return JSON.parse(text);
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** FIFO queue: up to batchSize lines per batch, with earlier lines as context, which may be revised. */
export class Refiner {
  /** Why the circuit breaker tripped; once set, DeepSeek is no longer called. */
  fatal: string | null = null;

  private readonly state: State;
  private readonly queue: number[] = [];
  private running = false;
  private waiters: Array<() => void> = [];
  private readonly systemPrompt: string;
  private readonly opts: Required<
    Pick<RefinerOptions, 'maxAttempts' | 'retryDelayMs' | 'batchSize' | 'contextSize' | 'requestTimeoutMs'>
  >;
  private readonly fetchFn: typeof fetch;
  private readonly sleepFn: (ms: number) => Promise<void>;
  private readonly url: string;
  private readonly apiKey: string;
  private readonly model: string;
  private readonly onUsage: RefinerOptions['onUsage'];

  constructor(o: RefinerOptions) {
    this.onUsage = o.onUsage;
    this.state = o.state;
    this.apiKey = o.apiKey;
    this.model = o.model;
    this.url = `${(o.baseUrl ?? 'https://api.deepseek.com').replace(/\/+$/, '')}/chat/completions`;
    this.fetchFn = o.fetch ?? fetch;
    this.sleepFn = o.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.opts = {
      maxAttempts: o.maxAttempts ?? 2,
      retryDelayMs: o.retryDelayMs ?? 500,
      batchSize: o.batchSize ?? 4,
      contextSize: o.contextSize ?? 6,
      requestTimeoutMs: o.requestTimeoutMs ?? 30_000,
    };
    this.systemPrompt = buildSystemPrompt({ topic: o.topic, glossary: o.glossary, context: o.context });
  }

  enqueue(id: number): void {
    if (this.fatal) {
      this.state.setError(id, this.fatal);
      return;
    }
    this.queue.push(id);
    if (!this.running) void this.drain();
  }

  /** Resolves true once the queue is empty and nothing is in flight; false on timeout or abort. */
  idle(timeoutMs = Number.POSITIVE_INFINITY, abort?: AbortSignal): Promise<boolean> {
    if (!this.running && this.queue.length === 0) return Promise.resolve(true);
    return new Promise((resolve) => {
      let timer: NodeJS.Timeout | undefined;
      const done = (ok: boolean) => {
        if (timer) clearTimeout(timer);
        abort?.removeEventListener('abort', onAbort);
        resolve(ok);
      };
      const onAbort = () => done(false);
      this.waiters.push(() => done(true));
      if (Number.isFinite(timeoutMs)) timer = setTimeout(() => done(false), timeoutMs);
      if (abort?.aborted) onAbort();
      else abort?.addEventListener('abort', onAbort, { once: true });
    });
  }

  private async drain(): Promise<void> {
    this.running = true;
    try {
      // Let lines enqueued at the same moment form one batch
      await Promise.resolve();
      while (this.queue.length) {
        const batch = this.queue.splice(0, this.opts.batchSize);
        await this.process(batch);
      }
    } finally {
      this.running = false;
      const waiters = this.waiters;
      this.waiters = [];
      for (const w of waiters) w();
    }
  }

  private async process(ids: number[]): Promise<void> {
    let remaining = ids;
    let lastError = '';
    for (let attempt = 1; attempt <= this.opts.maxAttempts; attempt++) {
      try {
        remaining = await this.attempt(remaining);
        if (remaining.length === 0) return;
        lastError = 'The model response is missing some lines';
      } catch (err) {
        lastError = errorMessage(err);
        if (err instanceof FatalError) {
          this.trip(lastError, remaining);
          return;
        }
      }
      if (attempt < this.opts.maxAttempts) await this.sleepFn(this.opts.retryDelayMs);
    }
    for (const id of remaining) this.state.setError(id, lastError);
    this.state.setStatus(`Polishing failed (${lastError}); affected lines show the Soniox draft`);
  }

  /** After the first fatal error stop calling DeepSeek; queued and later lines fall back to the draft. */
  private trip(reason: string, current: number[]): void {
    this.fatal = reason;
    this.state.setStatus(`DeepSeek polishing disabled: ${reason}. Later lines show the Soniox draft`);
    for (const id of [...current, ...this.queue.splice(0)]) this.state.setError(id, reason);
  }

  /** Returns the ids that still have no translation after this round. */
  private async attempt(ids: number[]): Promise<number[]> {
    const state = this.state;
    const first = Math.min(...ids);
    const context = state.segments
      .filter((s) => s.id < first)
      .slice(-this.opts.contextSize)
      .map((s) => ({ id: s.id, en: s.en, zh: s.status === 'error' ? '' : s.zh }));
    const fresh = ids.map((id) => {
      const s = state.get(id)!;
      return { id, en: s.en, draft_zh: s.draftZh };
    });

    let res: Response;
    try {
      res = await this.fetchFn(this.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${this.apiKey}` },
        body: JSON.stringify({
          model: this.model,
          messages: [
            { role: 'system', content: this.systemPrompt },
            { role: 'user', content: JSON.stringify({ context, new: fresh }) },
          ],
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
          temperature: 0.2,
          max_tokens: 1500,
          stream: false,
        }),
        signal: AbortSignal.timeout(this.opts.requestTimeoutMs),
      });
    } catch (err) {
      throw new Error(`Request failed: ${errorMessage(err)}`);
    }
    if (!res.ok) {
      const body = (await res.text().catch(() => '')).slice(0, 200);
      const msg = `HTTP ${res.status}${body ? ` ${body}` : ''}`;
      throw FATAL_STATUS.has(res.status) ? new FatalError(msg) : new Error(msg);
    }

    const payload = (await res.json().catch(() => null)) as {
      choices?: Array<{ message?: { content?: unknown } }>;
      usage?: DeepseekUsage;
    } | null;
    this.onUsage?.(payload?.usage);
    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('The model returned empty content');

    let parsed: { new?: unknown; revisions?: unknown };
    try {
      parsed = parseModelJson(content) as { new?: unknown; revisions?: unknown };
    } catch {
      throw new Error('The model did not return valid JSON');
    }
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.new)) {
      throw new Error('The model JSON has no "new" array');
    }

    const wanted = new Set(ids);
    const done = new Set<number>();
    for (const item of parsed.new as ModelItem[]) {
      const id = asId(item?.id);
      if (id === null || !wanted.has(id) || typeof item.zh !== 'string' || !item.zh.trim()) continue;
      state.setRefined(id, item.zh.trim());
      done.add(id);
    }
    // Revisions may only point at lines that appeared in the context
    const allowed = new Set(context.map((c) => c.id));
    if (Array.isArray(parsed.revisions)) {
      for (const item of parsed.revisions as ModelItem[]) {
        const id = asId(item?.id);
        if (id === null || !allowed.has(id) || typeof item.zh !== 'string' || !item.zh.trim()) continue;
        state.revise(id, item.zh.trim());
      }
    }
    return ids.filter((id) => !done.has(id));
  }
}
