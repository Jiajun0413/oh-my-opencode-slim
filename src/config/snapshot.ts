/**
 * Shared cached read surface for plugin configuration and the preset catalog.
 *
 * One entry per resolved (directory, hostFlavor) context (bounded to 32)
 * holds the captured text of every selected layer plus the candidate
 * identities behind it. Every read re-stats ALL candidates (absent files
 * included, so a new `.jsonc` flipping the precedence is itself an identity
 * change) and compares identities plus the volatile context parts: the
 * env-selected preset, the project-config flag, the config search
 * directories, and every referenced `{env:NAME}` value. On a miss only the
 * SELECTED files are read, once, and their text is fed into the existing
 * `loadPluginConfig` / `loadRawPluginConfigFromPath` seams through the
 * internal `readText` hook, so the loader never re-reads the same bytes.
 *
 * The merged config snapshot and the preset catalog derive lazily from the
 * entry and are cached on it. Outcomes are frozen; a stat/read failure or a
 * mid-read identity change bypasses the cache for that read and is never
 * stored. Warnings stay on every outcome and replay to subscribers on each
 * read, hit or miss.
 */

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { ConfigLoadWarning } from './loader';
import {
  findPluginConfigPaths,
  getPluginConfigCandidates,
  isProjectConfigDisabled,
  loadPluginConfig,
  loadRawPluginConfigFromPath,
  mergePluginConfigs,
} from './loader';
import { getConfigSearchDirs } from './paths';
import { mergePresetMaps } from './presets';
import type {
  PresetInput,
  RawPluginConfig,
  ResolvedPluginConfig,
} from './schema';

const MAX_SNAPSHOT_ENTRIES = 32;
const ENV_REFERENCE_PATTERN = /\{env:([^}]+)\}/g;

export interface PluginConfigSnapshotPaths {
  userConfigPath: string | null;
  projectConfigPath: string | null;
  projectConfigPaths: string[];
}

/** Frozen outcome of one cached config read. */
export interface PluginConfigSnapshot {
  readonly config: ResolvedPluginConfig;
  /** All non-fatal warnings of the load, kept even when this read was silent. */
  readonly warnings: readonly ConfigLoadWarning[];
  readonly paths: PluginConfigSnapshotPaths;
  /** Identity of every input that produced this outcome. */
  readonly fingerprint: string;
}

export interface ReadPluginConfigSnapshotOptions {
  hostFlavor?: string;
  /** Select a preset for this read only (same semantics as the load option). */
  presetName?: string;
  /** Existing watcher/explicit notification proved a write, even when the
   * filesystem's timestamp granularity leaves the stat signature unchanged. */
  fresh?: boolean;
  /** Receives the outcome's warnings on every read, hit or miss. */
  onWarning?: (warning: ConfigLoadWarning) => void;
}

/** Frozen catalog: raw user layer + validated project layers + derived maps. */
export interface PresetCatalog {
  readonly userConfig: Record<string, unknown> | null;
  readonly userPresets: Record<string, PresetInput>;
  readonly projectConfig: Record<string, unknown> | null;
  readonly projectPresets: Record<string, PresetInput>;
  /** Effective catalog: user presets as the base, project presets overriding. */
  readonly presets: Record<string, PresetInput>;
  readonly warnings: readonly ConfigLoadWarning[];
  readonly fingerprint: string;
}

export interface LoadPresetCatalogOptions {
  /** Receives the catalog's warnings on every read, hit or miss. */
  onWarning?: (warning: ConfigLoadWarning) => void;
}

interface ReadContext {
  directory: string;
  hostFlavor?: string;
}

interface FileIdentity {
  dev: number;
  ino: number;
  mtimeMs: number;
  ctimeMs: number;
  size: number;
}

interface CandidateState {
  identity: FileIdentity | null;
  /** Captured text of a selected file; null for absent or unread files. */
  text: string | null;
}

interface SnapshotEntry {
  context: ReadContext;
  states: Map<string, CandidateState>;
  selected: PluginConfigSnapshotPaths;
  envReferenceNames: string[];
  contentFingerprint: string;
  fingerprint: string;
  readText: (configPath: string) => string;
  catalog: PresetCatalog | null;
  configs: Map<string, PluginConfigSnapshot>;
}

const entries = new Map<string, SnapshotEntry>();

function ownValue<T>(record: Record<string, T>, name: string): T | undefined {
  if (!Object.hasOwn(record, name)) return undefined;
  const descriptor = Object.getOwnPropertyDescriptor(record, name);
  return descriptor && 'value' in descriptor
    ? (descriptor.value as T)
    : undefined;
}

