import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { makeEnv, type Env } from './helpers.js';

let env: Env;
beforeEach(async () => {
  env = await makeEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function prompt(text: string, cwd = env.repo): Promise<string> {
  return env.ok(['hook', 'user-prompt-submit'], { input: JSON.stringify({ prompt: text, cwd, hook_event_name: 'UserPromptSubmit' }) });
}

function context(out: string): string {
  if (out === '') return '';
  return (JSON.parse(out) as { hookSpecificOutput: { additionalContext: string } }).hookSpecificOutput.additionalContext;
}

describe('user-prompt-submit', () => {
  it('injects linked issues mentioned in the prompt', async () => {
    await env.linkErp();
    const ctx = context(await prompt('Please fix ERP-12 and check erp-14 too, ERP-12 again'));
    expect(ctx).toContain('ERP-12 Login fails on Safari');
    expect(ctx).toContain('Steps: open /login in Safari 18.');
    expect(ctx).toContain('shot.png');
    expect(ctx).not.toContain('ERP-14');
  });

  it('ignores unregistered prefixes and look-alikes without calling Taiga', async () => {
    await env.linkErp();
    const before = env.mock.requests.length;
    expect(await prompt('UTF-8 and ISO-9001 and WEB-3 and #12')).toBe('');
    expect(env.mock.requests.length).toBe(before);
  });

  it('does nothing outside a linked repo', async () => {
    expect(await prompt('ERP-12')).toBe('');
  });

  it('adds one line and exits 0 when not logged in', async () => {
    await env.linkErp();
    await env.ok(['logout']);
    const ctx = context(await prompt('ERP-12'));
    expect(ctx).toContain('ERP-12');
    expect(ctx).toContain('taiga login');
    expect(ctx.split('\n')).toHaveLength(1);
  });

  it('reports a missing issue inline', async () => {
    await env.linkErp();
    expect(context(await prompt('ERP-999'))).toContain('ERP-999 does not exist');
  });
});

describe('pre-tool-use', () => {
  async function pre(command: string): Promise<string> {
    return env.ok(['hook', 'pre-tool-use'], {
      input: JSON.stringify({ tool_name: 'Bash', tool_input: { command }, cwd: env.repo, hook_event_name: 'PreToolUse' }),
    });
  }

  it('asks the user before any Taiga write', async () => {
    for (const command of ['taiga finish ERP-12 --text "done"', '/opt/x/bin/taiga comment ERP-1 --text hi', 'cd a && taiga-link finish ERP-2 --text x']) {
      const out = JSON.parse(await pre(command)) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
      expect(out.hookSpecificOutput.permissionDecision).toBe('ask');
      expect(out.hookSpecificOutput.permissionDecisionReason).toContain('Taiga');
    }
  });

  it('stays silent for everything else', async () => {
    for (const command of ['taiga show ERP-12', 'echo taiga finish', 'grep "taiga comment" README.md', 'ls']) {
      expect(await pre(command)).toBe('');
    }
    expect(
      await env.ok(['hook', 'pre-tool-use'], { input: JSON.stringify({ tool_name: 'Edit', tool_input: { file_path: 'x' } }) }),
    ).toBe('');
  });
});
