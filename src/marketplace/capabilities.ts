/**
 * Tool names a marketplace package may declare, split out of the full
 * manifest schemas so the agent registry can project package capabilities
 * without pulling the manifest schema graph. The manifest schemas
 * re-export it, so the published contract is unchanged.
 */
export const MARKETPLACE_TOOL_NAMES = [
  'read',
  'glob',
  'grep',
  'ast_grep_search',
  'edit',
  'write',
  'apply_patch',
  'ast_grep_replace',
  'bash',
  'webfetch',
  'websearch',
] as const;
