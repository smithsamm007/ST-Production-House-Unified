import test from "node:test";
import assert from "node:assert/strict";

import {
  CAMPAIGN_INTAKE_ERROR_CODES,
  canonicalDisclosureTemplates,
  createScannedAffiliateLink,
} from "../src/promotion/campaignIntake.js";
import {
  CampaignIntakeRegistry,
  assertCampaignIntact,
  recomputeCampaignId,
} from "../src/promotion/campaignIntakeRegistry.js";

const OPTIONS = {
  ownerId: "owner-campaign-test",
  allowedDomains: ["partner.example", "shop.example"],
  internalNames: ["jarvis", "lakme", "veda"],
};

function baseLink(url = "https://go.partner.example/offer?ref=42", disclosure = "Paid partnership. #ad", template = null) {
  return { url, disclosure, disclosureTemplate: template };
}

function baseIntakeInput() {
  return {
    productName: "Neural Paint Studio",
    serviceCategory: "Software Subscription",
    destinations: ["youtube", "instagram"],
    affiliateLinks: [baseLink()],
    brandIntegrationMode: "OWNER_DECISION_REQUIRED",
  };
}

test("scanner accepts https, allowlisted, credential-free links and binds the disclosure verbatim", () => {
  const link = createScannedAffiliateLink(baseLink(), { allowedDomains: OPTIONS.allowedDomains, internalNames: OPTIONS.internalNames });
  assert.equal(link.host, "go.partner.example");
  assert.equal(link.disclosure, "Paid partnership. #ad");
  assert.match(link.urlMc, /^https:\/\/go\.partner\.example\/offer\?ref=42$/);
  assert.equal(link.linkId.length, 64);
  // identical inputs must be deterministic (same link id)
  const again = createScannedAffiliateLink(baseLink(), { allowedDomains: OPTIONS.allowedDomains, internalNames: OPTIONS.internalNames });
  assert.equal(again.linkId, link.linkId);
});

