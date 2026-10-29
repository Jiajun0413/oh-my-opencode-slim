/**
 * Per-admission reuse view over a session-preset binding.
 *
 * The native `session.prompt` hook obtains `{record, identity}` from ONE
 * `ensureAdmission` transaction (one `session.get` + one KV lookup) and
 * derives the per-session profile table here instead of re-running a
 * second `ensure` inside the profile bridge's `profilesForSession`. The
 * derivation is byte-equivalent to the previous second-ensure path, so
 * the captured table is exactly what that path would have produced.
 *
 * This is admission-local reuse of a value already read — never a
 * persistent state cache: the next admission revalidates directory,
 * parent, and the KV binding through a fresh transaction.
 */
import type { V2AgentRuntimeProfiles } from './runtime-profiles';
import type { SessionPresetRecord } from './session-presets';

/**
 * Per-session profile table for an admission: the bound record's
 * execution (child) or team (root) bundle profiles, with each agent's
 * `managedProviderOptionKeys` widened by the startup-registered and
 * current provider-option keys so clearing a preset field cannot leak
 * the startup registry value into a new child. An unbound record
 * (historical child) falls back to the current global table, matching
 * the previous `profilesForSession` behavior for `ensure === undefined`.
 */
export function sessionAdmissionProfiles(
  record: SessionPresetRecord | undefined,
  current: V2AgentRuntimeProfiles,
  registered: V2AgentRuntimeProfiles,
): V2AgentRuntimeProfiles {
  if (!record) return current;
  const profiles = (record.execution ?? record.bundle).profiles;
  return Object.fromEntries(
    Object.entries(profiles).map(([agent, profile]) => [
      agent,
      {
        ...profile,
        managedProviderOptionKeys: [
          ...new Set([
            ...(profile.managedProviderOptionKeys ?? []),
            ...Object.keys(registered[agent]?.providerOptions ?? {}),
            ...Object.keys(profile.providerOptions ?? {}),
          ]),
        ],
      },
    ]),
  );
}
