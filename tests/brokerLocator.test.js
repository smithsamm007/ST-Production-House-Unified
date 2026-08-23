import test from "node:test";
import assert from "node:assert/strict";
import {
  mintLocator,
  parseLocator,
  isValidLocator,
  LocatorError
} from "../src/broker/locator.js";

test("Credential Broker Locator - Round-trip: mintLocator -> parseLocator returns identical id and version v1", () => {
  const minted = mintLocator();
  assert.ok(minted.id);
  assert.ok(minted.issuedAt);
  assert.ok(minted.id.startsWith("loc_v1_"));

  const parsed = parseLocator(minted.id);
  assert.strictEqual(parsed.id, minted.id);
  assert.strictEqual(parsed.version, "v1");

  // Also test parseLocator given object returned by mintLocator
  const parsedObj = parseLocator(minted);
  assert.strictEqual(parsedObj.id, minted.id);
  assert.strictEqual(parsedObj.version, "v1");

  // isValidLocator returns true
  assert.strictEqual(isValidLocator(minted.id), true);
  assert.strictEqual(isValidLocator(minted), true);
});

test("Credential Broker Locator - Tamper tests: empty string, null, undefined, whitespace rejected with EMPTY code", () => {
  const emptyInputs = ["", "   ", null, undefined, { id: "" }];
  for (const input of emptyInputs) {
    assert.throws(
      () => parseLocator(input),
      (err) => {
        assert.ok(err instanceof LocatorError);
        assert.strictEqual(err.code, "EMPTY");
        return true;
      }
    );
    assert.strictEqual(isValidLocator(input), false);
  }
});

test("Credential Broker Locator - Tamper tests: wrong prefix, flipped chars, non-string/invalid structure rejected with MALFORMED code", () => {
  const malformedInputs = [
    "vault://secret/path",
    "opaque://secret/key",
    "invalid_v1_mHN7uvQ3TvY1ov-2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    "loc_1_mHN7uvQ3TvY1ov-2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    // Flipped characters (+ / = instead of base64url - _)
    "loc_v1_mHN7uvQ3TvY1ov+2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    "loc_v1_mHN7uvQ3TvY1ov/2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    "loc_v1_mHN7uvQ3TvY1ov=2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    // Incorrect length
    "loc_v1_short",
    "loc_v1_mHN7uvQ3TvY1ov-2mghVyDffJz4Z-4EGHIEkN9vhWw4EXTRA",
    // Non-string primitive / object types
    12345,
    true,
    [],
    {}
  ];

  for (const input of malformedInputs) {
    assert.throws(
      () => parseLocator(input),
      (err) => {
        assert.ok(err instanceof LocatorError);
        assert.strictEqual(err.code, "MALFORMED");
        return true;
      }
    );
    assert.strictEqual(isValidLocator(input), false);
  }
});

test("Credential Broker Locator - Tamper tests: loc_v9_... and unsupported version prefix rejected with WRONG_VERSION code", () => {
  const wrongVersionInputs = [
    "loc_v2_mHN7uvQ3TvY1ov-2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    "loc_v9_mHN7uvQ3TvY1ov-2mghVyDffJz4Z-4EGHIEkN9vhWw4",
    "loc_v0_mHN7uvQ3TvY1ov-2mghVyDffJz4Z-4EGHIEkN9vhWw4"
  ];

  for (const input of wrongVersionInputs) {
    assert.throws(
      () => parseLocator(input),
      (err) => {
        assert.ok(err instanceof LocatorError);
        assert.strictEqual(err.code, "WRONG_VERSION");
        return true;
      }
    );
    assert.strictEqual(isValidLocator(input), false);
  }
});

test("Credential Broker Locator - Uniqueness: 10,000 mints produce 10,000 distinct ids", () => {
  const set = new Set();
  const count = 10000;
  for (let i = 0; i < count; i++) {
    const loc = mintLocator();
    set.add(loc.id);
  }
  assert.strictEqual(set.size, count);
});

test("Credential Broker Locator - No secret leak test: locator contains NO provider name, NO agent name, NO secret", () => {
  const locator = mintLocator();

  // Check string representation and serialization
  const strVal = String(locator);
  const jsonVal = JSON.stringify(locator);

  assert.strictEqual(strVal, locator.id);
  assert.strictEqual(jsonVal, JSON.stringify(locator.id));

  // Ensure no secret markers, provider names, or agent names exist
  const providerNames = ["openai", "anthropic", "google", "aws", "azure"];
  const agentNames = ["JARVIS", "SHERLOCK", "VEDA", "LAKME", "PANCHI"];
  const secretKeywords = ["secret", "password", "api_key", "token", "private_key"];

  for (const provider of providerNames) {
    assert.strictEqual(locator.id.toLowerCase().includes(provider), false);
  }
  for (const agent of agentNames) {
    assert.strictEqual(locator.id.toLowerCase().includes(agent.toLowerCase()), false);
  }
  for (const keyword of secretKeywords) {
    assert.strictEqual(locator.id.toLowerCase().includes(keyword), false);
  }
});

test("Credential Broker Locator - isValidLocator: never throws under any condition", () => {
  const hostileInputs = [
    null, undefined, "", 0, NaN, Infinity, -1, {}, [],
    Symbol("test"), () => {}, new Date(), /regex/
  ];

  for (const input of hostileInputs) {
    assert.doesNotThrow(() => {
      const result = isValidLocator(input);
      assert.strictEqual(typeof result, "boolean");
    });
  }
});
