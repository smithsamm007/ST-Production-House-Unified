/**
 * ST Production House — Provider catalog (provider metadata registry).
 *
 * Secrets & Connections surface, part 1: the catalog tells the owner WHAT a
 * provider is, WHERE its official credential page lives (HTTPS-only, validated
 * by the existing URL safety rules), and WHICH fields a connection requires —
 * secrets (locator-backed) vs configuration (displayable).
 *
 * Security contract (AGENTS.md Rules 1/15/17):
 *   - Metadata only: NO secret values, NO credential material, NO env reads.
 *     Secret values live in the external secret manager behind opaque
 *     locators (vault:// / opaque://); this module never sees them.
 *   - Every stored URL is HTTPS, no embedded credentials, no exotic ports,
 *     no private/localhost targets — transport-safety rules re-implemented
 *     here (CONVENTIONS Rule 1). `rejectUnsafeUrls` in the reference library
 *     is intentionally domain-allowlisted (YouTube-only) and therefore NOT
 *     reused: provider metadata must accept every OFFICIAL provider domain.
 *     A hostile catalog entry fails the module load, not production.
 *   - Rule 15 is honored by design: the catalog is provider metadata and
 *     carries no agent names at all.
 *
 * Extensibility (Blueprint §6): owners register CUSTOM providers via
 * `validateCustomProviderDefinition` — ST is never permanently bound to a
 * fixed catalog. Custom definitions pass the same URL safety rules and must
 * declare their required secret field keys up front.
 */

import { isIP } from "node:net";

/**
 * Provider-metadata URL safety (CONVENTIONS Rule 1): HTTPS-only, no embedded
 * credentials, no non-443 ports, no localhost/private-IP/.local/.internal
 * targets. Throws with a stable code on any violation.
 */
export function validateProviderMetadataUrl(rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("INVALID_URL_FORMAT");
  }
  if (parsed.protocol !== "https:") throw new Error("HTTPS_ONLY_REQUIRED");
  if (parsed.username || parsed.password) throw new Error("EMBEDDED_CREDENTIALS_PROHIBITED");
  if (parsed.port && parsed.port !== "443") throw new Error("NON_STANDARD_PORTS_PROHIBITED");
  const host = parsed.hostname.toLowerCase().replace(/\.$/, "");
  if (
    host === "localhost" ||
    isIP(host) ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  ) {
    throw new Error("PRIVATE_OR_LOCALHOST_TARGET_REJECTED");
  }
  if (host.length === 0 || !host.includes(".")) {
    throw new Error("INVALID_PROVIDER_URL_HOST");
  }
  return parsed;
}

const CATEGORY_LLM = "llm";
const CATEGORY_MEDIA = "media";
const CATEGORY_IMAGE = "image";
const CATEGORY_EMAIL = "email";
const CATEGORY_SOCIAL = "social";

export const CONNECTION_KINDS = Object.freeze([
  CATEGORY_LLM, CATEGORY_MEDIA, CATEGORY_IMAGE, CATEGORY_EMAIL, CATEGORY_SOCIAL,
]);

/**
 * Field descriptors shared by catalog entries. `kind: "secret"` fields are
 * stored ONLY as opaque locators; `kind: "config"` fields are non-secret.
 */
const F = {
  apiKey: Object.freeze({ key: "api_key", label: "API Key", kind: "secret", required: true }),
  apiSecret: Object.freeze({ key: "api_secret", label: "API Secret", kind: "secret", required: true }),
  organization: Object.freeze({ key: "organization", label: "Organization ID", kind: "config", required: false }),
  projectId: Object.freeze({ key: "project_id", label: "Project ID", kind: "config", required: false }),
  region: Object.freeze({ key: "region", label: "Region", kind: "config", required: false }),
  baseUrl: Object.freeze({ key: "base_url", label: "Base URL", kind: "config", required: false }),
  model: Object.freeze({ key: "model", label: "Model", kind: "config", required: false }),
  voiceId: Object.freeze({ key: "voice_id", label: "Voice ID", kind: "config", required: false }),
  channelId: Object.freeze({ key: "channel_id", label: "Channel ID", kind: "config", required: false }),
  emailAddress: Object.freeze({ key: "email_address", label: "Email address", kind: "config", required: false }),
  smtpHost: Object.freeze({ key: "smtp_host", label: "SMTP host", kind: "config", required: false }),
  smtpPort: Object.freeze({ key: "smtp_port", label: "SMTP port", kind: "config", required: false }),
  smtpUser: Object.freeze({ key: "smtp_user", label: "SMTP username", kind: "config", required: false }),
  smtpPassword: Object.freeze({ key: "smtp_password", label: "SMTP password", kind: "secret", required: true }),
  oauthAccessToken: Object.freeze({ key: "oauth_access_token", label: "OAuth access token", kind: "secret", required: false }),
  oauthRefreshToken: Object.freeze({ key: "oauth_refresh_token", label: "OAuth refresh token", kind: "secret", required: false }),
  oauthClientSecret: Object.freeze({ key: "oauth_client_secret", label: "OAuth client secret", kind: "secret", required: false }),
};

