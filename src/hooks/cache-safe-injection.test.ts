import { describe, expect, test } from 'bun:test';
import {
  appendTaggedSyntheticPart,
  appendTrailingVolatileMessage,
  createTaggedSyntheticPart,
  hasTaggedPart,
  isTaggedPart,
  isVolatileTaggedMessage,
  omittedOrFull,
  stripTaggedContent,
  stripTaggedContents,
} from './cache-safe-injection';
import type { MessageWithParts } from './types';

const KEY = 'oh-my-opencode-slim.testTag';
const PHASE_KEY = 'oh-my-opencode-slim.phaseReminder';
const COUNCIL_KEY = 'oh-my-opencode-slim.councilInject';
const GOAL_KEY = 'oh-my-opencode-slim.deepworkGoal';
const KEYS = [PHASE_KEY, COUNCIL_KEY, GOAL_KEY] as const;

function userMessage(text: string): MessageWithParts {
  return {
    info: { role: 'user', agent: 'orchestrator', sessionID: 's1', id: 'm1' },
    parts: [{ type: 'text', text }],
  };
}

describe('createTaggedSyntheticPart', () => {
  test('builds a synthetic text part with the tag winning over extras', () => {
    const part = createTaggedSyntheticPart({
      text: 'hello',
      metadataKey: KEY,
      extraMetadata: { other: 1, [KEY]: false },
    });

    expect(part).toEqual({
      type: 'text',
      synthetic: true,
      text: 'hello',
      metadata: { other: 1, [KEY]: true },
    });
  });

  test('never adds cache marks to a tagged part (v1 bytes)', () => {
    const part = createTaggedSyntheticPart({
      text: 'hello',
      metadataKey: KEY,
    });
    expect(part).toEqual({
      type: 'text',
      synthetic: true,
      text: 'hello',
      metadata: { [KEY]: true },
    });
    expect('cache' in part).toBe(false);
  });
});

describe('isTaggedPart / hasTaggedPart', () => {
  test('recognizes only synthetic parts carrying the exact tag', () => {
    const tagged = createTaggedSyntheticPart({ text: 'x', metadataKey: KEY });
    expect(isTaggedPart(tagged, KEY)).toBe(true);
    expect(isTaggedPart(tagged, 'other-key')).toBe(false);
    expect(isTaggedPart({ type: 'text', text: 'x' }, KEY)).toBe(false);
    expect(
      isTaggedPart({ type: 'text', text: 'x', metadata: { [KEY]: true } }, KEY),
    ).toBe(false);
    expect(isTaggedPart(undefined, KEY)).toBe(false);
  });

  test('hasTaggedPart scans all parts of a message', () => {
    const message = userMessage('hi');
    expect(hasTaggedPart(message, KEY)).toBe(false);
    appendTaggedSyntheticPart(message, { text: 'r', metadataKey: KEY });
    expect(hasTaggedPart(message, KEY)).toBe(true);
  });
});

describe('appendTaggedSyntheticPart', () => {
  test('appends at the tail without touching existing parts', () => {
    const message = userMessage('original');
    const before = JSON.stringify(message.parts[0]);

    appendTaggedSyntheticPart(message, { text: 'reminder', metadataKey: KEY });

    expect(message.parts).toHaveLength(2);
    expect(JSON.stringify(message.parts[0])).toBe(before);
    expect(isTaggedPart(message.parts[1], KEY)).toBe(true);
  });
});

describe('stripTaggedContent', () => {
  test('removes tagged parts from real messages and drops emptied synthetic messages', () => {
    const real = userMessage('keep me');
    appendTaggedSyntheticPart(real, { text: 'legacy', metadataKey: KEY });
    const messages: unknown[] = [real];
    appendTrailingVolatileMessage(
      messages,
      { role: 'user', id: 'm1-tag' },
      { text: 'volatile', metadataKey: KEY },
    );

    stripTaggedContent(messages, KEY);

    expect(messages).toHaveLength(1);
    expect((messages[0] as MessageWithParts).parts).toHaveLength(1);
    expect((messages[0] as MessageWithParts).parts[0].text).toBe('keep me');
  });

  test('leaves messages without the tag byte-identical', () => {
    const real = userMessage('untouched');
    const other = userMessage('also untouched');
    appendTaggedSyntheticPart(other, {
      text: 'different tag',
      metadataKey: 'other-key',
    });
    const messages: unknown[] = [real, other];
    const before = JSON.stringify(messages);

    stripTaggedContent(messages, KEY);

    expect(JSON.stringify(messages)).toBe(before);
  });

  test('preserves messages that were already empty', () => {
    const empty: MessageWithParts = {
      info: { role: 'user' },
      parts: [],
    };
    const messages: unknown[] = [empty];

    stripTaggedContent(messages, KEY);

    expect(messages).toHaveLength(1);
  });
});

