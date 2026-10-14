import { readFileSync } from 'node:fs';
import type { GlossaryEntry } from './types.ts';

/** One entry per line: `English = Chinese`, or just the English term to keep it as is. Lines starting with # are comments. */
export function parseGlossary(text: string): GlossaryEntry[] {
  const entries: GlossaryEntry[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(.*?)\s*(?:=>|->|=|\t)\s*(.*)$/.exec(line);
    const term = (m ? m[1]! : line).trim();
    const zh = m ? m[2]!.trim() : '';
    if (!term) continue;
    entries.push(zh ? { term, zh } : { term });
  }
  return entries;
}

export function loadGlossary(path: string): GlossaryEntry[] {
  return parseGlossary(readFileSync(path, 'utf8'));
}
