import WebSocket from 'ws';
import type { SonioxResponse } from './types.ts';

export const SONIOX_URL = 'wss://stt-rt.soniox.com/transcribe-websocket';

export interface SonioxOptions {
  url?: string;
  apiKey: string;
  model: string;
  /** Source language hint, e.g. en */
  source: string;
  target?: string;
  onResponse: (res: SonioxResponse) => void;
  onClose: (reason: string) => void;
}

export class SonioxClient {
  private ws: WebSocket | null = null;
  /** Audio bytes actually sent on this connection */
  bytesSent = 0;
  private readonly o: SonioxOptions;

  constructor(o: SonioxOptions) {
    this.o = o;
  }

  get isOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  connect(): Promise<void> {
    const { apiKey } = this.o;
    return new Promise((resolve, reject) => {
      // The docs are inconsistent about auth, so send both the header and api_key in the config
      const ws = new WebSocket(this.o.url ?? SONIOX_URL, {
        headers: { Authorization: `Bearer ${apiKey}` },
        handshakeTimeout: 10_000,
      });
      this.ws = ws;
      let opened = false;
      ws.once('open', () => {
        opened = true;
        ws.send(
          JSON.stringify({
            api_key: apiKey,
            model: this.o.model,
            audio_format: 'pcm_s16le',
            sample_rate: 16000,
            num_channels: 1,
            language_hints: [this.o.source],
            translation: { type: 'one_way', target_language: this.o.target ?? 'zh' },
          }),
        );
        resolve();
      });
      ws.on('message', (data, isBinary) => {
        if (isBinary) return;
        try {
          this.o.onResponse(JSON.parse(data.toString()) as SonioxResponse);
        } catch (err) {
          this.o.onClose(`Could not parse a Soniox message: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
      ws.on('error', (err) => {
        if (!opened) reject(err);
        else this.o.onClose(`Connection error: ${err.message}`);
      });
      ws.on('close', (code, reason) => {
        this.o.onClose(`Connection closed (${code}${reason.length ? ` ${reason.toString()}` : ''})`);
      });
    });
  }

  sendAudio(chunk: Buffer): void {
    if (!this.isOpen) return;
    this.ws!.send(chunk, { binary: true });
    this.bytesSent += chunk.length;
  }

  /** An empty frame marks the end of the audio. */
  endAudio(): void {
    if (this.isOpen) this.ws!.send('');
  }

  close(): void {
    try {
      this.ws?.terminate();
    } catch {
      // Already closed
    }
  }
}
