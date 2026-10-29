import { describe, expect, test } from 'bun:test';
import { asImagePart } from './image-part';
import { createMessageTransformView } from './message-transform-view';
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
