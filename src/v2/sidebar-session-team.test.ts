import { afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { testRender } from '@opentui/solid';
import {
  getSidebarAgentTargets,
  getSidebarReusableTargets,
  overlaySelectedRootModel,
  projectSidebarTeam,
  renderSidebar,
} from '../tui';
import { readTuiSnapshot } from '../tui-state';
import type { SessionPresetState } from './preset-rpc';
import { makeTestEnv } from './test-fixtures';

let env: ReturnType<typeof makeTestEnv>;
beforeEach(() => {
  env = makeTestEnv('omos-sidebar-team');
});
afterEach(() => env.restore());

function savedState(): SessionPresetState {
  return {
    sessionID: 'root-a',
    status: 'bound',
    presetName: 'A',
    affects: 'future-children-only',
    team: {
      agentModels: { oracle: 'saved/team-a' },
      agentVariants: { explorer: 'high' },
      inheritance: { explorer: 'session' },
    },
  };
}

describe('visible session sidebar team', () => {
  test('saved A replaces global B locally; older backends retain the existing view', () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentModels = { oracle: 'global/team-b' };
    snapshot.agentVariants = { oracle: 'low' };
    const before = structuredClone(snapshot);
    const saved = savedState();
    const projected = projectSidebarTeam(snapshot, saved);
    expect(projected.agentModels).toEqual({
      oracle: 'saved/team-a',
      explorer: 'Inherits session',
    });
    expect(projected.agentVariants).toEqual({ explorer: 'high' });
    expect(snapshot).toEqual(before);
    expect(projectSidebarTeam(snapshot)).toBe(snapshot);
    expect(projectSidebarTeam(snapshot, { ...saved, team: undefined })).toBe(
      snapshot,
    );
  });

  test('canonical/display aliases share one row and retain inherited variants and activity', async () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentModels = { oracle: 'global/team-b' };
    snapshot.agentDisplayNames = {
      oracle: 'Research Lead',
      custom_a: 'Reviewer',
      custom_b: 'Reviewer',
    };
    snapshot.sessionParents = { task: 'root-a' };
    snapshot.activeSessions = { task: 'Research Lead' };
    snapshot.reusableByAgent = {
      'root-a': {
        'Research Lead': [{ taskID: 'task', alias: 'ora-1', running: true }],
      },
    };
    const saved = savedState();
    if (!saved.team) throw new Error('Missing test team');
    saved.team.agentModels = {
      'Research Lead': 'legacy/duplicate',
      oracle: 'saved/team-a',
      librarian: 'legacy/explorer',
      custom_a: 'saved/shared-model',
      custom_b: 'saved/shared-model',
    };
    saved.team.agentVariants.librarian = 'low';
    const before = structuredClone({ snapshot, saved });
    const projected = projectSidebarTeam(snapshot, saved);
    expect(projected.agentModels.oracle).toBe('saved/team-a');
    expect(projected.agentVariants.explorer).toBe('high');
    expect(getSidebarAgentTargets(projected, 'root-a')).toMatchObject([
      { agentName: 'oracle', sessions: [{ sessionID: 'task' }] },
    ]);
    expect(
      getSidebarReusableTargets(projected, 'root-a').get('oracle'),
    ).toHaveLength(1);
    const rendered = await testRender(
      () =>
        renderSidebar(
          projected,
          'test',
          {
            accent: '#777777',
            background: '#111111',
            borderActive: '#555555',
            text: '#eeeeee',
            textMuted: '#aaaaaa',
          },
          false,
          false,
          () => 0,
          'root-a',
        ),
      { width: 80, height: 32 },
    );
    try {
      await rendered.renderOnce();
      const frame = rendered.captureCharFrame();
      expect(frame.match(/Research Lead/g)).toHaveLength(1);
      expect(frame.match(/\bexplorer\b/g)).toHaveLength(1);
      expect(frame.match(/Reviewer/g)).toHaveLength(2);
      expect(frame).toMatch(/Inherits session[\s│]*variant\s+high/);
      expect(frame).not.toContain('duplicate');
      expect(frame).not.toContain('team-b');
      expect({ snapshot, saved }).toEqual(before);
    } finally {
      rendered.renderer.destroy();
    }
  });

  test('the main row retains its live snapshot model and variant beneath the root picker', () => {
    const snapshot = readTuiSnapshot(env.projectDir);
    snapshot.agentDisplayNames = { orchestrator: 'Team Lead' };
    snapshot.agentModels = {
      'Team Lead': 'legacy/root-model',
      orchestrator: 'live/root-model',
    };
    snapshot.agentVariants = { 'Team Lead': 'low', orchestrator: 'medium' };
    const saved = savedState();
    if (!saved.team) throw new Error('Missing test team');
    saved.team.agentModels.orchestrator = 'saved/root-model';
    saved.team.agentVariants.orchestrator = 'low';
    const projected = projectSidebarTeam(snapshot, saved);
    const childView = overlaySelectedRootModel(projected, undefined);
    expect(childView.agentModels.orchestrator).toBe('live/root-model');
    expect(childView.agentVariants.orchestrator).toBe('medium');
    expect(childView.agentModels['Team Lead']).toBeUndefined();
    const displayed = overlaySelectedRootModel(projected, {
      model: 'picker/next-model',
      variant: 'high',
    });
    expect(displayed.agentModels.orchestrator).toBe('picker/next-model');
    expect(displayed.agentVariants.orchestrator).toBe('high');
    expect(displayed.agentModels.oracle).toBe('saved/team-a');
    expect(projected.agentModels.orchestrator).toBe('live/root-model');
    expect(projected.agentVariants.orchestrator).toBe('medium');
    const absent = projectSidebarTeam(readTuiSnapshot(env.projectDir), saved);
    expect(absent.agentModels.orchestrator).toBeUndefined();
    expect(absent.agentVariants.orchestrator).toBeUndefined();
  });
});
