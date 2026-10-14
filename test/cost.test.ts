import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CostTracker, DEFAULT_PRICING, formatCost, formatUsd, isPeak } from '../src/cost.ts';

const utc = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(Date.UTC(y, mo - 1, d, h, mi));

describe('isPeak (UTC weekdays 01-04 and 06-10)', () => {
  it('boundaries', () => {
    // 2026-10-14 is a Wednesday
    assert.equal(isPeak(utc(2026, 10, 14, 0, 59)), false);
    assert.equal(isPeak(utc(2026, 10, 14, 1, 0)), true);
    assert.equal(isPeak(utc(2026, 10, 14, 3, 59)), true);
    assert.equal(isPeak(utc(2026, 10, 14, 4, 0)), false);
    assert.equal(isPeak(utc(2026, 10, 14, 5, 59)), false);
    assert.equal(isPeak(utc(2026, 10, 14, 6, 0)), true);
    assert.equal(isPeak(utc(2026, 10, 14, 9, 59)), true);
    assert.equal(isPeak(utc(2026, 10, 14, 10, 0)), false);
    assert.equal(isPeak(utc(2026, 10, 14, 15, 0)), false);
  });

  it('weekends are off-peak all day; Monday and Friday behave normally', () => {
    assert.equal(isPeak(utc(2026, 10, 17, 2)), false); // Saturday
    assert.equal(isPeak(utc(2026, 10, 18, 7)), false); // Sunday
    assert.equal(isPeak(utc(2026, 10, 12, 1)), true); // Monday
    assert.equal(isPeak(utc(2026, 10, 16, 9)), true); // Friday
  });
});

describe('CostTracker', () => {
  const usage = { prompt_tokens: 1000, completion_tokens: 100, prompt_cache_hit_tokens: 400, prompt_cache_miss_tokens: 600 };

  it('DeepSeek: peak vs off-peak price (off-peak is half)', () => {
    const peak = new CostTracker(DEFAULT_PRICING, () => utc(2026, 10, 14, 2));
    const off = new CostTracker(DEFAULT_PRICING, () => utc(2026, 10, 14, 12));
    peak.addDeepseek('refine', usage);
    off.addDeepseek('refine', usage);
    assert.ok(Math.abs(peak.report().deepseek.refine.usd - 302.4e-6) < 1e-12);
    assert.ok(Math.abs(off.report().deepseek.refine.usd - 151.2e-6) < 1e-12);
  });

  it('without cache fields the whole prompt counts as a miss; without usage only the call is counted', () => {
    const t = new CostTracker(DEFAULT_PRICING, () => utc(2026, 10, 14, 12));
    t.addDeepseek('summary', { prompt_tokens: 1000, completion_tokens: 0 });
    t.addDeepseek('summary', undefined);
    const b = t.report().deepseek.summary;
    assert.equal(b.calls, 2);
    assert.equal(b.miss, 1000);
    assert.equal(b.hit, 0);
    assert.ok(Math.abs(b.usd - 1000 * 0.15e-6) < 1e-12);
  });

  it('Soniox: $0.12 per audio hour + $4 per million output tokens', () => {
    const t = new CostTracker();
    t.addAudio(3600_000);
    t.addSonioxTokens(250_000);
    const s = t.report().soniox;
    assert.equal(s.audioSeconds, 3600);
    assert.ok(Math.abs(s.audioUsd - 0.12) < 1e-12);
    assert.ok(Math.abs(s.tokensUsd - 1) < 1e-12);
    assert.ok(Math.abs(t.report().totalUsd - 1.12) < 1e-12);
  });

  it('prices can be overridden (--soniox-rate)', () => {
    const t = new CostTracker({ ...DEFAULT_PRICING, sonioxPerHour: 0.18 });
    t.addAudio(3600_000);
    assert.ok(Math.abs(t.report().soniox.audioUsd - 0.18) < 1e-12);
  });

  it('formatCost / formatUsd', () => {
    const t = new CostTracker(DEFAULT_PRICING, () => utc(2026, 10, 14, 2));
    t.addAudio((12 * 60 + 34) * 1000);
    t.addSonioxTokens(18230);
    t.addDeepseek('refine', usage);
    const lines = formatCost(t.report());
    assert.match(lines[0]!, /^Soniox: 12 min 34 s of audio ≈ \$0\.0251; 18,230 output tokens ≈ \$0\.0729$/);
    assert.match(lines[1]!, /^DeepSeek polish: 1 call, 1,000 input tokens \(400 cached\), 100 output tokens ≈ \$0\.0003$/);
    assert.ok(!lines.some((l) => l.includes('summary')), 'summary is not listed when there were no summary calls');
    assert.match(lines.at(-1)!, /^Total ≈ \$0\.0984$/);
    assert.equal(formatUsd(1.234), '$1.23');
    assert.equal(formatUsd(0.00005), '$0.0001');
  });
});
