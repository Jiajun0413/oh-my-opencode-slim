import {
  type SpecialistRole,
  SUPPORTED_SPECIALIST_ROLES,
} from '../config/agent-roles';
import type { AgentDefinition } from './orchestrator';
import {
  DESIGNER_PROMPT,
  EXPLORER_PROMPT,
  FIXER_PROMPT,
  LIBRARIAN_PROMPT,
  OBSERVER_PROMPT,
  ORACLE_PROMPT,
} from './role-prompts';
import { ROLE_ROUTING_BLOCKS } from './role-routing';

export interface SpecialistRoleDefinition {
  readonly id: SpecialistRole;
  readonly prompt: string;
  readonly description: string;
}

export const SPECIALIST_ROLES = SUPPORTED_SPECIALIST_ROLES;
export type { SpecialistRole };

export const ROLE_DEFINITIONS: Readonly<
  Record<SpecialistRole, SpecialistRoleDefinition>
> = Object.freeze({
  explorer: Object.freeze({
    id: 'explorer',
    prompt: EXPLORER_PROMPT,
    // Routing criteria live in the routing data / slim <Agents> lines; the
    // description (native dynamic subagent list) stays a single
    // non-duplicating identifier.
    description: 'Fast codebase search and pattern matching.',
  }),
  librarian: Object.freeze({
    id: 'librarian',
    prompt: LIBRARIAN_PROMPT,
    description: 'External documentation and library research.',
  }),
  oracle: Object.freeze({
    id: 'oracle',
    prompt: ORACLE_PROMPT,
    description: 'Strategic technical advisor.',
  }),
  designer: Object.freeze({
    id: 'designer',
    prompt: DESIGNER_PROMPT,
    description: 'UI/UX design, review, and implementation.',
  }),
  fixer: Object.freeze({
    id: 'fixer',
    prompt: FIXER_PROMPT,
    description: 'Fast implementation specialist.',
  }),
  observer: Object.freeze({
    id: 'observer',
    prompt: OBSERVER_PROMPT,
    description: 'Visual analysis specialist; requires a vision-capable model.',
  }),
});

/**
 * Write-capability verdict for a specialist role (C2 wake grading),
 * derived from the role's permission row in the routing data
 * (`- Permissions: ...`). A role that grants `write_files` is a writer
 * lane; a role with an explicit non-write permission row is not. An
 * unknown agent, a missing permission row, or an undeterminable agent
 * name fails safe to writer — the graded verification instruction is
 * attached rather than omitted (an extra sentence costs less than a
 * missing instruction). No agent names are hardcoded.
 */
export function roleHasWriteCapability(agent: string | undefined): boolean {
  if (!agent) return true;
  const routingBlock = ROLE_ROUTING_BLOCKS[agent];
  if (!routingBlock) return true;
  const permissions = /^- Permissions: (.+)$/m.exec(routingBlock);
  if (!permissions) return true;
  return permissions[1].includes('write_files');
}

export function createRoleAgent(
  role: SpecialistRoleDefinition,
  model: string,
  customPrompt?: string,
  customAppendPrompt?: string,
): AgentDefinition {
  const prompt = customPrompt
    ? customPrompt
    : customAppendPrompt
      ? `${role.prompt}\n\n${customAppendPrompt}`
      : role.prompt;

  return {
    name: role.id,
    description: role.description,
    config: { model, prompt },
  };
}
