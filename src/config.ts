import { existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { loadGlossary } from './glossary.ts';
import type { GlossaryEntry } from './types.ts';

export const USAGE = `Usage: npm start -- [options]

  --wav FILE          Use a 16 kHz mono 16-bit WAV instead of the microphone (played in real time)
  --device N          Microphone device index (see --list-devices)
  --list-devices      List microphones and exit
  --source LANG       Source language hint, default en
  --topic TEXT        Lecture topic, helps the polish step pick words
  --glossary FILE     Glossary file, one "English = Chinese" per line (see glossary.example.txt)
  --context TEXT      Extra background; use @file to read it from a file
  --model NAME        DeepSeek model, default deepseek-flash
  --soniox-model NAME Soniox model, default stt-rt-v5
  --port N            Page port, default 8765
  --host HOST         Listen address, default 127.0.0.1
  --soniox-rate N     Soniox price in USD per hour for the cost estimate, default 0.12
  --out DIR           Output directory, default ./output (transcript_<time>.txt and summary_<time>.md)
  --paused            Start without listening; click "Start listening" (or press Space) on the page
  --no-summary        Turn off the live class summary
  --no-browser        Do not open the browser
  -h, --help          Show this help

API keys come from the environment or a .env file in the current directory: SONIOX_API_KEY, DEEPSEEK_API_KEY`;

export interface CliOptions {
  help: boolean;
  listDevices: boolean;
  sonioxKey: string;
  deepseekKey: string;
  source: string;
  topic?: string | undefined;
  glossary: GlossaryEntry[];
  context?: string | undefined;
  model: string;
  sonioxModel: string;
  port: number;
  host: string;
  noBrowser: boolean;
  paused: boolean;
  summary: boolean;
  outDir: string;
  sonioxRate?: number | undefined;
  device?: number | undefined;
  wav?: string | undefined;
}

export class ConfigError extends Error {}

/** Load .env: never overrides existing environment variables; supports an export prefix, quotes and comments. */
export function loadDotEnv(path = '.env', env: NodeJS.ProcessEnv = process.env): void {
  if (!existsSync(path)) return;
  for (const raw of readFileSync(path, 'utf8').split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(raw);
    if (!m || raw.trimStart().startsWith('#')) continue;
    let value = m[2]!;
    const quoted = /^(["'])(.*)\1$/.exec(value);
    if (quoted) value = quoted[2]!;
    else value = value.replace(/\s+#.*$/, '');
    if (env[m[1]!] === undefined) env[m[1]!] = value;
  }
}

function rate(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) throw new ConfigError(`--soniox-rate needs a number >= 0, got "${value}"`);
  return n;
}

function intOption(name: string, value: string | undefined, min: number, max: number): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < min || n > max) throw new ConfigError(`--${name} needs an integer from ${min} to ${max}, got "${value}"`);
  return n;
}

export function parseCli(argv: string[], env: NodeJS.ProcessEnv = process.env): CliOptions {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      strict: true,
      options: {
        wav: { type: 'string' },
        device: { type: 'string' },
        'list-devices': { type: 'boolean' },
        source: { type: 'string' },
        topic: { type: 'string' },
        glossary: { type: 'string' },
        context: { type: 'string' },
        model: { type: 'string' },
        'soniox-model': { type: 'string' },
        port: { type: 'string' },
        host: { type: 'string' },
        'no-browser': { type: 'boolean' },
        out: { type: 'string' },
        'soniox-rate': { type: 'string' },
        paused: { type: 'boolean' },
        'no-summary': { type: 'boolean' },
        help: { type: 'boolean', short: 'h' },
      },
    }));
  } catch (err) {
    throw new ConfigError(`${err instanceof Error ? err.message : String(err)}\n\n${USAGE}`);
  }

  const help = Boolean(values.help);
  const listDevices = Boolean(values['list-devices']);
  const sonioxKey = env.SONIOX_API_KEY?.trim() ?? '';
  const deepseekKey = env.DEEPSEEK_API_KEY?.trim() ?? '';
  if (!help && !listDevices) {
    const missing = [!sonioxKey && 'SONIOX_API_KEY', !deepseekKey && 'DEEPSEEK_API_KEY'].filter(Boolean);
    if (missing.length) {
      throw new ConfigError(`Please set ${missing.join(' and ')} (in the environment or a .env file in the current directory; see .env.example).`);
    }
  }

  let glossary: GlossaryEntry[] = [];
  if (values.glossary) {
    try {
      glossary = loadGlossary(values.glossary);
    } catch {
      throw new ConfigError(`Could not read the glossary file: ${values.glossary}`);
    }
  }
  let context = values.context;
  if (context?.startsWith('@')) {
    const file = context.slice(1);
    try {
      context = readFileSync(file, 'utf8').trim();
    } catch {
      throw new ConfigError(`Could not read the file given to --context: ${file}`);
    }
  }

  return {
    help,
    listDevices,
    sonioxKey,
    deepseekKey,
    source: values.source ?? 'en',
    topic: values.topic,
    glossary,
    context,
    model: values.model ?? 'deepseek-flash',
    sonioxModel: values['soniox-model'] ?? 'stt-rt-v5',
    port: intOption('port', values.port, 0, 65535) ?? 8765,
    host: values.host ?? '127.0.0.1',
    noBrowser: Boolean(values['no-browser']),
    outDir: values.out ?? 'output',
    sonioxRate: rate(values['soniox-rate']),
    paused: Boolean(values.paused),
    summary: !values['no-summary'],
    device: intOption('device', values.device, -1, 1000),
    wav: values.wav,
  };
}
