import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHUNK_BYTES, createWavSource, parseWav, WavFormatError } from '../src/audio.ts';
import { makeWav } from './helpers.ts';

describe('parseWav', () => {
  it('accepts 16 kHz mono 16-bit', () => {
    assert.equal(parseWav(makeWav({ samples: 100 })).data.length, 200);
  });

  it('skips other chunks between fmt and data', () => {
    const base = makeWav({ samples: 10 });
    const list = Buffer.alloc(8 + 4);
    list.write('LIST', 0, 'ascii');
    list.writeUInt32LE(4, 4);
    const wav = Buffer.concat([base.subarray(0, 36), list, base.subarray(36)]);
    assert.equal(parseWav(wav).data.length, 20);
  });

  it('a streamed WAV with data length 0xFFFFFFFF reads to the end of the file', () => {
    assert.equal(parseWav(makeWav({ samples: 50, dataSize: 0xffffffff })).data.length, 100);
  });

  for (const [name, opts, expected] of [
    ['wrong sample rate', { rate: 44100 }, /44100 Hz/],
    ['stereo', { channels: 2 }, /2 channel/],
    ['8-bit', { bits: 8 }, /8-bit/],
  ] as const) {
    it(`gives a conversion hint for ${name}`, () => {
      assert.throws(() => parseWav(makeWav(opts)), (err: Error) => {
        assert.ok(err instanceof WavFormatError);
        assert.match(err.message, expected);
        assert.match(err.message, /ffmpeg -i input\.mp3 -ar 16000 -ac 1 -c:a pcm_s16le/);
        return true;
      });
    });
  }

  it('rejects a file that is not a WAV', () => {
    assert.throws(() => parseWav(Buffer.from('not a wav file at all')), WavFormatError);
  });
});

describe('createWavSource', () => {
  it('cuts chunks of 3840 bytes (120 ms); the last one may be shorter', async () => {
    const data = Buffer.alloc(CHUNK_BYTES * 2 + 100, 7);
    const sizes: number[] = [];
    for await (const c of createWavSource(data, { pace: 0 }).chunks) sizes.push(c.length);
    assert.deepEqual(sizes, [CHUNK_BYTES, CHUNK_BYTES, 100]);
  });

  it('stops producing after stop(), and interrupts the wait', async () => {
    const source = createWavSource(Buffer.alloc(CHUNK_BYTES * 100), { pace: 1 });
    let n = 0;
    const started = Date.now();
    for await (const _ of source.chunks) {
      if (++n === 2) source.stop();
    }
    assert.equal(n, 2);
    assert.ok(Date.now() - started < 1000);
  });
});