function defineOwn<T>(record: Record<string, T>, name: string, value: T): void {
  Object.defineProperty(record, name, {
    value,
    writable: true,
    enumerable: true,
    configurable: true,
  });
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function presetMapOf(config: unknown): Record<string, PresetInput> {
  const presets = isPlainRecord(config) ? config.presets : undefined;
  return isPlainRecord(presets) ? (presets as Record<string, PresetInput>) : {};
}

function deepFreeze<T>(value: T): T {
  if (Array.isArray(value)) {
    for (const entry of value) deepFreeze(entry);
    Object.freeze(value);
    return value;
  }
  if (isPlainRecord(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

/**
 * Deep-clone a JSON-shaped value. Cached outcomes are frozen; public preset
 * read functions hand out clones so returned values stay independently
 * mutable without corrupting the cache. Own (prototype-sensitive) keys are
 * preserved through `defineProperty`, never plain assignment.
 */
export function cloneConfigValue<T>(value: T): T {
  if (Array.isArray(value)) return value.map(cloneConfigValue) as T;
  if (isPlainRecord(value)) {
    const clone: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      defineOwn(clone, key, cloneConfigValue(value[key]));
    }
    return clone as T;
  }
  return value;
}

function replayWarnings(
  warnings: readonly ConfigLoadWarning[],
  onWarning?: (warning: ConfigLoadWarning) => void,
): void {
  if (!onWarning) return;
  for (const warning of warnings) onWarning(warning);
}

function identityKey(candidate: string, state: CandidateState): string {
  if (!state.identity) return `${candidate}\u0001absent`;
  const file = state.identity;
  return [
    candidate,
    'present',
    file.dev,
    file.ino,
    file.mtimeMs,
    file.ctimeMs,
    file.size,
  ].join('\u0001');
}

function statAllCandidates(candidates: readonly string[]): {
  states: Map<string, CandidateState>;
  failed: boolean;
} {
  const states = new Map<string, CandidateState>();
  let failed = false;
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate);
      states.set(candidate, {
        identity: {
          dev: stat.dev,
          ino: stat.ino,
          mtimeMs: stat.mtimeMs,
          ctimeMs: stat.ctimeMs,
          size: stat.size,
        },
        text: null,
      });
    } catch (error) {
      if (
        error instanceof Error &&
        'code' in error &&
        (error as NodeJS.ErrnoException).code === 'ENOENT'
      ) {
        states.set(candidate, { identity: null, text: null });
        continue;
      }
      failed = true;
    }
  }
  return { states, failed };
}

function sameStates(
  candidates: readonly string[],
  left: Map<string, CandidateState>,
  right: Map<string, CandidateState>,
): boolean {
  if (left.size !== right.size || left.size !== candidates.length) return false;
  const previousOrder = [...left.keys()];
  if (
    candidates.some((candidate, index) => candidate !== previousOrder[index])
  ) {
    return false;
  }
  for (const candidate of candidates) {
    const a = left.get(candidate);
    const b = right.get(candidate);
    if (!a || !b) return false;
    if (identityKey(candidate, a) !== identityKey(candidate, b)) return false;
  }
  return true;
}

/** Selected sources: per base `.jsonc` beats `.json`; the user keeps the
 * first directory that has one, the project keeps every layer plus the
 * current directory's own file (mirrors `findPluginConfigPaths`). */
function selectPaths(
  userCandidates: readonly string[],
  projectCandidates: readonly string[],
  exists: (candidate: string) => boolean,
): PluginConfigSnapshotPaths {
  const selectPairs = (candidates: readonly string[]): string[] => {
    const selected: string[] = [];
    for (let index = 0; index < candidates.length; index += 2) {
      if (exists(candidates[index])) selected.push(candidates[index]);
      else if (exists(candidates[index + 1]))
        selected.push(candidates[index + 1]);
    }
    return selected;
  };
  const userSelected = selectPairs(userCandidates);
  const projectSelected = selectPairs(projectCandidates);
  return {
    userConfigPath: userSelected[0] ?? null,
    projectConfigPath: selectPairs(projectCandidates.slice(-2))[0] ?? null,
    projectConfigPaths: projectSelected,
  };
}

function collectEnvReferenceNames(texts: readonly string[]): string[] {
  const names = new Set<string>();
  for (const text of texts) {
    for (const match of text.matchAll(ENV_REFERENCE_PATTERN)) {
      if (match[1]) names.add(match[1]);
    }
  }
  return [...names].sort();
}

function currentEnvValues(names: readonly string[]): string[] {
  return names.map((name) => `${name}=${process.env[name] ?? ''}`);
}

