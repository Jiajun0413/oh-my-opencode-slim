/** v2↔v1 delegation tool normalization. The v2 host's built-in `subagent`
 * tool corresponds to v1's `task`: the v2 setup tool-execute bridge
 * translates names/args so the whole v1 pipeline (task-session-manager,
 * job board, task_* tools) is reused with zero changes. */

import { delegationVocabulary } from './adapters';

export const DELEGATION_TOOL_V2 = 'subagent';
export const DELEGATION_TOOL_V1 = 'task';

/** v2 `subagent` tool name → the `task` name the v1 pipeline expects;
 * every other name is returned unchanged. */
export function toolNameToV1(tool: string): string {
  return tool.toLowerCase() === DELEGATION_TOOL_V2 ? DELEGATION_TOOL_V1 : tool;
}

/** Shallow-copy record view with an `{}` fallback for non-objects.
 * Deliberately NOT `isRecord` from `utils/guards` (a pure type guard):
 * both subagentArgsToV1 copies rely on the copy + fallback semantics. */
function asRecord(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object'
    ? { ...(input as Record<string, unknown>) }
    : {};
}

/** v2 subagent args → v1 task args view (shallow copy):
 * agent→subagent_type, sessionID→task_id, rest unchanged.
 *
 * Accepts a legacy `task_id` as the resume id too (a v2 model may still
 * emit the v1 parameter name): canonical `sessionID` wins when both are
 * present, otherwise `task_id` is surfaced as-is. */
export function subagentArgsToV1(input: unknown): Record<string, unknown> {
  const args = asRecord(input);
  const resume = args.sessionID !== undefined ? args.sessionID : args.task_id;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'agent') out.subagent_type = value;
    else if (key !== 'sessionID' && key !== 'task_id') out[key] = value;
  }
  if (resume !== undefined) out.task_id = resume;
  return out;
}

/** v1 task args → v2 subagent args (shallow copy, reverse mapping).
 * A hook deleting task_id → result has no sessionID; a hook writing
 * task_id → sessionID stays in sync. `task_id` is never emitted: the
 * host only understands the canonical `sessionID`. */
export function v1ArgsToSubagent(
  args: Record<string, unknown>,
): Record<string, unknown> {
  const resume = args.task_id !== undefined ? args.task_id : args.sessionID;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    if (key === 'subagent_type') out.agent = value;
    else if (key !== 'task_id' && key !== 'sessionID') out[key] = value;
  }
  if (resume !== undefined) out.sessionID = resume;
  return out;
}

/** Host-aware delegation wording for model-visible guidance. Returns the
 * native delegation tool plus its agent-selector and existing-session
 * parameters, derived from `delegationVocabulary` so the v1/v2 mapping has a
 * single source: v2 → `subagent` / `agent` / `sessionID`; v1 and any unknown
 * flavor → `task` / `subagent_type` / `task_id`. The control tools (`task_*`)
 * share the same identifier param (`controlParamName`). */
export interface DelegationWording {
  tool: string;
  agentParam: string;
  resumeParam: string;
}

export function delegationWording(
  hostFlavor: string | undefined,
): DelegationWording {
  const { tool, agentParam, resumeParam } = delegationVocabulary(hostFlavor);
  return { tool, agentParam, resumeParam };
}

/** Rewritten native `subagent` description for the background-default flip
 * (v2 only): the native prose anchors the omitted-parameter default to the
 * foreground ("Foreground (default)…", "Use background only for…") and
 * fights the wake-based orchestration loop this plugin ships. The flipped
 * text states the mechanism the execute.before bridge enforces (omitted
 * `background` launches asynchronously), teaches `background: false` as the
 * dependent-work escape hatch, and is one line shorter than the native
 * text so the swap never grows the tool surface. */
export const SUBAGENT_BACKGROUND_DEFAULT_DESCRIPTION = [
  'Spawns an agent in a child session to work on the specified task.',
  'The output includes a sessionID you can pass back later to continue that specific conversation with the subagent.',
  "New child sessions start with fresh context, so include all relevant context and instructions when you don't pass a sessionID.",
  'Background (default) launches it asynchronously and returns immediately; you are notified when it finishes.',
  'Foreground (background: false) runs the subagent to completion and returns its final response — use it only when the result is the direct input to your next step.',
].join('\n');

/** Pairing state for the background-default flip: the mechanism half (the
 * args rewrite in tool-execute-hooks) only runs once the wording half (the
 * description rewrite in v2 setup) has verifiably landed. Both halves state
 * one contract — if the description rewrite fails or never runs (setup
 * failure, missing native tool), the rewrite stays inert and the native
 * foreground default keeps operating end-to-end. Process-global: setup runs
 * once per host process and disarms on teardown. */
let backgroundDefaultFlipArmed = false;

/** Arm the mechanism half — call only after the description rewrite was
 * verified in place (setup probes the flipped description via draft.get). */
export function armBackgroundDefaultFlip(): void {
  backgroundDefaultFlipArmed = true;
}

/** Disarm on setup teardown so a disposed-and-rebuilt host never keeps a
 * stale armed mechanism without its wording half. */
export function disarmBackgroundDefaultFlip(): void {
  backgroundDefaultFlipArmed = false;
}

/** Whether the flip's mechanism half may rewrite omitted `background`. */
export function isBackgroundDefaultFlipArmed(): boolean {
  return backgroundDefaultFlipArmed;
}
