# AI News Research Brief Contract

> Status: implemented (deterministic, offline). No live network, provider, publishing, or deployment capability is claimed by this document.

## Purpose

`src/aiNews/deterministicResearchBrief.js` converts bounded, owner/agent-scoped source descriptors into a provenance-first editorial brief for the AI News agent. It is a planning contract only: it never fetches the network, never calls a provider, and never invents facts.

## Input contract

The planner accepts a single object with:

- `schemaVersion: 1` (exactly; anything else is rejected with `RESEARCH_BRIEF_SCHEMA_UNSUPPORTED`).
- `ownerId` and `agentId`: scope identifiers matching `^[a-zA-Z0-9][a-zA-Z0-9._-]*$` (3–64 chars).
- `asOf` (optional): strict ISO-8601 timestamp (`YYYY-MM-DDTHH:MM:SS(.ffffff)?(Z|±HH:MM)`), not more than 5 minutes in the future.
- `sources`: array of 1–50 source descriptors, each containing:
  - `url`: HTTPS-only public URL (no credentials, no non-443 ports, no localhost/private/internal hosts).
  - `publisher`: publisher name (2–120 chars).
  - `observedAt`: strict ISO-8601 timestamp of observation, not in the future relative to `asOf`/now.
  - `headline` (5–300 chars) and `excerpt` (10–2000 chars).
  - `contentHash`: lowercase SHA-256 hex of the observed content (64 hex chars).
  - `claims` (optional): up to 12 claim strings (3–300 chars each) asserted by that source.

## Truthfulness rules

1. **Echo-only content.** Every claim, headline, and excerpt in the output is copied from supplied input. The planner generates no narrative text (`generatedNarrative` is always `null`) and no media (`generatedMedia` is always `[]`).
2. **Corroboration gate.** A claim is marked `corroborated` only when supported by sources from at least two independent publisher domains. Single-source claims are marked `unverified_single_source` under `unresolvedClaims` and are never presented as fact.
3. **`INSUFFICIENT_CORROBORATION`.** If fewer than two independent publisher domains remain, the planner returns a truthful non-ready brief with `reasonCode: "INSUFFICIENT_CORROBORATION"`, empty `verifiedClaims`, and `publishable: false`.
4. **Syndication is not corroboration.** A byte-identical copy (same `contentHash`) on another domain is kept for provenance but marked `corroborationEligible: false` and adds no independent domain weight.
5. **Contradictions are flagged, never resolved.** Otherwise-equivalent claims reporting different numbers from independent domains produce a `NUMERIC_DIVERGENCE` contradiction flag. The planner never picks a winner.
6. **`publishable` is always `false`.** Briefs are editor inputs. Publication remains owner-gated elsewhere in the platform.
7. **Rule 15.** Internal agent names are rejected in all provenance text (`RESEARCH_BRIEF_INTERNAL_NAME_REJECTED`).

## Rejection behavior (fail closed)

The planner throws typed errors and produces no output for: secret-like fields (`password`, `api key`, `bearer`, `vault://`, `opaque://`, private keys, access/client tokens — `RESEARCH_BRIEF_SECRET_REJECTED`), raw HTML/script markup (`RESEARCH_BRIEF_RAW_HTML_REJECTED`), non-HTTPS/credential-embedded/non-standard-port/private-host URLs, malformed or future timestamps, cross-owner/agent-scoped sources (`RESEARCH_BRIEF_SCOPE_MISMATCH`), wrong schema version, oversized payloads (> 262144 canonicalized bytes), oversized bounds, and invalid content hashes.

## Determinism

- URL canonicalization: lowercase host, strip trailing slash and default port, sort query parameters — so equivalent URLs deduplicate.
- Sources are ordered by `observedAt`, then `sourceId` (SHA-256 of the canonical URL). Claims are grouped by a whitespace/punctuation-normalized key and ordered by that key.
- The `briefId` is `sha256(canonical JSON of scope + asOf + sorted source descriptors)`. Identical inputs — in any source order — yield the identical `briefId` and identical output.

## Exclusions (what this module does NOT do)

- No network fetch, crawl, scraping, DNS, or RSS access of any kind.
- No provider/API/model calls; `provenance.providerCalls` is always `0`.
- No publishing, scheduling, or platform interaction; `publication.status` is always `not_requested`.
- No translation, summarization, or rewriting of source text.
- No PostgreSQL dependency, migration, or npm dependency.

## Verification

`tests/aiNewsResearchBrief.test.js` covers determinism, order-independence, corroboration gating, syndication de-duplication, contradiction flags, hostile URL rejection, canonicalization, secret/HTML/internal-name rejection, scope isolation, timestamp and bounds enforcement, and honesty markers. `npm test && npm run verify` must pass with zero skips.
