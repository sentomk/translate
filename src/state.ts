import { EventEmitter } from 'node:events';
import type { MicView, Segment, Snapshot, SummaryView } from './types.ts';

/**
 * All caption state. A global revision counter goes up on every change and each segment
 * has its own rev; diff(seen) returns whatever changed since `seen`.
 */
export class State extends EventEmitter {
  rev = 0;
  segments: Segment[] = [];
  private draft = '';
  private draftEn = '';
  private draftRev = 0;
  private status = '';
  private statusRev = 0;
  private mic: MicView | null = null;
  private micRev = 0;
  private summary: SummaryView | null = null;
  private summaryRev = 0;

  constructor() {
    super();
    this.setMaxListeners(0);
  }

  get(id: number): Segment | undefined {
    return this.segments[id - 1];
  }

  addSegment(en: string, draftZh: string): Segment {
    const seg: Segment = {
      id: this.segments.length + 1,
      en,
      draftZh,
      zh: draftZh,
      status: 'pending',
      revised: false,
      rev: this.bump(),
    };
    this.segments.push(seg);
    this.emit('change');
    return seg;
  }

  /** Polished result. Does not bump rev if nothing changed. */
  setRefined(id: number, zh: string): void {
    const seg = this.get(id);
    if (!seg || (seg.status === 'refined' && seg.zh === zh)) return;
    seg.zh = zh;
    seg.status = 'refined';
    delete seg.error;
    seg.rev = this.bump();
    this.emit('change');
  }

  /** A revision triggered by later context. Ignored if the text is unchanged; returns whether it changed. */
  revise(id: number, zh: string): boolean {
    const seg = this.get(id);
    if (!seg || seg.zh === zh) return false;
    seg.zh = zh;
    seg.status = 'refined';
    seg.revised = true;
    delete seg.error;
    seg.rev = this.bump();
    this.emit('change');
    return true;
  }

  /** Polishing failed: fall back to the Soniox draft. */
  setError(id: number, reason: string): void {
    const seg = this.get(id);
    if (!seg) return;
    seg.status = 'error';
    seg.error = reason;
    seg.zh = seg.draftZh;
    seg.rev = this.bump();
    this.emit('change');
  }

  /** The sentence being spoken: Chinese draft and English source. */
  setDraft(zh: string, en = ''): void {
    if (zh === this.draft && en === this.draftEn) return;
    this.draft = zh;
    this.draftEn = en;
    this.draftRev = this.bump();
    this.emit('change');
  }

  setStatus(text: string): void {
    if (text === this.status) return;
    this.status = text;
    this.statusRev = this.bump();
    this.emit('change');
  }

  setMic(view: MicView): void {
    if (this.mic?.state === view.state && this.mic.source === view.source) return;
    this.mic = view;
    this.micRev = this.bump();
    this.emit('change');
  }

  getMic(): MicView | null {
    return this.mic;
  }

  setSummary(view: SummaryView): void {
    this.summary = view;
    this.summaryRev = this.bump();
    this.emit('change');
  }

  getStatus(): string {
    return this.status;
  }

  diff(seen: number): Snapshot | null {
    const out: Snapshot = { rev: this.rev };
    const changed = this.segments.filter((s) => s.rev > seen);
    if (changed.length) out.segments = changed;
    if (this.draftRev > seen) {
      out.draft = this.draft;
      out.draftEn = this.draftEn;
    }
    if (this.statusRev > seen) out.status = this.status;
    if (this.mic && this.micRev > seen) out.mic = this.mic;
    if (this.summary && this.summaryRev > seen) out.summary = this.summary;
    return this.rev > seen ? out : null;
  }

  private bump(): number {
    return ++this.rev;
  }
}
