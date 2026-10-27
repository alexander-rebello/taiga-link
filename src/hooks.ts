import { z } from 'zod';
import { TaigaClient } from './api.js';
import { findConfigFile, readConfig } from './config.js';
import { TaigaError } from './errors.js';
import { formatIssue } from './format.js';
import { issueDocument } from './issues.js';
import { findRefs } from './refs.js';

export type HookName = 'user-prompt-submit' | 'pre-tool-use';
export const HOOK_NAMES: readonly HookName[] = ['user-prompt-submit', 'pre-tool-use'];

const PromptInputSchema = z.object({ prompt: z.string(), cwd: z.string().optional() });
const ToolInputSchema = z.object({
  tool_name: z.string(),
  tool_input: z.object({ command: z.string().optional() }).loose(),
});

const BUDGET_MS = 8_000;

function withBudget<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      setTimeout(() => {
        reject(new TaigaError(`Taiga did not answer within ${ms / 1000} s`));
      }, ms).unref();
    }),
  ]);
}

function context(event: string, text: string): string {
  return JSON.stringify({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });
}

async function promptContext(raw: string): Promise<string | undefined> {
  const input = PromptInputSchema.safeParse(JSON.parse(raw));
  if (!input.success) return undefined;
  const file = findConfigFile(input.data.cwd ?? process.cwd());
  if (file === undefined) return undefined;
  const config = readConfig(file);
  const refs = findRefs(input.data.prompt, config);
  if (refs.length === 0) return undefined;
  const keys = refs.map((r) => r.key).join(', ');
  let client: TaigaClient;
  try {
    client = await TaigaClient.open(config.url);
  } catch {
    return `taiga-link: ${keys} not loaded, not logged in to ${config.url} (the user must run "taiga login" in a terminal).`;
  }
  const session = { config, client };
  const docs = await Promise.all(
    refs.map(async (ref) => {
      try {
        return formatIssue(await withBudget(issueDocument(session, ref), BUDGET_MS));
      } catch (error) {
        return `${ref.key}: ${(error as Error).message}`;
      }
    }),
  );
  return `Taiga issues referenced in the prompt (from taiga-link):\n\n${docs.join('\n\n---\n\n')}`;
}

// A command position: start, or after a shell separator; the binary may be given with a path.
const WRITE_PATTERN = /(?:^|[;&|(]\s*|&&\s*|\|\|\s*)(?:\S*\/)?taiga(?:-link)?\s+(comment|finish)\b/;

function preToolUse(raw: string): string | undefined {
  const input = ToolInputSchema.safeParse(JSON.parse(raw));
  if (!input.success || input.data.tool_name !== 'Bash') return undefined;
  const command = input.data.tool_input.command ?? '';
  const match = WRITE_PATTERN.exec(command.trim());
  if (match === null) return undefined;
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `taiga-link: this ${match[1] ?? 'write'} is visible to everyone in Taiga. Check the text before approving.`,
    },
  });
}

export async function runHook(name: HookName, raw: string): Promise<string | undefined> {
  if (name === 'pre-tool-use') return preToolUse(raw);
  const text = await promptContext(raw);
  return text === undefined ? undefined : context('UserPromptSubmit', text);
}