function buildFingerprint(
  entry: SnapshotEntry,
  envValues: readonly string[],
): string {
  return [
    '1',
    entry.context.directory,
    entry.context.hostFlavor ?? '',
    entry.contentFingerprint,
    process.env.OH_MY_OPENCODE_SLIM_PRESET ?? '',
    isProjectConfigDisabled()
      ? 'project-config-disabled'
      : 'project-config-enabled',
    getConfigSearchDirs().join('\u0001'),
    ...[...entry.states].map(([candidate, state]) =>
      identityKey(candidate, state),
    ),
    ...envValues,
  ].join('\u0002');
}

function cacheKey(context: ReadContext): string {
  return `${context.directory}\u0000${context.hostFlavor ?? ''}`;
}

/**
 * Look up (or build) the shared entry for a context. Building reads every
 * SELECTED file once and stores its text; the loader consumes that text
 * through the `readText` seam. Returns null when the read must stay uncached
 * (stat or read failure, or identity drift observed mid-read).
 */
function getEntry(context: ReadContext): SnapshotEntry | null {
  const key = cacheKey(context);
  const cached = entries.get(key);
  const candidates = getPluginConfigCandidates(
    context.directory,
    context.hostFlavor,
  );
  const allCandidates = [...candidates.user, ...candidates.project];
  const { states, failed } = statAllCandidates(allCandidates);
  if (failed) return null;

  const unchanged = cached
    ? sameStates(allCandidates, cached.states, states)
    : false;
  if (cached && unchanged) {
    const fresh = buildFingerprint(
      cached,
      currentEnvValues(cached.envReferenceNames),
    );
    if (fresh === cached.fingerprint) return cached;
  }

  const selected = selectPaths(
    candidates.user,
    candidates.project,
    (candidate) => Boolean(states.get(candidate)?.identity),
  );
  const selectedPaths = [
    ...(selected.userConfigPath ? [selected.userConfigPath] : []),
    ...selected.projectConfigPaths,
  ];
  for (const selectedPath of selectedPaths) {
    const state = states.get(selectedPath);
    if (!state) return null;
    const previous = unchanged ? cached?.states.get(selectedPath) : undefined;
    if (previous?.text !== null && previous?.text !== undefined) {
      state.text = previous.text;
      continue;
    }
    try {
      state.text = fs.readFileSync(selectedPath, 'utf-8');
    } catch {
      // Read failure: bypass the cache and never remember a fallback state.
      return null;
    }
  }

  const after = statAllCandidates(allCandidates);
  if (after.failed || !sameStates(allCandidates, states, after.states)) {
    // Identity changed while the selected files were read: this outcome may
    // be a mixture, so it stays uncached.
    return null;
  }

  const entry: SnapshotEntry = {
    context,
    states,
    selected,
    envReferenceNames: collectEnvReferenceNames(
      selectedPaths.map((selectedPath) => states.get(selectedPath)?.text ?? ''),
    ),
    contentFingerprint: createHash('sha256')
      .update(
        JSON.stringify(selectedPaths.map((source) => states.get(source)?.text)),
      )
      .digest('hex'),
    fingerprint: '',
    readText: (configPath: string) => {
      const text = states.get(configPath)?.text;
      if (text === null || text === undefined) {
        entries.delete(key);
        const error = new Error(
          `Config source changed during read: ${configPath}`,
        );
        throw Object.assign(error, { code: 'EIO' });
      }
      return text;
    },
    catalog: null,
    configs: new Map(),
  };
  entry.fingerprint = buildFingerprint(
    entry,
    currentEnvValues(entry.envReferenceNames),
  );
  if (entries.size >= MAX_SNAPSHOT_ENTRIES) {
    entries.delete(entries.keys().next().value as string);
  }
  entries.set(key, entry);
  return entry;
}

/** Uncached fallback entry: the loader reads from disk itself. */
function detachedEntry(
  context: ReadContext,
  selected: PluginConfigSnapshotPaths,
): SnapshotEntry {
  const content = createHash('sha256');
  const entry: SnapshotEntry = {
    context,
    states: new Map(),
    selected,
    envReferenceNames: [],
    contentFingerprint: '',
    fingerprint: `uncached:${context.directory}`,
    readText: (configPath: string) => {
      const text = fs.readFileSync(configPath, 'utf-8');
      content.update(JSON.stringify([configPath, text]));
      entry.contentFingerprint = content.copy().digest('hex');
      return text;
    },
    catalog: null,
    configs: new Map(),
  };
  return entry;
}

