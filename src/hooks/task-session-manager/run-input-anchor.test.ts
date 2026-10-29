/**
 * Focused run-input-anchor contract tests: `registerTaskOutputLaunch` via the
 * exported entry points (`registerDelegatedLaunchFromStructured`,
 * `handleToolExecuteAfter`, `handleToolExecuteBefore`) with a REAL tracker and
 * board, so the admission-binding flow — not hand-seeded records — is verified.
 */
import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import type { BackgroundJobTerminalGate } from '../../utils/background-job-terminal-gate';
import { createSubagentExecutorWrapper } from '../../v2/subagent-executor-wrapper';
import {
  createPendingCallTracker,
  type PendingTaskCall,
} from './pending-call-tracker';
import {
  type DelegatedLaunchFromStructuredInput,
  handleToolExecuteAfter,
  handleToolExecuteBefore,
  type RegisterDelegatedLaunchDeps,
  registerDelegatedLaunchFromStructured,
} from './tool-execute-hooks';

function makePending(
  overrides: Partial<PendingTaskCall> = {},
): PendingTaskCall {
  return {
    callId: 'call_1',
    parentSessionId: 'parent_1',
    agentType: 'fixer',
    label: 'label',
    fullObjective: 'objective',
    background: true,
    lifecycleEpoch: 0,
    ...overrides,
  };
}

function makeTracker(board: BackgroundJobBoard) {
  return createPendingCallTracker({
    releaseLease: (lease) => board.releaseLease(lease),
  });
}

function makeLaunchDeps(
  board: BackgroundJobBoard,
  tracker: ReturnType<typeof makeTracker>,
): RegisterDelegatedLaunchDeps {
  return {
    directory: '/tmp',
    backgroundJobBoard: board,
    terminalGate: {
      reconcile: async () => undefined,
    } as unknown as BackgroundJobTerminalGate,
    taskContextTracker: {
      pendingManagedTaskIds: new Set<string>(),
      addContext: () => {},
      contextFilesForPrompt: () => [],
    },
    firstAdmission: (sessionID) => tracker.firstAdmission(sessionID),
  };
}

/** Structured launch input with the wrapper-lane defaults; childTaskID derives
 *  from a resumed pending and must be named explicitly for fresh launches. */
function structured(
  pending: PendingTaskCall,
  overrides: Partial<DelegatedLaunchFromStructuredInput> = {},
) {
  const childTaskID = overrides.childTaskID ?? pending.resumedTaskId;
  if (!childTaskID) throw new Error('fresh launches must name the child');
  return {
    callID: pending.callId,
    childTaskID,
    state: overrides.state ?? 'running',
    background: overrides.background ?? false,
    exactCallConfirmed: overrides.exactCallConfirmed ?? true,
    pending,
    handledByWrapper: true,
  };
}

/** A relaunch lease over the previous generation, with its live pending. */
function resumed(
  board: BackgroundJobBoard,
  tracker: ReturnType<typeof makeTracker>,
  taskID: string,
  previousAdmission?: string,
) {
  const previous = board.registerLaunch({
    taskID,
    parentSessionID: 'parent_1',
    agent: 'fixer',
  });
  if (previousAdmission) tracker.noteAdmission(taskID, previousAdmission);
  const lease = board.acquireLease(taskID, previous.generation, 'relaunch');
  if (!lease) throw new Error('missing relaunch lease');
  const pending = makePending({ resumedTaskId: taskID, relaunchLease: lease });
  tracker.add(pending);
  return { previous, pending };
}

/** Mirror the v2 wiring: the wrapper's structured outcome routes through the
 *  shared registration entry (exactly one launch registration on v2). */
function makeWrapperLane(
  board: BackgroundJobBoard,
  tracker: ReturnType<typeof makeTracker>,
) {
  return createSubagentExecutorWrapper({
    register: (launch) => {
      const pending = tracker.peekByCallId(
        launch.callID,
        launch.parentSessionID,
      );
      if (!pending) return undefined;
      return registerDelegatedLaunchFromStructured(
        {
          callID: launch.callID,
          childTaskID: launch.childTaskID,
          state: launch.state,
          background: launch.background,
          ...(launch.result !== undefined ? { result: launch.result } : {}),
          exactCallConfirmed: launch.callID !== '',
          pending,
          handledByWrapper: true,
        },
        makeLaunchDeps(board, tracker),
      );
    },
  });
}

