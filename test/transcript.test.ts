import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { renderSummaryMarkdown, renderTranscript, saveSession } from '../src/transcript.ts';
import { State } from '../src/state.ts';
import type { Summary } from '../src/types.ts';

const summary: Summary = {
  topic: '梯度下降',
  current: '讲到学习率',
  points: ['用下山类比', '步长叫学习率'],
  terms: [{ en: 'learning rate', zh: '学习率' }],
  upto: 2,
  updatedAt: 0,
};

function segments() {
  const s = new State();
  s.addSegment('Hello.', '草稿一');
  s.setRefined(1, '你好。');
  s.addSegment('Bye.', '草稿二');
  s.setError(2, 'HTTP 500');
  return s.segments;
}

describe('transcript / summary output', () => {
  it('transcript: failed lines fall back to the draft and are marked', () => {
    const txt = renderTranscript(segments());
    assert.match(txt, /\[1\] Hello\.\n {4}你好。/);
    assert.match(txt, /\[2\] Bye\.\n {4}\[draft\] 草稿二/);
  });

  it('summary Markdown: title, key points (ordered), terms, last covered', () => {
    const md = renderSummaryMarkdown(summary, { at: new Date(2026, 9, 14, 21, 5), sentences: 2, transcriptFile: 't.txt' });
    assert.equal(
      md,
      '# 梯度下降\n\n> 2026-10-14 21:05 · 2 lines · Transcript: t.txt\n\n## Key points\n\n1. 用下山类比\n2. 步长叫学习率\n\n## Terms\n\n- **learning rate** — 学习率\n\n## Last covered\n\n讲到学习率\n',
    );
  });

  it('without a topic it uses the default title and omits empty sections', () => {
    const md = renderSummaryMarkdown({ ...summary, topic: '', terms: [], current: '' }, { at: new Date(2026, 0, 2, 3, 4), sentences: 1 });
    assert.match(md, /^# Class summary\n\n> 2026-01-02 03:04 · 1 line\n/);
    assert.doesNotMatch(md, /## Terms|## Last covered/);
  });

  it('saveSession writes .txt and .md with the same timestamp; without a summary only the .txt; with no lines nothing', () => {
    const dir = join(mkdtempSync(join(tmpdir(), 'out-')), 'nested', 'output');
    const at = new Date(2026, 9, 14, 21, 5, 9);
    const both = saveSession(dir, segments(), summary, { at })!;
    assert.equal(both.transcriptPath, join(dir, 'transcript_20261014_210509.txt'));
    assert.equal(both.summaryPath, join(dir, 'summary_20261014_210509.md'));
    assert.match(readFileSync(both.summaryPath!, 'utf8'), /Transcript: transcript_20261014_210509\.txt/);

    const txtOnly = saveSession(dir, segments(), null, { at: new Date(2026, 9, 14, 22, 0, 0) })!;
    assert.equal(txtOnly.summaryPath, undefined);
    assert.equal(existsSync(join(dir, 'summary_20261014_220000.md')), false);

    assert.equal(saveSession(join(dir, 'empty'), [], summary), undefined);
    assert.equal(existsSync(join(dir, 'empty')), false);
  });
});
