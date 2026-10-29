import { parse as parseJsonc } from 'jsonc-parser';

/** JSON object shape shared by config file readers and writers. */
export type JsonConfig = Record<string, unknown>;

/**
 * Strip JSON comments (single-line // and multi-line) and trailing commas for JSONC support.
 */
export function stripJsonComments(json: string): string {
  const commentPattern = /\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g;
  const trailingCommaPattern = /\\"|"(?:\\"|[^"])*"|(,)(\s*[}\]])/g;

  return json
    .replace(commentPattern, (match, commentGroup) =>
      commentGroup ? '' : match,
    )
    .replace(trailingCommaPattern, (match, comma, closing) =>
      comma ? closing : match,
    );
}

/** Parse config text into a JSON object, rejecting arrays and primitives. */
export function parseJsonConfigText(source: string): JsonConfig {
  const errors: Parameters<typeof parseJsonc>[1] = [];
  const parsed: unknown = parseJsonc(source.replace(/^\uFEFF/, ''), errors, {
    allowTrailingComma: true,
  });
  if (errors.length > 0) throw new Error('Invalid JSONC config');
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Config file must contain a JSON object');
  }
  return parsed as JsonConfig;
}
