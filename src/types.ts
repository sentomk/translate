export type SegmentStatus = 'pending' | 'refined' | 'error';

/** A finalized English sentence and its Chinese translation. */
export interface Segment {
  id: number;
  en: string;
  /** Soniox machine-translation draft; the fallback when polishing fails */
  draftZh: string;
  /** The translation on screen: the draft before polishing, DeepSeek's result after */
  zh: string;
  status: SegmentStatus;
  /** Whether a later sentence has revised this one */
  revised: boolean;
  error?: string;
  rev: number;
}

export type MicState = 'off' | 'starting' | 'on' | 'stopping';

export interface MicView {
  state: MicState;
  /** Audio source: the real microphone, or a --wav file */
  source: 'mic' | 'wav';
}

/** Class summary that DeepSeek keeps updating as the lecture goes on. */
export interface Summary {
  topic: string;
  /** What the teacher is covering right now */
  current: string;
  points: string[];
  terms: Array<{ en: string; zh: string }>;
  /** Summarized through this line (segment id) */
  upto: number;
  updatedAt: number;
}

export interface SummaryView {
  enabled: boolean;
  busy: boolean;
  error?: string;
  data: Summary | null;
}

/** Incremental update pushed to the page. */
export interface Snapshot {
  rev: number;
  mic?: MicView;
  summary?: SummaryView;
  segments?: Segment[];
  /** The sentence being spoken right now: Soniox's Chinese draft / English */
  draft?: string;
  draftEn?: string;
  status?: string;
}

export interface Sentence {
  en: string;
  zh: string;
}

export interface SonioxToken {
  text?: string;
  is_final?: boolean;
  translation_status?: 'none' | 'original' | 'translation';
  start_ms?: number;
  end_ms?: number;
}

/** The usage field of a DeepSeek response */
export interface DeepseekUsage {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
}

export interface SonioxResponse {
  tokens?: SonioxToken[];
  total_audio_proc_ms?: number;
  finished?: boolean;
  error_code?: number | string | null;
  error_message?: string | null;
}

export interface GlossaryEntry {
  term: string;
  /** Empty means keep the original term */
  zh?: string;
}