function entry(definition) {
  return Object.freeze({ ...definition, fields: Object.freeze(definition.fields.map((f) => Object.freeze(f))) });
}

/**
 * The governed provider catalog. URLs point to the OFFICIAL credential /
 * console / authorization pages so the owner never has to search for them.
 */
export const PROVIDER_CATALOG = Object.freeze({
  // ---------------------------------------------------------------- LLM
  gemini: entry({
    providerKey: "gemini",
    displayName: "Google Gemini",
    category: CATEGORY_LLM,
    authType: "api_key",
    websiteUrl: "https://ai.google.dev/",
    credentialUrl: "https://aistudio.google.com/app/apikey",
    fields: [F.apiKey, F.projectId, F.model, F.region],
    capabilities: ["research", "script_generation", "reasoning", "text_generation"],
  }),
  anthropic: entry({
    providerKey: "anthropic",
    displayName: "Anthropic Claude",
    category: CATEGORY_LLM,
    authType: "api_key",
    websiteUrl: "https://www.anthropic.com/",
    credentialUrl: "https://console.anthropic.com/settings/keys",
    fields: [F.apiKey, F.model],
    capabilities: ["script_generation", "reasoning", "text_generation"],
  }),
  openai: entry({
    providerKey: "openai",
    displayName: "OpenAI",
    category: CATEGORY_LLM,
    authType: "api_key",
    websiteUrl: "https://openai.com/",
    credentialUrl: "https://platform.openai.com/api-keys",
    fields: [F.apiKey, F.organization, F.model],
    capabilities: ["script_generation", "reasoning", "text_generation"],
  }),
  // -------------------------------------------------------------- media
  elevenlabs: entry({
    providerKey: "elevenlabs",
    displayName: "ElevenLabs",
    category: CATEGORY_MEDIA,
    authType: "api_key",
    websiteUrl: "https://elevenlabs.io/",
    credentialUrl: "https://elevenlabs.io/app/settings/api-keys",
    fields: [F.apiKey, F.voiceId],
    capabilities: ["text_to_speech", "voice_cloning_review"],
  }),
  "edge-tts": entry({
    providerKey: "edge-tts",
    displayName: "Edge TTS",
    category: CATEGORY_MEDIA,
    authType: "none",
    websiteUrl: "https://github.com/rany2/edge-tts",
    credentialUrl: "https://github.com/rany2/edge-tts",
    fields: [F.voiceId],
    capabilities: ["text_to_speech"],
  }),
  piper: entry({
    providerKey: "piper",
    displayName: "Piper (local emergency TTS)",
    category: CATEGORY_MEDIA,
    authType: "none",
    websiteUrl: "https://github.com/rhasspy/piper",
    credentialUrl: "https://github.com/rhasspy/piper",
    fields: [F.voiceId],
    capabilities: ["text_to_speech_local"],
  }),
  // -------------------------------------------------------------- image
  "custom-image-provider": entry({
    providerKey: "custom-image-provider",
    displayName: "Custom image/video provider",
    category: CATEGORY_IMAGE,
    authType: "api_key",
    websiteUrl: null,
    credentialUrl: null,
    fields: [F.apiKey, F.baseUrl],
    capabilities: ["image_generation"],
  }),
  // -------------------------------------------------------------- email
  "director-email": entry({
    providerKey: "director-email",
    displayName: "Director email (SMTP)",
    category: CATEGORY_EMAIL,
    authType: "password",
    websiteUrl: null,
    credentialUrl: null,
    fields: [F.emailAddress, F.smtpHost, F.smtpPort, F.smtpUser, F.smtpPassword],
    capabilities: ["email_send"],
  }),
  // ------------------------------------------------------------- social
  youtube: entry({
    providerKey: "youtube",
    displayName: "YouTube",
    category: CATEGORY_SOCIAL,
    authType: "oauth",
    websiteUrl: "https://www.youtube.com/",
    credentialUrl: "https://console.cloud.google.com/apis/credentials",
    fields: [F.oauthAccessToken, F.oauthRefreshToken, F.oauthClientSecret, F.channelId],
    capabilities: ["publish_video", "publish_short"],
  }),
  instagram: entry({
    providerKey: "instagram",
    displayName: "Instagram",
    category: CATEGORY_SOCIAL,
    authType: "oauth",
    websiteUrl: "https://www.instagram.com/",
    credentialUrl: "https://developers.facebook.com/apps",
    fields: [F.oauthAccessToken, F.oauthRefreshToken, F.oauthClientSecret],
    capabilities: ["publish_reel"],
  }),
  facebook: entry({
    providerKey: "facebook",
    displayName: "Facebook",
    category: CATEGORY_SOCIAL,
    authType: "oauth",
    websiteUrl: "https://www.facebook.com/",
    credentialUrl: "https://developers.facebook.com/apps",
    fields: [F.oauthAccessToken, F.oauthRefreshToken, F.oauthClientSecret],
    capabilities: ["publish_video"],
  }),
  snapchat: entry({
    providerKey: "snapchat",
    displayName: "Snapchat",
    category: CATEGORY_SOCIAL,
    authType: "oauth",
    websiteUrl: "https://snapchat.com/",
    credentialUrl: "https://kit.snapchat.com/manage",
    fields: [F.oauthAccessToken, F.oauthRefreshToken, F.oauthClientSecret],
    capabilities: ["publish_spotlight"],
  }),
  bilibili: entry({
    providerKey: "bilibili",
    displayName: "Bilibili",
    category: CATEGORY_SOCIAL,
    authType: "oauth",
    websiteUrl: "https://www.bilibili.com/",
    credentialUrl: "https://member.bilibili.com/platform/upload/video/frame",
    fields: [F.oauthAccessToken, F.oauthRefreshToken, F.oauthClientSecret],
    capabilities: ["publish_video"],
  }),
});