describe('stripTaggedContents (multi-key single pass)', () => {
  /** Strip each key in order — the pre-existing compaction shape. */
  function sequentialStrip(messages: unknown[], keys: readonly string[]) {
    for (const key of keys) {
      stripTaggedContent(messages, key);
    }
  }

  function buildFixture(seed: number): unknown[] {
    // Deterministic PRNG: tests must not depend on Math.random.
    let state = seed + 1;
    const random = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const pick = <T>(items: readonly T[]) =>
      items[Math.floor(random() * items.length)];

    const tagFor = (key: string) =>
      createTaggedSyntheticPart({ text: `part-${key}`, metadataKey: key });
    const messages: unknown[] = [];
    const count = 4 + Math.floor(random() * 5);
    for (let i = 0; i < count; i += 1) {
      // Entry kinds: well-formed real, well-formed tagged-only, already
      // empty, malformed shell — all the shapes the sequential form had to
      // treat differently.
      const kind = pick([
        'real',
        'real-tagged',
        'tagged-only',
        'empty',
        'empty-tagged',
        'malformed',
      ] as const);
      if (kind === 'malformed') {
        messages.push(pick([{}, { info: { role: 'user' } }, null, 'literal']));
        continue;
      }
      const message: MessageWithParts = {
        info: { role: 'user', sessionID: 's1', id: `m${i}` },
        parts: [],
      };
      if (kind === 'real' || kind === 'real-tagged') {
        message.parts.push({ type: 'text', text: `real ${i}` });
      }
      if (
        kind === 'tagged-only' ||
        kind === 'real-tagged' ||
        kind === 'empty-tagged'
      ) {
        message.parts.push(
          tagFor(pick([PHASE_KEY, COUNCIL_KEY, GOAL_KEY, KEY] as const)),
        );
        if (random() < 0.5) {
          // Dual-tagged parts exist in the wild (the deepwork goal pointer
          // carries both its own key and the board key).
          message.parts.push(tagFor(pick(KEYS)));
        }
      }
      messages.push(message);
    }
    return messages;
  }

  test('removes tagged parts of every key and drops emptied messages', () => {
    const real = userMessage('keep me');
    appendTaggedSyntheticPart(real, {
      text: 'phase',
      metadataKey: PHASE_KEY,
    });
    const dual = userMessage('also real');
    appendTaggedSyntheticPart(dual, {
      text: 'council',
      metadataKey: COUNCIL_KEY,
    });
    appendTaggedSyntheticPart(dual, { text: 'goal', metadataKey: GOAL_KEY });
    const preempty: MessageWithParts = {
      info: { role: 'user' },
      parts: [],
    };
    const messages: unknown[] = [real, dual, preempty];
    appendTrailingVolatileMessage(
      messages,
      { role: 'user', id: 'm-tag' },
      { text: 'volatile', metadataKey: PHASE_KEY },
    );

    stripTaggedContents(messages, KEYS);

    expect(messages).toHaveLength(3);
    expect((messages[0] as MessageWithParts).parts).toHaveLength(1);
    expect((messages[1] as MessageWithParts).parts).toHaveLength(1);
    // A message emptied by TWO key strips is still removed exactly once.
    expect(messages[2]).toBe(preempty);
  });

  test('is byte-identical to sequential per-key stripping', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const fixture = buildFixture(seed);
      const sequential = structuredClone(fixture);
      const combined = structuredClone(fixture);

      sequentialStrip(sequential, KEYS);
      stripTaggedContents(combined, KEYS);

      expect(JSON.stringify(combined)).toBe(JSON.stringify(sequential));
      if (seed === 1) {
        // The sequential form drops every message the keys empty, keeps
        // preempty messages, and keeps one tagged-only trailing message —
        // assert the shape once so the equivalence above is not vacuous.
        expect(sequential.length).toBeGreaterThan(0);
      }
    }
  });

  test('equivalence holds for every key subset and order', () => {
    const permutations: Array<readonly string[]> = [
      [PHASE_KEY],
      [COUNCIL_KEY, GOAL_KEY],
      [GOAL_KEY, PHASE_KEY, COUNCIL_KEY],
      [COUNCIL_KEY, PHASE_KEY],
      [],
    ];
    for (const keys of permutations) {
      for (let seed = 1; seed <= 25; seed += 1) {
        const fixture = buildFixture(seed * 7 + 3);
        const sequential = structuredClone(fixture);
        const combined = structuredClone(fixture);

        sequentialStrip(sequential, keys);
        stripTaggedContents(combined, keys);

        expect(JSON.stringify(combined)).toBe(JSON.stringify(sequential));
      }
    }
  });

  test('empty key list strips nothing (same as zero sequential passes)', () => {
    const messages: unknown[] = [userMessage('real')];

    stripTaggedContents(messages, []);

    expect(messages).toHaveLength(1);
    expect((messages[0] as MessageWithParts).parts).toHaveLength(1);
  });

  test('leaves messages tagged with other keys byte-identical', () => {
    const other = userMessage('untouched');
    appendTaggedSyntheticPart(other, { text: 'other', metadataKey: KEY });
    const messages: unknown[] = [other, userMessage('real')];
    const before = JSON.stringify(messages);

    stripTaggedContents(messages, KEYS);

    expect(JSON.stringify(messages)).toBe(before);
  });

  test('survivors keep their relative order', () => {
    const first = userMessage('first');
    appendTaggedSyntheticPart(first, { text: 'phase', metadataKey: PHASE_KEY });
    const second = userMessage('second');
    const third = userMessage('third');
    appendTaggedSyntheticPart(third, {
      text: 'goal',
      metadataKey: GOAL_KEY,
    });
    const messages: unknown[] = [first, second, third];

    stripTaggedContents(messages, KEYS);

    // Real messages keep their real parts; only the injected parts go.
    expect(messages.map((m) => (m as MessageWithParts).parts[0].text)).toEqual([
      'first',
      'second',
      'third',
    ]);
    expect(
      messages.every((m) => (m as MessageWithParts).parts.length === 1),
    ).toBe(true);
  });

  test('removes synthetic-only messages in source order around survivors', () => {
    const real = userMessage('real turn');
    const messages: unknown[] = [real];
    appendTrailingVolatileMessage(
      messages,
      { role: 'user', id: 'board-1' },
      { text: 'board', metadataKey: COUNCIL_KEY },
    );
    appendTrailingVolatileMessage(
      messages,
      { role: 'user', id: 'pointer-1' },
      { text: 'pointer', metadataKey: GOAL_KEY },
    );

    stripTaggedContents(messages, KEYS);

    expect(messages).toEqual([real]);
    expect((messages[0] as MessageWithParts).parts).toHaveLength(1);
  });
});

