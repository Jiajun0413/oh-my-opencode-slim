import { describe, expect, test } from 'bun:test';
import { asImagePart } from './image-part';
import {
  createMessageTransformView,
  resolveView,
} from './message-transform-view';
import {
  findLatestUserMessage,
  isMessageWithParts,
  type MessageWithParts,
} from './types';

const IMG_BYTES = Buffer.from('89504e470d0a1a0a', 'hex');
const IMG = {
  type: 'image',
  url: `data:image/png;base64,${IMG_BYTES.toString('base64')}`,
};

function userMessage(text: string, sessionID = 's1'): MessageWithParts {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID },
    parts: [{ type: 'text', text }],
  };
}

function malformedFixture(): unknown[] {
  return [
    {},
    { info: { role: 'assistant' } },
    { parts: [{ type: 'text', text: 'missing info' }] },
    userMessage('hello', 's1'),
    {
      info: { role: 'assistant', sessionID: 's1' },
      parts: [{ type: 'text', text: 'answer' }],
    },
    userMessage('latest', 's2'),
  ];
}

describe('createMessageTransformView', () => {
  test('valid/user indexes skip malformed entries and preserve order', () => {
    const view = createMessageTransformView(malformedFixture());

    expect(view.valid.map((message) => message.info.role)).toEqual([
      'user',
      'assistant',
      'user',
    ]);
    expect(view.valid[0]).toBe(view.userMessages[0]);
    expect(view.userMessages.map((message) => message.info.role)).toEqual([
      'user',
      'user',
    ]);
    // Indices point at the SOURCE array positions, not a compacted view.
    expect(view.userEntries.map((entry) => entry.index)).toEqual([3, 5]);
    expect(view.userEntries[0].message).toBe(view.valid[0]);
  });

  test('latest user message and session identity mirror the root derivation', () => {
    for (const fixture of [
      malformedFixture(),
      [userMessage('only')],
      [{ info: { role: 'assistant' }, parts: [] }] as unknown[],
      [] as unknown[],
    ]) {
      const view = createMessageTransformView(fixture);
      expect(view.latestUser).toEqual(findLatestUserMessage(fixture));
      expect(view.sessionID).toBe(
        findLatestUserMessage(fixture)?.info.sessionID ??
          fixture.find(isMessageWithParts)?.info.sessionID,
      );
      expect(view.messages).toBe(fixture);
      expect(view.length).toBe(fixture.length);
    }
  });

  test('mixed sessions: latest user wins, first valid message is the fallback', () => {
    const view = createMessageTransformView(malformedFixture());
    expect(view.latestUser?.info.sessionID).toBe('s2');
    expect(view.sessionID).toBe('s2');

    // Latest user message without a sessionID falls back to the first
    // well-formed message's sessionID (the root transform's derivation).
    const fallback = createMessageTransformView([
      userMessage('no session id here'),
      userMessage('latest', 's1'),
    ]);
    expect(fallback.latestUser?.info.sessionID).toBe('s1');
    expect(fallback.sessionID).toBe('s1');

    const missingLatest = createMessageTransformView([
      {
        info: { role: 'assistant', sessionID: 'assistant-session' },
        parts: [],
      },
      {
        info: { role: 'user', agent: 'orchestrator' },
        parts: [{ type: 'text', text: 'latest' }],
      },
    ]);
    expect(missingLatest.sessionID).toBe('assistant-session');
  });

  test('part and text lookups stay live after the view is built', () => {
    const messages = malformedFixture();
    const view = createMessageTransformView(messages);

    // A prior hook appends a part to an earlier message...
    const firstUser = view.userMessages[0] as MessageWithParts;
    firstUser.parts.push({ type: 'text', text: 'appended later' });

    // ...and replaces another message's parts entirely.
    const latest = view.latestUser as MessageWithParts;
    latest.parts = [{ type: 'text', text: 'replaced parts' }];

    const after = createMessageTransformView(messages);
    expect(after.userMessages[0].parts).toHaveLength(2);
    expect(after.userMessages[0].parts[1].text).toBe('appended later');
    // The view's own references see the live arrays, not a snapshot: the
    // replacement above is visible through the pre-existing view too.
    expect(view.latestUser?.parts[0].text).toBe('replaced parts');
    expect(view.userMessages[0].parts).toBe(firstUser.parts);
  });

  test('image views are decoded once per request and never shared across views', () => {
    const message = userMessage('look');
    message.parts.push(IMG as never);
    const messages = [message];

    const first = createMessageTransformView(messages);
    const second = createMessageTransformView(messages);

    const imagePart = message.parts[1];
    const a = first.imageView(imagePart);
    const b = first.imageView(imagePart);

    expect(a).not.toBeNull();
    // Memoized: the SAME decoded view object comes back within a request.
    expect(b).toBe(a);
    expect(a).toEqual(asImagePart(imagePart));

    // Request-local: the second view decodes fresh — no cross-view (or
    // global/persistent) memo. asImagePart copies the buffer, so identity
    // is the proof.
    const c = second.imageView(imagePart);
    expect(c).toEqual(a);
    expect(c).not.toBe(a);
    // Repeated reads on the second view are memoized too.
    expect(second.imageView(imagePart)).toBe(c);

    // Non-image parts are never decoded: type dispatch rejects first.
    expect(first.imageView({ type: 'text', text: 'no decode' })).toBeNull();
    expect(first.imageView(null)).toBeNull();
    expect(first.imageView('literal')).toBeNull();
    // A null (no image) is also memoized: repeat lookups stay cheap.
    expect(first.imageView({ type: 'text', text: 'no decode' })).toBeNull();
  });

  test('per-request rebuild: a new view reflects structural changes', () => {
    const messages: unknown[] = [userMessage('first')];
    const before = createMessageTransformView(messages);
    expect(
      before.latestUser?.info.text ?? before.userMessages[0].parts[0]?.text,
    ).toBeDefined();

    messages.push(userMessage('second'));
    const after = createMessageTransformView(messages);

    expect(before.length).toBe(1);
    expect(after.length).toBe(2);
    expect(after.latestUser?.parts[0]?.text).toBe('second');
    expect(before.latestUser?.parts[0]?.text).toBe('first');
    // No global state: the stale view is not mutated by the rebuild.
    expect(before.userMessages).toHaveLength(1);
  });
});

