/**
 * Pure resolution of the `package.json` that belongs to a running file.
 *
 * A bundled entry can be split into `dist/chunks/<hash>.js` (or deeper), so a
 * fixed list of `../package.json` candidates cannot be relied on. Walking up
 * from the file itself can: the first manifest on that chain carrying the
 * expected package name is the running copy's own.
 *
 * The walk matches by name and never scans sibling install directories — a
 * leftover install of a newer version sits beside the running one, so any
 * answer that is not the running module's own ancestor would be wrong.
 *
 * Read-only filesystem access; every failure is "not found".
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

/** A located manifest of the expected package. */
export interface PackageManifest {
  /** Absolute path of the resolved `package.json`. */
  path: string;
  /** Its `version` when that is a string, otherwise `undefined`. */
  version: string | undefined;
}

/** Ancestor levels probed, matching the server checker's historical bound. */
const WALK_LIMIT = 10;

/**
 * The nearest `package.json` at or above `startPath` (a file or a directory)
 * whose `name` equals `packageName`, or `null` when there is none within
 * {@link WALK_LIMIT} levels. Manifests that are unreadable, unparseable or
 * belong to another package are stepped over — the chain continues upwards,
 * because the owner of the running file may sit above an intermediate
 * package (a workspace, a bundler's output directory).
 */
export function findOwnedPackageJson(
  startPath: string,
  packageName: string,
): PackageManifest | null {
  let directory: string;
  try {
    directory = fs.statSync(startPath).isDirectory()
      ? startPath
      : path.dirname(startPath);
  } catch {
    directory = path.dirname(startPath);
  }

  for (let depth = 0; depth < WALK_LIMIT; depth += 1) {
    const manifestPath = path.join(directory, 'package.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as {
          name?: unknown;
          version?: unknown;
        };
        if (manifest.name === packageName) {
          return {
            path: manifestPath,
            version:
              typeof manifest.version === 'string'
                ? manifest.version
                : undefined,
          };
        }
      } catch {
        // Unreadable or malformed manifest: step over it and keep walking.
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) return null;
    directory = parent;
  }

  return null;
}
