# Repository Audit and Selective Reuse Decision

No source from the supplied projects has been copied into this foundation.
This document records what may be adapted after file-level review.

| Source | License observed | Strongest reference | Decision |
|---|---|---|---|
| ST Production House | MIT | Owner dashboard and canonical agent list | Preserve product direction; replace insecure/fake backend paths |
| JARVIS v14 | MIT | Story universe, continuity, promotion domain concepts | Adapt validated domain concepts behind an isolated story worker |
| ViMax | MIT | Real Veo/OpenRouter/Yunwu motion provider patterns | Adapt as the AI-motion worker; remove shell execution and shared-key config |
| MoneyPrinter | MIT | PostgreSQL job claiming and FFmpeg/TTS/stock assembly | Adapt selected queue and assembly patterns with leases and authentication |
| MoneyPrinterTurbo | MIT | Subtitle, material, TTS and vertical-video assembly | Adapt selected code only; replace lossy queue and insecure API defaults |
| Postiz | AGPL-3.0 | Mature multi-platform publishing service | Deploy separately and use its authenticated API; do not merge its source |
| YouTube Automation Agent | MIT | Google upload flow examples | Reference only; replace plaintext tokens and simulated fallbacks |
| ShortGPT | MIT | Short-form workflow ideas | Do not integrate runtime code due to command injection and weak persistence |
| AI Content Studio | No license file observed | Desktop workflow concepts | Do not copy code/assets until the copyright holder grants a clear license |

## Explicit exclusions

- Static-image-plus-tone outputs presented as finished videos.
- Text files renamed as media and placeholder media that passes verification.
- Locally generated YouTube/Instagram IDs, URLs, analytics, or audit events.
- Authentication that silently becomes the first owner.
- Plaintext API keys, OAuth tokens, pickle token stores, or browser secrets.
- Shell commands assembled from user-controlled paths.
- Unlicensed bundled music, fonts, images, model weights, or stock media.
- Duplicate HTTP routes or competing production pipelines.

## Integration order

1. Secure ST identity, sessions, PostgreSQL schema, queue, evidence, and audit.
2. ViMax motion adapter with job-scoped provider secret handles.
3. MoneyPrinterTurbo assembly adapter with verified FFmpeg/FFprobe output.
4. JARVIS story/continuity adapter after deleting simulated provider paths.
5. Postiz API adapter for owner-approved draft/live publishing.
6. Additional gateways: signed Telegram intake, partner API, catalog import,
   commerce adapters, QR codes, owned landing pages, and compliant captions.

Any adapted file must receive a provenance header or a corresponding entry in
`THIRD_PARTY_NOTICES.md`, retain its upstream license, and pass security review.