describe('resolveView', () => {
  test('reuses a view that still covers the array', () => {
    const messages = malformedFixture();
    const view = createMessageTransformView(messages);
    expect(resolveView(view, messages)).toBe(view);
  });

  test('rebuilds after a tail append (the board volatile-zone strip/append shape)', () => {
    const messages: unknown[] = [userMessage('turn')];
    const view = createMessageTransformView(messages);

    // Simulate the job board's trailing volatile append.
    messages.push({
      info: { role: 'user', sessionID: 's1' },
      parts: [
        {
          type: 'text',
          synthetic: true,
          text: '[board]',
          metadata: { 'oh-my-opencode-slim.board': true },
        },
      ],
    });

    const resolved = resolveView(view, messages);
    expect(resolved).not.toBe(view);
    expect(resolved.latestUser?.parts[0]).toMatchObject({ text: '[board]' });
  });

  test('rebuilds after a tail removal (a volatile-zone strip)', () => {
    const messages: unknown[] = [
      userMessage('turn'),
      {
        info: { role: 'user', sessionID: 's1' },
        parts: [
          {
            type: 'text',
            synthetic: true,
            text: '[board]',
            metadata: { 'oh-my-opencode-slim.board': true },
          },
        ],
      },
    ];
    const view = createMessageTransformView(messages);

    messages.pop();
    const resolved = resolveView(view, messages);
    expect(resolved).not.toBe(view);
    expect(resolved.latestUser?.parts[0]?.text).toBe('turn');
  });

  test('net-neutral append+pop keeps a still-correct view (documented failsafe limit)', () => {
    // The failsafe is identity+length: a strip and an append that cancel out
    // are not observable in O(1). That shape never occurs in the pipeline
    // (the board appends; the root compaction strip runs after the last
    // view consumer), and the root rebuild-point contract covers it anyway.
    // When it does happen with tail-only operations, the surviving view is
    // still correct: the covered messages are the same live objects.
    const messages: unknown[] = [userMessage('turn')];
    const view = createMessageTransformView(messages);
    messages.push({
      info: { role: 'user', sessionID: 's1' },
      parts: [{ type: 'text', synthetic: true, text: '[board]' }],
    });
    messages.pop();
    expect(resolveView(view, messages)).toBe(view);
    expect(view.latestUser?.parts[0]?.text).toBe('turn');
  });

  test('rebuilds when the array identity changed (a different output object)', () => {
    const view = createMessageTransformView([userMessage('a')]);
    const other = [userMessage('a')];
    expect(resolveView(view, other)).not.toBe(view);
    expect(resolveView(undefined, other)).not.toBe(view);
  });

  test('undefined always builds fresh', () => {
    const messages = [userMessage('a')];
    const resolved = resolveView(undefined, messages);
    expect(resolved.messages).toBe(messages);
    expect(resolved.latestUser?.parts[0]?.text).toBe('a');
  });
});
