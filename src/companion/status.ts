/**
 * Pure normalization of OpenCode session lifecycle events into the Companion's
 * busy/idle vocabulary.
 *
 * Extracted from `manager.ts` so the root wiring (`src/index.ts`) can import it
 * statically without pulling in the state-file/child-process machinery of the
 * full manager. Keep this module dependency-free.
 */

export function normalizeCompanionSessionStatus(
  eventType: string,
  status?: string,
): 'busy' | 'idle' | undefined {
  if (eventType === 'session.idle' || eventType === 'session.error') {
    return 'idle';
  }
  if (eventType !== 'session.status') return undefined;
  if (status === 'busy' || status === 'retry') return 'busy';
  if (
    status === 'idle' ||
    status === 'completed' ||
    status === 'stopped' ||
    status === 'error' ||
    status === 'failed'
  ) {
    return 'idle';
  }
  return undefined;
}