/** The v2 steer lane: before-hook delegation of a running child task. */
function steerBefore(
  board: BackgroundJobBoard,
  tracker: ReturnType<typeof makeTracker>,
  callID: string,
  taskID: string,
  extra: Partial<Parameters<typeof handleToolExecuteBefore>[2]> = {},
) {
  return handleToolExecuteBefore(
    { tool: 'task', sessionID: 'parent_1', callID },
    { args: { subagent_type: 'fixer', task_id: taskID, prompt: 'continue' } },
    {
      shouldManageSession: () => true,
      backgroundJobBoard: board,
      pendingCallTracker: tracker,
      taskContextTracker: { pendingManagedTaskIds: new Set<string>() },
      hostFlavor: 'v2',
      ...extra,
    },
  );
}

describe('run input anchors through structured launch registration', () => {
  test('a fresh launch anchors to the child session first admission', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    tracker.noteAdmission('ses_child', 'msg_dispatch');

    const record = await registerDelegatedLaunchFromStructured(
      structured(makePending(), { childTaskID: 'ses_child' }),
      makeLaunchDeps(board, tracker),
    );

    expect(record?.runInputMessageID).toBe('msg_dispatch');
    expect(board.get('ses_child')?.runInputMessageID).toBe('msg_dispatch');
  });

  test('a fresh launch without an observed admission stays unanchored (late admission never retro-stamps)', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);

    const record = await registerDelegatedLaunchFromStructured(
      structured(makePending(), { childTaskID: 'ses_late' }),
      makeLaunchDeps(board, tracker),
    );

    expect(record).toBeDefined();
    expect(record?.runInputMessageID).toBeUndefined();
    expect('runInputMessageID' in (record ?? {})).toBe(false);

    // The admission lands after registration: no re-read, no retro-stamp.
    tracker.noteAdmission('ses_late', 'msg_after');
    expect(board.get('ses_late')?.runInputMessageID).toBeUndefined();
  });

  test('a resumed relaunch anchors to its own pending admission, never the session map', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    // The session map still holds the PREVIOUS generation's input.
    const { previous, pending } = resumed(
      board,
      tracker,
      'ses_resumed',
      'msg_previous',
    );
    // The resume's own input admission binds the live pending.
    tracker.noteAdmission('ses_resumed', 'msg_resume');

    const record = await registerDelegatedLaunchFromStructured(
      structured(pending, { background: true }),
      makeLaunchDeps(board, tracker),
    );

    expect(record?.generation).toBeGreaterThan(previous.generation);
    expect(record?.runInputMessageID).toBe('msg_resume');
  });

  test('a resumed relaunch with no bound admission and an old session map stays unanchored', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    // The resume's admission is delayed past registration.
    const { pending } = resumed(board, tracker, 'ses_delayed', 'msg_previous');

    const record = await registerDelegatedLaunchFromStructured(
      structured(pending, { background: true }),
      makeLaunchDeps(board, tracker),
    );

    // Old session-map evidence must not anchor the new generation.
    expect(record).toBeDefined();
    expect(record?.runInputMessageID).toBeUndefined();
  });

  test('an identity-unresolved pending never anchors', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    tracker.noteAdmission('ses_flagged', 'msg_dispatch');

    const record = await registerDelegatedLaunchFromStructured(
      structured(makePending({ identityUnresolved: true }), {
        childTaskID: 'ses_flagged',
        exactCallConfirmed: false,
      }),
      makeLaunchDeps(board, tracker),
    );

    expect(record).toBeDefined();
    expect(record?.runInputMessageID).toBeUndefined();
  });
});

describe('run input anchors through the after-hook ID-only promotion', () => {
  const idOnlyOutput = '<task id="ses_orphan"/>';

  function makeAfterDeps(
    board: BackgroundJobBoard,
    tracker: ReturnType<typeof makeTracker>,
  ) {
    return {
      ...makeLaunchDeps(board, tracker),
      pendingCallTracker: tracker,
      taskContextTracker: {
        pendingManagedTaskIds: new Set<string>(),
        addContext: () => {},
        contextFilesForPrompt: () => [],
        prune: () => {},
      },
      hostFlavor: 'v2',
    } as unknown as Parameters<typeof handleToolExecuteAfter>[2];
  }

  test('promotes a placeholder with the session first admission', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    board.registerLaunch({
      taskID: 'ses_orphan',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      provisional: true,
    });
    tracker.add(makePending());
    tracker.noteAdmission('ses_orphan', 'msg_owner');

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      { output: idOnlyOutput, metadata: {} },
      makeAfterDeps(board, tracker),
    );

    const promoted = board.get('ses_orphan');
    expect(promoted?.provisional).toBe(false);
    expect(promoted?.runInputMessageID).toBe('msg_owner');
  });

  test('never overwrites an anchor the placeholder already carries', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    board.registerLaunch({
      taskID: 'ses_orphan',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      provisional: true,
      runInputMessageID: 'msg_existing',
    });
    tracker.add(makePending());
    tracker.noteAdmission('ses_orphan', 'msg_owner');

    await handleToolExecuteAfter(
      { tool: 'task', sessionID: 'parent_1', callID: 'call_1' },
      { output: idOnlyOutput, metadata: {} },
      makeAfterDeps(board, tracker),
    );

    expect(board.get('ses_orphan')?.runInputMessageID).toBe('msg_existing');
  });
});

