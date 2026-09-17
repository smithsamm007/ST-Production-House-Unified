import test from "node:test";
import assert from "node:assert/strict";
import {
  CHARACTER_RECORD_TYPE,
  MAX_CANONICAL_EVENTS,
  MAX_RELATIONSHIPS,
  appendCanonicalEvent,
  assertSameDirector,
  computeCharacterId,
  createCharacter,
  detectCharacterTampering,
  reviseCharacter,
  serializeCharacter,
  verifyCharacterIntegrity,
} from "../src/characters/characterContinuity.js";

function baseInput(overrides = {}) {
  return {
    agentId: "agent-01",
    characterKey: "meera_shadow_wife",
    displayName: "Meera",
    appearance: "late 20s, kohl-rimmed eyes, red silk saree",
    personality: "calm, watchful, grief-stricken beneath the surface",
    wardrobe: "red silk saree, brass bangles",
    environment: "abandoned haveli, monsoon night",
    timelinePosition: "story-1/episode-3/night",
    voiceProfileRef: { profileId: "profile-jrv-meera-01", note: "low register, slow pace" },
    relationships: [
      { target: "vikram_husband", relation: "widowed wife of" },
      { target: "inspector_rao", relation: "suspects" },
    ],
    canonicalEvents: [{ eventKey: "ep1_disappearance", summary: "Husband vanished on the courtyard night." }],
    ...overrides,
  };
}

test("createCharacter builds a deterministic SHA-256-anchored record", () => {
  const a = createCharacter(baseInput());
  const b = createCharacter(baseInput());
  assert.equal(a.recordType, CHARACTER_RECORD_TYPE);
  assert.equal(a.version, 1);
  assert.equal(a.previousVersionId, null);
  assert.match(a.id, /^[0-9a-f]{64}$/);
  assert.equal(a.id, b.id); // identical inputs → byte-identical record
  assert.equal(JSON.stringify(a), JSON.stringify(b));
  assert.equal(computeCharacterId(a), a.id); // id is recomputed content hash
});

test("integrity verification detects any mutation of a record", () => {
  const record = createCharacter(baseInput());
  assert.equal(verifyCharacterIntegrity(record).intact, true);
  const tampered = { ...record, displayName: "Not Meera" };
  const verdict = verifyCharacterIntegrity(tampered);
  assert.equal(verdict.intact, false);
  assert.equal(verdict.reason, "CHARACTER_ID_MISMATCH");
  assert.match(verdict.expectedId, /^[0-9a-f]{64}$/);
});

test("detectCharacterTampering lists changed fields deterministically", () => {
  const original = createCharacter(baseInput());
  const candidate = createCharacter(baseInput({ wardrobe: "black saree" }));
  assert.deepEqual(detectCharacterTampering(original, candidate), ["wardrobe"]);
  const wrongId = { ...original, id: "0".repeat(64) };
  assert.deepEqual(detectCharacterTampering(original, wrongId), ["id"]);
});

test("free-text fields reject secrets and internal agent names (Rules 15/17)", () => {
  assert.throws(() => createCharacter(baseInput({ appearance: "necklace with vault://kms/key1 locator" })), /CHARACTER_SECRET_REJECTED/);
  assert.throws(() => createCharacter(baseInput({ personality: "modeled on JARVIS" })), /CHARACTER_INTERNAL_NAME_REJECTED/);
  assert.throws(() => createCharacter(baseInput({ characterKey: "api_key_stealer" })), /CHARACTER_SECRET_REJECTED/);
});

test("unregistered agent ids fail closed", () => {
  assert.throws(() => createCharacter(baseInput({ agentId: "agent-999" })), /CHARACTER_AGENT_INVALID/);
  assert.throws(() => createCharacter(baseInput({ agentId: 42 })), /CHARACTER_AGENT_INVALID/);
});

test("cross-Director access fails closed with a stable isolation code", () => {
  const jarvis = createCharacter(baseInput());
  const sherlock = createCharacter(baseInput({ agentId: "agent-02" }));
  assert.throws(() => assertSameDirector(jarvis, sherlock), /CHARACTER_ISOLATION_VIOLATION/);
  assert.equal(assertSameDirector(jarvis, createCharacter(baseInput())), true);
});

