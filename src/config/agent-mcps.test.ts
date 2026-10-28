import { describe, expect, test } from 'bun:test';
import { DEFAULT_AGENT_MCPS, getAgentMcpList, parseList } from './agent-mcps';
import { RuntimeConfig } from './runtime';
import type { PluginConfig } from './schema';

const TEST_DIRECTORY = 'runtime-test-agent-mcps';
function runtimeFor(config: PluginConfig = {}) {
  RuntimeConfig.reset(TEST_DIRECTORY);
  return RuntimeConfig.init(TEST_DIRECTORY, config);
}

describe('parseList', () => {
  test('empty list returns empty array', () => {
    expect(parseList([], ['mcp1', 'mcp2'])).toEqual([]);
  });

  test('wildcard includes all available', () => {
    expect(parseList(['*'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([
      'mcp1',
      'mcp2',
      'mcp3',
    ]);
  });

  test('orchestrator wildcard excludes context7 but includes custom mcps', () => {
    expect(
      parseList(DEFAULT_AGENT_MCPS.orchestrator, [
        'context7',
        'gh_grep',
        'custom-mcp',
      ]),
    ).toEqual(['gh_grep', 'custom-mcp']);
  });

  test('wildcard with exclusions', () => {
    expect(parseList(['*', '!mcp2'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([
      'mcp1',
      'mcp3',
    ]);
  });

  test('exclude wildcard returns empty', () => {
    expect(parseList(['!*'], ['mcp1', 'mcp2'])).toEqual([]);
  });

  test('specific items only', () => {
    expect(
      parseList(['mcp1', 'mcp3'], ['mcp1', 'mcp2', 'mcp3', 'mcp4']),
    ).toEqual(['mcp1', 'mcp3']);
  });

  test('specific items with exclusions', () => {
    expect(
      parseList(['mcp1', 'mcp3', '!mcp3'], ['mcp1', 'mcp2', 'mcp3']),
    ).toEqual(['mcp1']);
  });

  test('exclusions without matching allows', () => {
    expect(parseList(['!mcp2'], ['mcp1', 'mcp2', 'mcp3'])).toEqual([]);
  });
});

describe('getAgentMcpList rename continuity', () => {
  test("reads mcps from a legacy 'librarian' record for the explorer", () => {
    const runtime = runtimeFor({
      agents: { librarian: { mcps: ['legacy-mcp'] } },
    });
    expect(getAgentMcpList('explorer', runtime)).toEqual(['legacy-mcp']);
  });

  test("canonical 'explorer' mcps win over the legacy record", () => {
    const runtime = runtimeFor({
      agents: {
        explorer: { mcps: ['canonical-mcp'] },
        librarian: { mcps: ['legacy-mcp'] },
      },
    });
    expect(getAgentMcpList('explorer', runtime)).toEqual(['canonical-mcp']);
  });
});

describe('getAgentMcpList pass-local agents record', () => {
  test('uses the provided record instead of deriving from the runtime', () => {
    const runtime = runtimeFor({
      agents: { explorer: { mcps: ['runtime-mcp'] } },
    });
    expect(
      getAgentMcpList('explorer', runtime, {
        explorer: { mcps: ['pass-mcp'] },
      }),
    ).toEqual(['pass-mcp']);
  });

  test('legacy aliases resolve inside the provided record', () => {
    const runtime = runtimeFor({});
    expect(
      getAgentMcpList('explorer', runtime, {
        librarian: { mcps: ['legacy-mcp'] },
      }),
    ).toEqual(['legacy-mcp']);
  });

  test('per-agent defaults apply for entries absent from the record', () => {
    const runtime = runtimeFor({});
    expect(getAgentMcpList('oracle', runtime, {})).toEqual([]);
    expect(getAgentMcpList('custom-unknown', runtime, {})).toEqual([]);
  });

  test('without the record the runtime derivation still applies', () => {
    const runtime = runtimeFor({
      agents: { explorer: { mcps: ['configured-mcp'] } },
    });
    expect(getAgentMcpList('explorer', runtime)).toEqual(['configured-mcp']);
  });
});
