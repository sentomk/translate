import type { Segmenter } from './segmenter.ts';
import type { State } from './state.ts';
import type { Sentence, SonioxResponse } from './types.ts';

const CONTROL_TOKENS = new Set(['<end>', '<fin>']);

export interface PipelineDeps {
  state: State;
  segmenter: Segmenter;
  sink: { enqueue(id: number): void };
  now?: () => number;
}

export interface PipelineResult {
  finished: boolean;
  error?: string;
}

/** Turns Soniox token messages into sentences, writes them to the state and hands them to the polish queue. */
export class Pipeline {
  private liveZh = '';
  private liveEn = '';
  private readonly deps: PipelineDeps;
  private readonly now: () => number;

  constructor(deps: PipelineDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
  }

  handleResponse(res: SonioxResponse): PipelineResult {
    if (res.error_code !== undefined && res.error_code !== null) {
      const error = `Soniox error ${res.error_code}: ${res.error_message ?? ''}`;
      this.deps.state.setStatus(error);
      return { finished: true, error };
    }

    if (res.tokens) {
      let newEn = '';
      let newZh = '';
      let liveZh = '';
      let liveEn = '';
      for (const tok of res.tokens) {
        const text = tok.text;
        if (!text || CONTROL_TOKENS.has(text)) continue;
        const isTranslation = tok.translation_status === 'translation';
        if (tok.is_final) {
          if (isTranslation) newZh += text;
          else newEn += text;
        } else if (isTranslation) {
          // Non-final tokens are re-sent whole in every response, so replace rather than append
          liveZh += text;
        } else {
          liveEn += text;
        }
      }
      const { segmenter } = this.deps;
      segmenter.pushEn(newEn, this.now());
      segmenter.pushZh(newZh);
      this.liveZh = liveZh;
      this.liveEn = liveEn;
      this.emit(segmenter.poll(this.now()));
      this.updateDraft();
    }
    return { finished: Boolean(res.finished) };
  }

  /** Call on a timer to emit sentences that have been idle long enough. */
  tick(): void {
    this.emit(this.deps.segmenter.poll(this.now()));
    this.updateDraft();
  }

  /** At the end of the session, emit all remaining text. */
  flush(): void {
    this.emit(this.deps.segmenter.flush());
    this.liveZh = '';
    this.liveEn = '';
    this.updateDraft();
  }

  private emit(sentences: Sentence[]): void {
    for (const s of sentences) {
      if (!s.en) continue;
      const seg = this.deps.state.addSegment(s.en, s.zh);
      this.deps.sink.enqueue(seg.id);
    }
  }

  private updateDraft(): void {
    // The sentence being spoken = finalized text that is not a full sentence yet + the non-final part that may still change
    const { segmenter, state } = this.deps;
    state.setDraft((segmenter.pendingZh + this.liveZh).trim(), (segmenter.pendingEn + this.liveEn).trim());
  }
}
