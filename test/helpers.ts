import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocketServer } from 'ws';

export interface MockSoniox {
  url: string;
  configs: any[];
  authHeaders: Array<string | undefined>;
  audioChunks: () => number;
  endFrames: () => number;
  close(): Promise<void>;
}

/**
 * Pretends to be Soniox: on the 1st audio chunk it sends a non-final draft; on the 5th it sends the first sentence and the start of the second;
 * after the empty end frame it sends the rest plus finished. With ignoreEnd it does not answer the end frame.
 */
export async function startMockSoniox(opts: { ignoreEnd?: boolean } = {}): Promise<MockSoniox> {
  const wss = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise<void>((resolve) => wss.once('listening', resolve));
  const configs: any[] = [];
  const authHeaders: Array<string | undefined> = [];
  let chunks = 0;
  let ends = 0;

  wss.on('connection', (ws, req: IncomingMessage) => {
    authHeaders.push(req.headers.authorization);
    ws.on('message', (data, isBinary) => {
      const send = (tokens: object[], extra: object = {}) =>
        ws.send(JSON.stringify({ tokens, total_audio_proc_ms: chunks * 120, ...extra }));
      if (isBinary) {
        chunks++;
        if (chunks === 1) {
          send([
            { text: 'Hello', is_final: false, translation_status: 'original' },
            { text: '你好', is_final: false, translation_status: 'translation' },
          ]);
        } else if (chunks === 5) {
          send([
            { text: ' Hello everyone.', is_final: true, translation_status: 'original' },
            { text: ' Today we talk', is_final: true, translation_status: 'original' },
            { text: '你好，大家。', is_final: true, translation_status: 'translation' },
            { text: '<end>', is_final: true, translation_status: 'none' },
          ]);
        }
        return;
      }
      const text = data.toString();
      if (text === '') {
        ends++;
        if (opts.ignoreEnd) return;
        send(
          [
            { text: ' about gradient descent.', is_final: true, translation_status: 'original' },
            { text: '今天我们讲梯度下降。', is_final: true, translation_status: 'translation' },
            { text: '<fin>', is_final: true, translation_status: 'none' },
          ],
          { finished: true },
        );
        ws.close();
        return;
      }
      configs.push(JSON.parse(text));
    });
  });

  return {
    url: `ws://127.0.0.1:${(wss.address() as AddressInfo).port}`,
    configs,
    authHeaders,
    audioChunks: () => chunks,
    endFrames: () => ends,
    close: () =>
      new Promise<void>((resolve) => {
        for (const c of wss.clients) c.terminate();
        wss.close(() => resolve());
      }),
  };
}

export interface MockDeepseek {
  url: string;
  requests: Array<{ body: any; auth: string | undefined }>;
  close(): Promise<void>;
}

export type DeepseekHandler = (body: any, index: number) => { status?: number; json?: unknown; content?: unknown; usage?: object };

export async function startMockDeepseek(handler: DeepseekHandler, delayMs = 0): Promise<MockDeepseek> {
  const requests: MockDeepseek['requests'] = [];
  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw);
      const index = requests.push({ body, auth: req.headers.authorization }) - 1;
      const out = handler(body, index);
      setTimeout(() => {
        res.writeHead(out.status ?? 200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(out.json ?? { choices: [{ message: { content: JSON.stringify(out.content) } }], usage: out.usage }));
      }, delayMs);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      }),
  };
}

/** Read the SSE stream until the server closes it and return every data message. */
export async function collectSse(url: string): Promise<{ messages: any[]; done: Promise<void> }> {
  const res = await fetch(url);
  const messages: any[] = [];
  const decoder = new TextDecoder();
  const reader = res.body!.getReader();
  let buffer = '';
  const done = (async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        for (let i = buffer.indexOf('\n\n'); i >= 0; i = buffer.indexOf('\n\n')) {
          const block = buffer.slice(0, i);
          buffer = buffer.slice(i + 2);
          const line = block.split('\n').find((l) => l.startsWith('data: '));
          if (line) messages.push(JSON.parse(line.slice(6)));
        }
      }
    } catch {
      // The connection was closed by the server
    }
  })();
  return { messages, done };
}

/** Build WAV file contents (default 16 kHz mono 16-bit, 1 second). */
export function makeWav(opts: { rate?: number; channels?: number; bits?: number; samples?: number; dataSize?: number } = {}): Buffer {
  const { rate = 16000, channels = 1, bits = 16, samples = 16000 } = opts;
  const data = Buffer.alloc(samples * channels * (bits / 8), 1);
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + data.length, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(channels, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE((rate * channels * bits) / 8, 28);
  header.writeUInt16LE((channels * bits) / 8, 32);
  header.writeUInt16LE(bits, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(opts.dataSize ?? data.length, 40);
  return Buffer.concat([header, data]);
}
