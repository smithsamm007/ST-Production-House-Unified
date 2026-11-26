# ST Production House Unified (React Web Console)

Owner Console and Control Plane UI for ST Production House, rewritten as a React + TypeScript + Tailwind CSS application powered by Vite.

## Key Capabilities

1. **Command Center (Overview)**:
   - Live operational metrics: active jobs, live channels, registered directors (`21/50`), and completed jobs.
   - 8-stage production pipeline visualization (`story` → `visual` → `audio` → `assembly` → `reels` → `packaging` → `qc` → `complete`).
   - Active production releases with real-time stage progress, stage logs, and stage advancement.
   - Director channels summary with the 4 canonical media slots (`main_video`, `content_reel_1`, `content_reel_2`, `brand_reel`) and deterministic SHA-256 inspection receipts.

2. **Director Channels Registry**:
   - Public channel branding (`Midnight Horror Studios`, `Epic Mythology Labs`, `Case Notes Anime`, `Newton Explains`).
   - Agent Name Internal-Only Rule (Rule 15): Internal director identifiers remain internal and never leak into public channel branding.
   - Search and filter channels by name, slug, or language; register new channels with custom slugs and launch titles.

3. **Episode & Production Scheduling (`sql/029`)**:
   - Per-director schedule configuration: episode duration (`30m`, `40m`, `50m`), episodes per day (`1`–`6`), production day presets (`Every day`, `Mon–Fri`), preferred start time, IANA timezone, and enable/pause toggle.
   - Plan preview (dry-run) and `Run Scheduler Now` execution queuing planned episodes.

4. **Director Communication Studio**:
   - Dedicated communication window per director with semantic categories (`conversation`, `proposal`, `instruction`, `decision`), sender attribution (`owner` vs `director`), quick instruction templates, and simulated director replies.

5. **Director Memory & Creative Charters**:
   - Universe logline, premise, visual style, pacing, target audience, and non-negotiable character continuity rules per director.

6. **Production Pipeline & QC Gate**:
   - Launch new production releases by channel, season, and episode and advance through all 8 canonical stages.

7. **Active Jobs & Lifecycle Control (`sql/010` + `sql/017`)**:
   - Filterable job queue (`queued`, `running`, `paused`, `waiting_for_quota`, `waiting_for_approval`, `succeeded`, `failed`) with Pause, Resume, and Cancel controls.

8. **Provider Status & Quotas (Rule 5 & Rule 17)**:
   - 3 private remote slots + 1 local emergency slot across Visual, Narration, Assembly, and Publisher categories with latency and daily quota tracking.

9. **OAuth & Secrets (`Connections`)**:
   - Isolated per-director connection slots (`YouTube`, `Instagram`, `Snapchat`) using opaque `vault://...` secret locators.

10. **Publishing Approvals (Rule 7)**:
    - Owner approvals bound to the exact artifact SHA-256 hash, destination, caption, disclosure, and affiliate links.

11. **Durable Evidence Ledger (Rules 1 & 2)**:
    - Filterable cryptographic audit trail recording every authentication, inspection, schedule save, stage advance, job update, and approval decision.

12. **Hermes AI Manager**:
    - Authority Matrix (Tier 1 Autonomous, Tier 2 Policy Governed, Tier 3 Owner Required) and triage decision logs.

13. **Settings & System Configuration**:
    - Owner identity, `local-device` storage status, canonical seed data reset, and Rule 7 publishing safety mode (`Dry Run` / `Live`).

## Running Locally

The console signs in against the real backend and reads every production fact
from the PostgreSQL-backed API. See [docs/OWNER_CONSOLE.md](docs/OWNER_CONSOLE.md)
for the session/CSRF flow, the screen-to-API matrix, the LIVE/STALE/UNAVAILABLE
semantics and the capabilities that are explicitly unavailable.

```bash
npm install
npm run build      # builds the React Owner Console into dist/
npm start          # unified runtime: console + /api on http://0.0.0.0:3000
```

`npm start` runs `node server.js`, which serves the built console from `dist/`
and the Express control plane from the same origin on port `3000`. If `dist/`
has not been built it serves the legacy `public/` dashboard and logs
`DASHBOARD_STATIC_ROOT source:"public"` — it never claims a build that is absent.

For hot-reload development, run the two processes side by side:

```bash
npm run dev:api    # control plane on 127.0.0.1:3000
npm run dev        # Vite dev server on 0.0.0.0:5173, proxies /api/* to :3000
```
