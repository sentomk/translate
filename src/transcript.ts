import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { COST_NOTE, formatCost, type CostReport } from './cost.ts';
import type { Segment, Summary } from './types.ts';

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function renderTranscript(segments: Segment[], cost?: CostReport): string {
  const bilingual = segments
    .map((s) => {
      const mark = s.status === 'error' ? '[draft] ' : '';
      return `[${s.id}] ${s.en}\n    ${mark}${s.zh}`;
    })
    .join('\n');
  const en = segments.map((s) => s.en).join(' ');
  const zh = segments.map((s) => s.zh).join('');
  return (
    `== Bilingual ==\n${bilingual}\n\n` +
    `== English (source) ==\n${en}\n\n` +
    `== Chinese (translation) ==\n${zh}\n` +
    (cost ? `\n== Cost estimate ==\n${formatCost(cost).join('\n')}\n(${COST_NOTE})\n` : '')
  );
}

export interface SummaryMeta {
  at: Date;
  sentences: number;
  /** File name of the matching transcript, shown at the top of the summary for reference */
  transcriptFile?: string | undefined;
}

/** The class summary as Markdown. */
export function renderSummaryMarkdown(summary: Summary, meta: SummaryMeta, cost?: CostReport): string {
  const { at } = meta;
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`;
  const info = [when, `${meta.sentences} ${meta.sentences === 1 ? 'line' : 'lines'}`, meta.transcriptFile && `Transcript: ${meta.transcriptFile}`].filter(Boolean);
  const out = [`# ${summary.topic || 'Class summary'}`, '', `> ${info.join(' · ')}`, ''];
  if (summary.points.length) out.push('## Key points', '', ...summary.points.map((p, i) => `${i + 1}. ${p}`), '');
  if (summary.terms.length) out.push('## Terms', '', ...summary.terms.map((t) => `- **${t.en}** — ${t.zh}`), '');
  if (summary.current) out.push('## Last covered', '', summary.current, '');
  if (cost) out.push('## Cost estimate', '', ...formatCost(cost).map((l) => `- ${l}`), '', `*${COST_NOTE}*`, '');
  return out.join('\n');
}

export interface SavedSession {
  transcriptPath: string;
  summaryPath?: string;
}

/**
 * Writes transcript_YYYYMMDD_HHMMSS.txt (the transcript) and, if there is one, summary_YYYYMMDD_HHMMSS.md into dir.
 * Writes nothing and returns undefined when there are no lines.
 */
export function saveSession(
  dir: string,
  segments: Segment[],
  summary?: Summary | null,
  opts: { at?: Date; cost?: CostReport } = {},
): SavedSession | undefined {
  if (!segments.length) return undefined;
  const at = opts.at ?? new Date();
  mkdirSync(dir, { recursive: true });
  const stamp =
    `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}_` +
    `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
  const transcriptFile = `transcript_${stamp}.txt`;
  const transcriptPath = join(dir, transcriptFile);
  writeFileSync(transcriptPath, renderTranscript(segments, opts.cost), 'utf8');
  const saved: SavedSession = { transcriptPath };
  if (summary) {
    saved.summaryPath = join(dir, `summary_${stamp}.md`);
    writeFileSync(saved.summaryPath, renderSummaryMarkdown(summary, { at, sentences: segments.length, transcriptFile }, opts.cost), 'utf8');
  }
  return saved;
}
