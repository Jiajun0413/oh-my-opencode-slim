import { describe, expect, spyOn, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-board';
import * as logger from '../../utils/logger';
import { handleToolExecuteBefore } from './tool-execute-hooks';

const PARENT = 'ses_parent';

/** Minimal deps for the background-default flip: the guard chain up to the
 * flip needs a managed session, a board, and a pending-call tracker. */
function deps(hostFlavor?: string, managed = true) {
  return {
    shouldManageSession: () => managed,
    backgroundJobBoard: new BackgroundJobBoard(),
    pendingCallTracker: {
      add() {},
      take: () => undefined,
      pendingCallId: () => 'call_flip',
    },
    taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
    hostFlavor,
  };
}

function call(args: Record<string, unknown>, hostFlavor?: string) {
  const output = { args };
  return {
    output,
    promise: handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'call_flip' },
      output,
      deps(hostFlavor),
    ),
  };
}

describe('v2 background-default flip', () => {
  test('v2: omitted background is rewritten to true', async () => {
    const { output } = call({ subagent_type: 'fixer', prompt: 'work' }, 'v2');
    await output.promise;
    expect(output.args.background).toBe(true);
  });

  test('v2: explicit false passes through untouched', async () => {
    const { output } = call(
      { subagent_type: 'fixer', prompt: 'work', background: false },
      'v2',
    );
    await output.promise;
    expect(output.args.background).toBe(false);
  });

  test('v2: explicit true stays true', async () => {
    const { output } = call(
      { subagent_type: 'fixer', prompt: 'work', background: true },
      'v2',
    );
    await output.promise;
    expect(output.args.background).toBe(true);
  });

  test('non-v2 hosts keep the native omitted default (no rewrite)', async () => {
    const { output } = call({ subagent_type: 'fixer', prompt: 'work' });
    await output.promise;
    expect(output.args.background).toBeUndefined();
  });

  test('unmanaged sessions never reach the flip', async () => {
    const output = { args: { subagent_type: 'fixer', prompt: 'work' } };
    await handleToolExecuteBefore(
      { tool: 'task', sessionID: PARENT, callID: 'call_flip' },
      output,
      { ...deps('v2'), shouldManageSession: () => false },
    );
    expect(output.args.background).toBeUndefined();
  });
});

describe('v2 background explicit-lane observation', () => {
  test('explicit false and true each log their raw value (dependent-lane health)', async () => {
    const logSpy = spyOn(logger, 'log');
    try {
      const falseLane = {
        args: { subagent_type: 'fixer', prompt: 'w', background: false },
      };
      await handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'c1' },
        falseLane,
        deps('v2'),
      );
      const trueLane = {
        args: { subagent_type: 'fixer', prompt: 'w', background: true },
      };
      await handleToolExecuteBefore(
        { tool: 'task', sessionID: PARENT, callID: 'c2' },
        trueLane,
        deps('v2'),
      );
      const explicitCalls = logSpy.mock.calls.filter((call) =>
        String(call[0]).includes('background explicit'),
      );
      // Full-suite runs share the logger; assert our two lanes are present
      // with their raw values rather than an exact count.
      const values = explicitCalls
        .map((call) => (call[1] as { background?: unknown }).background)
        .filter((value) => value === false || value === true);
      expect(values).toContain(false);
      expect(values).toContain(true);
    } finally {
      logSpy.mockRestore();
    }
  });
});
