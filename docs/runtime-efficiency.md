# Runtime efficiency

Slim keeps the same feature roster and enabled defaults while avoiding repeated
work. Feature switches remain independent: disabling the sidebar does not
remove pane management, and disabling managed jobs does not remove native
subagents, council or observer.

## Configuration reads

Setup, TUI gates and preset catalogs share a bounded read Module under
`src/config/`. One source snapshot carries resolved configuration, warnings,
source paths and its input fingerprint. The fingerprint includes candidate
paths (including absent files), device/inode/mtime/ctime/size, the host's project
scope and referenced environment values. Creating a preferred `.jsonc`, editing
in place, replacing a file or changing `{env:NAME}` therefore invalidates the
read when their file identity changes. Existing watcher and explicit
configuration notifications force a fresh read, covering writes within the
filesystem's timestamp granularity. No TTL or extra watcher is used.

Raw editable user presets and validated/interpolated runtime layers retain their
different policies. Mutable callers receive isolated values. Read failures do
not become a successful cached empty configuration; strict profile refreshes
still retain the last good generation on invalid input.

The sidebar keeps its 1s render poll. With `sidebar: false`, the 5s config poll
still detects external multiplexer edits, but unchanged files are not parsed
again. Companion request detection retains its 250ms interval; configuration
catalog refresh remains a separate once-per-second duty.

## Pass-local facts

Agent registration reuses merged overrides, model arrays and MCP inputs within
each pass. A larger custom-agent roster no longer repeats those whole-table
derivations once per agent. Health accounting is taken from completed
registrations.

On v2, a prompt admission reuses the validated session identity and preset
binding for profile capture. The next admission still checks host identity and
storage: this is not a persistent session cache. Stored history is read for
agent attribution only when a user message lacks attribution.

Message transforms use a request-local view of valid/user messages. Parts are
read live; the view is rebuilt after structural edits. Phase and council anchors,
Interview kickoff handling and the trailing goal pointer retain their existing
ordering and rendered bytes.

## Optional implementation loading

Interview, Marketplace and Companion implementations load through their existing
activation paths instead of being eagerly initialized by unrelated imports.
Each host has one Interview owner. Shared schema and policy primitives remain
available to normal agent registration.

The package includes ESM chunks alongside the unchanged public entry paths:
`dist/index.js`, `dist/server/index.js`, `dist/tui.js` and `dist/tui2.js`. Release
verification checks that every relative static and dynamic import target is
inside the packed artifact. Use the whole package, not a copied entry file.

## State and event handling

Board lookup and boolean predicates do not sort; ordered history still does.
TUI projection uses one board view, and snapshot reads/writes share one bounded
file-identity cache. Native event batches coalesce derived projection work while
retaining synchronous final commits and per-owner disposal. Cross-process locks,
atomic publication and failure/retry semantics remain in place.

The v2 event subscription freezes the union required by enabled consumers at
setup. Native lifecycle, usage, forms and permissions remain observed. Interview
text streams are subscribed only when Interview is enabled. Raw-first event
synthesis and terminal-generation fences are unchanged.

The server updater and TUI notice share raw npm facts through native RPC when it
is available. Their decisions remain independent: installation retains channel
and major-version rules, while the notice compares against the running copy.
No persisted update-state file or new update lock is introduced.

## Verification

Focused tests count reads/derivations and exercise file replacement, malformed
configuration, admission identity checks, event selection and state publication.
Prompt snapshots and prefix-stability properties guard model-facing bytes.
Build and packed-artifact checks cover lazy imports.

Operation counts and emitted byte sizes are not CPU, RSS or end-user latency
benchmarks; they should not be reported as measured wall-clock speedups.
