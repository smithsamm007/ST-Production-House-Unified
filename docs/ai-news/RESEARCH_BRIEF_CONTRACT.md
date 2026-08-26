# AI News Research Brief Contract

The AI News Research Brief planner (`src/aiNews/deterministicResearchBrief.js`) converts bounded source descriptors into a provenance-first, deterministic editorial brief.

## Core Guarantees

### 1. Offline & Network Isolation
- **Zero Live Network Calls**: Operates strictly offline without making HTTP requests, performing web scraping, or resolving DNS.
- **Zero Provider Calls**: Does not invoke external LLMs, AI APIs, or third-party web services (`providerCalls: []`).
- **Generation Mode**: Formally stamped as `generationMode: "deterministic_offline"`.

### 2. Truthfulness & Provenance-First Rules
- **No Invented Facts**: Generated text is never asserted as a fact (`confidence: "verified_fact"`) unless directly corroborated by supplied input provenance.
- **Independent Domain Corroboration Requirement**:
  - A brief is marked `status: "PUBLISHABLE"` (`publishable: true`) if and only if its deduplicated sources represent at least **two independent publisher domains**.
  - If fewer than two independent publisher domains are present, the brief truthfully returns `status: "INSUFFICIENT_CORROBORATION"` (`publishable: false`).
- **Claim Categorization**:
  - **Verified Claims** (`claims.verified`): Claims supported by 2+ independent publisher domains, linking explicitly to `sourceIds` and `corroboratedBy` domains.
  - **Unresolved Claims** (`claims.unresolved`): Claims supported by a single publisher domain, marked with `confidence: "unresolved_claim"`.
  - **Contradiction Flags** (`contradictionFlags`): Explicitly flags opposing assertions or conflicting assertions across source reports.

### 3. URL Canonicalization & Offline Deduplication
- **HTTPS Enforcement**: Only `https://` URLs are accepted. Unsupported protocols (`http://`, `ftp://`, `file://`, `javascript:`) are rejected immediately (`RESEARCH_BRIEF_UNSUPPORTED_PROTOCOL`).
- **Normalization**: Hostnames are lowercased, default port `:443` is removed, path trailing slashes are normalized, and query parameters are deterministically sorted alphabetically by parameter name.
- **Offline Deduplication**: Multiple entries canonicalizing to the same URL are deduplicated offline, retaining the earliest observed timestamp.

### 4. Safety & Scope Isolation
- **Scope Isolation**: Every execution requires valid `ownerId` and `agentId` scope strings. If source items define mismatched `ownerId` or `agentId`, the operation fails closed with `RESEARCH_BRIEF_SCOPE_MISMATCH`.
- **Secret Rejection**: Plaintext secrets, tokens, API keys, or secret locators (`vault://`, `opaque://`, `password`, `bearer`) trigger immediate rejection (`RESEARCH_BRIEF_SECRET_REJECTED`).
- **Internal Agent Name Leakage Protection**: Public text fields are checked against internal agent names (e.g. JARVIS, LAKME, VEDA) and fail closed if detected (`RESEARCH_BRIEF_INTERNAL_AGENT_NAME_REJECTED`).
- **Hostile Input & HTML/Script Rejection**: Any HTML markup (`<script>`, `<iframe>`), inline handlers (`onload=`), or script pseudo-protocols trigger `RESEARCH_BRIEF_HOSTILE_INPUT`.
- **Input Bounding**: Imposes bounded limits (maximum 50 sources, strict string character limits, valid ISO 8601 timestamps, and 64-hex SHA-256 content hashes).

### 5. Deterministic Execution
- **Stable Brief ID**: Produces a SHA-256 digest `briefId` derived deterministically from canonicalized inputs and provenance structure. Identical inputs yield byte-for-byte identical brief outputs across multiple runs.