test("scanner fails closed on every unsafe link shape", () => {
  const cases = [
    ["http://go.partner.example/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS],
    ["https://shop.evil/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_DOMAIN_NOT_ALLOWED], // 'shop.evil' is not on the allowlist
    ["https://attacker.example/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_DOMAIN_NOT_ALLOWED],
    ["https://user:pass@go.partner.example/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_EMBEDDED_CREDENTIALS],
    ["https://go.partner.example:8443/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_NONSTANDARD_PORT],
    ["https://localhost/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_UNSAFE_HOST], // hostname passes the charclass; the private-host pattern rejects it
    ["https://127.0.0.1/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_UNSAFE_HOST],
    ["ftp://go.partner.example/x", CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS],
    ["", CAMPAIGN_INTAKE_ERROR_CODES.LINK_REQUIRED],
    ["not a url", CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS],
  ];
  for (const [url, expected] of cases) {
    if (expected === CAMPAIGN_INTAKE_ERROR_CODES.LINK_NOT_HTTPS && url.startsWith("https://localhost")) {
      // hostname 'localhost' is lowercase-alpha so the uri pattern accepts it;
      // the private-host pattern then rejects it inside parse
      assert.throws(
        () => createScannedAffiliateLink({ url, disclosure: "d" }, { allowedDomains: OPTIONS.allowedDomains, internalNames: [] }),
        (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.LINK_UNSAFE_HOST
      );
      continue;
    }
    assert.throws(
      () => createScannedAffiliateLink({ url, disclosure: "d" }, { allowedDomains: OPTIONS.allowedDomains, internalNames: [] }),
      (err) => err.code === expected,
      `expected ${expected} for ${url}`
    );
  }
});

test("disclosure is mandatory, template names are bounded, and Rule 15 names never pass", () => {
  assert.throws(
    () => createScannedAffiliateLink({ url: "https://go.partner.example/x", disclosure: "" }, { allowedDomains: OPTIONS.allowedDomains, internalNames: [] }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_REQUIRED
  );
  assert.throws(
    () => createScannedAffiliateLink({ url: "https://go.partner.example/x", disclosure: "ok", disclosureTemplate: "not_in_catalog" }, { allowedDomains: OPTIONS.allowedDomains, internalNames: [] }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.DISCLOSURE_TEMPLATE_UNKNOWN
  );
  assert.throws(
    () => createScannedAffiliateLink({ url: "https://go.partner.example/x", disclosure: "thanks jarvis agent" }, { allowedDomains: OPTIONS.allowedDomains, internalNames: OPTIONS.internalNames }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.INTERNAL_NAME_IN_PUBLIC
  );
  assert.deepEqual(Object.keys(canonicalDisclosureTemplates).sort(), ["caption_suffix", "humanoid_label", "video_overlay"]);
});

test("registry registers a scanner-passing campaign and refuses a duplicate identity (Rule 8)", () => {
  const registry = new CampaignIntakeRegistry(OPTIONS);
  const record = registry.register(baseIntakeInput());
  assert.equal(record.brandIntegrationMode, "OWNER_DECISION_REQUIRED");
  assert.equal(record.promoteMainVideo, false);
  assert.equal(record.standaloneReel.mode, "RESERVED");
  assert.equal(record.status, "submitted");
  assert.equal(assertCampaignIntact(record), true);

  assert.throws(
    () => registry.register(baseIntakeInput()),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.DUPLICATE_IDENTITY
  );
  assert.deepEqual(registry.listReservedIdentities().length, 1);
  const found = registry.findByIdentity("neural paint studio", "software subscription");
  assert.equal(found.campaignId, record.campaignId);
});

test("Rule 9: main-video promotion is owner-decision-bound and never crosses the standalone Reel", () => {
  const registry = new CampaignIntakeRegistry(OPTIONS);
  // INTEGRATED without owner evidence → fail closed
  assert.throws(
    () => registry.register({ ...baseIntakeInput(), brandIntegrationMode: "INTEGRATED", promoteMainVideo: true }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.MAIN_VIDEO_PROMOTION_UNAUTHORIZED
  );
  // INTEGRATED with evidence but without the explicit promote flag → fail closed
  assert.throws(
    () => registry.register({ ...baseIntakeInput(), brandIntegrationMode: "INTEGRATED", ownerEvidenceRef: "ledger-ref-1" }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.MAIN_VIDEO_PROMOTION_UNAUTHORIZED
  );
  // STANDALONE_ONLY can never carry main-video promotion
  assert.throws(
    () => registry.register({ ...baseIntakeInput(), brandIntegrationMode: "STANDALONE_ONLY", promoteMainVideo: true }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.MAIN_VIDEO_PROMOTION_UNAUTHORIZED
  );
  // the authorized shape records the owner decision verbatim
  const authorized = registry.register({
    ...baseIntakeInput(),
    brandIntegrationMode: "INTEGRATED",
    ownerEvidenceRef: "ledger-ref-1",
    promoteMainVideo: true,
  });
  assert.equal(authorized.promoteMainVideo, true);
  assert.equal(authorized.ownerEvidenceRef, "ledger-ref-1");
});

test("records are byte-stable, tamper-detectable, and integrity-verified", () => {
  const registry = new CampaignIntakeRegistry(OPTIONS);
  const first = registry.register(baseIntakeInput());
  const second = new CampaignIntakeRegistry(OPTIONS).register(baseIntakeInput());
  assert.equal(first.campaignId, second.campaignId, "identical intake yields identical ids");
  assert.equal(recomputeCampaignId(first), first.campaignId);

  const mutated = JSON.parse(JSON.stringify(first));
  mutated.affiliateLinks[0].disclosure = "mutated disclosure";
  assert.throws(() => assertCampaignIntact(mutated), (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.TAMPERED);
});

test("intake hard-rejects missing identity/destinations and internal names in destinations", () => {
  const registry = new CampaignIntakeRegistry(OPTIONS);
  assert.throws(
    () => registry.register({ ...baseIntakeInput(), productName: "" }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.IDENTITY_REQUIRED
  );
  assert.throws(
    () => registry.register({ ...baseIntakeInput(), destinations: [] }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.DESTINATION_REQUIRED
  );
  assert.throws(
    () => registry.register({ ...baseIntakeInput(), destinations: ["campaign for jarvis"] }),
    (err) => err.code === CAMPAIGN_INTAKE_ERROR_CODES.INTERNAL_NAME_IN_PUBLIC
  );
});
