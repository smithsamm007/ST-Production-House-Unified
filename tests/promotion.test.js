import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizeProductServiceIdentity,
  PromotionPolicyKernel
} from "../src/promotion/promotionPolicy.js";

test("normalizes product/service identity against trivial duplicates", () => {
  const first = normalizeProductServiceIdentity(" Kuku   FM ", "AUDIO-BOOKS");
  const second = normalizeProductServiceIdentity("kuku fm", "audio books");
  assert.equal(first.fingerprint, second.fingerprint);
});

test("allows duplicate campaigns only with explicit permission but only one Reel", () => {
  const policy = new PromotionPolicyKernel();
  const first = policy.createCampaign({
    productName: "Kuku FM",
    serviceCategory: "Audiobooks",
    ownerAgentId: "agent-01",
    destinations: ["youtube"],
    includeInMainVideo: false
  });
  assert.throws(() => policy.createCampaign({
    productName: " kuku   fm ",
    serviceCategory: "AUDIOBOOKS",
    ownerAgentId: "agent-02",
    includeInMainVideo: false
  }), /DUPLICATE_CAMPAIGN_REQUIRES_OWNER_PERMISSION/);
  const duplicate = policy.createCampaign({
    productName: " kuku   fm ",
    serviceCategory: "AUDIOBOOKS",
    ownerAgentId: "agent-02",
    allowDuplicateCampaign: true,
    includeInMainVideo: false
  });
  policy.reserveStandaloneReel(first.id);
  assert.throws(() => policy.reserveStandaloneReel(duplicate.id),
    /ONE_REEL_PER_PRODUCT_SERVICE/);
});

test("main-video placement is explicit and independent", () => {
  const policy = new PromotionPolicyKernel();
  const campaign = policy.createCampaign({
    productName: "ST Cloud",
    serviceCategory: "Hosting",
    ownerAgentId: "agent-03",
    includeInMainVideo: true,
    targetEpisodeId: "episode-9"
  });
  assert.equal(policy.getMainVideoPlacements(campaign.id).length, 1);
  const reel = policy.reserveStandaloneReel(campaign.id);
  assert.equal(reel.status, "reserved");
});

test("affiliate links require HTTPS, disclosure, and a domain allowlist", () => {
  const policy = new PromotionPolicyKernel();
  const campaign = policy.createCampaign({
    productName: "Safe Product",
    serviceCategory: "Software",
    ownerAgentId: "agent-04",
    includeInMainVideo: false
  });
  const link = policy.addAffiliateLink(campaign.id, {
    destination: "https://offers.example.com/buy?ref=st",
    allowedDomains: ["example.com"],
    disclosure: "ST may earn a commission from this link.",
    platform: "youtube",
    placement: "description"
  });
  assert.equal(link.status, "pending_security_scan");
  assert.throws(() => policy.addAffiliateLink(campaign.id, {
    destination: "http://localhost/admin",
    allowedDomains: ["localhost"],
    disclosure: "affiliate",
    platform: "youtube",
    placement: "description"
  }), /UNSAFE_AFFILIATE_URL/);
});
