# JARVIS Subtitle Timing and Segmentation Contract

`src/jarvis/deterministicSubtitlePlan.js` provides deterministic, offline planning of subtitle cues (SRT and VTT formats) for Hindi and Hinglish narration segments.

## 1. Scope and Isolation

- **Owner Scope:** Must match valid `ownerId` (`/^[a-zA-Z0-9_-]{3,80}$/`).
- **Agent Scope:** Bound to `agent-01` (JARVIS). Mismatches fail closed with `SUBTITLE_SCOPE_MISMATCH`.
- **Preloaded Internal Names:** Public fields (such as text or speaker) containing preloaded internal agent names (e.g., `JARVIS`, `SHERLOCK`, `LAKME`) are strictly rejected with `SUBTITLE_INTERNAL_AGENT_NAME_REJECTED`.
- **Secrets:** Text containing secret patterns (`vault://`, `opaque://`, `api_key=`, `bearer`, etc.) is rejected with `SUBTITLE_SECRET_REJECTED`.

## 2. Timing and Boundary Constraints

- **Segment Timings:** Must be finite numbers with `startTime >= 0`, `endTime > startTime`, and `endTime <= 1800` (30 minutes max).
- **Overlaps:** Overlapping narration segments (where `seg[i].startTime < seg[i-1].endTime`) are strictly rejected with `SUBTITLE_TIMING_OVERLAP_DETECTED`.
- **Cue Length and Duration:**
  - Maximum characters per cue line: 42 characters.
  - Maximum cue duration: 7.0 seconds.
- **Word Boundaries:** Oversized text is split strictly at safe whitespace/word boundaries, preserving full words and Devanagari Hindi Unicode / Hinglish characters without transliteration or mutation.

## 3. Formats and Aspect Ratio Profiles

- **Long-form Profile (16:9):**
  - Dimensions: 1920x1080.
  - Generates full sequential cue sequence with SRT and VTT timestamps (`HH:MM:SS,mmm` and `HH:MM:SS.mmm`).
- **Shorts Profiles (9:16):**
  - Dimensions: 1080x1920.
  - Exactly three Shorts profiles:
    1. `opening_hook` (Hook beat, ~30s target).
    2. `high_tension_moment` (Escalation beat, ~45s target).
    3. `cliffhanger_teaser` (Cliffhanger beat, ~30s target).
  - `endingRevealAllowed` is strictly set to `false` for all Shorts.
  - Cliffhanger Shorts carries `endingDisclosure: "ending_not_revealed"`.

## 4. Truthfulness and Rendering Exclusions

This module performs deterministic local subtitle cue planning only.
It **does not**:
- Synthesize speech or audio.
- Render or burn-in subtitle images/video files.
- Call external AI providers or remote services.
- Issue fake receipts or placeholder URLs.
- Request or perform media publication or deployment.

The output package contains:
- `readiness: "subtitle_plan_only"`
- `generationMode: "deterministic_local"`
- `generatedMedia: []`
- `providerCalls: []`
- `artifacts: []`
- `publication: { requested: false, status: "not_requested" }`
