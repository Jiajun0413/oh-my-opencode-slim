import { describe, expect, test } from 'bun:test';
import { BackgroundJobBoard } from '../../utils/background-job-fixture';
import { createMessageTransformView } from '../message-transform-view';
import { createTaskSessionManagerHook } from './index';

const SESSION = 'parent-1';

function userTurn(id: string, text: string, agent = 'orchestrator') {
  return {
    info: { role: 'user', agent, sessionID: SESSION, id },
    parts: [{ type: 'text', text }],
  };
}

function transformFixture() {
  return [
    {} as unknown,
    { info: { role: 'assistant' } } as unknown,
    userTurn('u1', 'start the scheduler work'),
    {
      info: { role: 'assistant', sessionID: SESSION, id: 'a1' },
      parts: [
        {
          type: 'tool',
          tool: 'task',
          state: {
            status: 'running',
            input: {
              background: true,
              subagent_type: 'explorer',
              description: 'running child',
              prompt: 'go',
            },
            output: [
              'task_id: r1',
              'state: running',
              '',
              '<task_result>',
              'Background task started.',
              '</task_result>',
            ].join('\n'),
          },
        },
      ],
    },
    userTurn('u2', 'follow up', 'oracle'),
    userTurn('u3', 'latest'),
  ];
}

function makeHook(board: BackgroundJobBoard) {
  return createTaskSessionManagerHook(
    {
      client: {
        session: {
          status: async () => ({ data: {} }),
        },
      },
      directory: '/tmp',
      worktree: '/tmp',
    } as never,
    {
      maxSessionsPerAgent: 2,
      backgroundJobBoard: board,
      shouldManageSession: () => true,
    },
  );
}

/**
 * The transform's user loop reuses the view's indexed user entries; Parts are
 * read live, so stabilize/rehydrate mutations land identically. The loop's
 * source indices feed occurrence IDs keyed on part positions.
 */
describe('task-session-manager transform (request-local view mode)', () => {
  test('view mode renders byte-identical output to no-view mode', async () => {
    const withoutView = { messages: transformFixture() };
    await makeHook(new BackgroundJobBoard())[
      'experimental.chat.messages.transform'
    ]({}, withoutView);

    const withView = { messages: transformFixture() };
    const view = createMessageTransformView(withView.messages);
    await makeHook(new BackgroundJobBoard())[
      'experimental.chat.messages.transform'
    ]({}, withView, view);

    expect(JSON.stringify(withView)).toBe(JSON.stringify(withoutView));
  });

  test('the rehydrated running task lands identically through the view', async () => {
    const boards = [new BackgroundJobBoard(), new BackgroundJobBoard()];
    const outputs = [
      { messages: transformFixture() },
      { messages: transformFixture() },
    ];
    const view = createMessageTransformView(outputs[1].messages);

    await makeHook(boards[0])['experimental.chat.messages.transform'](
      {},
      outputs[0],
    );
    await makeHook(boards[1])['experimental.chat.messages.transform'](
      {},
      outputs[1],
      view,
    );

    expect(boards[1].get('r1')).toEqual(boards[0].get('r1'));
    expect(boards[1].get('r1')).toMatchObject({ state: 'running' });
  });

  test('a stale view (built before a tail append) still matches no-view mode', async () => {
    const withoutView = { messages: transformFixture() };
    withoutView.messages.push(userTurn('u4', 'follow-up turn'));
    await makeHook(new BackgroundJobBoard())[
      'experimental.chat.messages.transform'
    ]({}, withoutView);

    const stale = { messages: transformFixture() };
    const staleView = createMessageTransformView(stale.messages);
    stale.messages.push(userTurn('u4', 'follow-up turn'));
    await makeHook(new BackgroundJobBoard())[
      'experimental.chat.messages.transform'
    ]({}, stale, staleView);

    expect(JSON.stringify(stale)).toBe(JSON.stringify(withoutView));
  });

  test('reentry with the same view and array is a no-op', async () => {
    const board = new BackgroundJobBoard();
    const hook = makeHook(board);
    const output = { messages: transformFixture() };
    const view = createMessageTransformView(output.messages);

    await hook['experimental.chat.messages.transform']({}, output, view);
    const firstRun = JSON.stringify(output);
    await hook['experimental.chat.messages.transform']({}, output, view);

    expect(JSON.stringify(output)).toBe(firstRun);
  });
});
