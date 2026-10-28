/**
 * Numeric `major.minor.patch` comparison shared by the server update checker
 * (`src/hooks/auto-update-checker/checker.ts`) and the TUI update notice
 * (`src/v2/update-notice.ts`).
 *
 * Both callers keep their own parsing policies — the server strips range
 * prefixes and orders prereleases, the TUI ignores prereleases entirely — so
 * this module deliberately offers only the tuple comparison, not parsing.
 * It stays dependency-free and adds nothing to any prompt surface.
 */

/** The numeric part of a version: `major`, `minor`, `patch`. */
export type NumericVersion = readonly [number, number, number];

/**
 * -1 / 0 / 1 for the numeric parts of two versions, compared left to right.
 * Only the sign is ever meaningful to the callers (sort comparator, update
 * decision), so the result is normalized rather than a raw difference.
 */
export function compareNumericVersions(
  left: NumericVersion,
  right: NumericVersion,
): number {
  for (let index = 0; index < 3; index += 1) {
    const a = left[index];
    const b = right[index];
    if (a !== b) return a < b ? -1 : 1;
  }
  return 0;
}