function resolveConfigSnapshot(
  entry: SnapshotEntry,
  presetName: string | undefined,
): PluginConfigSnapshot {
  const key = presetName ?? '';
  const existing = entry.configs.get(key);
  if (existing) return existing;

  const warnings: ConfigLoadWarning[] = [];
  const config = loadPluginConfig(entry.context.directory, {
    hostFlavor: entry.context.hostFlavor,
    presetName,
    silent: true,
    readText: entry.readText,
    onWarning: (warning) => warnings.push(warning),
  });
  const snapshot: PluginConfigSnapshot = deepFreeze({
    config,
    warnings,
    paths: entry.selected,
    fingerprint: buildFingerprint(
      entry,
      currentEnvValues(entry.envReferenceNames),
    ),
  });
  if (warnings.some((warning) => warning.kind === 'read-error')) {
    entries.delete(cacheKey(entry.context));
  } else {
    if (entry.configs.size >= MAX_SNAPSHOT_ENTRIES) {
      const oldest = entry.configs.keys().next().value;
      if (oldest !== undefined) entry.configs.delete(oldest);
    }
    entry.configs.set(key, snapshot);
  }
  return snapshot;
}

function resolveCatalog(entry: SnapshotEntry): PresetCatalog {
  if (entry.catalog) return entry.catalog;

  const warnings: ConfigLoadWarning[] = [];
  const userConfig = entry.selected.userConfigPath
    ? loadRawPluginConfigFromPath(entry.selected.userConfigPath, {
        raw: true,
        silent: true,
        readText: entry.readText,
        onWarning: (warning) => warnings.push(warning),
      })
    : null;

  let projectConfig: RawPluginConfig | null = null;
  for (const configPath of entry.selected.projectConfigPaths) {
    const layer = loadRawPluginConfigFromPath(configPath, {
      silent: true,
      readText: entry.readText,
      onWarning: (warning) => warnings.push(warning),
    });
    if (layer) {
      projectConfig = mergePluginConfigs(projectConfig ?? {}, layer);
    }
  }

  const userPresets = presetMapOf(userConfig);
  const projectPresets = presetMapOf(projectConfig);
  const merged = mergePresetMaps(userPresets, projectPresets) ?? {};
  const presets: Record<string, PresetInput> = {};
  for (const name of Object.keys(merged)) {
    const value = ownValue(merged, name);
    if (value !== undefined) defineOwn(presets, name, value);
  }

  const catalog: PresetCatalog = deepFreeze({
    userConfig,
    userPresets,
    projectConfig,
    projectPresets,
    presets,
    warnings,
    fingerprint: buildFingerprint(
      entry,
      currentEnvValues(entry.envReferenceNames),
    ),
  });
  if (warnings.some((warning) => warning.kind === 'read-error')) {
    entries.delete(cacheKey(entry.context));
  } else {
    entry.catalog = catalog;
  }
  return catalog;
}

/**
 * Read the merged, normalized plugin config through the single
 * `loadPluginConfig` seam, cached by input identity. Every miss reloads
 * through the loader, so last-good fallback semantics and warning
 * kinds/paths/presetNames stay exactly those of `loadPluginConfig`. The
 * console stays silent: warnings live in `snapshot.warnings` and replay
 * through `onWarning`.
 */
export function readPluginConfigSnapshot(
  directory: string,
  options?: ReadPluginConfigSnapshotOptions,
): PluginConfigSnapshot {
  const context: ReadContext = {
    directory: path.resolve(directory),
    hostFlavor: options?.hostFlavor,
  };
  if (options?.fresh) entries.delete(cacheKey(context));
  const entry =
    getEntry(context) ??
    detachedEntry(
      context,
      findPluginConfigPaths(context.directory, options?.hostFlavor),
    );
  const snapshot = resolveConfigSnapshot(entry, options?.presetName);
  replayWarnings(snapshot.warnings, options?.onWarning);
  return snapshot;
}

/**
 * Load the shared preset catalog, cached by input identity on the same entry
 * as the config snapshot. The user layer is read raw (no interpolation, no
 * schema validation) so editable preset syntax and prototype-sensitive preset
 * names survive; project layers are validated and interpolated like the
 * runtime merge. `getEditablePreset` keeps its user-first policy and
 * `getPresetSource` its project-first policy over this one catalog.
 */
export function loadPresetCatalog(
  directory: string,
  hostFlavor?: string,
  options?: LoadPresetCatalogOptions,
): PresetCatalog {
  const context: ReadContext = {
    directory: path.resolve(directory),
    hostFlavor,
  };
  const entry =
    getEntry(context) ??
    detachedEntry(
      context,
      findPluginConfigPaths(context.directory, context.hostFlavor),
    );
  const catalog = resolveCatalog(entry);
  replayWarnings(catalog.warnings, options?.onWarning);
  return catalog;
}
