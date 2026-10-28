import { afterAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyPackagedImportClosure } from './package-imports';

const fixtures: string[] = [];
afterAll(() => {
  for (const root of fixtures) rmSync(root, { recursive: true, force: true });
});

/**
 * Build a throwaway package layout (no installed dependencies) and return the
 * repo root plus a helper to write dist files.
 */
function createFixture() {
  const root = mkdtempSync(path.join(tmpdir(), 'omos-package-imports-'));
  fixtures.push(root);
  const dist = path.join(root, 'dist');
  mkdirSync(path.join(dist, 'chunks'), { recursive: true });
  mkdirSync(path.join(dist, 'server', 'chunks'), { recursive: true });

  const write = (relativePath: string, source: string) => {
    const target = path.join(root, relativePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, source);
  };

  return { root, write };
}

/** A complete, multi-level split bundle graph that must pass. */
const completeGraph = [
  [
    'dist/index.js',
    [
      "import { shared } from './chunks/index-abc123.js';",
      'export const core = shared;',
    ].join('\n'),
  ],
  [
    'dist/tui.js',
    [
      "import { shared } from './chunks/index-abc123.js';",
      "import { pane } from './chunks/pane-def456.js';",
      'export const tui = pane(shared);',
    ].join('\n'),
  ],
  [
    'dist/tui2.js',
    [
      "import { shared } from './chunks/index-abc123.js';",
      'export async function run() {',
      "  const { render } = await import('./chunks/render-789xyz.js');",
      '  return render(shared);',
      '}',
    ].join('\n'),
  ],
  [
    'dist/server/index.js',
    [
      "import { shared } from './chunks/shared-hash1.js';",
      'export async function boot() {',
      "  const { registry } = await import('./chunks/registry-hash2.js');",
      '  return registry(shared);',
      '}',
    ].join('\n'),
  ],
  [
    'dist/cli/index.js',
    [
      "import { shared } from '../chunks/index-abc123.js';",
      "import { Plugin } from '@opencode-ai/plugin';",
      "import { z } from 'zod';",
      "import { readFileSync } from 'node:fs';",
      'console.log(shared, Plugin, z, readFileSync);',
    ].join('\n'),
  ],
  [
    'dist/marketplace-contract/index.js',
    "export { validate } from './chunks/validate-hash3.js';",
  ],
  [
    'dist/chunks/index-abc123.js',
    "import { base } from './base-hash4.js';\nexport const shared = base;",
  ],
  ['dist/chunks/base-hash4.js', "export const base = 'base';"],
  ['dist/chunks/pane-def456.js', 'export const pane = (x) => "pane:" + x;'],
  [
    'dist/chunks/render-789xyz.js',
    // Nested `../` edge: a chunk directory reaching back to dist root.
    "import { base } from '../chunks/base-hash4.js';\nexport const render = () => base;",
  ],
  [
    'dist/server/chunks/shared-hash1.js',
    "import { base } from '../../chunks/base-hash4.js';\nexport const shared = base;",
  ],
  [
    'dist/server/chunks/registry-hash2.js',
    "import { shared } from './shared-hash1.js';\nexport const registry = () => shared;",
  ],
  [
    'dist/cli/chunks/pane-def456.js',
    "import { pane } from '../../chunks/pane-def456.js';\nexport { pane };",
  ],
  [
    'dist/marketplace-contract/chunks/validate-hash3.js',
    'export const validate = () => true;',
  ],
] as const;

const completeFilePaths = completeGraph.map(([file]) => file);

function writeCompleteGraph(write: (file: string, source: string) => void) {
  for (const [file, source] of completeGraph) write(file, source);
}

describe('verifyPackagedImportClosure', () => {
  test('accepts a complete multi-level static and dynamic chunk graph', () => {
    const { root, write } = createFixture();
    writeCompleteGraph(write);

    expect(() =>
      verifyPackagedImportClosure(root, new Set(completeFilePaths)),
    ).not.toThrow();
  });

  test('fails when a static chunk edge is missing from the tarball', () => {
    const { root, write } = createFixture();
    writeCompleteGraph(write);

    const packed = new Set(completeFilePaths);
    packed.delete('dist/chunks/index-abc123.js');

    expect(() => verifyPackagedImportClosure(root, packed)).toThrow(
      /dist\/cli\/index\.js imports "\.\.\/chunks\/index-abc123\.js" resolves to dist\/chunks\/index-abc123\.js, which is not included in the npm tarball/,
    );
  });

  test('fails when a dynamic chunk edge is missing from the tarball', () => {
    const { root, write } = createFixture();
    writeCompleteGraph(write);

    const packed = new Set(completeFilePaths);
    packed.delete('dist/server/chunks/registry-hash2.js');

    expect(() => verifyPackagedImportClosure(root, packed)).toThrow(
      /dist\/server\/index\.js dynamically imports "\.\/chunks\/registry-hash2\.js" resolves to dist\/server\/chunks\/registry-hash2\.js, which is not included in the npm tarball/,
    );
  });

  test('fails when a nested ../ chunk edge is missing from the tarball', () => {
    const { root, write } = createFixture();
    writeCompleteGraph(write);

    const packed = new Set(completeFilePaths);
    packed.delete('dist/chunks/base-hash4.js');

    // Make the nested edge the first missing import in sorted file order.
    write('dist/chunks/index-abc123.js', "export const shared = 'base';");
    expect(() => verifyPackagedImportClosure(root, packed)).toThrow(
      /dist\/chunks\/render-789xyz\.js imports "\.\.\/chunks\/base-hash4\.js" resolves to dist\/chunks\/base-hash4\.js, which is not included in the npm tarball/,
    );
  });

  test('fails when a relative import escapes the packaged dist/ directory', () => {
    const { root, write } = createFixture();
    writeCompleteGraph(write);
    write(
      'dist/chunks/index-abc123.js',
      "import { leaked } from '../../src/leaked.js';\nexport const shared = leaked;",
    );

    expect(() =>
      verifyPackagedImportClosure(root, new Set(completeFilePaths)),
    ).toThrow(
      /dist\/chunks\/index-abc123\.js imports "\.\.\/\.\.\/src\/leaked\.js" resolves to "src\/leaked\.js", which is outside the packaged dist\/ directory/,
    );
  });
});
