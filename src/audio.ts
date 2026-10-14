import { PvRecorder } from '@picovoice/pvrecorder-node';

export const SAMPLE_RATE = 16_000;
/** 3840 bytes = 1920 samples = 120 ms */
export const CHUNK_BYTES = 3840;
export const CHUNK_MS = 120;

export class WavFormatError extends Error {}

export interface AudioSource {
  chunks: AsyncIterable<Buffer>;
  stop(): void;
  /** WAV: bytes sent so far, used to resume after a pause */
  position?(): number;
  /** WAV: whether playback reached the end of the file on its own (not stopped) */
  exhausted?(): boolean;
}

const CONVERT_HINT = `Convert it with: ffmpeg -i input.mp3 -ar ${SAMPLE_RATE} -ac 1 -c:a pcm_s16le out.wav`;

/** Parse a 16 kHz mono 16-bit PCM WAV and return the raw PCM. Other formats get a conversion hint. */
export function parseWav(buf: Buffer): { data: Buffer } {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new WavFormatError(`Not a valid WAV file. ${CONVERT_HINT}`);
  }
  let fmt: { tag: number; channels: number; rate: number; bits: number } | undefined;
  let off = 12;
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4);
    let size = buf.readUInt32LE(off + 4);
    const start = off + 8;
    if (id === 'fmt ' && start + 16 <= buf.length) {
      fmt = {
        tag: buf.readUInt16LE(start),
        channels: buf.readUInt16LE(start + 2),
        rate: buf.readUInt32LE(start + 4),
        bits: buf.readUInt16LE(start + 14),
      };
    } else if (id === 'data') {
      if (!fmt) throw new WavFormatError('The WAV data chunk comes before the fmt chunk, so it cannot be parsed.');
      if (fmt.tag !== 1 || fmt.channels !== 1 || fmt.rate !== SAMPLE_RATE || fmt.bits !== 16) {
        throw new WavFormatError(
          `WAV must be ${SAMPLE_RATE / 1000} kHz, mono, 16-bit PCM` +
            ` (got ${fmt.rate} Hz / ${fmt.channels} channel(s) / ${fmt.bits}-bit / format ${fmt.tag}). ${CONVERT_HINT}`,
        );
      }
      // Streamed WAVs may write the length as 0xFFFFFFFF
      if (size === 0xffffffff || start + size > buf.length) size = buf.length - start;
      return { data: buf.subarray(start, start + (size & ~1)) };
    }
    off = start + size + (size & 1);
  }
  throw new WavFormatError(`No audio data found in the WAV. ${CONVERT_HINT}`);
}

export interface WavSourceOptions {
  /** Playback speed multiplier, default 1 (real time); 0 or Infinity means no waiting (for tests) */
  pace?: number;
  /** Byte offset to start from (resume after a pause) */
  startOffset?: number;
}

/** Emit one 120 ms chunk of the WAV at a time, at real-time speed. */
export function createWavSource(data: Buffer, opts: WavSourceOptions = {}): AudioSource {
  const pace = opts.pace ?? 1;
  const delay = pace > 0 && Number.isFinite(pace) ? CHUNK_MS / pace : 0;
  let stopped = false;
  let done = false;
  let position = opts.startOffset ?? 0;
  let wake: (() => void) | undefined;

  const sleep = (ms: number) =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, ms);
      wake = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  async function* gen(): AsyncGenerator<Buffer> {
    while (position < data.length && !stopped) {
      const end = Math.min(position + CHUNK_BYTES, data.length);
      const chunk = data.subarray(position, end);
      position = end;
      yield chunk;
      if (delay) await sleep(delay);
    }
    done = position >= data.length && !stopped;
  }
  return {
    chunks: gen(),
    stop() {
      stopped = true;
      wake?.();
    },
    position: () => position,
    exhausted: () => done,
  };
}

export function listMicDevices(): string[] {
  return PvRecorder.getAvailableDevices();
}

/** Microphone: each pvrecorder frame is 1920 Int16 samples (16 kHz), exactly 120 ms. */
export function createMicSource(device = -1): AudioSource {
  const recorder = new PvRecorder(CHUNK_BYTES / 2, device);
  let stopped = false;
  let stopSignal: (() => void) | undefined;
  const stopped$ = new Promise<null>((resolve) => {
    stopSignal = () => resolve(null);
  });

  async function* gen(): AsyncGenerator<Buffer> {
    recorder.start();
    let reading = false;
    try {
      while (!stopped) {
        reading = true;
        const frame = await Promise.race([recorder.read(), stopped$]);
        reading = false;
        if (!frame) break;
        // Buffer.from(Uint8Array) copies, so we never hold pvrecorder's internal buffer
        yield Buffer.from(new Uint8Array(frame.buffer, frame.byteOffset, frame.byteLength));
      }
    } catch (err) {
      if (!stopped) throw err;
    } finally {
      try {
        recorder.stop();
        // Do not release while a read() is still pending; let process exit clean up
        if (!reading) recorder.release();
      } catch {
        // The device is no longer available
      }
    }
  }
  return {
    chunks: gen(),
    stop() {
      stopped = true;
      stopSignal?.();
    },
  };
}
