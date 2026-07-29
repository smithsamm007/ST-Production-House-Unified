import { createHash, randomUUID } from "node:crypto";
import { isIP } from "node:net";

export function normalizeProductServiceIdentity(productName, serviceCategory) {
  const normalize = (value) => String(value ?? "")
    .normalize("NFKC")
    .trim()
    .toLocaleLowerCase("en-US")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .replace(/\s+/g, " ");
  const product = normalize(productName);
  const category = normalize(serviceCategory);
  if (!product || !category) throw new Error("PRODUCT_AND_CATEGORY_REQUIRED");
  const canonical = `${product}::${category}`;
  return {
    canonical,
    fingerprint: createHash("sha256").update(canonical).digest("hex")
  };
}

function assertSafeAffiliateUrl(rawUrl, allowedDomains) {
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_AFFILIATE_URL");
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    throw new Error("UNSAFE_AFFILIATE_URL");
  }
  const host = url.hostname.toLowerCase().replace(/\.$/, "");
  if (host === "localhost" || isIP(host) ||
      host.endsWith(".local") || host.endsWith(".internal")) {
    throw new Error("PRIVATE_AFFILIATE_DESTINATION_DENIED");
  }
  if (!allowedDomains.some((domain) =>
    host === domain || host.endsWith(`.${domain}`))) {
    throw new Error("AFFILIATE_DOMAIN_NOT_ALLOWED");
  }
  return url.toString();
}

export class PromotionPolicyKernel {
  #identities = new Map();
  #campaigns = new Map();
  #reels = new Map();
  #mainVideoPlacements = new Map();
  #affiliateLinks = new Map();

  createCampaign(input) {
    const identity = normalizeProductServiceIdentity(
      input.productName,
      input.serviceCategory
    );
    const existingCampaigns = [...this.#campaigns.values()]
      .filter((item) => item.productFingerprint === identity.fingerprint);
    if (existingCampaigns.length > 0 && input.allowDuplicateCampaign !== true) {
      throw new Error("DUPLICATE_CAMPAIGN_REQUIRES_OWNER_PERMISSION");
    }
    if (!input.ownerAgentId) throw new Error("OWNER_AGENT_SELECTION_REQUIRED");
    if (typeof input.includeInMainVideo !== "boolean") {
      throw new Error("MAIN_VIDEO_PROMOTION_DECISION_REQUIRED");
    }
    if (input.includeInMainVideo && !input.targetEpisodeId) {
      throw new Error("TARGET_EPISODE_REQUIRED");
    }

    this.#identities.set(identity.fingerprint, identity);
    const campaign = Object.freeze({
      id: randomUUID(),
      productFingerprint: identity.fingerprint,
      productName: String(input.productName).trim(),
      serviceCategory: String(input.serviceCategory).trim(),
      ownerAgentId: input.ownerAgentId,
      destinations: Object.freeze([...(input.destinations ?? [])]),
      allowDuplicateCampaign: input.allowDuplicateCampaign === true,
      includeInMainVideo: input.includeInMainVideo,
      targetEpisodeId: input.targetEpisodeId ?? null,
      status: "draft",
      createdAt: new Date().toISOString()
    });
    this.#campaigns.set(campaign.id, campaign);

    if (campaign.includeInMainVideo) {
      const placement = Object.freeze({
        id: randomUUID(),
        campaignId: campaign.id,
        targetEpisodeId: campaign.targetEpisodeId,
        status: "requested"
      });
      this.#mainVideoPlacements.set(placement.id, placement);
    }
    return campaign;
  }

  reserveStandaloneReel(campaignId) {
    const campaign = this.#campaigns.get(campaignId);
    if (!campaign) throw new Error("CAMPAIGN_NOT_FOUND");
    if (this.#reels.has(campaign.productFingerprint)) {
      throw new Error("ONE_REEL_PER_PRODUCT_SERVICE");
    }
    const reel = Object.freeze({
      id: randomUUID(),
      campaignId,
      productFingerprint: campaign.productFingerprint,
      ownerAgentId: campaign.ownerAgentId,
      status: "reserved",
      currentVersion: 0
    });
    this.#reels.set(campaign.productFingerprint, reel);
    return reel;
  }

  registerReelAttempt(campaignId, artifact) {
    const campaign = this.#campaigns.get(campaignId);
    const reel = campaign && this.#reels.get(campaign.productFingerprint);
    if (!reel) throw new Error("REEL_RESERVATION_REQUIRED");
    if (!/^[a-f0-9]{64}$/i.test(artifact?.sha256 ?? "")) {
      throw new Error("VERIFIED_ARTIFACT_HASH_REQUIRED");
    }
    const next = Object.freeze({
      ...reel,
      currentVersion: reel.currentVersion + 1,
      status: artifact.ffprobeVerified ? "verified" : "failed_verification",
      artifact: Object.freeze({ ...artifact })
    });
    this.#reels.set(campaign.productFingerprint, next);
    return next;
  }

  addAffiliateLink(campaignId, input) {
    if (!this.#campaigns.has(campaignId)) throw new Error("CAMPAIGN_NOT_FOUND");
    if (!input.disclosure?.trim()) throw new Error("AFFILIATE_DISCLOSURE_REQUIRED");
    const allowedDomains = (input.allowedDomains ?? [])
      .map((item) => item.toLowerCase());
    if (allowedDomains.length === 0) throw new Error("DOMAIN_ALLOWLIST_REQUIRED");
    const link = Object.freeze({
      id: randomUUID(),
      campaignId,
      destination: assertSafeAffiliateUrl(input.destination, allowedDomains),
      placement: input.placement,
      platform: input.platform,
      disclosure: input.disclosure.trim(),
      status: "pending_security_scan"
    });
    this.#affiliateLinks.set(link.id, link);
    return link;
  }

  getMainVideoPlacements(campaignId) {
    return [...this.#mainVideoPlacements.values()]
      .filter((item) => item.campaignId === campaignId);
  }
}
