# Media Inspection Runner (Issue #170)

The executor boundary for real media verification. S-M30-01 (artifact
descriptor) defined WHEN a descriptor may be promoted to VERIFIED — a real
inspection result matching the artifact's content hash — but nothing
performed the inspection itself. This module is the runner a real assembly
worker calls:

```
descriptor (UNVERIFIED)
  └── inspectAndVerifyArtifact()
        ├── hashArtifactFile()      — SHA-256 over the REAL file bytes
        ├── runFfprobe()            — ffprobe via ARRAY ARGS, no shell
        └── verifyArtifactDescriptor() — existing S-M30-01 promotion
```

## Real tamper detection

The hash is computed from the ACTUAL on-disk content at inspection time. If
a file is substituted after generation, the computed hash no longer matches
the descriptor's `contentSha256`, and `verifyArtifactDescriptor` fails closed
with `INSPECTION_HASH_MISMATCH`. FFprobe "succeeding" on a substituted file
does not promote anything — the hash check binds inspection to real content.

## Honesty matrix

| Condition | Result |
|---|---|
| File missing/unreadable | `INSPECTION_SOURCE_UNREADABLE` — nothing verified |
| ffprobe binary absent | `FFPROBE_SPAWN_FAILED` — truthful environment state; descriptor stays UNVERIFIED (`ffprobe_verified:false`) |
| Timeout | `FFPROBE_TIMEOUT` |
| Non-zero exit | `FFPROBE_EXIT_NONZERO` |
| Unparseable stdout | `FFPROBE_OUTPUT_UNPARSEABLE` |
| Empty format+streams | `FFPROBE_PAYLOAD_EMPTY` |
| Substituted file (hash mismatch) | `INSPECTION_HASH_MISMATCH` via S-M30-01 |
| Matching hash + valid payload | descriptor → **VERIFIED** |

Nothing is ever fabricated. The absence of ffprobe is a truthful
environmental fact, not a fake success.

## Safety (CONVENTIONS Rules 1–2, §16/§17 of the production plan)

- **Array arguments only** — `buildFfprobeArgs` returns a frozen array
  (`-v error -print_format json -show_format -show_streams <path>`); no
  shell string is ever constructed.
- **Path validation** before any execution input is derived: non-empty,
  ≤4096 chars, no NUL, no leading dash (option-injection), no `..`
  traversal segments (`PATH_UNSAFE`).
- Paths are passed as the final argv entry — never interpolated into a
  command line.

## Injected transports (offline testability)

`readFileImpl` (file bytes) and `spawnImpl` (`{ args, timeoutMs }` →
`{ exitCode, stdout, stderr, timedOut }`) are injectable, so the test suite
proves the full contract offline — including the tamper-detection path —
without an ffprobe binary or real media. Production binds `node:fs/promises`
and a `node:child_process.spawn` wrapper (array args, `shell: false`,
bounded stdout, timeout kill).

## Deliberate non-goals (this slice)

- No wiring into an assembly worker: real media must exist first (TTS/visual
  generation are separate owner-gated/provider-gated work). This module is
  the callable boundary those workers will use.
- No duration/codec policy enforcement (e.g. the 1800–3000 s main-video
  window): the runner returns the real ffprobe payload; policy checks belong
  to the QC layer that consumes it.
- No evidence-ledger writes: the caller records the returned inspection
  record through the existing ledger append path.
