import type { GlossaryEntry } from './types.ts';

export interface PromptInput {
  topic?: string | undefined;
  glossary?: GlossaryEntry[] | undefined;
  context?: string | undefined;
}

export function buildSystemPrompt({ topic, glossary = [], context }: PromptInput): string {
  const lines = [
    'You polish live subtitles for a lecture. The teacher speaks English; speech recognition (ASR) splits the speech into sentences and attaches a machine-translated Chinese draft. Captions appear while the teacher is still talking, so earlier lines were translated with incomplete information. When later sentences arrive, correct the earlier ones.',
    '',
    'Each input has "context" (lines already shown to students, with the Chinese they currently see) and "new" (sentences that just arrived). Do two things:',
    '',
    'Step 1: translate "new" into natural, accurate, spoken Simplified Chinese. The draft_zh may be wrong or incomplete; use it only as a hint. Do not merge or split sentences and do not add anything that is not in the English.',
    '',
    'Step 2: use "new" as fresh evidence and re-check the Chinese of every line in "context". This is the most important step. If any case below applies, you must put that line in "revisions" with its complete new translation:',
    '- A later sentence settles an ambiguous word (bat: animal or club; bank: financial or river; cell: biology, prison or spreadsheet; model, table, kernel, ...).',
    '- ASR misheard a word and a later sentence reveals the real one (for example "lawn model" earlier and "large language model" later means the earlier line should say LLM).',
    '- A pronoun or omitted subject was resolved wrongly in the earlier translation.',
    '- A term is translated inconsistently, or differs from the glossary.',
    'Do not put lines without such a problem into "revisions", and do not reword translations that are already correct. Ids in "revisions" must come from "context".',
  ];
  if (topic) lines.push('', `Lecture topic: ${topic}`);
  if (glossary.length) {
    lines.push('', 'Glossary (follow it):');
    for (const { term, zh } of glossary) lines.push(zh ? `- ${term} → ${zh}` : `- ${term} (keep in English)`);
  }
  if (context) lines.push('', `Background: ${context}`);
  lines.push(
    '',
    'The input is a json object: {"context":[{"id":1,"en":"...","zh":"..."}],"new":[{"id":5,"en":"...","draft_zh":"..."}]}',
    'Output a single json object and nothing else: {"new":[{"id":5,"zh":"..."}],"revisions":[{"id":3,"zh":"..."}]}',
    '"new" must contain every id from the input; "revisions" is [] when nothing needs revising.',
    '',
    'Example 1 (a later sentence settles an ambiguous word):',
    'Input: {"context":[{"id":1,"en":"Let us look at the bat.","zh":"我们来看看这根球棒。"}],"new":[{"id":2,"en":"It flew out of the cave at dusk.","draft_zh":"它在黄昏时从洞穴里飞出来。"}]}',
    'Output: {"new":[{"id":2,"zh":"它在黄昏时从洞穴里飞了出来。"}],"revisions":[{"id":1,"zh":"我们来看看这只蝙蝠。"}]}',
    '',
    'Example 2 (a later sentence exposes a recognition error):',
    'Input: {"context":[{"id":3,"en":"Today we study the lawn model.","zh":"今天我们研究草坪模型。"}],"new":[{"id":4,"en":"L, L, M, large language model, is the thing everyone is talking about.","draft_zh":"L、L、M，大语言模型，是大家都在谈论的东西。"}]}',
    'Output: {"new":[{"id":4,"zh":"LLM，也就是大语言模型，是现在大家都在谈论的东西。"}],"revisions":[{"id":3,"zh":"今天我们研究大语言模型（LLM）。"}]}',
  );
  return lines.join('\n');
}
