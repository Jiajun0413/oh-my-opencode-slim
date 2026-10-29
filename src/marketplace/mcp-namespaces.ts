export function ambiguousMcpNamespaces(
  required: readonly string[],
  available: ReadonlySet<string>,
): string[] {
  const namespace = (name: string) => name.replace(/[^a-zA-Z0-9_-]/g, '_');
  const conflicts = new Set<string>();
  const names = [...available].sort();
  for (const name of required) {
    const own = namespace(name);
    for (const other of names) {
      const otherNamespace = namespace(other);
      if (
        name !== other &&
        (own === otherNamespace ||
          own.startsWith(`${otherNamespace}_`) ||
          otherNamespace.startsWith(`${own}_`))
      ) {
        conflicts.add([name, other].sort().join(' and '));
      }
    }
  }
  return [...conflicts].sort();
}