describe('resume admission paths in the before-hook', () => {
  test('a v2 steer keeps the generation, takes no lease, and never marks the run used', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    const running = board.registerLaunch({
      taskID: 'ses_steer',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
    });
    const before = board.get('ses_steer');
    if (!before) throw new Error('missing running record');

    await steerBefore(board, tracker, 'call_steer', 'ses_steer');

    const pending = tracker.peekByCallId('call_steer', 'parent_1');
    expect(pending?.resumedTaskId).toBe('ses_steer');
    expect(pending?.relaunchLease).toBeUndefined();
    expect(pending?.inputMessageID).toBeUndefined();
    // The steer fences the pending; the outcome lane commits the amendment.
    expect(pending?.steerAmendment).toEqual({
      taskID: 'ses_steer',
      generation: running.generation,
      terminalRevision: running.terminalRevision,
    });
    const after = board.get('ses_steer');
    expect(after?.generation).toBe(running.generation);
    expect(after?.lastUsedAt).toBe(before.lastUsedAt);
    expect(after?.runInputMessageID).toBeUndefined();

    // The steer's admission binds the pending, but its registration is refused.
    if (!pending) throw new Error('missing steer pending');
    tracker.noteAdmission('ses_steer', 'msg_steer');
    expect(tracker.peekByCallId('call_steer', 'parent_1')?.inputMessageID).toBe(
      'msg_steer',
    );
    const record = await registerDelegatedLaunchFromStructured(
      structured(pending),
      makeLaunchDeps(board, tracker),
    );
    expect(record).toBeUndefined();
    expect(board.get('ses_steer')?.generation).toBe(running.generation);
    expect(board.get('ses_steer')?.runInputMessageID).toBeUndefined();
    // The committed amendment is this call's own admitted input.
    expect(board.get('ses_steer')?.amendmentInputMessageID).toBe('msg_steer');
  });

  test('a steer rejected before prompting never stamps, even for byte-identical later input (Greptile P1)', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    const running = board.registerLaunch({
      taskID: 'ses_steer2',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
    });

    await steerBefore(board, tracker, 'call_steer2', 'ses_steer2');

    // A pre-prompt rejection throws before any outcome reaches the stamping lane.
    const wrapper = makeWrapperLane(board, tracker);
    const wrapped = wrapper.wrap(async () => {
      throw new Error('Failed to prompt subagent: ses_steer2');
    });
    await expect(
      wrapped({}, { id: 'call_steer2', sessionID: 'parent_1' }),
    ).rejects.toThrow('Failed to prompt subagent');
    expect(board.get('ses_steer2')?.amendmentInputMessageID).toBeUndefined();

    // A byte-identical later input cannot become the amendment (no text compare).
    tracker.noteAdmission('ses_steer2', 'msg_foreign');
    expect(board.get('ses_steer2')?.amendmentInputMessageID).toBeUndefined();

    // After the after-hook's consumption, a further input still cannot stamp.
    const consumed = tracker.take('call_steer2', 'parent_1');
    expect(consumed?.inputMessageID).toBe('msg_foreign');
    tracker.noteAdmission('ses_steer2', 'msg_foreign_again');
    expect(board.get('ses_steer2')?.amendmentInputMessageID).toBeUndefined();
    expect(board.get('ses_steer2')?.generation).toBe(running.generation);
  });

  test('an admission captured before a failed commit never stamps the run', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    board.registerLaunch({
      taskID: 'ses_steer_pre',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
    });

    await steerBefore(board, tracker, 'call_pre', 'ses_steer_pre');

    // Host ordering (verified on the pinned host): the awaited prompt hook
    // runs BEFORE admission commits. An id can therefore be captured while
    // the admission itself fails, and a hook fire is NOT success evidence.
    tracker.noteAdmission('ses_steer_pre', 'msg_prepared');
    const wrapper = makeWrapperLane(board, tracker);
    const wrapped = wrapper.wrap(async () => {
      throw new Error('PromptConflictError: admission lost');
    });
    await expect(
      wrapped({}, { id: 'call_pre', sessionID: 'parent_1' }),
    ).rejects.toThrow('PromptConflictError');

    // Captured ≠ admitted: the unrecognized failure never reaches the
    // stamping lane, and a later input cannot promote the captured id either.
    expect(board.get('ses_steer_pre')?.amendmentInputMessageID).toBeUndefined();
    tracker.noteAdmission('ses_steer_pre', 'msg_later');
    expect(board.get('ses_steer_pre')?.amendmentInputMessageID).toBeUndefined();
  });

  test('a genuinely prompted steer stamps its own admission on the captured terminal revision (+1)', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    // The opening input is the recorded anchor (the replay guard ignores it later).
    const running = board.registerLaunch({
      taskID: 'ses_steer_ok',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
      runInputMessageID: 'msg_open',
    });
    tracker.noteAdmission('ses_steer_ok', 'msg_open');

    await steerBefore(board, tracker, 'call_ok', 'ses_steer_ok');
    // The steer's own prompt is admitted: the pending binds its id.
    tracker.noteAdmission('ses_steer_ok', 'msg_amend');
    const pending = tracker.peekByCallId('call_ok', 'parent_1');
    if (!pending) throw new Error('missing steer pending');

    // The single terminal publication lands BEFORE the executor resolves (+1).
    const ended = board.updateStatus({
      taskID: 'ses_steer_ok',
      state: 'error',
      resultSummary: 'boom',
      expectedGeneration: running.generation,
      now: 200,
    });
    expect(ended?.terminalRevision).toBe(running.terminalRevision + 1);

    const wrapper = makeWrapperLane(board, tracker);
    const wrapped = wrapper.wrap(async () => {
      throw new Error(
        'Subagent failed (sessionID: ses_steer_ok): child blew up',
      );
    });
    await expect(
      wrapped({}, { id: 'call_ok', sessionID: 'parent_1' }),
    ).rejects.toThrow('Subagent failed (sessionID: ses_steer_ok)');

    // The host-proven outcome stamps the call's own admission on the terminal row.
    const record = board.get('ses_steer_ok');
    expect(record?.amendmentInputMessageID).toBe('msg_amend');
    expect(record?.state).toBe('error');
    expect(record?.generation).toBe(running.generation);
    expect(record?.terminalRevision).toBe(running.terminalRevision + 1);
  });

  test.each([false, true])(
    'a later matching admission voids the wrapper stamp (sibling consumed: %s)',
    async (consumeSibling) => {
      const board = new BackgroundJobBoard();
      const tracker = makeTracker(board);
      board.registerLaunch({
        taskID: 'ses_steer_cousin',
        parentSessionID: 'parent_1',
        agent: 'fixer',
        now: 100,
        runInputMessageID: 'msg_open',
      });
      tracker.noteAdmission('ses_steer_cousin', 'msg_open');
      await steerBefore(board, tracker, 'call_a', 'ses_steer_cousin');

      const wrapped = makeWrapperLane(board, tracker).wrap(async () => {
        tracker.noteAdmission('ses_steer_cousin', 'msg_a');
        const pending = tracker.peekByCallId('call_a', 'parent_1');
        expect(pending?.inputMessageID).toBe('msg_a');
        await steerBefore(board, tracker, 'call_b', 'ses_steer_cousin');
        tracker.noteAdmission('ses_steer_cousin', 'msg_b');
        expect(pending?.inputMessageID).toBeNull();
        expect(
          tracker.peekByCallId('call_b', 'parent_1')?.inputMessageID,
        ).toBeNull();
        if (consumeSibling) {
          tracker.take('call_b', 'parent_1');
          tracker.noteAdmission('ses_steer_cousin', 'msg_later');
          expect(pending?.inputMessageID).toBeNull();
        }
        board.updateStatus({
          taskID: 'ses_steer_cousin',
          state: 'error',
          now: 200,
        });
        throw new Error('Subagent failed (sessionID: ses_steer_cousin): boom');
      });
      await expect(
        wrapped({}, { id: 'call_a', sessionID: 'parent_1' }),
      ).rejects.toThrow('Subagent failed');
      expect(
        board.get('ses_steer_cousin')?.amendmentInputMessageID,
      ).toBeUndefined();
      expect(board.get('ses_steer_cousin')?.runInputMessageID).toBe('msg_open');
    },
  );

  test('a foreign admission during a proven call refuses the stamp (ambiguity)', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    board.registerLaunch({
      taskID: 'ses_steer3',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
    });

    await steerBefore(board, tracker, 'call_steer3', 'ses_steer3');
    const pending = tracker.peekByCallId('call_steer3', 'parent_1');
    if (!pending) throw new Error('missing steer pending');

    // Two different admissions inside the call's extent: no provable owner.
    tracker.noteAdmission('ses_steer3', 'msg_own');
    tracker.noteAdmission('ses_steer3', 'msg_foreign');

    await registerDelegatedLaunchFromStructured(
      structured(pending, { state: 'completed' }),
      makeLaunchDeps(board, tracker),
    );

    expect(board.get('ses_steer3')?.amendmentInputMessageID).toBeUndefined();
  });

  test('a host-reported child other than the steered run never stamps', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    board.registerLaunch({
      taskID: 'ses_steer_mismatch',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
    });
    await steerBefore(board, tracker, 'call_mismatch', 'ses_steer_mismatch');
    tracker.noteAdmission('ses_steer_mismatch', 'msg_own');

    // The wrapper reports a session the steer never resumed: the entry gate
    // must refuse before the amendment fence is even consulted.
    const wrapped = makeWrapperLane(board, tracker).wrap(async () => ({
      output: { sessionID: 'ses_other_child', status: 'completed' },
      content:
        '<subagent sessionID="ses_other_child" state="completed">x</subagent>',
    }));
    await wrapped({}, { id: 'call_mismatch', sessionID: 'parent_1' });

    expect(
      board.get('ses_steer_mismatch')?.amendmentInputMessageID,
    ).toBeUndefined();
    expect(board.get('ses_steer_mismatch')?.runInputMessageID).toBeUndefined();
  });

  test('a terminal transition beyond the same run refuses the stamp', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);
    const running = board.registerLaunch({
      taskID: 'ses_steer5',
      parentSessionID: 'parent_1',
      agent: 'fixer',
      now: 100,
    });

    await steerBefore(board, tracker, 'call_steer5', 'ses_steer5');
    const pending = tracker.peekByCallId('call_steer5', 'parent_1');
    if (!pending) throw new Error('missing steer pending');
    tracker.noteAdmission('ses_steer5', 'msg_own');

    // Two terminal publications on one generation: the single-transition window fails.
    const firstEnd = board.updateStatus({
      taskID: 'ses_steer5',
      state: 'error',
      expectedGeneration: running.generation,
      now: 200,
    });
    expect(firstEnd?.terminalRevision).toBe(1);
    const reopened = board.markRunningFromLiveSession('ses_steer5', 300);
    expect(reopened?.state).toBe('running');
    const secondEnd = board.updateStatus({
      taskID: 'ses_steer5',
      state: 'error',
      expectedGeneration: running.generation,
      now: 400,
    });
    expect(secondEnd?.terminalRevision).toBe(3);

    await registerDelegatedLaunchFromStructured(
      structured(pending, { state: 'completed' }),
      makeLaunchDeps(board, tracker),
    );

    expect(board.get('ses_steer5')?.amendmentInputMessageID).toBeUndefined();
  });

  test('a queued revive keeps the existing explicit id and its relaunch lease', async () => {
    const board = new BackgroundJobBoard();
    const tracker = makeTracker(board);

    await steerBefore(board, tracker, 'call_revive', 'ses_retained', {
      recoverRetainedSession: async () => {
        // session-recovery imports the retained row before answering.
        board.restoreRetainedSession({
          taskID: 'ses_retained',
          parentSessionID: 'parent_1',
          agent: 'fixer',
          description: 'retained work',
          state: 'stopped',
          background: false,
        });
        return { kind: 'recovered', taskID: 'ses_retained' };
      },
    });

    const pending = tracker.peekByCallId('call_revive', 'parent_1');
    // The revived session keeps the explicit id; the revive holds a relaunch lease.
    expect(pending?.resumedTaskId).toBe('ses_retained');
    expect(pending?.relaunchLease).toBeDefined();
    expect(pending?.inputMessageID).toBeUndefined();
    const record = board.get('ses_retained');
    expect(record?.state).toBe('stopped');
    expect(record?.lastUsedAt).toBeGreaterThan(0);
  });
});
