/// <reference types="bun-types" />

import { afterEach, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { findPluginConfigPaths } from './loader';
import { loadPresetCatalog, readPluginConfigSnapshot } from './snapshot';

let tempDir: string;
let userConfigDir: string;
let projectDir: string;
const originalEnv = { ...process.env };
const activeReadSpies: Array<{ mockRestore: () => void }> = [];

function userConfigPath(extension = '.json'): string {
  return path.join(userConfigDir, `oh-my-opencode-slim${extension}`);
}

function projectConfigPath(extension = '.json'): string {
  return path.join(projectDir, '.opencode', `oh-my-opencode-slim${extension}`);
}

function writeUserConfig(content: unknown, extension = '.json'): string {
  const target = userConfigPath(extension);
  fs.writeFileSync(
    target,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return target;
}

function writeProjectConfig(content: unknown, extension = '.json'): string {
  const dir = path.join(projectDir, '.opencode');
  fs.mkdirSync(dir, { recursive: true });
  const target = projectConfigPath(extension);
  fs.writeFileSync(
    target,
    typeof content === 'string' ? content : JSON.stringify(content),
  );
  return target;
}

/** Count reads of the given path (the shared reader must not re-read). */
function countReads(target: string): () => number {
  const original = fs.readFileSync;
  let reads = 0;
  const spy = spyOn(fs, 'readFileSync').mockImplementation(((
    file: fs.PathLike,
    ...rest: unknown[]
  ) => {
    if (file === target) reads += 1;
    return (original as (...args: unknown[]) => string).call(fs, file, ...rest);
  }) as typeof fs.readFileSync);
  activeReadSpies.push(spy);
  return () => reads;
}

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-snapshot-'));
  userConfigDir = path.join(tempDir, 'xdg-config', 'opencode');
  projectDir = path.join(tempDir, 'project');
  fs.mkdirSync(userConfigDir, { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  delete process.env.OPENCODE_CONFIG_DIR;
  delete process.env.OH_MY_OPENCODE_SLIM_PRESET;
  delete process.env.OPENCODE_DISABLE_PROJECT_CONFIG;
  process.env.XDG_CONFIG_HOME = path.join(tempDir, 'xdg-config');
});

afterEach(() => {
  for (const spy of activeReadSpies) spy.mockRestore();
  activeReadSpies.length = 0;
  fs.rmSync(tempDir, { recursive: true, force: true });
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
});

describe('readPluginConfigSnapshot', () => {
  test('returns config, paths, warnings and a fingerprint', () => {
    writeUserConfig({ agents: { oracle: { model: 'test/model' } } });

    const snapshot = readPluginConfigSnapshot(projectDir);

    expect(snapshot.config.agents?.oracle?.model).toBe('test/model');
    expect(snapshot.warnings).toEqual([]);
    expect(snapshot.paths.userConfigPath).toBe(userConfigPath());
    expect(snapshot.paths.projectConfigPaths).toEqual([]);
    expect(snapshot.fingerprint.length).toBeGreaterThan(0);
  });

  test('explicit refresh invalidates a source even when stat identity is unchanged', () => {
    const target = writeUserConfig({ sidebar: false });
    const realStat = fs.statSync;
    const frozenStat = realStat(target);
    const statSpy = spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (String(args[0]) === target) return frozenStat;
      return realStat(...(args as Parameters<typeof fs.statSync>));
    });
    try {
      const first = readPluginConfigSnapshot(projectDir);
      expect(first.config.sidebar).toBe(false);
      writeUserConfig({ sidebar: true });
      const refreshed = readPluginConfigSnapshot(projectDir, { fresh: true });
      expect(refreshed.config.sidebar).toBe(true);
      expect(refreshed).not.toBe(first);
      expect(refreshed.fingerprint).not.toBe(first.fingerprint);
      expect(readPluginConfigSnapshot(projectDir)).toBe(refreshed);
    } finally {
      statSpy.mockRestore();
    }
  });

  test('reuses the cached read: no second file read, same fingerprint', () => {
    const target = writeUserConfig({ preset: 'alpha' });
    const reads = countReads(target);

    const first = readPluginConfigSnapshot(projectDir);
    const afterFirst = reads();
    const second = readPluginConfigSnapshot(projectDir);

    expect(afterFirst).toBeGreaterThan(0);
    expect(reads()).toBe(afterFirst);
    expect(second.fingerprint).toBe(first.fingerprint);
    expect(second.config.preset).toBe('alpha');
  });

  test('reloads after an in-place edit', () => {
    const target = writeUserConfig({ preset: 'alpha' });
    readPluginConfigSnapshot(projectDir);

    fs.writeFileSync(target, JSON.stringify({ preset: 'beta' }));

    const next = readPluginConfigSnapshot(projectDir);
    expect(next.config.preset).toBe('beta');
  });

  test('reloads after a new .jsonc file takes precedence over .json', () => {
    writeUserConfig({ preset: 'alpha' });
    expect(readPluginConfigSnapshot(projectDir).config.preset).toBe('alpha');

    writeUserConfig({ preset: 'jsonc' }, '.jsonc');

    const next = readPluginConfigSnapshot(projectDir);
    expect(next.config.preset).toBe('jsonc');
    expect(next.paths.userConfigPath).toBe(userConfigPath('.jsonc'));
  });

  test('reloads after the selected file is deleted', () => {
    const target = writeUserConfig({ preset: 'alpha' });
    readPluginConfigSnapshot(projectDir);

    fs.rmSync(target);

    const next = readPluginConfigSnapshot(projectDir);
    expect(next.config.preset).toBeUndefined();
    expect(next.paths.userConfigPath).toBeNull();
  });

  test('reloads when a project layer appears', () => {
    writeUserConfig({ preset: 'alpha' });
    expect(readPluginConfigSnapshot(projectDir).config.preset).toBe('alpha');

    writeProjectConfig({ preset: 'project' });

    const next = readPluginConfigSnapshot(projectDir);
    expect(next.config.preset).toBe('project');
    expect(next.paths.projectConfigPaths).toEqual([projectConfigPath()]);
  });

  test('reloads when an environment reference changes', () => {
    process.env.OMOS_SNAPSHOT_MODEL = 'first';
    writeUserConfig({
      agents: { oracle: { model: '{env:OMOS_SNAPSHOT_MODEL}' } },
    });

    expect(
      readPluginConfigSnapshot(projectDir).config.agents?.oracle?.model,
    ).toBe('first');

    process.env.OMOS_SNAPSHOT_MODEL = 'second';

    expect(
      readPluginConfigSnapshot(projectDir).config.agents?.oracle?.model,
    ).toBe('second');
  });

  test('reloads when the env-selected preset changes', () => {
    writeUserConfig({ preset: 'alpha' });
    expect(readPluginConfigSnapshot(projectDir).config.preset).toBe('alpha');

    process.env.OH_MY_OPENCODE_SLIM_PRESET = 'beta';

    expect(readPluginConfigSnapshot(projectDir).config.preset).toBe('beta');
  });

  test('keeps warnings on the snapshot and replays them to subscribers', () => {
    writeUserConfig('{ not json', '.jsonc');

    const seen: string[] = [];
    const snapshot = readPluginConfigSnapshot(projectDir, {
      onWarning: (warning) => seen.push(warning.kind),
    });

    expect(snapshot.warnings.map((warning) => warning.kind)).toContain(
      'invalid-json',
    );
    expect(seen).toContain('invalid-json');

    const replayed: string[] = [];
    const cached = readPluginConfigSnapshot(projectDir, {
      onWarning: (warning) => replayed.push(warning.kind),
    });
    expect(cached.warnings).toBe(snapshot.warnings);
    expect(replayed).toContain('invalid-json');
  });

  test('recovers from a malformed file once it is fixed', () => {
    const target = writeUserConfig('{ not json', '.jsonc');
    expect(
      readPluginConfigSnapshot(projectDir).warnings.map((w) => w.kind),
    ).toContain('invalid-json');

    fs.writeFileSync(target, JSON.stringify({ preset: 'alpha' }));

    const next = readPluginConfigSnapshot(projectDir);
    expect(next.config.preset).toBe('alpha');
    expect(next.warnings.map((warning) => warning.kind)).not.toContain(
      'invalid-json',
    );
  });

  test('uncached reads fingerprint actual content when stat is unavailable', () => {
    const target = writeUserConfig({ compactSidebar: false });
    const realStat = fs.statSync;
    const statSpy = spyOn(fs, 'statSync').mockImplementation((...args) => {
      if (String(args[0]) === target) {
        throw Object.assign(new Error('stat unavailable'), { code: 'EACCES' });
      }
      return realStat(...(args as Parameters<typeof fs.statSync>));
    });
    try {
      const first = readPluginConfigSnapshot(projectDir);
      expect(first.config.compactSidebar).toBe(false);
      writeUserConfig({ compactSidebar: true });
      const next = readPluginConfigSnapshot(projectDir);
      expect(next.config.compactSidebar).toBe(true);
      expect(next.fingerprint).not.toBe(first.fingerprint);
      expect(next).not.toBe(first);
    } finally {
      statSpy.mockRestore();
    }
  });

  test('never caches a read failure', () => {
    const target = userConfigPath();
    fs.mkdirSync(target, { recursive: true });

    const first = readPluginConfigSnapshot(projectDir);
    expect(first.warnings.map((warning) => warning.kind)).toContain(
      'read-error',
    );

    // The failed read must not be remembered: removing the directory and
    // re-reading yields the real (empty) state, and a fresh failure is
    // re-detected instead of served from the cache.
    fs.rmSync(target, { recursive: true, force: true });
    const second = readPluginConfigSnapshot(projectDir);
    expect(second.warnings).toEqual([]);
    expect(second.paths.userConfigPath).toBeNull();
  });

  test('returns frozen values so callers cannot corrupt the cache', () => {
    writeUserConfig({ preset: 'alpha' });
    const first = readPluginConfigSnapshot(projectDir);

    expect(Object.isFrozen(first.config)).toBe(true);
    expect(Object.isFrozen(first.warnings)).toBe(true);
    expect(() => {
      (first.config as { preset?: string }).preset = 'mutated';
    }).toThrow();

    expect(readPluginConfigSnapshot(projectDir).config.preset).toBe('alpha');
  });

  test('paths match the loader discovery', () => {
    writeUserConfig({ preset: 'alpha' });
    writeProjectConfig({ preset: 'project' });

    const snapshot = readPluginConfigSnapshot(projectDir);
    const discovered = findPluginConfigPaths(projectDir);

    expect(snapshot.paths.userConfigPath).toBe(discovered.userConfigPath);
    expect(snapshot.paths.projectConfigPath).toBe(discovered.projectConfigPath);
    expect(snapshot.paths.projectConfigPaths).toEqual(
      discovered.projectConfigPaths,
    );
  });

  test('current project write path stays absent when only an ancestor has config', () => {
    const nested = path.join(projectDir, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    writeProjectConfig({ preset: 'ancestor' });
    const snapshot = readPluginConfigSnapshot(nested, { hostFlavor: 'v2' });
    expect(snapshot.paths.projectConfigPaths).toContain(projectConfigPath());
    expect(snapshot.paths.projectConfigPath).toBeNull();
  });

  test('a changed project discovery boundary invalidates the cached source set', () => {
    writeProjectConfig({ agents: { oracle: { model: 'parent/model' } } });
    const nested = path.join(projectDir, 'nested');
    fs.mkdirSync(nested, { recursive: true });
    expect(readPluginConfigSnapshot(nested).config.agents?.oracle?.model).toBe(
      'parent/model',
    );
    fs.mkdirSync(path.join(nested, '.git'));
    const bounded = readPluginConfigSnapshot(nested);
    expect(bounded.config.agents?.oracle?.model).toBeUndefined();
    expect(bounded.paths.projectConfigPaths).not.toContain(projectConfigPath());
  });

  test('honours the per-read preset name', () => {
    writeUserConfig({
      preset: 'alpha',
      presets: {
        alpha: { oracle: { model: 'alpha/model' } },
        beta: { oracle: { model: 'beta/model' } },
      },
    });

    const snapshot = readPluginConfigSnapshot(projectDir, {
      presetName: 'beta',
    });
    expect(snapshot.config.agents?.oracle?.model).toBe('beta/model');
  });
});

describe('loadPresetCatalog', () => {
  test('reads the user layer raw and the project layer validated', () => {
    writeUserConfig({
      preset: '{env:OMOS_CATALOG_PRESET}',
      presets: { alpha: { oracle: { model: 'user/model' } } },
    });
    writeProjectConfig({
      presets: { beta: { fixer: { model: 'project/model' } } },
    });

    const catalog = loadPresetCatalog(projectDir);

    expect(catalog.userConfig?.preset).toBe('{env:OMOS_CATALOG_PRESET}');
    expect(catalog.userPresets.alpha).toEqual({
      oracle: { model: 'user/model' },
    });
    expect(catalog.projectPresets.beta).toEqual({
      fixer: { model: 'project/model' },
    });
    expect(Object.keys(catalog.presets).sort()).toEqual(['alpha', 'beta']);
    expect(catalog.fingerprint.length).toBeGreaterThan(0);
  });

  test('project presets override user presets in the effective catalog', () => {
    writeUserConfig({
      presets: { alpha: { oracle: { model: 'user/model' } } },
    });
    writeProjectConfig({
      presets: { alpha: { oracle: { model: 'project/model' } } },
    });

    const catalog = loadPresetCatalog(projectDir);
    expect(catalog.presets.alpha).toEqual({
      oracle: { model: 'project/model' },
    });
  });

  test('reuses the cached catalog until an input changes', () => {
    const target = writeUserConfig({
      presets: { alpha: { oracle: { model: 'user/model' } } },
    });
    const reads = countReads(target);

    const first = loadPresetCatalog(projectDir);
    const afterFirst = reads();
    const second = loadPresetCatalog(projectDir);

    expect(afterFirst).toBeGreaterThan(0);
    expect(reads()).toBe(afterFirst);
    expect(second).toBe(first);

    fs.writeFileSync(
      target,
      JSON.stringify({
        presets: { alpha: { oracle: { model: 'new/model' } } },
      }),
    );
    const third = loadPresetCatalog(projectDir);
    expect(third).not.toBe(first);
    expect(third.userPresets.alpha).toEqual({
      oracle: { model: 'new/model' },
    });
  });

  test('keeps prototype-sensitive preset names as own properties', () => {
    writeUserConfig('{"presets":{"__proto__":{"oracle":{"model":"x"}}}}');

    const catalog = loadPresetCatalog(projectDir);
    expect(Object.hasOwn(catalog.userPresets, '__proto__')).toBe(true);
    expect(
      Object.getOwnPropertyDescriptor(catalog.userPresets, '__proto__')?.value,
    ).toEqual({ oracle: { model: 'x' } });
  });

  test('returns frozen values', () => {
    writeUserConfig({
      presets: { alpha: { oracle: { model: 'user/model' } } },
    });
    const catalog = loadPresetCatalog(projectDir);

    expect(Object.isFrozen(catalog.userConfig)).toBe(true);
    expect(Object.isFrozen(catalog.presets)).toBe(true);
    expect(() => {
      (catalog.presets as Record<string, unknown>).alpha = 'mutated';
    }).toThrow();
  });
});
