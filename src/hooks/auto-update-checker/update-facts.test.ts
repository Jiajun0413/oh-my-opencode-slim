import { describe, expect, mock, test } from 'bun:test';

// The index-hook suite mocks the ordinary checker module in Bun's shared
// process. A distinct module URL keeps these tests on the real Implementation.
const { createUpdateFactsReader, getLatestCompatibleVersion } = await import(
  './checker?activation-facts-tests'
);

const metadata = {
  'dist-tags': { latest: '3.0.7', beta: '3.1.0-beta.2' },
  versions: { '3.0.6': {}, '3.0.7': {}, '3.1.0-beta.2': {} },
};

describe('activation-local update facts', () => {
  test('concurrent consumers and compatible policy reuse one request', async () => {
    const originalFetch = globalThis.fetch;
    let release: (value: Response) => void = () => {};
    const response = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const fetch = mock(() => response);
    globalThis.fetch = fetch as never;
    try {
      const read = createUpdateFactsReader();
      const first = read();
      const second = read();
      expect(fetch).toHaveBeenCalledTimes(1);
      release(Response.json(metadata));
      const facts = await first;
      expect(await second).toEqual(facts);
      expect(await getLatestCompatibleVersion('3.0.6', 'latest', read)).toEqual(
        {
          latestVersion: '3.0.7',
          latestMajorVersion: null,
          blockedByMajor: false,
        },
      );
      expect(
        await getLatestCompatibleVersion('3.0.6', 'beta', read),
      ).toMatchObject({
        latestVersion: '3.1.0-beta.2',
      });
      expect(facts?.versions).toEqual(Object.keys(metadata.versions));
      expect(fetch).toHaveBeenCalledTimes(1);
      await createUpdateFactsReader()();
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('failed and malformed reads are not memoized as known facts', async () => {
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = mock(async () => {
      calls += 1;
      if (calls === 1) throw new Error('offline');
      if (calls === 2) return Response.json({ 'dist-tags': { latest: 7 } });
      return Response.json(metadata);
    }) as never;
    try {
      const read = createUpdateFactsReader();
      expect(await read()).toBeNull();
      expect(await read()).toBeNull();
      expect(await read()).toMatchObject({ distTags: metadata['dist-tags'] });
      expect(calls).toBe(3);
      await read();
      expect(calls).toBe(3);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  test('unparseable current version does not invoke the package facts provider', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = mock(async () =>
      Response.json({ latest: '3.0.7' }),
    ) as never;
    const read = mock(async () => null);
    try {
      expect(
        await getLatestCompatibleVersion('unknown', 'latest', read),
      ).toMatchObject({
        latestVersion: null,
        unsafeReason: 'unparseable-current-version',
      });
      expect(read).not.toHaveBeenCalled();
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
