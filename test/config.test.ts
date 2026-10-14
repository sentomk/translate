import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';
import { ConfigError, loadDotEnv, parseCli } from '../src/config.ts';
import { parseGlossary } from '../src/glossary.ts';

const keys = { SONIOX_API_KEY: 's', DEEPSEEK_API_KEY: 'd' };

describe('parseCli', () => {
  it('defaults', () => {
    const o = parseCli([], keys);
    assert.equal(o.source, 'en');
    assert.equal(o.model, 'deepseek-flash');
    assert.equal(o.sonioxModel, 'stt-rt-v5');
    assert.equal(o.port, 8765);
    assert.equal(o.host, '127.0.0.1');
    assert.equal(o.noBrowser, false);
    assert.equal(o.paused, false);
    assert.equal(o.summary, true);
    assert.equal(o.outDir, 'output');
  });

  it('names the missing key', () => {
    assert.throws(() => parseCli([], { SONIOX_API_KEY: 's' }), (e: Error) => e instanceof ConfigError && /DEEPSEEK_API_KEY/.test(e.message));
  });

  it('--help and --list-devices do not need keys', () => {
    assert.equal(parseCli(['--help'], {}).help, true);
    assert.equal(parseCli(['--list-devices'], {}).listDevices, true);
  });

  it('parses the options', () => {
    const o = parseCli(['--wav', 'a.wav', '--device', '1', '--port', '9000', '--no-browser', '--topic', 'ML', '--model', 'm'], keys);
    assert.equal(o.wav, 'a.wav');
    assert.equal(o.device, 1);
    assert.equal(o.port, 9000);
    assert.equal(o.noBrowser, true);
    assert.equal(o.topic, 'ML');
    assert.equal(o.model, 'm');
  });

  it('--paused / --no-summary / --out', () => {
    const o = parseCli(['--paused', '--no-summary', '--out', 'notes'], keys);
    assert.equal(o.paused, true);
    assert.equal(o.summary, false);
    assert.equal(o.outDir, 'notes');
  });

  it('--soniox-rate: unset by default, invalid values throw', () => {
    assert.equal(parseCli([], keys).sonioxRate, undefined);
    assert.equal(parseCli(['--soniox-rate', '0.18'], keys).sonioxRate, 0.18);
    assert.throws(() => parseCli(['--soniox-rate', 'abc'], keys), ConfigError);
    assert.throws(() => parseCli(['--soniox-rate', '-1'], keys), ConfigError);
  });

  it('invalid port and unknown options throw ConfigError', () => {
    assert.throws(() => parseCli(['--port', 'abc'], keys), ConfigError);
    assert.throws(() => parseCli(['--bogus'], keys), ConfigError);
  });

  it('--glossary reads a file; --context @file reads the file contents', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cfg-'));
    writeFileSync(join(dir, 'g.txt'), 'gradient descent = 梯度下降\n');
    writeFileSync(join(dir, 'c.txt'), '这是一门机器学习导论\n');
    const o = parseCli(['--glossary', join(dir, 'g.txt'), '--context', `@${join(dir, 'c.txt')}`], keys);
    assert.deepEqual(o.glossary, [{ term: 'gradient descent', zh: '梯度下降' }]);
    assert.equal(o.context, '这是一门机器学习导论');
    assert.throws(() => parseCli(['--glossary', join(dir, 'nope.txt')], keys), ConfigError);
  });
});

describe('parseGlossary', () => {
  it('supports = / => / -> separators, a bare term to keep it as is, comments and blank lines', () => {
    const entries = parseGlossary('# 注释\n\na = 甲\nb => 乙\nc -> 丙\nPyTorch\n  GPU  \n');
    assert.deepEqual(entries, [
      { term: 'a', zh: '甲' },
      { term: 'b', zh: '乙' },
      { term: 'c', zh: '丙' },
      { term: 'PyTorch' },
      { term: 'GPU' },
    ]);
  });
});

describe('loadDotEnv', () => {
  it('reads variables, supports quotes / export / comments, and never overrides existing variables', () => {
    const dir = mkdtempSync(join(tmpdir(), 'env-'));
    const file = join(dir, '.env');
    writeFileSync(file, '# c\nA=1\nexport B="two words"\nC=\'3\' \nD=4 # tail\nE=keep\n');
    const env: NodeJS.ProcessEnv = { E: 'existing' };
    loadDotEnv(file, env);
    assert.deepEqual(env, { A: '1', B: 'two words', C: '3', D: '4', E: 'existing' });
  });

  it('does nothing when the file does not exist', () => {
    const env: NodeJS.ProcessEnv = {};
    loadDotEnv('/nonexistent/.env', env);
    assert.deepEqual(env, {});
  });
});
