import type { DeepseekUsage } from './types.ts';

/** Unit prices in USD. Source: the deepseek-flash pricing page at api-docs.deepseek.com and soniox.com/pricing (checked 2026-10-14). */
export interface Pricing {
  /** Soniox real-time recognition, per hour of audio */
  sonioxPerHour: number;
  /** Soniox output text (transcript + translation), per million tokens */
  sonioxPerMTokens: number;
  /** DeepSeek, per million tokens */
  deepseekPeak: { hit: number; miss: number; out: number };
  deepseekOffPeak: { hit: number; miss: number; out: number };
}

export const DEFAULT_PRICING: Pricing = {
  sonioxPerHour: 0.12,
  sonioxPerMTokens: 4,
  deepseekPeak: { hit: 0.006, miss: 0.3, out: 1.2 },
  deepseekOffPeak: { hit: 0.003, miss: 0.15, out: 0.6 },
};

/**
 * DeepSeek peak hours: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday.
 * Chinese public holidays are off-peak but cannot be detected here, so they are priced as peak (the estimate errs high, never low).
 */
export function isPeak(at: Date): boolean {
  const day = at.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = at.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export type DeepseekKind = 'refine' | 'summary';

export interface DeepseekBucket {
  calls: number;
  /** Input tokens served from the cache */
  hit: number;
  /** Input tokens not served from the cache */
  miss: number;
  out: number;
  usd: number;
}

export interface CostReport {
  soniox: { audioSeconds: number; outputTokens: number; audioUsd: number; tokensUsd: number; usd: number };
  deepseek: Record<DeepseekKind, DeepseekBucket>;
  totalUsd: number;
}

export class CostTracker {
  private audioMs = 0;
  private sonioxTokens = 0;
  private readonly buckets: Record<DeepseekKind, DeepseekBucket> = {
    refine: { calls: 0, hit: 0, miss: 0, out: 0, usd: 0 },
    summary: { calls: 0, hit: 0, miss: 0, out: 0, usd: 0 },
  };
  private readonly pricing: Pricing;
  private readonly clock: () => Date;

  constructor(pricing: Pricing = DEFAULT_PRICING, clock: () => Date = () => new Date()) {
    this.pricing = pricing;
    this.clock = clock;
  }

  addAudio(ms: number): void {
    if (ms > 0) this.audioMs += ms;
  }

  addSonioxTokens(n: number): void {
    if (n > 0) this.sonioxTokens += n;
  }

  /** One DeepSeek call; if there is no usage field, only the call is counted. */
  addDeepseek(kind: DeepseekKind, usage: DeepseekUsage | undefined): void {
    const b = this.buckets[kind];
    b.calls++;
    if (!usage) return;
    const out = usage.completion_tokens ?? 0;
    const hit = usage.prompt_cache_hit_tokens ?? 0;
    const miss = usage.prompt_cache_miss_tokens ?? Math.max(0, (usage.prompt_tokens ?? 0) - hit);
    const p = isPeak(this.clock()) ? this.pricing.deepseekPeak : this.pricing.deepseekOffPeak;
    b.hit += hit;
    b.miss += miss;
    b.out += out;
    b.usd += (hit * p.hit + miss * p.miss + out * p.out) / 1e6;
  }

  report(): CostReport {
    const audioSeconds = this.audioMs / 1000;
    const audioUsd = (audioSeconds / 3600) * this.pricing.sonioxPerHour;
    const tokensUsd = (this.sonioxTokens / 1e6) * this.pricing.sonioxPerMTokens;
    const soniox = { audioSeconds, outputTokens: this.sonioxTokens, audioUsd, tokensUsd, usd: audioUsd + tokensUsd };
    return {
      soniox,
      deepseek: { refine: { ...this.buckets.refine }, summary: { ...this.buckets.summary } },
      totalUsd: soniox.usd + this.buckets.refine.usd + this.buckets.summary.usd,
    };
  }
}

export function formatUsd(v: number): string {
  return v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(4)}`;
}

function duration(seconds: number): string {
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return h ? `${h} h ${m} min` : m ? `${m} min ${s % 60} s` : `${s} s`;
}

const n = (v: number) => v.toLocaleString('en-US');

/** One item per line, shared by the terminal, the txt and the md. */
export function formatCost(r: CostReport): string[] {
  const { soniox, deepseek } = r;
  const lines = [
    `Soniox: ${duration(soniox.audioSeconds)} of audio ≈ ${formatUsd(soniox.audioUsd)}; ${n(soniox.outputTokens)} output tokens ≈ ${formatUsd(soniox.tokensUsd)}`,
  ];
  const labels: Record<DeepseekKind, string> = { refine: 'polish', summary: 'summary' };
  for (const kind of ['refine', 'summary'] as const) {
    const b = deepseek[kind];
    if (!b.calls) continue;
    lines.push(
      `DeepSeek ${labels[kind]}: ${b.calls} ${b.calls === 1 ? 'call' : 'calls'}, ${n(b.hit + b.miss)} input tokens (${n(b.hit)} cached), ${n(b.out)} output tokens ≈ ${formatUsd(b.usd)}`,
    );
  }
  lines.push(`Total ≈ ${formatUsd(r.totalUsd)}`);
  return lines;
}

export const COST_NOTE =
  'Estimate in USD; your invoices are the source of truth. DeepSeek is priced per request by UTC time (peak: weekdays 01–04 and 06–10); Chinese public holidays cannot be detected and are priced as peak, so this may run slightly high. Soniox is estimated at $0.12 per audio hour plus $4 per million output tokens.';
