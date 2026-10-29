/// <reference types="bun-types" />

import { afterEach, describe, expect, test } from 'bun:test';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { getConfigDir, getConfigSearchDirs } from './paths';

describe('shared config paths', () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in originalEnv)) delete process.env[key];
    }
    Object.assign(process.env, originalEnv);
  });

  test('getConfigDir() uses OPENCODE_CONFIG_DIR when set', () => {
    process.env.OPENCODE_CONFIG_DIR = '/custom/directory';
    delete process.env.XDG_CONFIG_HOME;
    expect(getConfigDir()).toBe('/custom/directory');
  });

  test('getConfigDir() uses XDG_CONFIG_HOME when set', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';
    expect(getConfigDir()).toBe('/tmp/xdg-config/opencode');
  });

  test('getConfigDir() falls back to ~/.config when XDG_CONFIG_HOME is unset', () => {
    delete process.env.OPENCODE_CONFIG_DIR;
    delete process.env.XDG_CONFIG_HOME;
    const expected = join(homedir(), '.config', 'opencode');
    expect(getConfigDir()).toBe(expected);
  });

  test('getConfigSearchDirs() returns custom dir first, then default dir', () => {
    process.env.OPENCODE_CONFIG_DIR = '/custom/directory';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';

    expect(getConfigSearchDirs()).toEqual([
      '/custom/directory',
      '/tmp/xdg-config/opencode',
    ]);
  });

  test('getConfigSearchDirs() de-duplicates identical dirs', () => {
    process.env.OPENCODE_CONFIG_DIR = '/tmp/xdg-config/opencode';
    process.env.XDG_CONFIG_HOME = '/tmp/xdg-config';

    expect(getConfigSearchDirs()).toEqual(['/tmp/xdg-config/opencode']);
  });
});
