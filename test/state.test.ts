import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { State } from '../src/state.ts';

describe('State', () => {
  it('diff(0) returns every segment; diff(rev) returns null when nothing changed', () => {
    const s = new State();
    s.addSegment('One.', '一。');
    s.addSegment('Two.', '二。');
    const all = s.diff(0)!;
    assert.equal(all.segments!.length, 2);
    assert.equal(s.diff(all.rev), null);
  });

  it('diff only returns changed segments; rev goes up after a revision', () => {
    const s = new State();
    s.addSegment('One.', '一');
    s.addSegment('Two.', '二');
    const seen = s.diff(0)!.rev;
    const before = s.get(1)!.rev;
    assert.equal(s.revise(1, '一（改）'), true);
    const d = s.diff(seen)!;
    assert.deepEqual(d.segments!.map((x) => x.id), [1]);
    assert.ok(d.segments![0]!.rev > before);
    assert.equal(d.segments![0]!.revised, true);
    assert.equal(d.draft, undefined);
  });

  it('does not bump rev when the translation did not change', () => {
    const s = new State();
    s.addSegment('One.', '一');
    s.setRefined(1, '壹');
    const rev = s.rev;
    s.setRefined(1, '壹');
    assert.equal(s.revise(1, '壹'), false);
    assert.equal(s.rev, rev);
  });

  it('draft and status are only pushed when they change', () => {
    const s = new State();
    s.setDraft('草稿');
    s.setStatus('Listening');
    const seen = s.rev;
    s.setDraft('草稿');
    s.setStatus('Listening');
    assert.equal(s.diff(seen), null);
    s.setDraft('新的草稿');
    assert.deepEqual(s.diff(seen), { rev: s.rev, draft: '新的草稿', draftEn: '' });
    s.setDraft('新的草稿', 'new draft');
    assert.equal(s.diff(s.rev - 1)!.draftEn, 'new draft');
  });

  it('falls back to the Soniox draft when polishing fails', () => {
    const s = new State();
    s.addSegment('One.', '草稿一');
    s.setRefined(1, '润色一');
    s.setError(1, 'HTTP 500');
    assert.equal(s.get(1)!.zh, '草稿一');
    assert.equal(s.get(1)!.status, 'error');
  });

  it('emits a change event on every change', () => {
    const s = new State();
    let n = 0;
    s.on('change', () => n++);
    s.addSegment('One.', '一');
    s.setStatus('x');
    assert.equal(n, 2);
  });
});
