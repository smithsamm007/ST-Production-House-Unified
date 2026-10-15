# Campaign Intake & Affiliate Link Scanner (TASK-4.1)

The owner boundary between "wants to promote something" and "authorized to
publish": a deterministic, offline, fail-closed intake that produces the
records the Rule-7 approval and destination-publisher contracts consume
(`src/promotion/campaignIntakeRegistry.js`, scanner in
`src/promotion/campaignIntake.js`). No provider calls, no uploads, no
publishing — live enablement stays owner-gated (S-M24-LIVE / issue #118).

## Contracts

- **Affiliate link security scanner** — every link must be:
  HTTPS-only, well-formed (`URL` parsed — nothing "best effort"),
  credential-free (no `user:pass@`), host-allowlisted (exact or
  suffix-match registrable domains from the deployment configuration),
  private-host-free (localhost, `.local`, `.internal`, loopback/private
  ranges — honest stable codes), standard-port only (`443` or none), and
  bound verbatim to a non-empty disclosure string. Deterministic `linkId`
  (SHA-256 over allowlisted content) makes identical inputs produce
  identical records.
- **Disclosure templates** — a bounded, shipped catalog
  (`canonicalDisclosureTemplates`: `caption_suffix`, `humanoid_label`,
  `video_overlay`); unknown template names fail closed
  (`AFFILIATE_DISCLOSURE_TEMPLATE_UNKNOWN`).
- **Rule 15** — every public string (disclosures, destinations) is scanned
  against the canonical internal-agent-name list supplied at construction;
  any internal name fails closed (`CAMPAIGN_INTERNAL_NAME_IN_PUBLIC`).
- **Rule 8** — one intake per normalized product/service identity inside a
  registry instance; a second attempts an honest
  `CAMPAIGN_DUPLICATE_IDENTITY` refusal (database reservation enforcement
  remains the Reel-plan/database layer's job).
- **Rule 9** — `promoteMainVideo` is an explicit owner decision:
  `INTEGRATED` requires an `ownerEvidenceRef` AND `promoteMainVideo === true`
  (both fail closed otherwise), and `STANDALONE_ONLY` never promotes the main
  video. `brandIntegrationMode` is the same three-value enum family as the
  Reel plan (`STANDALONE_ONLY`, `INTEGRATED`, `OWNER_DECISION_REQUIRED`).
- **Tamper detection** — intake records are frozen; the `campaignId` is
  recomputed over the allowlisted content, `recomputeCampaignId(record)`
  reproduces it, and `assertCampaignIntact(record)` throws
  `CAMPAIGN_TAMPERED` for any mutation of a deserialized copy.

## Tests

`tests/campaignIntake.test.js` — 7 offline tests: acceptance (determinism),
the fail-closed link matrix (non-https, non-allowlisted host, embedded
credentials, non-standard port, private host, unparseable, empty),
disclosure/template/Rule-15 gates, Rule 8 duplication refusal, Rule 9 owner
decision matrix, tamper detection, and identity/destination hard-rejection.