/** Public catalog DTO: everything is metadata; nothing secret-shaped exists here. */
export function catalogDto(providerKey, catalog = PROVIDER_CATALOG) {
  const entryValue = catalog[providerKey];
  if (!entryValue) return null;
  return {
    providerKey: entryValue.providerKey,
    displayName: entryValue.displayName,
    category: entryValue.category,
    authType: entryValue.authType,
    websiteUrl: entryValue.websiteUrl,
    credentialUrl: entryValue.credentialUrl,
    fields: entryValue.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, required: f.required })),
    capabilities: [...entryValue.capabilities],
  };
}

export function listCatalog(catalog = PROVIDER_CATALOG) {
  return Object.keys(catalog).map((key) => catalogDto(key, catalog));
}

/**
 * Register an owner-defined custom provider. Returns a NEW frozen catalog;
 * the caller's catalog is never mutated, so no runtime component can
 * silently rewrite the governed catalog. The definition must pass the same
 * safety bar as built-ins (validateCustomProviderDefinition) or this throws.
 */
export function registerCustomProvider(catalog, definition) {
  if (!catalog || typeof catalog !== "object" || Array.isArray(catalog)) {
    throw new Error("CUSTOM_PROVIDER_CATALOG_REQUIRED");
  }
  validateCustomProviderDefinition(definition, catalog);
  const categoryOf = { llm: CATEGORY_LLM, media: CATEGORY_MEDIA, image: CATEGORY_IMAGE, email: CATEGORY_EMAIL, social: CATEGORY_SOCIAL };
  const providerEntry = entry({
    providerKey: definition.providerKey,
    displayName: definition.displayName.trim(),
    category: categoryOf[definition.category],
    authType: definition.authType ?? "api_key",
    websiteUrl: definition.websiteUrl ?? null,
    credentialUrl: definition.credentialUrl ?? null,
    fields: definition.fields.map((f) => ({
      key: f.key,
      label: f.label ?? f.key,
      kind: f.kind,
      required: f.required ?? f.kind === "secret",
    })),
    capabilities: [...definition.capabilities],
  });
  return Object.freeze({
    ...catalog,
    [definition.providerKey]: providerEntry,
  });
}

