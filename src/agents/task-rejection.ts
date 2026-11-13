export const TASK_REJECTION_INSTRUCTION =
  'If a task is outside your role, do not attempt partial work. Return a brief reason to the orchestrator.';

export function appendTaskRejectionInstruction(prompt: string): string {
  return `${prompt}\n\n${TASK_REJECTION_INSTRUCTION}`;
}

export const OBSERVER_DISPATCH_INSTRUCTION =
  'When you cannot view an image or visual file directly, dispatch @observer with the file path and a precise goal, then work from its reported observations.';

/** Roles whose prompts may gain OBSERVER_DISPATCH_INSTRUCTION. */
export const OBSERVER_DISPATCH_ROLES = new Set<string>([
  'explorer',
  'oracle',
  'designer',
]);

/**
 * Decide per role whether the observer dispatch instruction belongs in its
 * prompt. A role keeps it when its resolved model can't read images (or its
 * capability is unknown — fail-open): a vision-capable advisor must not be
 * primed into delegating images it can read itself, while a text-only advisor
 * has no other path to visual input. Default (no capability input) keeps the
 * instruction for every role, preserving pre-existing behavior.
 */
export function observerDispatchRolesFor(
  acceptsImagesFor: (role: string) => boolean | undefined,
): Set<string> {
  const roles = new Set<string>();
  for (const role of OBSERVER_DISPATCH_ROLES) {
    if (acceptsImagesFor(role) === true) continue;
    roles.add(role);
  }
  return roles;
}

export function appendObserverDispatchInstruction(
  prompt: string,
  enabled: boolean,
): string {
  return enabled ? `${prompt}\n\n${OBSERVER_DISPATCH_INSTRUCTION}` : prompt;
}
