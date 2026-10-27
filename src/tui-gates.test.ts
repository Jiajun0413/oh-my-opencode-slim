import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import tuiPlugin from './tui';

interface TestEnvironment {
  root: string;
  projectDir: string;
  restore: () => void;
}

const ENV_KEYS = [
  'OPENCODE_CONFIG_DIR',
  'XDG_CONFIG_HOME',
  'XDG_DATA_HOME',
  'OPENCODE_LOG_DIR',
  'OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS',
  'OH_MY_OPENCODE_SLIM_DISABLE',
] as const;

function makeTestEnvironment(): TestEnvironment {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'omos-tui-gates-'));
  const projectDir = path.join(root, 'project');
  fs.mkdirSync(projectDir, { recursive: true });
  const original = Object.fromEntries(
    ENV_KEYS.map((key) => [key, process.env[key]]),
  );
  const configDir = path.join(root, 'opencode-config');

  process.env.OPENCODE_CONFIG_DIR = configDir;
  process.env.XDG_CONFIG_HOME = path.join(root, 'xdg-config');
  process.env.XDG_DATA_HOME = path.join(root, 'xdg-data');
  process.env.OPENCODE_LOG_DIR = path.join(root, 'logs');
  delete process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS;
  delete process.env.OH_MY_OPENCODE_SLIM_DISABLE;
  fs.mkdirSync(configDir, { recursive: true });

  return {
    root,
    projectDir,
    restore: () => {
      for (const key of ENV_KEYS) {
        const value = original[key];
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    },
  };
}

function writeUserConfig(config: Record<string, unknown>): void {
  const configDir = process.env.OPENCODE_CONFIG_DIR;
  if (!configDir) throw new Error('OPENCODE_CONFIG_DIR not set');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'oh-my-opencode-slim.json'),
    JSON.stringify(config, null, 2),
  );
}

function writeProjectConfig(
  projectDir: string,
  config: Record<string, unknown>,
): void {
  const configDir = path.join(projectDir, '.opencode');
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, 'oh-my-opencode-slim.json'),
    JSON.stringify(config, null, 2),
  );
}

type Dispose = () => void | Promise<void>;

interface V1Capture {
  slotRegistrations: number;
  commands: Array<Record<string, unknown>>;
}

function makeV1Api(projectDir: string): {
  api: Record<string, unknown>;
  capture: V1Capture;
  disposers: Dispose[];
} {
  const capture: V1Capture = { slotRegistrations: 0, commands: [] };
  const disposers: Dispose[] = [];
  const api = {
    state: { path: { directory: projectDir } },
    route: { current: { name: 'home' } },
    lifecycle: {
      onDispose: (callback: Dispose) => {
        disposers.push(callback);
        return () => {};
      },
    },
    renderer: { requestRender: () => {} },
    slots: {
      register: () => {
        capture.slotRegistrations += 1;
        return 'test-slot';
      },
    },
    theme: { current: {} },
    command: {
      register: (callback: () => Array<Record<string, unknown>>) => {
        capture.commands.push(...callback());
        return () => {};
      },
    },
  };
  return { api, capture, disposers };
}

async function runV1Entry(api: Record<string, unknown>): Promise<void> {
  await tuiPlugin.tui(
    api as unknown as Parameters<typeof tuiPlugin.tui>[0],
    {},
    { version: 'test' } as Parameters<typeof tuiPlugin.tui>[2],
  );
}

function spyOnIntervals(): { delays: number[]; restore: () => void } {
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  const timerHost = globalThis as unknown as {
    setInterval: typeof setInterval;
    clearInterval: typeof clearInterval;
  };
  const delays: number[] = [];
  const setIntervalSpy = mock((callback: () => void, delay?: number) => {
    void callback;
    delays.push(delay ?? 0);
    return 0 as unknown as ReturnType<typeof setInterval>;
  });
  const clearIntervalSpy = mock((_timer: unknown) => {});
  timerHost.setInterval = setIntervalSpy as unknown as typeof setInterval;
  timerHost.clearInterval = clearIntervalSpy as unknown as typeof clearInterval;
  return {
    delays,
    restore: () => {
      timerHost.setInterval = originalSetInterval;
      timerHost.clearInterval = originalClearInterval;
    },
  };
}

