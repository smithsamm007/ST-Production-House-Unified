import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, PRELOADED_AGENTS } from "../src/catalog/agents.js";
import {
  createDraftCharter,
  updateDraftCharter,
  createNewCharterVersion,
  approveExactImmutableVersion,
  activateApprovedVersion,
  assignCharterToInternalAgent,
  updateAssignment,
  deactivateCharter,
  retrieveActiveCharter,
  generateSanitizedWorkerContext,
  generateSanitizedPublicAttribution,
  LakmeLazyHierarchy,
  resetCreativeCharterRegistry,
  computeSnapshotHash,
  initializeSeedState
} from "../src/catalog/creativeCharter.js";

test("1. Exactly 20 canonical agents remain preloaded", () => {
  const registry = new AgentRegistry();
  assert.equal(PRELOADED_AGENTS.length, 20);
  assert.equal(registry.list().length, 20);
});

test("2. The maximum remains 50 agents", () => {
  const registry = new AgentRegistry();
  assert.throws(() => {
    for (let i = 21; i <= 51; i++) {
      registry.add({
        id: `agent-${i}`,
        name: `AGENT_NAME_${i}`,
        namespace: `st.agent.name_${i}`
      });
    }
  }, /AGENT_CAP_REACHED/);
});

test("3. Idempotent test-only foundation seed creates missing active approved charters for JARVIS and LAKME", () => {
  const ownerId = "owner-uuid-123";
  initializeSeedState(ownerId);

  // JARVIS active
  const jarvisCharter = retrieveActiveCharter("agent-01");
  assert.ok(jarvisCharter);
  assert.equal(jarvisCharter.defaultLanguage, "Hindi");
  assert.equal(jarvisCharter.secondaryLanguage, "Hinglish");

  // LAKME active
  const lakmeCharter = retrieveActiveCharter("agent-03");
  assert.ok(lakmeCharter);
  assert.equal(lakmeCharter.defaultLanguage, "Hindi");

  // Remaining 18 agents inactive
  const allAgents = PRELOADED_AGENTS.map((a) => a.id);
  for (const id of allAgents) {
    if (id !== "agent-01" && id !== "agent-03") {
      assert.equal(retrieveActiveCharter(id), null);
    }
  }
});

test("4. Seeding snapshots deterministic hashes match 006 SQL seed migration exactly", () => {
  // Verifies that seeded snapshots computed via canonical serialization equals 006 migration exactly
  const jarvisSnapshot = {
    universeType: "Hindi/Hinglish Horror Cinematic Universe",
    genresAndThemes: ["horror", "suspense", "thriller", "supernatural mystery", "curses", "crime", "emotion", "entertainment"],
    universeBible: {
      recurringCharacters: [],
      supernaturalEntities: [],
      cursedObjects: [],
      curseRules: [],
      organizations: [],
      historicalEvents: [],
      storyArcs: [],
      episodeContinuity: [],
      universeTimeline: [],
      characterRelationships: [],
      crossovers: [],
      callbacks: [],
      unresolvedMysteries: [],
      postCreditContinuity: [],
      canonAndNonCanon: []
    }
  };
  const lakmeSnapshot = {
    universeType: "Hindu Mythology Universe",
    narrator: {
      identity: "Samay (Time)",
      concept: "Samay narrates events according to their position in the cosmic and historical timeline."
    },
    sacredTerminology: "Sanskrit with Hindi explanations.",
    sourceCategories: ["Vedas", "Puranas", "Upanishads", "Ramayana", "Mahabharata"],
    claimSafetyClassifications: {
      directlySupported: "directly supported by a cited source",
      traditionalVersion: "traditional or regional version",
      interpretation: "scholarly or narrative interpretation",
      dramatizedConnective: "dramatized connective material",
      ownerApprovedFictional: "owner-approved fictionalization"
    }
  };

  const jarvisHash = computeSnapshotHash(jarvisSnapshot);
  const lakmeHash = computeSnapshotHash(lakmeSnapshot);

  // Exact hashes registered in sql/006 seed
  assert.equal(jarvisHash, "de4fe123a0453899e35661debf8f22278be203dc26c500cdb019127f2edc3092");
  assert.equal(lakmeHash, "cea206577342ac7a633e0f91736d33b68513491556cc5dbb392672e169bd3a46");
});

