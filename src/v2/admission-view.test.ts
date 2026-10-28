/** Focused tests for the admission reuse view: the per-session profile
 * table derived from ONE admission transaction's record must match what
 * the previous second-ensure path produced (setup `profilesForSession`),
 * including execution-bundle precedence and managed option keys. */
import { describe, expect, test } from 'bun:test';
import { sessionAdmissionProfiles } from './admission-view';
import type { V2AgentRuntimeProfiles } from './runtime-profiles';
import type { SessionPresetRecord } from './session-presets';

const CURRENT: V2AgentRuntimeProfiles = {
  explorer: {
    model: { providerID: 'openai', id: 'gpt-5' },
    sidebarModel: 'openai/gpt-5',
    temperature: 0.7,
  },
};

const REGISTERED: V2AgentRuntimeProfiles = {
  explorer: {
    model: { providerID: 'openai', id: 'gpt-5' },
    sidebarModel: 'openai/gpt-5',
    providerOptions: { reasoning: 'high' },
  },
};

function record(overrides?: Partial<SessionPresetRecord>): SessionPresetRecord {
  return {
    schemaVersion: 1,
    bundle: {
      presetName: 'default',
      fallbackEnabled: true,
      profiles: {
        explorer: {
          model: { providerID: 'anthropic', id: 'claude' },
          temperature: 0.3,
          providerOptions: { thinking: { type: 'enabled' } },
          sidebarModel: 'anthropic/claude',
        },
      },
      chains: { explorer: [{ id: 'anthropic/claude' }] },
      inheritance: {},
    },
    ...overrides,
  };
}

describe('sessionAdmissionProfiles', () => {
  test('unbound record falls back to the current global table', () => {
    expect(sessionAdmissionProfiles(undefined, CURRENT, REGISTERED)).toBe(
      CURRENT,
    );
  });

  test('bound bundle profiles override with merged managed option keys', () => {
    const table = sessionAdmissionProfiles(record(), CURRENT, REGISTERED);
    expect(table.explorer).toEqual({
      model: { providerID: 'anthropic', id: 'claude' },
      temperature: 0.3,
      providerOptions: { thinking: { type: 'enabled' } },
      sidebarModel: 'anthropic/claude',
      managedProviderOptionKeys: [
        'thinking',
        ...Object.keys(REGISTERED.explorer?.providerOptions ?? {}),
      ].sort(),
    });
    expect(table.explorer.providerOptions).toEqual({
      thinking: { type: 'enabled' },
    });
  });

  test('execution bundle takes precedence over the team bundle', () => {
    const r = record({
      execution: {
        presetName: 'exec',
        fallbackEnabled: false,
        profiles: {
          explorer: { sidebarModel: 'anthropic/claude-opus' },
        },
        chains: {},
        inheritance: {},
      },
    });
    const table = sessionAdmissionProfiles(r, CURRENT, REGISTERED);
    expect(table.explorer).toEqual({
      sidebarModel: 'anthropic/claude-opus',
      managedProviderOptionKeys: ['reasoning'].sort(),
    });
  });

  test('chains and preset identity travel with the record, not the table', () => {
    const r = record();
    // The admission keeps the full record (bundle chains, preset name,
    // preserveModel flags) for the caller; the profile table is only the
    // inference fields the bridge captures.
    expect(r.bundle.chains).toEqual({ explorer: [{ id: 'anthropic/claude' }] });
    expect(r.bundle.presetName).toBe('default');
    const table = sessionAdmissionProfiles(r, CURRENT, REGISTERED);
    expect('chains' in table.explorer).toBe(false);
  });

  test('preserved model flag is read from the record, not inferred', () => {
    const r = record({ preserveModel: true, explicitModel: true });
    expect(r.preserveModel).toBe(true);
    expect(r.explicitModel).toBe(true);
    // Profile table is unaffected by the flags.
    const table = sessionAdmissionProfiles(r, CURRENT, REGISTERED);
    expect(table.explorer.model).toEqual({
      providerID: 'anthropic',
      id: 'claude',
    });
  });
});