const LOCATOR_PREFIXES = Object.freeze(["vault://", "opaque://"]);

/**
 * True when every value in a secret-fields map is a locator-shaped string.
 * Non-objects, arrays, and non-string values fail closed (Rule 17).
 */
export function isLocatorShapedSecretFields(map) {
  if (!map || typeof map !== "object" || Array.isArray(map)) return false;
  const values = Object.values(map);
  if (values.length === 0) return false;
  return values.every(
    (value) =>
      typeof value === "string" &&
      value.length > 0 &&
      value.length <= 512 &&
      LOCATOR_PREFIXES.some((prefix) => value.startsWith(prefix)),
  );
}

/**
 * Validate an owner-defined CUSTOM provider definition. Same safety bar as
 * the built-in catalog: HTTPS-only official URLs, declared secret fields,
 * bounded strings. Throws (fail closed) with stable codes. Pure.
 */
export function validateCustomProviderDefinition(definition, catalog = PROVIDER_CATALOG) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new Error("CUSTOM_PROVIDER_DEFINITION_REQUIRED");
  }
  const providerKey = definition.providerKey;
  if (typeof providerKey !== "string" || !/^[a-z0-9][a-z0-9_-]{1,79}$/.test(providerKey)) {
    throw new Error("CUSTOM_PROVIDER_KEY_INVALID");
  }
  if (catalog[providerKey]) {
    throw new Error("CUSTOM_PROVIDER_KEY_RESERVED");
  }
  if (typeof definition.displayName !== "string" || definition.displayName.trim().length < 2 || definition.displayName.length > 120) {
    throw new Error("CUSTOM_PROVIDER_DISPLAY_NAME_INVALID");
  }
  if (!CONNECTION_KINDS.includes(definition.category)) {
    throw new Error("CUSTOM_PROVIDER_CATEGORY_INVALID");
  }
  if (definition.authType !== undefined && !["api_key", "oauth", "password", "none"].includes(definition.authType)) {
    throw new Error("CUSTOM_PROVIDER_AUTH_TYPE_INVALID");
  }
  for (const urlField of ["websiteUrl", "credentialUrl"]) {
    const url = definition[urlField];
    if (url === undefined || url === null) continue;
    if (typeof url !== "string") throw new Error("CUSTOM_PROVIDER_URL_INVALID");
    validateProviderMetadataUrl(url); // HTTPS-only, no embedded creds, no exotic ports
  }
  if (!Array.isArray(definition.fields) || definition.fields.length === 0 || definition.fields.length > 24) {
    throw new Error("CUSTOM_PROVIDER_FIELDS_INVALID");
  }
  for (const field of definition.fields) {
    if (!field || typeof field !== "object" || Array.isArray(field)) {
      throw new Error("CUSTOM_PROVIDER_FIELDS_INVALID");
    }
    if (typeof field.key !== "string" || !/^[a-z0-9_]{1,60}$/.test(field.key)) {
      throw new Error("CUSTOM_PROVIDER_FIELDS_INVALID");
    }
    if (!["secret", "config"].includes(field.kind)) {
      throw new Error("CUSTOM_PROVIDER_FIELDS_INVALID");
    }
    if (field.required !== undefined && typeof field.required !== "boolean") {
      throw new Error("CUSTOM_PROVIDER_FIELDS_INVALID");
    }
  }
  if (!Array.isArray(definition.capabilities) || definition.capabilities.length === 0 || definition.capabilities.length > 12) {
    throw new Error("CUSTOM_PROVIDER_CAPABILITIES_INVALID");
  }
  for (const capability of definition.capabilities) {
    if (typeof capability !== "string" || capability.length === 0 || capability.length > 60) {
      throw new Error("CUSTOM_PROVIDER_CAPABILITIES_INVALID");
    }
  }
  return definition;
}
