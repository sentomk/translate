import type { Sentence } from './types.ts';

const ABBREVIATIONS = new Set([
  'e.g.', 'i.e.', 'etc.', 'vs.', 'dr.', 'mr.', 'mrs.', 'ms.', 'fig.', 'eq.', 'no.', 'approx.',
  'prof.', 'sr.', 'jr.', 'st.', 'mt.', 'inc.', 'ltd.', 'co.', 'corp.', 'dept.', 'est.', 'cf.',
  'ca.', 'al.', 'vol.', 'ch.', 'sec.', 'pp.', 'u.s.', 'u.k.', 'a.m.', 'p.m.', 'ph.d.',
  'jan.', 'feb.', 'mar.', 'apr.', 'jun.', 'jul.', 'aug.', 'sep.', 'sept.', 'oct.', 'nov.', 'dec.',
]);

/** Terminal punctuation, optional closing quotes/brackets, whitespace, then more text. */
const BOUNDARY = /[.!?]["')\]]*\s+(?=\S)/g;
const ENDS_WITH_TERMINAL = /[.!?]["')\]]*$/;
const ZH_TERMINALS = '。！？';

export interface SegmenterOptions {
  /** Idle time before emitting a last sentence that ends with terminal punctuation */
  idleMs?: number;
  /** Idle time before emitting text with no punctuation */
  noPunctMs?: number;
  /** Force an emit once this many characters have accumulated */
  maxChars?: number;
}

function endsWithAbbreviation(text: string, periodIdx: number): boolean {
  const m = /([A-Za-z][A-Za-z.]*)$/.exec(text.slice(0, periodIdx + 1));
  return m !== null && ABBREVIATIONS.has(m[1]!.toLowerCase());
}

/**
 * Splits Soniox's finalized English text into sentences. The Chinese draft is split
 * proportionally by length; it is only a fallback when polishing fails, so it need not line up exactly.
 */
export class Segmenter {
  private en = '';
  private zh = '';
  private lastPush = 0;
  private readonly idleMs: number;
  private readonly noPunctMs: number;
  private readonly maxChars: number;

  constructor(opts: SegmenterOptions = {}) {
    this.idleMs = opts.idleMs ?? 800;
    this.noPunctMs = opts.noPunctMs ?? 6000;
    this.maxChars = opts.maxChars ?? 450;
  }

  /** Finalized English that has not formed a full sentence yet */
  get pendingEn(): string {
    return this.en.trim();
  }

  /** Finalized Chinese draft not yet assigned to any sentence */
  get pendingZh(): string {
    return this.zh.trim();
  }

  pushEn(text: string, now: number): void {
    if (!text) return;
    this.en += text;
    this.lastPush = now;
  }

  pushZh(text: string): void {
    this.zh += text;
  }

  /** Take every sentence that is ready to be emitted. */
  poll(now: number): Sentence[] {
    const out: Sentence[] = [];
    for (;;) {
      const end = this.findBoundary();
      if (end < 0) break;
      out.push(this.take(end));
    }
    const rest = this.en.trim();
    if (rest) {
      const idle = now - this.lastPush;
      const terminal = ENDS_WITH_TERMINAL.test(rest) && !this.restEndsWithAbbreviation(rest);
      if (this.en.length >= this.maxChars || (terminal && idle >= this.idleMs) || idle >= this.noPunctMs) {
        out.push(this.take(this.en.length));
      }
    }
    return out;
  }

  /** At the end of the session, emit everything that is left. */
  flush(): Sentence[] {
    const out = this.poll(Number.POSITIVE_INFINITY);
    if (this.en.trim()) out.push(this.take(this.en.length));
    return out;
  }

  private restEndsWithAbbreviation(rest: string): boolean {
    return rest.endsWith('.') && endsWithAbbreviation(rest, rest.length - 1);
  }

  private findBoundary(): number {
    BOUNDARY.lastIndex = 0;
    for (let m = BOUNDARY.exec(this.en); m; m = BOUNDARY.exec(this.en)) {
      if (this.en[m.index] === '.' && endsWithAbbreviation(this.en, m.index)) continue;
      return m.index + m[0].length;
    }
    return -1;
  }

  private take(end: number): Sentence {
    const all = end >= this.en.length;
    const fraction = all ? 1 : end / this.en.length;
    const en = this.en.slice(0, end).trim();
    this.en = this.en.slice(end).trimStart();
    return { en, zh: this.takeZh(fraction, all) };
  }

  private takeZh(fraction: number, all: boolean): string {
    if (all) {
      const zh = this.zh.trim();
      this.zh = '';
      return zh;
    }
    let cut = Math.round(this.zh.length * fraction);
    // Prefer cutting at a Chinese sentence end: look back first, then a short way forward
    let back = -1;
    for (let i = Math.min(cut, this.zh.length) - 1; i >= 0; i--) {
      if (ZH_TERMINALS.includes(this.zh[i]!)) {
        back = i + 1;
        break;
      }
    }
    if (back > 0) cut = back;
    else {
      for (let i = cut; i < Math.min(this.zh.length, cut + 12); i++) {
        if (ZH_TERMINALS.includes(this.zh[i]!)) {
          cut = i + 1;
          break;
        }
      }
    }
    const zh = this.zh.slice(0, cut).trim();
    this.zh = this.zh.slice(cut);
    return zh;
  }
}
