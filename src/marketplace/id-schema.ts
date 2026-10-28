import { z } from 'zod';

const packageIdPattern =
  /^[a-z0-9][a-z0-9._-]{0,63}\/[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Canonical marketplace package ID schema, split out of the full manifest
 * schemas so eager consumers (plugin config schema, ID normalization) do
 * not pull the manifest schema graph. The manifest schemas re-export it,
 * so the published contract is unchanged.
 */
export const MarketplacePackageIdSchema = z
  .string()
  .trim()
  .regex(
    packageIdPattern,
    'Expected a canonical package ID such as author/name',
  );
