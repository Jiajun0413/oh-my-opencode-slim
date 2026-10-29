import type { ApplyPatchErrorCode, ApplyPatchErrorKind } from './types';

// Model-facing wording names the operation, not a tool, so it is accurate
// for both served names (v1 `apply_patch`, v2 native `patch`) and matches
// the v2 patch tool's own failure wording ("patch verification failed").
const APPLY_PATCH_ERROR_PREFIX: Record<ApplyPatchErrorKind, string> = {
  blocked: 'patch blocked',
  validation: 'patch validation failed',
  verification: 'patch verification failed',
  internal: 'patch internal error',
};

const APPLY_PATCH_ERROR_CODE: Record<ApplyPatchErrorKind, ApplyPatchErrorCode> =
  {
    blocked: 'outside_workspace',
    validation: 'malformed_patch',
    verification: 'verification_failed',
    internal: 'internal_unexpected',
  };

export class ApplyPatchError extends Error {
  readonly code: ApplyPatchErrorCode;

  constructor(
    readonly kind: ApplyPatchErrorKind,
    message: string,
    cause?: unknown,
  ) {
    super(`${APPLY_PATCH_ERROR_PREFIX[kind]}: ${message}`, { cause });
    this.name = 'ApplyPatchError';
    this.code = APPLY_PATCH_ERROR_CODE[kind];
  }
}

export function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function ensureApplyPatchError(
  error: unknown,
  context: string,
): ApplyPatchError {
  if (error instanceof ApplyPatchError) {
    return error;
  }

  return new ApplyPatchError(
    'internal',
    `${context}: ${getErrorMessage(error)}`,
    error,
  );
}
