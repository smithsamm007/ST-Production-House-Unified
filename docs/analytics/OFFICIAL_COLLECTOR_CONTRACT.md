# Official Analytics Collector Contract (S-M39-01, offline portion)

> Status: **offline-verified** (`tests/officialAnalyticsCollectors.test.js`).
> This documents the governed translation layer between a REAL official
> platform API response and the existing analytics ingestion record
> (`AnalyticsService` + sql/027 `owner_analytics_records`). The module does
> **no networking**: the authenticated caller obtains the response body
> through the platform's official API; this contract normalizes it, fails
> closed, and records provenance. Live collection remains owner-gated
> (issue #118, S-M26-LIVE).

## What the collector enforces

1. **Strict per-platform normalizers** for the official response shapes
   verified against official documentation:
   - `youtube` — Data API v3 `videos.list` `statistics`
     (https://developers.google.com/youtube/v3/docs/videos). String-encoded
     counters are parsed to non-negative integers. `watchTimeSeconds`,
     `impressions`, and `shares` are NOT part of this shape and are left
     absent (ingestion defaults them to 0) — never invented.
   - `facebook` / `instagram` — Meta Graph API `/​{id}/insights`
     (`{ data: [{ name, period, values: [{ value }] }] }`,
     https://developers.facebook.com/docs/pages-api/insights and
     https://developers.facebook.com/docs/instagram-platform/insights).
     Explicit metric-name maps (`post_*` / professional-account names →
     ingestion fields); the LAST series value is ingested as the most
     recent; official metric names outside the ingestion set are ignored,
     never coerced.

2. **Identity binding** — where the official response carries the post id
   (YouTube `items[].id`), it MUST equal the expected `platformPostId`
   (`RESPONSE_IDENTITY_MISMATCH` otherwise): a body about another post can
   never be ingested for this one. Insight responses that do not carry an id
   bind at the record level through the caller-supplied identity.

3. **Fail-closed metrics** — negative, fractional, or unparsable metric
   values throw stable `OFFICIAL_COLLECTOR_PARSE_ERROR`; nothing is coerced.

4. **Honest unavailability** — `snapchat` and `bilibili` are registered with
   `parser: null` and `OFFICIAL_RESPONSE_SHAPE_UNVERIFIED` (their official
   analytics response shapes are not verified in this repository's
   documentation set). Unknown platforms yield the same stable code. No
   parser is ever invented for an unverified provider (the Bilibili identity
   precedent).

5. **Provenance, no secret material** — the collector returns the exact
   ingestion argument object plus metadata: `collector = parser name` and
   `collectorEnvelopeSha256 = SHA-256 of the raw response body` (evidence of
   what was parsed; the raw body is never persisted). The service's own
   gates stay intact: agent-name leakage, secret-shaped fields, and
   non-negative-integer validation all still apply downstream.

## Stable codes

| Code | Meaning |
|---|---|
| `OFFICIAL_COLLECTOR_UNAVAILABLE` | unregistered platform or unverified official shape |
| `RESPONSE_IDENTITY_MISMATCH` | response describes a different post |
| `OFFICIAL_COLLECTOR_PARSE_ERROR` | malformed body or metric-invalid value |

## What remains owner-gated (honest scope)

Live collection requires: an authenticated official API client per platform
(owner-configured credentials via Secrets & Connections / the vault), the
ingester caller that fetches bodies on a schedule from the deployed worker,
and real published content to collect for. None of that is claimed here —
the contract and its offline proof are the deliverable; Hermes optimization
(S-M26-LIVE) stays blocked until ingestion is verified against real platform
responses.
