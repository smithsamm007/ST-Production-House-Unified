/**
 * ST Production House — per-Director SOCIAL OAuth provider registry.
 *
 * Section 6 of the master contract: "Independent social-media accounts for
 * every Director". Issue #206 built the YouTube lifecycle; this module is the
 * data-driven registry behind the GENERIC engine
 * (src/catalog/socialOAuthService.js) so facebook / instagram / snapchat /
 * bilibili are connectable through the identical security contract, and a new
 * Director (or a newly approved platform) needs no bespoke source changes.
 *
 * Honesty contract (AGENTS.md Rules 1, 3):
 *   - Every endpoint below is taken from the OFFICIAL provider documentation
 *     and is frozen here. Nothing is invented, proxied, or guessed.
 *   - A provider whose official IDENTITY endpoint could not be confirmed
 *     (bilibili) is registered with `identityUnconfirmed: true`. The service
 *     then refuses to mark an account `connected` — an unverified connection
 *     is never reported as verified.
 *   - Endpoints are HTTPS-only, on an explicit official-host allowlist, with
 *     no embedded credentials and no exotic ports. A hostile edit fails the
 *     module load, never production.
 *
 * Sources (read 2026-10-13):
 *   - Meta: developers.facebook.com "Manually Build a Login Flow", Graph API
 *     versions index (v26.0), User/Accounts/Page references.
 *   - Snap: developers.snap.com Public Profile API "Get Started"/"Profiles".
 *   - Bilibili: 哔哩哔哩开放平台 account-authorization guide.
 *
 * No secret values live here: only WHERE the owner's credentials are obtained
 * (see src/catalog/providerCatalog.js) and WHICH env vars name the app config.
 * Client IDs/secrets are read at call time from the environment; nothing is
 * cached at module load and nothing secret is ever serialized.
 */

/** Official hosts allowed to appear as an authorization/token/identity endpoint. */
const OFFICIAL_HOSTS = Object.freeze([
  "www.facebook.com",
  "graph.facebook.com",
  "accounts.snapchat.com",
  "businessapi.snapchat.com",
  "account.bilibili.com",
  "api.bilibili.com",
]);

/** HTTPS-only, official-host-only endpoint validation (CONVENTIONS Rule 1). */
export function assertOfficialEndpoint(rawUrl) {
  if (typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 512) {
    throw new Error("SOCIAL_OAUTH_ENDPOINT_INVALID");
  }
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("SOCIAL_OAUTH_ENDPOINT_INVALID");
  }
  if (parsed.protocol !== "https:") throw new Error("SOCIAL_OAUTH_ENDPOINT_HTTPS_ONLY");
  if (parsed.username || parsed.password) throw new Error("SOCIAL_OAUTH_ENDPOINT_CREDENTIALS_PROHIBITED");
  if (parsed.port && parsed.port !== "443") throw new Error("SOCIAL_OAUTH_ENDPOINT_PORT_PROHIBITED");
  if (!OFFICIAL_HOSTS.includes(parsed.hostname.toLowerCase())) {
    throw new Error("SOCIAL_OAUTH_ENDPOINT_HOST_NOT_OFFICIAL");
  }
  return parsed;
}

const META_AUTHORIZE = Object.freeze({
  // Graph API v26.0 (latest documented version at time of writing).
  url: "https://www.facebook.com/v26.0/dialog/oauth",
  clientIdParam: "client_id",
  redirectUriParam: "redirect_uri",
  responseTypeParam: "response_type",
  responseTypeValue: "code",
  scopeParam: "scope",
  stateParam: "state",
});

const META_TOKEN = Object.freeze({
  url: "https://graph.facebook.com/v26.0/oauth/access_token",
  method: "GET",
  encoding: "query",
  clientIdParam: "client_id",
  clientSecretParam: "client_secret",
  codeParam: "code",
  redirectUriParam: "redirect_uri",
  // Meta documents this exchange WITHOUT a grant_type parameter.
  grantTypeParam: null,
  grantTypeValue: null,
});

const META_REVOKE = Object.freeze({
  url: "https://graph.facebook.com/v26.0/me/permissions",
  method: "DELETE",
  encoding: "query",
  tokenParam: "access_token",
});

const META_PAGES_URL =
  "https://graph.facebook.com/v26.0/me/accounts?fields=id,name,access_token,instagram_business_account";

/**
 * The frozen governed registry. Keys match the SOCIAL entries in
 * providerCatalog.js so the dashboard's provider list and this registry agree.
 */
