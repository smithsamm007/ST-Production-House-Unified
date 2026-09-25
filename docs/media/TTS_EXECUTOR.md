# Real TTS Execution Worker (Issue #177)

The voice boundary of the media chain. S-M32-01 (ttsAdapter.js) defines the
free-first tier chain, persistent voice profiles, and truthful outcomes;
S-M30-01 anchors artifact identity to content hashes; the S-M30 runner
(Issue #170) performs real inspections. Until now NO component executed
text-to-speech. This module is the worker:

```
voice profile (tts_voice_profile_v1) + script
  └── executeTtsGeneration()
        ├── verifyVoiceProfile()            — tamper gate (S-M32-01)
        ├── selectTtsProvider()             — contract tier chain, quota-aware
        ├── buildEdgeTtsArgs/buildPiperArgs — ARRAY ARGS ONLY (Rule 2)
        ├── runTtsProvider()                — injectable spawn, no shell
        ├── inspectMediaFile()              — real bytes → hash + ffprobe (#170)
        ├── verifyArtifactDescriptor()      — S-M30-01 promotion
        └── recordTtsGenerationOutcome()    — S-M32-01 truthful outcome
```

## Free-first routing (Rule 35)

`TTS_PROVIDER_CHAIN` binds the frozen S-M32-01 tier order to the governed
provider catalog:

| Tier | Provider | Role | authType |
|---|---|---|---|
| 1 | `edge-tts` | approved_free_primary | none |
| 4 | `piper` | local_open_source_emergency | none |

- **ElevenLabs is deliberately absent**: it remains an owner-configured
  catalog entry for live use; the automatic production chain never routes to
  a paid provider. No subscription, billing, or account rotation exists here.
- Selection is capability-aware: a provider is chosen only if its DECLARED
  capabilities (`declareTtsProviderCapabilities`) include the requested
  language AND voice. Capabilities are metadata for routing — never evidence
  that generation happened.
- Selection is quota-aware: a registry slot marked `quotaExhausted` is
  skipped. When no provider remains, the result is the durable
  **WAITING_FOR_QUOTA** state (with `CREDENTIAL_MISSING` surfaced when the
  blocker is owner credential onboarding rather than provider quota) — never
  a disguised failure or a fabricated success.

## Credential-reference flow (Rule 17)

A provider whose catalog `authType` is not `"none"` requires a broker-issued
opaque locator (`loc_v1_…`, validated via `isValidLocator`) in its registry
slot. The executor never sees, logs, or serializes raw key material; the
production transport resolves locator → credential outside this boundary.

## Array-args safety (CONVENTIONS Rule 2)

- `buildEdgeTtsArgs` → `--voice <id> --text <text> --write-media <path>`
- `buildPiperArgs` → `--model <path> --output_file <path>`; narration text
  travels via spawn `stdin`, never argv.
- Output path and narration text are validated BEFORE any argv is derived:
  bounded, no NUL, no leading dash (option injection), no `..` traversal;
  text is scanned against secret-shaped content and internal agent names
  (R15/R17). Nothing is ever interpolated into a shell string.

## Honesty matrix (nothing is ever fabricated)

| Condition | Result |
|---|---|
| Tampered/malformed voice profile | `TTS_PROFILE_TAMPERED` / `TTS_PROFILE_INVALID` — no provider call is made |
| Unusable narration (empty, oversize, secret-shaped, internal name) | `TTS_SCRIPT_INVALID` |
| Hostile output path | `TTS_OUTPUT_PATH_UNSAFE` |
| Provider absent from registry / no declaration | skipped `PROVIDER_UNAVAILABLE` |
| Registry slot quota-exhausted | skipped `QUOTA_EXHAUSTED` → falls through |
| Declared languages/voices do not cover the request | skipped `LANGUAGE_UNSUPPORTED` / `VOICE_UNSUPPORTED` |
| Non-"none" authType without a valid locator | skipped `CREDENTIAL_MISSING` |
| No provider remains | `quotaState = WAITING_FOR_QUOTA` — the truthful waiting state |
| Binary absent / spawn throws | `PROVIDER_UNAVAILABLE` |
| Timeout | `TTS_TIMEOUT` |
| Non-zero exit | `PROVIDER_CALL_FAILED` (+ exitCode + bounded stderrTail) |
| Output unreadable / probe fails | `INSPECTION_FAILED`; outcome recorded against an UNVERIFIED descriptor |

A success result requires ALL of: a real provider invocation from the
contract chain, a real inspection of the written audio (hash computed from
the actual bytes, ffprobe payload present), and the S-M30-01 promotion. The
S-M32-01 outcome then honestly reports `mediaStatus: "verified"` and
`generationMode: "provider_generated"`; its integrity is anchored by
`computeTtsOutcomeId`. A provider exit 0 alone is never success.

## Injected transports (offline testability)

`spawnImpl` (`{ command, args, timeoutMs, stdin }` → `{ exitCode, stdout,
stderr, timedOut }`), `readFileImpl`, and the clock are injectable, so the
suite proves routing, quota/credential honesty, every failure code, and the
verified-success path offline — no edge-tts/piper/ffprobe binaries, no
network. Production binds `node:child_process.spawn` (array args,
`shell: false`, stdin write, timeout kill) and `node:fs/promises`.

## Real-world integration gate (Issue #177, honest-by-default)

With owner credentials or network access absent, the live gate stays
explicitly **unverified**: `executeTtsGeneration` in an unconfigured
environment truthfully reports `PROVIDER_UNAVAILABLE` (binaries absent) —
the same code path a real outage produces. A controlled live test requires
the owner to provide `edge-tts`/`ffprobe` binaries and record provider,
capability, timestamp, result, sanitized response, and artifact hash as
evidence.

## Deliberate non-goals (this slice)

- No worker/queue wiring: the audio-dispatch worker slice invokes
  `executeTtsGeneration` and records the returned evidence through the
  existing ledger append path.
- No streaming/partial synthesis; one narration in, one audio file out.
- No SSML; pronunciation profiles ride the S-M32-01 voice profile contract.