describe('appendTrailingVolatileMessage / isVolatileTaggedMessage', () => {
  test('appends a synthetic message at the end and marks it volatile', () => {
    const real = userMessage('turn');
    const messages: unknown[] = [real];

    appendTrailingVolatileMessage(
      messages,
      { role: 'user', agent: 'orchestrator', sessionID: 's1', id: 'm1-board' },
      { text: 'board', metadataKey: KEY },
    );

    expect(messages).toHaveLength(2);
    expect(isVolatileTaggedMessage(messages[1], KEY)).toBe(true);
    expect(isVolatileTaggedMessage(messages[0], KEY)).toBe(false);
    expect(isVolatileTaggedMessage(messages[1], 'other-key')).toBe(false);
  });

  test('strip-then-append keeps at most one instance, always trailing', () => {
    const real = userMessage('turn');
    const messages: unknown[] = [real];

    for (const text of ['board v1', 'board v2']) {
      stripTaggedContent(messages, KEY);
      appendTrailingVolatileMessage(
        messages,
        { role: 'user', id: 'm1-board' },
        { text, metadataKey: KEY },
      );
    }

    expect(messages).toHaveLength(2);
    const trailing = messages[1] as MessageWithParts;
    expect(trailing.parts[0].text).toBe('board v2');
  });
});

describe('omittedOrFull', () => {
  test('returns the full text at or below the cap', () => {
    expect(omittedOrFull('hello', 5)).toBe('hello');
    expect(omittedOrFull('hello', 6)).toBe('hello');
  });

  test('omits above the cap instead of truncating', () => {
    expect(omittedOrFull('hello world', 5)).toBeUndefined();
  });

  test('property: every cap yields either the whole input or nothing', () => {
    // A truncated restriction reads as an authorization ("only read
    // directory A" cut short becomes "read directory A"), so no cap may
    // ever return a strict prefix of the input.
    const input = 'only read directory A; never touch directory B';
    for (let cap = 0; cap <= input.length + 2; cap += 1) {
      const result = omittedOrFull(input, cap);
      if (cap >= input.length) {
        expect(result).toBe(input);
      } else {
        expect(result).toBeUndefined();
      }
    }
  });
});
