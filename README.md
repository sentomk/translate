# Live Captions

The teacher speaks English, and a web page shows Chinese captions in real time. When a later sentence reveals that an earlier line was translated wrong, the page fixes it. A side panel keeps a running summary of the class.

```
microphone / WAV ──▶ Soniox (live speech recognition + translation, fast draft)
                  ──▶ sentence splitter
                  ──▶ DeepSeek (polish each line, revise earlier lines)  ──▶ web page (SSE)
                  ──▶ DeepSeek (rolling class summary)                   ──▶ side panel
```

- **Draft (Soniox):** the English and a Chinese draft appear in the "Speaking now" card as the teacher talks.
- **Polish (DeepSeek):** each finished sentence is polished. With every new sentence, DeepSeek also re-checks the last 6 lines. If the new sentence settles an ambiguous word (bat, bank), exposes a recognition error ("lawn model" → LLM) or resolves a pronoun, the earlier line is revised. The revised line is highlighted, the old text is struck through and a "✎ Revised" label appears.
- **Summary (DeepSeek):** topic, what is being covered now, key points and terms. It updates every 3 new lines or every 45 seconds.
- **Output:** when you stop, `output/` gets `transcript_<time>.txt` and `summary_<time>.md`, both with a cost estimate at the end. `output/` is in `.gitignore`.

## Run

Needs Node 20.11 or newer.

```bash
npm install
cp .env.example .env     # then put SONIOX_API_KEY and DEEPSEEK_API_KEY in it
npm start                # listens to the microphone and opens the page
```

- The first time, allow microphone access for your terminal (System Settings → Privacy & Security → Microphone).
- No microphone? Play a file: `npm start -- --wav lecture.wav`. It must be 16 kHz, mono, 16-bit. Convert with
  `ffmpeg -i in.mp3 -ar 16000 -ac 1 -c:a pcm_s16le out.wav`.
- Press **Ctrl+C** to finish. It stops the audio, waits for the last translation, polish and summary, then saves the files. A second Ctrl+C quits at once and still saves what it has.
- Options go after `--`, for example `npm start -- --paused --topic "Machine learning"`.

| Option | What it does |
| --- | --- |
| `--wav FILE` | Play a WAV file instead of the microphone |
| `--device N`, `--list-devices` | Pick a microphone, or list them |
| `--paused` | Start without listening; click "Start listening" on the page |
| `--source LANG` | Source language hint, default `en` (the target is always Chinese) |
| `--topic TEXT` | Lecture topic, helps word choice |
| `--glossary FILE` | Glossary file (format below) |
| `--context TEXT` | Extra background; `@notes.txt` reads it from a file |
| `--model NAME` | DeepSeek model, default `deepseek-flash` |
| `--soniox-model NAME` | Soniox model, default `stt-rt-v5` |
| `--no-summary` | Turn off the class summary |
| `--out DIR` | Output directory, default `./output` |
| `--soniox-rate N` | Soniox price in USD per hour, only used for the cost estimate (default 0.12) |
| `--port N`, `--host HOST` | Page port (default 8765) and listen address (default 127.0.0.1) |
| `--no-browser` | Do not open the browser |

Keys are read from the environment first, then from `.env` in the current directory.

### Glossary

One entry per line; lines starting with `#` are comments (see `glossary.example.txt`):

```
gradient descent = 梯度下降     # pin a translation
PyTorch                         # a bare term stays in English
```

## The page

- **Start / Pause listening** (top left, or the Space key). Pausing also closes the Soniox connection, so nothing is billed while paused. Starting again reconnects and carries on, and line numbers continue.
- **Speaking now:** live draft of the sentence being spoken. Finished lines are grey until polished, then turn black.
- **Summary** (right panel, toggle in the header): topic, now covering, key points, terms. New items flash briefly. "↻ Refresh" updates it right away. On narrow screens it slides over the captions.
- **EN** shows or hides the English text, **A− / A+** change the text size, **◐** switches dark and light (it follows your system by default). Settings are saved in the browser.
- If you scroll up, the page stops following the latest line and shows "↓ Jump to latest".

The switch only accepts same-origin JSON requests from this machine (it checks the origin, the Host header and the content type), so other web pages cannot turn your microphone on. With `--host 0.0.0.0` other devices on your network can watch the captions but cannot control them.

## Cost estimate

When a session ends, the terminal prints an estimate, the same text is written at the end of both output files, and the page status shows the total:

```
Cost estimate (USD; an estimate, your invoice is the source of truth)
  Soniox: 39 s of audio ≈ $0.0013; 423 output tokens ≈ $0.0017
  DeepSeek polish: 11 calls, 10,007 input tokens (6,912 cached), 288 output tokens ≈ $0.0007
  DeepSeek summary: 4 calls, 2,324 input tokens (768 cached), 481 output tokens ≈ $0.0005
  Total ≈ $0.0042
```

- **DeepSeek:** the `usage` of every response times the [deepseek-flash price](https://api-docs.deepseek.com/quick_start/pricing). Peak hours (UTC, weekdays 01:00–04:00 and 06:00–10:00) cost twice as much, and each request is priced by its own time. Chinese public holidays cannot be detected, so they are priced as peak and the estimate may run a little high.
- **Soniox:** audio time reported by the server × $0.12/hour, plus finalized output tokens × $4 per million. This is the less certain part: the [Soniox pricing page](https://soniox.com/pricing) also says translation is included, so your invoice may be lower.
- Prices were checked on 2026-10-14. If they change, edit `DEFAULT_PRICING` in `src/cost.ts`.

## Development

```bash
npm run typecheck   # tsc --noEmit
npm test            # node:test, no network, keys or microphone needed
```

The tests include unit tests and end-to-end runs against a fake Soniox WebSocket server and a fake DeepSeek HTTP server. The code is in `src/`:

| File | Role |
| --- | --- |
| `app.ts` | `runApp(options, signal)`: starts everything, listening rounds, wrap-up |
| `soniox.ts`, `audio.ts` | Soniox WebSocket client; microphone and WAV sources |
| `segmenter.ts`, `pipeline.ts` | Sentence splitting; Soniox tokens → lines |
| `refiner.ts`, `prompt.ts` | DeepSeek polish queue and its prompt |
| `summarizer.ts` | Rolling class summary |
| `state.ts`, `server.ts`, `page.html` | Caption state, HTTP + SSE server, the page |
| `cost.ts`, `transcript.ts` | Cost estimate; output files |
| `config.ts`, `glossary.ts`, `index.ts` | CLI, `.env`, glossary, entry point |

## Limits

- If polishing fails, the line shows the Soniox draft with a "Draft" label, and the transcript marks it `[draft]`. After a 401, 402 or 403 from DeepSeek, polishing stops for the rest of the run and the status bar says so.
- If the Soniox connection drops, the page goes back to "Paused"; click "Start listening" to reconnect. Existing captions stay.
- Sentences are split on `.`, `!` and `?`. If Soniox punctuates a pause with `;` or `:`, several sentences can merge into one long line and show up a little later. The abbreviation list is short (`e.g.`, `Dr.`, `U.S.`, …).
- The Chinese draft is matched to English sentences by length. It is only a fallback, so it may not line up exactly.
- Revisions only look back 6 lines, and only happen when later speech gives a real clue.
- The summary is written by a model from the captions alone, so it can miss things or be loose. A failed summary never affects captions.
- Make sure the school and the teacher allow recording. Soniox bills while connected, so pause or stop when class ends.