describe('TUI feature gates', () => {
  let env: TestEnvironment;

  beforeEach(() => {
    env = makeTestEnvironment();
  });

  afterEach(() => {
    env.restore();
    fs.rmSync(env.root, { recursive: true, force: true });
  });

  test('v1 entry registers nothing when tui is false', async () => {
    writeUserConfig({});
    writeProjectConfig(env.projectDir, { tui: false });
    const { api, capture, disposers } = makeV1Api(env.projectDir);

    await runV1Entry(api);

    expect(capture.slotRegistrations).toBe(0);
    expect(capture.commands).toEqual([]);
    expect(disposers).toEqual([]);
  });

  test('independently reachable internal setup honors tui false', async () => {
    writeUserConfig({ tui: false });

    const cleanup = await tuiPlugin.setup({
      location: { directory: env.projectDir },
    } as unknown as Parameters<typeof tuiPlugin.setup>[0]);

    expect(cleanup).toBeUndefined();
  });

  test('v1 disabled_commands removes killall and keeps preset', async () => {
    writeUserConfig({});
    writeProjectConfig(env.projectDir, { disabled_commands: ['killall'] });
    const { api, capture, disposers } = makeV1Api(env.projectDir);

    try {
      await runV1Entry(api);
      const names = capture.commands.map((command) => command.value);
      expect(names).toContain('preset');
      expect(names).not.toContain('omo.kill_all');
    } finally {
      for (const dispose of disposers) await dispose();
    }
  });

  test('v1 disabled_commands removes preset and keeps killall', async () => {
    writeUserConfig({});
    writeProjectConfig(env.projectDir, { disabled_commands: ['preset'] });
    const { api, capture, disposers } = makeV1Api(env.projectDir);

    try {
      await runV1Entry(api);
      const names = capture.commands.map((command) => command.value);
      expect(names).not.toContain('preset');
      expect(names).toContain('omo.kill_all');
    } finally {
      for (const dispose of disposers) await dispose();
    }
  });

  test('v1 commands are enabled by default', async () => {
    writeUserConfig({});
    const { api, capture, disposers } = makeV1Api(env.projectDir);

    try {
      await runV1Entry(api);
      expect(capture.commands.map((command) => command.value)).toEqual([
        'preset',
        'omo.kill_all',
      ]);
    } finally {
      for (const dispose of disposers) await dispose();
    }
  });

  describe('sidebar polling intervals', () => {
    test('sidebar-on rendering keeps the fast 1s poll', async () => {
      writeUserConfig({});
      const intervals = spyOnIntervals();
      const { api, disposers } = makeV1Api(env.projectDir);
      try {
        await runV1Entry(api);
        expect(intervals.delays).toContain(1000);
        expect(intervals.delays).toContain(100);
        expect(intervals.delays).not.toContain(5000);
      } finally {
        for (const dispose of disposers) await dispose();
        intervals.restore();
      }
    });

    test('sidebar-off config polling uses the slow 5s interval', async () => {
      writeUserConfig({});
      writeProjectConfig(env.projectDir, { sidebar: false });
      const intervals = spyOnIntervals();
      const { api, disposers } = makeV1Api(env.projectDir);
      try {
        await runV1Entry(api);
        expect(intervals.delays).toContain(5000);
        expect(intervals.delays).not.toContain(1000);
        expect(intervals.delays).not.toContain(100);
      } finally {
        for (const dispose of disposers) await dispose();
        intervals.restore();
      }
    });

    test('the refresh test hook overrides either poll interval', async () => {
      process.env.OH_MY_OPENCODE_SLIM_TUI_REFRESH_MS = '42';
      writeUserConfig({});
      const fastIntervals = spyOnIntervals();
      const fast = makeV1Api(env.projectDir);
      try {
        await runV1Entry(fast.api);
        expect(fastIntervals.delays).toContain(42);
        expect(fastIntervals.delays).not.toContain(1000);
      } finally {
        for (const dispose of fast.disposers) await dispose();
        fastIntervals.restore();
      }

      writeProjectConfig(env.projectDir, { sidebar: false });
      const slowIntervals = spyOnIntervals();
      const slow = makeV1Api(env.projectDir);
      try {
        await runV1Entry(slow.api);
        expect(slowIntervals.delays).toContain(42);
        expect(slowIntervals.delays).not.toContain(5000);
      } finally {
        for (const dispose of slow.disposers) await dispose();
        slowIntervals.restore();
      }
    });
  });
});
