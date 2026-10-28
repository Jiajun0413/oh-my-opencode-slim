/** Focused tests for `ensureAdmission`: one-admission read reuse.

Scope: the admission transaction returns `{record, identity}` from ONE
host identity read + ONE KV lookup; the fences that make the preset
service trustworthy (id+directory+parent identity on every admission,
serial transactions, write/abort/dispose fences) stay load-bearing.
These tests do NOT build the whole v1 plugin.
*/
import { describe, expect, test } from 'bun:test';
import type { SessionTeamBundle } from './session-presets';
import { createSessionPresets } from './session-presets';

const DIRECTORY = '/project';

const BUNDLE: SessionTeamBundle = {
  presetName: 'default',
  fallbackEnabled: true,
  profiles: {
    explorer: { sidebarModel: 'openai/gpt-5-mini' },
  },
  chains: {},
  inheritance: {},
};

interface Harness {
  presets: ReturnType<typeof createSessionPresets>;
  storage: Map<string, unknown>;
  getCalls: Array<unknown>;
  /** Ordered effect log: proves concurrent admissions never interleave
   *  their identity reads and KV transactions. */
  log: Array<'identity' | 'kv-read' | 'kv-write'>;
  setGetResponse: (response: unknown) => void;
}

function makeHarness(options?: { directory?: string }): Harness {
  const storage = new Map<string, unknown>();
  const getCalls: Array<unknown> = [];
  const log: Harness['log'] = [];
  let getResponse: unknown;
  const get = async (input: { sessionID: string }) => {
    getCalls.push(input);
    log.push('identity');
    return getResponse;
  };
  const session = { get };
  const presets = createSessionPresets({
    storage: {
      get: async (key: string) => {
        log.push('kv-read');
        return storage.get(key);
      },
      set: async (key: string, value: unknown) => {
        log.push('kv-write');
        storage.set(key, value);
      },
      remove: async (key: string) => {
        log.push('kv-write');
        storage.delete(key);
      },
      scan: async () => ({ entries: [] }),
    },
    session,
    directory: options?.directory ?? DIRECTORY,
    current: () => BUNDLE,
    named: async () => BUNDLE,
  });
  return {
    presets,
    storage,
    getCalls,
    log,
    setGetResponse: (response: unknown) => {
      getResponse = response;
    },
  };
}

function storageKey(id: string) {
  return `session-preset/v1/${id}`;
}

describe('ensureAdmission', () => {
  test('returns record + precise identity from one identity read and one KV lookup', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: {
        id: 'root-1',
        agent: 'orchestrator',
        parentID: undefined,
        model: { providerID: 'openai', id: 'gpt-5' },
        location: { directory: DIRECTORY },
      },
    });
    const admission = await h.presets.ensureAdmission('root-1');
    expect(admission).toBeDefined();
    expect(admission?.record?.bundle.presetName).toBe('default');
    expect(admission?.record?.parentID).toBeUndefined();
    expect(admission?.identity).toEqual({
      agent: 'orchestrator',
      model: { providerID: 'openai', id: 'gpt-5' },
      authoritative: true,
    });
    // ONE host identity read and ONE KV lookup for the whole admission.
    expect(h.getCalls).toEqual([{ sessionID: 'root-1' }]);
    expect([...h.storage.keys()]).toEqual([storageKey('root-1')]);
  });

  test('identity is absent fields parsed precisely, not the raw info object', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: {
        id: 'child-1',
        parentID: 'root-1',
        // No agent, no model: precise identity carries neither.
        location: { directory: DIRECTORY },
      },
    });
    const admission = await h.presets.ensureAdmission('child-1');
    expect(admission?.record).toBeUndefined();
    expect(admission?.identity).toEqual({
      parentID: 'root-1',
      authoritative: true,
    });
    expect(h.getCalls).toHaveLength(1);
  });

  test('next admission revalidates directory and identity', async () => {
    const h = makeHarness();
    const info = {
      data: {
        id: 'root-2',
        location: { directory: DIRECTORY },
      },
    };
    h.setGetResponse(info);
    await h.presets.ensureAdmission('root-2');
    expect(h.getCalls).toHaveLength(1);

    // Second admission re-reads host identity (directory guard) and KV.
    await h.presets.ensureAdmission('root-2');
    expect(h.getCalls).toHaveLength(2);

    // Directory mismatch is still fatal.
    h.setGetResponse({
      data: { id: 'root-2', location: { directory: '/elsewhere' } },
    });
    await expect(h.presets.ensureAdmission('root-2')).rejects.toThrow(
      'Session preset session/location mismatch',
    );
  });

  test('aborts and retries keep the fences', async () => {
    const h = makeHarness();
    h.setGetResponse({
      data: { id: 'root-3', location: { directory: DIRECTORY } },
    });
    const controller = new AbortController();
    controller.abort();
    // Aborted before the transaction starts: nothing is read or written.
    await expect(
      h.presets.ensureAdmission('root-3', controller.signal),
    ).rejects.toThrow();
    expect(h.getCalls).toHaveLength(0);
    expect(h.storage.size).toBe(0);
    // Retry after abort still captures (transaction runs fully).
    const admission = await h.presets.ensureAdmission('root-3');
    expect(admission?.record).toBeDefined();
    expect(h.getCalls).toHaveLength(1);
  });

  test('concurrent admissions serialize on the binding transaction', async () => {
    const h = makeHarness();
    let resolveGet: (value: unknown) => void = () => {};
    h.setGetResponse(
      new Promise((resolve) => {
        resolveGet = resolve;
      }),
    );
    const first = h.presets.ensureAdmission('root-4');
    // A second concurrent admission chains on the pending transaction;
    // its effects only start after the first completes (serial fence).
    const second = h.presets.ensureAdmission('root-4');
    resolveGet({ data: { id: 'root-4', location: { directory: DIRECTORY } } });
    const [a, b] = await Promise.all([first, second]);
    expect(a).toEqual(b);
    // Two full transactions, strictly non-interleaved: identity → KV,
    // then identity → KV again (never identity, identity, KV, KV).
    expect(h.log).toEqual([
      'identity',
      'kv-read',
      'kv-write',
      'identity',
      'kv-read',
    ]);
  });

  test('write path (explicit model) still runs inside the admission transaction', async () => {
    const h = makeHarness();
    h.storage.set(storageKey('child-1'), {
      schemaVersion: 1,
      parentID: 'root-1',
      bundle: BUNDLE,
    });
    h.setGetResponse({
      data: {
        id: 'child-1',
        parentID: 'root-1',
        location: { directory: DIRECTORY },
      },
    });
    const admission = await h.presets.ensureAdmission(
      'child-1',
      undefined,
      true,
    );
    expect(admission?.record?.explicitModel).toBe(true);
    expect(admission?.record?.preserveModel).toBe(true);
    expect(admission?.record?.parentID).toBe('root-1');
  });

  test('parent identity mismatch still rejects inside an admission', async () => {
    const h = makeHarness();
    h.storage.set(storageKey('child-2'), {
      schemaVersion: 1,
      parentID: 'root-a',
      bundle: BUNDLE,
    });
    h.setGetResponse({
      data: {
        id: 'child-2',
        parentID: 'root-b',
        location: { directory: DIRECTORY },
      },
    });
    await expect(h.presets.ensureAdmission('child-2')).rejects.toThrow(
      'Session preset parent identity mismatch',
    );
  });
});