test("reviseCharacter produces a new linked version and never rewrites history", () => {
  const v1 = createCharacter(baseInput());
  const v2 = reviseCharacter(v1, { wardrobe: "plain cotton saree", timelinePosition: "story-1/episode-4/dawn" });
  assert.equal(v2.version, 2);
  assert.equal(v2.previousVersionId, v1.id);
  assert.equal(v2.id !== v1.id, true);
  assert.equal(v2.wardrobe, "plain cotton saree");
  assert.equal(v1.wardrobe, "red silk saree, brass bangles"); // original untouched
  // identity/scope fields are immutable across revisions
  assert.throws(() => reviseCharacter(v1, { agentId: "agent-02" }), /CHARACTER_FIELD_IMMUTABLE/);
  assert.throws(() => reviseCharacter(v1, { characterKey: "someone_else" }), /CHARACTER_FIELD_IMMUTABLE/);
  assert.throws(() => reviseCharacter(v1, { displayName: "Mira" }), /CHARACTER_FIELD_IMMUTABLE/);
  // tampered predecessor cannot be revised
  assert.throws(() => reviseCharacter({ ...v1, appearance: "mutated" }, {}), /CHARACTER_ID_MISMATCH/);
});

test("appendCanonicalEvent appends without duplicating event keys", () => {
  const v1 = createCharacter(baseInput());
  const v2 = appendCanonicalEvent(v1, { eventKey: "ep2_flood", summary: "Survived the flooded tunnel." });
  assert.equal(v2.version, 2);
  assert.equal(v2.canonicalEvents.length, 2);
  assert.equal(v2.previousVersionId, v1.id);
  assert.throws(
    () => appendCanonicalEvent(v1, { eventKey: "ep1_disappearance", summary: "duplicate" }),
    /CHARACTER_EVENT_DUPLICATE/,
  );
});

test("bounded fields enforce limits with stable codes", () => {
  assert.throws(() => createCharacter(baseInput({ relationships: Array.from({ length: MAX_RELATIONSHIPS + 1 }, (_, i) => ({ target: `t_${i}_abc`, relation: "knows" })) })), /CHARACTER_RELATIONSHIP_LIMIT/);
  assert.throws(() => createCharacter(baseInput({ canonicalEvents: Array.from({ length: MAX_CANONICAL_EVENTS + 1 }, (_, i) => ({ eventKey: `e_${i}_abc`, summary: "s" })) })), /CHARACTER_EVENT_LIMIT/);
  assert.throws(() => createCharacter(baseInput({ relationships: [{ target: "vikram_husband", relation: "widowed wife of" }, { target: "vikram_husband", relation: "sister of" }] })), /CHARACTER_RELATIONSHIP_DUPLICATE/);
  assert.throws(() => createCharacter(baseInput({ version: 0 })), /CHARACTER_VERSION_INVALID/);
  assert.throws(() => createCharacter(baseInput({ version: 1.5 })), /CHARACTER_VERSION_INVALID/);
});

test("voiceProfileRef is locator-free by construction", () => {
  assert.throws(() => createCharacter(baseInput({ voiceProfileRef: { profileId: "vault://kms/key" } })), /CHARACTER_SECRET_REJECTED/);
  const record = createCharacter(baseInput());
  assert.deepEqual(record.voiceProfileRef, { profileId: "profile-jrv-meera-01", note: "low register, slow pace" });
});

test("serialization is a strict allowlist; polluted fields can never leak", () => {
  const record = createCharacter(baseInput());
  const polluted = { ...record, credentialLocator: "vault://kms/secret", ownerToken: "tok_123", freeText: "call me NEWTON please" };
  const output = serializeCharacter(polluted);
  assert.deepEqual(
    Object.keys(output),
    [
      "recordType",
      "id",
      "agentId",
      "characterKey",
      "displayName",
      "version",
      "previousVersionId",
      "appearance",
      "personality",
      "wardrobe",
      "environment",
      "timelinePosition",
      "voiceProfileRef",
      "relationships",
      "canonicalEvents",
    ],
  );
  assert.equal(JSON.stringify(output).includes("vault://"), false);
  assert.equal(JSON.stringify(output).includes("ownerToken"), false);
  assert.equal(Object.isFrozen(output), true);
  // optional fields left undefined serialize as null
  const minimal = createCharacter(baseInput({ appearance: undefined, voiceProfileRef: undefined, relationships: undefined, canonicalEvents: undefined }));
  const minOut = serializeCharacter(minimal);
  assert.equal(minOut.appearance, null);
  assert.equal(minOut.voiceProfileRef, null);
  assert.deepEqual(minOut.relationships, []);
});

test("serialized output contains no secret-like material for a normal record", () => {
  const record = createCharacter(baseInput());
  const json = JSON.stringify(serializeCharacter(record));
  for (const forbidden of ["password", "vault://", "access_token", "api_key"]) {
    assert.equal(json.toLowerCase().includes(forbidden), false);
  }
});
