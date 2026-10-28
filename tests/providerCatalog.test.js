import test from "node:test";
import assert from "node:assert/strict";
import {
  CONNECTION_KINDS,
  PROVIDER_CATALOG,
  catalogDto,
  isLocatorShapedSecretFields,
  listCatalog,
  registerCustomProvider,
  validateCustomProviderDefinition,
  validateProviderMetadataUrl,
} from "../src/catalog/providerCatalog.js";

test("catalog entries carry official HTTPS credential URLs and field schemas", () => {
  const catalog = listCatalog();
  assert.ok(catalog.length >= 13, "catalog covers llm/media/image/email/social");
  for (const entry of catalog) {
    assert.ok(CONNECTION_KINDS.includes(entry.category), `${entry.providerKey} category is a closed enum`);
    for (const url of [entry.websiteUrl, entry.credentialUrl]) {
      if (url !== null) {
        assert.ok(url.startsWith("https://"), `${entry.providerKey} URL must be HTTPS`);
      }
    }
    assert.ok(Array.isArray(entry.fields) && entry.fields.length > 0);
    for (const field of entry.fields) {
      assert.ok(["secret", "config"].includes(field.kind), "field kinds are closed");
      assert.equal(typeof field.required, "boolean");
    }
  }
});

test("key providers expose the official credential pages the owner would otherwise search for", () => {
  assert.equal(catalogDto("gemini").credentialUrl, "https://aistudio.google.com/app/apikey");
  assert.equal(catalogDto("anthropic").credentialUrl, "https://console.anthropic.com/settings/keys");
  assert.equal(catalogDto("openai").credentialUrl, "https://platform.openai.com/api-keys");
  assert.equal(catalogDto("elevenlabs").credentialUrl, "https://elevenlabs.io/app/settings/api-keys");
  assert.equal(catalogDto("youtube").credentialUrl, "https://console.cloud.google.com/apis/credentials");
  assert.equal(catalogDto("instagram").credentialUrl, "https://developers.facebook.com/apps");
  assert.equal(catalogDto("bilibili").credentialUrl, "https://member.bilibili.com/platform/upload/video/frame");
});

test("catalog is pure metadata: no secret-shaped material anywhere", () => {
  const serialized = JSON.stringify(listCatalog());
  assert.ok(!serialized.includes("vault://"));
  assert.ok(!serialized.includes("opaque://"));
  assert.ok(!/api_key\s*[:=]\s*"[^"]+"/i.test(serialized), "no credential values in metadata");
  // Rule 15: provider metadata carries no agent identity at all.
  assert.ok(!/(JARVIS|SHERLOCK|LAKME|VEDA|PANCHI)/.test(serialized));
});

test("secret-fields locator shape check fails closed on every hostile shape", () => {
  assert.equal(isLocatorShapedSecretFields({ api_key: "vault://a/b" }), true);
  assert.equal(isLocatorShapedSecretFields({ api_key: "opaque://x" }), true);
  assert.equal(isLocatorShapedSecretFields({ api_key: "sk-plaintext" }), false);
  assert.equal(isLocatorShapedSecretFields({ api_key: "" }), false);
  assert.equal(isLocatorShapedSecretFields({ api_key: 42 }), false);
  assert.equal(isLocatorShapedSecretFields({}), false, "empty map is not a valid secret set");
  assert.equal(isLocatorShapedSecretFields(null), false);
  assert.equal(isLocatorShapedSecretFields([("vault://x")]), false);
});

test("provider metadata URL validation enforces transport safety", () => {
  validateProviderMetadataUrl("https://runpod.io/console"); // no throw
  assert.throws(() => validateProviderMetadataUrl("http://runpod.io"), /HTTPS_ONLY_REQUIRED/);
  assert.throws(() => validateProviderMetadataUrl("https://user:pass@runpod.io"), /EMBEDDED_CREDENTIALS_PROHIBITED/);
  assert.throws(() => validateProviderMetadataUrl("https://runpod.io:8443"), /NON_STANDARD_PORTS_PROHIBITED/);
  assert.throws(() => validateProviderMetadataUrl("https://localhost/console"), /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);
  assert.throws(() => validateProviderMetadataUrl("https://127.0.0.1/console"), /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);
  assert.throws(() => validateProviderMetadataUrl("https://10.0.0.9/"), /PRIVATE_OR_LOCALHOST_TARGET_REJECTED/);
  assert.throws(() => validateProviderMetadataUrl("not a url"), /INVALID_URL_FORMAT/);
});

test("custom provider registration returns a NEW frozen catalog and never mutates the governed one", () => {
  const before = Object.keys(PROVIDER_CATALOG).length;
  const next = registerCustomProvider(PROVIDER_CATALOG, {
    providerKey: "runpod",
    displayName: "RunPod",
    category: "llm",
    authType: "api_key",
    websiteUrl: "https://runpod.io",
    credentialUrl: "https://runpod.io/console",
    fields: [{ key: "api_key", kind: "secret" }],
    capabilities: ["text_generation"],
  });
  assert.equal(Object.keys(next).length, before + 1);
  assert.equal(Object.keys(PROVIDER_CATALOG).length, before, "governed catalog untouched");
  assert.ok(Object.isFrozen(next));
  const dto = catalogDto("runpod", next);
  assert.equal(dto.displayName, "RunPod");
  assert.equal(dto.fields[0].required, true, "secret fields default to required");
  assert.equal(catalogDto("runpod"), null, "custom provider is not in the default catalog");
});

test("custom provider validation rejects reserved keys and hostile definitions", () => {
  assert.throws(
    () => validateCustomProviderDefinition({ providerKey: "gemini", displayName: "Fake Gemini", category: "llm", fields: [{ key: "api_key", kind: "secret" }], capabilities: ["c"] }),
    /CUSTOM_PROVIDER_KEY_RESERVED/,
  );
  assert.throws(
    () => validateCustomProviderDefinition({ providerKey: "bad key!", displayName: "X", category: "llm", fields: [{ key: "api_key", kind: "secret" }], capabilities: ["c"] }),
    /CUSTOM_PROVIDER_KEY_INVALID/,
  );
  assert.throws(
    () => validateCustomProviderDefinition({ providerKey: "okkey", displayName: "XY", category: "kubernetes", fields: [{ key: "api_key", kind: "secret" }], capabilities: ["c"] }),
    /CUSTOM_PROVIDER_CATEGORY_INVALID/,
  );
  assert.throws(
    () => validateCustomProviderDefinition({ providerKey: "okkey", displayName: "XY", category: "llm", websiteUrl: "http://insecure.example", fields: [{ key: "api_key", kind: "secret" }], capabilities: ["c"] }),
    /HTTPS_ONLY_REQUIRED/,
  );
  assert.throws(
    () => validateCustomProviderDefinition({ providerKey: "okkey", displayName: "XY", category: "llm", fields: [{ key: "DROP TABLE", kind: "secret" }], capabilities: ["c"] }),
    /CUSTOM_PROVIDER_FIELDS_INVALID/,
  );
  assert.throws(
    () => validateCustomProviderDefinition({ providerKey: "okkey", displayName: "XY", category: "llm", fields: [{ key: "api_key", kind: "secret" }] }),
    /CUSTOM_PROVIDER_CAPABILITIES_INVALID/,
  );
  assert.throws(() => validateCustomProviderDefinition(null), /CUSTOM_PROVIDER_DEFINITION_REQUIRED/);
});