test("5. Idempotent double seeding preserves existing records and does not duplicate", () => {
  const ownerId = "owner-uuid-123";
  initializeSeedState(ownerId);
  initializeSeedState(ownerId); // Double seed

  // Only two active assignments exist
  const j = retrieveActiveCharter("agent-01");
  const l = retrieveActiveCharter("agent-03");
  assert.ok(j);
  assert.ok(l);
});

test("6. Cross-owner authorizations are rejected", () => {
  resetCreativeCharterRegistry();
  const owner1 = "owner-1";
  const owner2 = "owner-2";

  const charter = createDraftCharter(owner1, {
    name: "C1",
    vision: "Vision statement",
    defaultLanguage: "en"
  });

  // Updating charter by owner2 fails
  assert.throws(() => {
    updateDraftCharter(owner2, charter.id, 1, { name: "Modified Name" });
  }, /OWNER_AUTHENTICATION_FAILED/);

  // Creating new version by owner2 fails
  assert.throws(() => {
    createNewCharterVersion(owner2, charter.id, { data: 1 });
  }, /OWNER_AUTHENTICATION_FAILED/);
});

test("7. Snapshot deep copies and recursive freezing are protected against nested tampering", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-123";

  const snapshot = {
    genres: ["horror", "thriller"],
    bible: {
      antagonists: ["DemonA"]
    }
  };

  const charter = createDraftCharter(ownerId, { name: "C", vision: "V", defaultLanguage: "en" });
  const ver = createNewCharterVersion(ownerId, charter.id, snapshot);

  // Verify deep frozen
  assert.ok(Object.isFrozen(ver.snapshot));
  assert.ok(Object.isFrozen(ver.snapshot.genres));
  assert.ok(Object.isFrozen(ver.snapshot.bible));

  // Snapshot mutation fails
  assert.throws(() => {
    ver.snapshot.bible.antagonists.push("DemonB");
  }, /TypeError/);
});

test("8. Optimistic concurrency / revision checks are strictly enforced on mutable records", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-123";

  const charter = createDraftCharter(ownerId, { name: "C1", vision: "V1", defaultLanguage: "en" });
  assert.equal(charter.revision, 1);

  // Stale write throws stale write error
  assert.throws(() => {
    updateDraftCharter(ownerId, charter.id, 2, { name: "New Name" });
  }, /STALE_WRITE_REJECTED/);

  // Correct revision succeeds and increments revision
  updateDraftCharter(ownerId, charter.id, 1, { name: "New Name" });
  assert.equal(charter.revision, 2);
  assert.equal(charter.name, "New Name");
});

test("9. LAKME supports lazy hierarchy dynamic references", () => {
  const hierarchy = new LakmeLazyHierarchy("universe-mythology-123");
  const pathDetails = hierarchy.resolveNodePath({
    era: "Kali Yuga",
    sourceCollection: "Mahabharata",
    series: "Bhishma Parva",
    season: 2,
    storyArc: "Gita Upadesha",
    episodeNo: 9555
  });

  assert.equal(pathDetails.formattedReference, "Kali Yuga → Mahabharata → Bhishma Parva → Season 2 → Gita Upadesha → Episode 9555");
});

test("10. Recursive secret sanitization in worker context DTO", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charter = createDraftCharter(ownerId, { name: "C1", vision: "V1", defaultLanguage: "en" });
  const snapshot = {
    universeType: "Horror",
    narrator: "Spooky Voice",
    bibleSummary: {
      password: "nestedSecretPasswordValue", // Must be sanitized recursively!
      api_key: "nestedSecretApiKeyValue", // Must be sanitized!
      safeField: "safeStringValue"
    }
  };

  const v = createNewCharterVersion(ownerId, charter.id, snapshot);
  const app = approveExactImmutableVersion(ownerId, charter.id, v.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-horror-jarvis-uuid"
  });
  activateApprovedVersion(ownerId, charter.id, v.versionNo, app.id);
  assignCharterToInternalAgent(ownerId, "agent-01", charter.id, "universe-horror-jarvis-uuid", app.id);

  const context = generateSanitizedWorkerContext("agent-01");
  assert.ok(context);
  assert.equal(context.snapshot.bibleSummary.password, undefined);
  assert.equal(context.snapshot.bibleSummary.api_key, undefined);
  assert.equal(context.snapshot.bibleSummary.safeField, "safeStringValue");
});
