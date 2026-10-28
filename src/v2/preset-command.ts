/**
 * Server-side `/preset` for non-TUI clients (issues #1474, #1700).
 *
 * Apply-only: create/edit/delete stay in the TUI preset manager. `/preset
 * <name>` binds the invoking session's inference snapshot (see
 * `./session-preset-apply`), matching the TUI fast path; the global default is
 * changed in configuration, not from this command.
 *
 * A preset switch is a config mutation, not a turn. v2 has no display-only
 * message channel — a synthetic inbox item is delivered into the model context
 * on the next turn — so the result travels through the command error channel
 * the client already renders. Nothing runs and nothing enters the context.
 */
import {
  bindSessionPreset,
  readAvailablePresets,
} from './session-preset-apply';
import type { SessionPresetState } from './session-presets';
import type { V2CommandDefinition } from './types';

export const PRESET_COMMAND_NAME = 'preset';
export const PRESET_COMMAND_DESCRIPTION =
  'List presets, or apply one to this session';

export interface PresetCommandOptions {
  directory: string;
  /** Binds a preset to the invoking session (server-side store, no RPC). */
  applyToSession: (
    sessionID: string,
    presetName: string,
  ) => Promise<SessionPresetState>;
  /** Reads the invoking session's binding, so the list reports what actually
   * applies to it instead of only the global default. */
  readSessionPreset: (sessionID: string) => Promise<SessionPresetState>;
}

/** No argument: visible presets, the session's own team, and the global default. */
export async function presetListFeedback(
  options: Pick<PresetCommandOptions, 'directory' | 'readSessionPreset'> & {
    sessionID: string;
    hostFlavor?: string;
  },
): Promise<string> {
  const {
    directory,
    sessionID,
    readSessionPreset,
    hostFlavor = 'v2',
  } = options;
  const { names, active } = readAvailablePresets(directory, hostFlavor);
  if (names.length === 0) {
    return 'No presets configured. Define presets in oh-my-opencode-slim.jsonc.';
  }

  const parts = [`Available presets: ${names.join(', ')}.`];
  try {
    const { presetName } = await readSessionPreset(sessionID);
    parts.push(
      presetName
        ? `Session team: ${presetName}.`
        : 'Session team: not bound yet.',
    );
  } catch {
    // Unreadable binding: report the default only, never guess the team.
  }
  if (active) parts.push(`Global default: ${active}.`);
  parts.push('Run /preset <name> to apply one to this session.');
  return parts.join(' ');
}

/** A named preset: bind it to the invoking session. Never throws. */
export async function presetApplyFeedback(
  options: Pick<PresetCommandOptions, 'directory' | 'applyToSession'> & {
    sessionID: string;
    presetName: string;
    hostFlavor?: string;
  },
): Promise<string> {
  const { directory, sessionID, presetName, applyToSession, hostFlavor } =
    options;
  const outcome = await bindSessionPreset({
    directory,
    presetName,
    hostFlavor: hostFlavor ?? 'v2',
    bind: (name) => applyToSession(sessionID, name),
  });
  return outcome.message;
}

/**
 * The v2 command definition. `execute` deliberately rejects with its feedback:
 * it is the only surface a non-TUI client renders without creating a message
 * or waking a turn.
 */
export function createPresetCommand(
  options: PresetCommandOptions,
): V2CommandDefinition {
  return {
    name: PRESET_COMMAND_NAME,
    description: PRESET_COMMAND_DESCRIPTION,
    execute: async (input) => {
      const presetName = (input?.prompt?.text ?? '').trim();
      throw new Error(
        presetName
          ? await presetApplyFeedback({
              directory: options.directory,
              applyToSession: options.applyToSession,
              sessionID: input.sessionID,
              presetName,
            })
          : await presetListFeedback({
              directory: options.directory,
              readSessionPreset: options.readSessionPreset,
              sessionID: input.sessionID,
            }),
      );
    },
  };
}