export const SOCIAL_OAUTH_PROVIDERS = Object.freeze({
  facebook: Object.freeze({
    providerKey: "facebook",
    displayName: "Facebook Page",
    capabilities: Object.freeze(["publish_video"]),
    scope: "public_profile,pages_show_list,pages_read_engagement",
    pkce: null,
    authorize: META_AUTHORIZE,
    token: META_TOKEN,
    revoke: META_REVOKE,
    identity: Object.freeze({
      url: META_PAGES_URL,
      method: "GET",
      auth: "query",
      parser: "meta_page",
    }),
    identityUnconfirmed: false,
    supportsRefresh: false,
  }),
  instagram: Object.freeze({
    providerKey: "instagram",
    displayName: "Instagram professional account",
    capabilities: Object.freeze(["publish_reel"]),
    scope: "public_profile,pages_show_list,pages_read_engagement,instagram_basic",
    pkce: null,
    authorize: META_AUTHORIZE,
    token: META_TOKEN,
    revoke: META_REVOKE,
    identity: Object.freeze({
      url: META_PAGES_URL,
      method: "GET",
      auth: "query",
      parser: "meta_instagram",
    }),
    identityUnconfirmed: false,
    supportsRefresh: false,
  }),
  snapchat: Object.freeze({
    providerKey: "snapchat",
    displayName: "Snapchat Public Profile",
    capabilities: Object.freeze(["publish_spotlight"]),
    scope: "snapchat-profile-api",
    // Snap's official server-side example uses PKCE with S256.
    pkce: "S256",
    authorize: Object.freeze({
      url: "https://accounts.snapchat.com/login/oauth2/authorize",
      clientIdParam: "client_id",
      redirectUriParam: "redirect_uri",
      responseTypeParam: "response_type",
      responseTypeValue: "code",
      scopeParam: "scope",
      stateParam: "state",
    }),
    token: Object.freeze({
      url: "https://accounts.snapchat.com/login/oauth2/access_token",
      method: "POST",
      encoding: "form",
      clientIdParam: "client_id",
      clientSecretParam: "client_secret",
      codeParam: "code",
      redirectUriParam: "redirect_uri",
      grantTypeParam: "grant_type",
      grantTypeValue: "authorization_code",
    }),
    revoke: null,
    refresh: Object.freeze({
      url: "https://accounts.snapchat.com/login/oauth2/access_token",
      method: "POST",
      encoding: "form",
      clientIdParam: "client_id",
      clientSecretParam: "client_secret",
      refreshTokenParam: "refresh_token",
      grantTypeParam: "grant_type",
      grantTypeValue: "refresh_token",
    }),
    identity: Object.freeze({
      url: "https://businessapi.snapchat.com/v1/public_profiles/my_profile",
      method: "GET",
      auth: "bearer",
      parser: "snapchat_profile",
    }),
    identityUnconfirmed: false,
    supportsRefresh: true,
  }),
  bilibili: Object.freeze({
    providerKey: "bilibili",
    displayName: "Bilibili",
    capabilities: Object.freeze(["publish_video"]),
    scope: null,
    // PKCE is not documented for the official Bilibili account-authorization flow.
    pkce: null,
    authorize: Object.freeze({
      url: "https://account.bilibili.com/pc/account-pc/auth/oauth",
      clientIdParam: "client_id",
      // Bilibili names the registered callback parameter `gourl`.
      redirectUriParam: "gourl",
      responseTypeParam: null,
      responseTypeValue: null,
      scopeParam: null,
      stateParam: "state",
    }),
    token: Object.freeze({
      url: "https://api.bilibili.com/x/account-oauth2/v1/token",
      method: "POST",
      encoding: "form",
      clientIdParam: "client_id",
      clientSecretParam: "client_secret",
      codeParam: "code",
      redirectUriParam: null,
      grantTypeParam: "grant_type",
      grantTypeValue: "authorization_code",
    }),
    revoke: null,
    refresh: Object.freeze({
      url: "https://api.bilibili.com/x/account-oauth2/v1/refresh_token",
      method: "POST",
      encoding: "form",
      clientIdParam: "client_id",
      clientSecretParam: "client_secret",
      refreshTokenParam: "refresh_token",
      grantTypeParam: "grant_type",
      grantTypeValue: "refresh_token",
    }),
    // The official authorized-user identity endpoint could not be confirmed
    // from accessible documentation, so NO identity URL is invented here.
    identity: null,
    identityUnconfirmed: true,
    supportsRefresh: true,
  }),
});

/** The frozen set of connectable social provider keys. */
export const SOCIAL_OAUTH_PROVIDER_KEYS = Object.freeze(Object.keys(SOCIAL_OAUTH_PROVIDERS));

export function getSocialOAuthProvider(providerKey) {
  return SOCIAL_OAUTH_PROVIDERS[providerKey] ?? null;
}

/** Public (secret-free) metadata for one provider, safe for the dashboard. */
export function socialOAuthProviderDto(provider) {
  return {
    providerKey: provider.providerKey,
    displayName: provider.displayName,
    capabilities: [...provider.capabilities],
    pkce: provider.pkce,
    supportsRefresh: provider.supportsRefresh === true,
    identityUnconfirmed: provider.identityUnconfirmed === true,
    connectable: provider.identityUnconfirmed !== true,
  };
}

/**
 * Load one provider's non-secret app configuration from the environment at
 * call time. The env vars name an application-wide developer configuration
 * (Section 6: "developer app IDs ... configured centrally"), never a
 * Director's own account authorization. No value is cached or logged.
 */
export function loadSocialOAuthConfig(providerKey, env = process.env) {
  const prefix = `STPH_${providerKey.toUpperCase()}_OAUTH`;
  return {
    clientId: env[`${prefix}_CLIENT_ID`] || null,
    clientSecret: env[`${prefix}_CLIENT_SECRET`] || null,
    redirectBaseUrl: env.STPH_SOCIAL_OAUTH_REDIRECT_BASE_URL || null,
  };
}

export function isSocialOAuthConfigured(config) {
  return Boolean(config?.clientId && config?.clientSecret && config?.redirectBaseUrl);
}

// Fail closed at module load: a tampered endpoint can never reach production.
for (const provider of Object.values(SOCIAL_OAUTH_PROVIDERS)) {
  assertOfficialEndpoint(provider.authorize.url);
  assertOfficialEndpoint(provider.token.url);
  if (provider.refresh) assertOfficialEndpoint(provider.refresh.url);
  if (provider.revoke) assertOfficialEndpoint(provider.revoke.url);
  if (provider.identity) assertOfficialEndpoint(provider.identity.url.split("?")[0]);
}
