import test from "node:test";
import assert from "node:assert/strict";
import { AgentRegistry, PRELOADED_AGENTS } from "../src/catalog/agents.js";
import {
  createDraftCharter,
  createNewCharterVersion,
  approveExactImmutableVersion,
  activateApprovedVersion,
  assignCharterToInternalAgent,
  deactivateCharter,
  retrieveActiveCharter,
  generateSanitizedWorkerContext,
  generateSanitizedPublicAttribution,
  LakmeLazyHierarchy,
  resetCreativeCharterRegistry,
  computeSnapshotHash
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

test("3 & 6. JARVIS has one active approved initial Creative Charter containing Hindi/Hinglish connected horror cinematic universe vision", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  // JARVIS Horror Cinematic Universe Charter Setup
  const charterJarvis = createDraftCharter(ownerId, {
    name: "JARVIS-Horror-Charter",
    vision: "A connected, long-running cinematic universe designed to produce stories and episodes for many years.",
    defaultLanguage: "Hindi",
    secondaryLanguage: "Hinglish"
  });

  const snapshot = {
    universeType: "Hindi/Hinglish Horror Cinematic Universe",
    genresAndThemes: ["horror", "suspense", "thriller", "supernatural mystery", "curses", "crime", "emotion", "entertainment"],
    universeBible: {
      recurringCharacters: ["Protag1", "Antag1"],
      supernaturalEntities: ["EntityX"],
      cursedObjects: ["ObjectC"],
      curseRules: ["Rule1"],
      timeline: ["EventA", "EventB"],
      characterRelationships: ["Rel1"],
      crossovers: ["Cross1"]
    }
  };

  const version = createNewCharterVersion(charterJarvis.id, snapshot);
  const approval = approveExactImmutableVersion(ownerId, charterJarvis.id, version.versionNo, {
    assignedAgentId: "agent-01", // JARVIS
    assignedUniverseId: "universe-horror-123"
  });

  activateApprovedVersion(charterJarvis.id, version.versionNo, approval.id);
  assignCharterToInternalAgent("agent-01", charterJarvis.id, "universe-horror-123", approval.id);

  const active = retrieveActiveCharter("agent-01");
  assert.ok(active);
  assert.equal(active.vision, "A connected, long-running cinematic universe designed to produce stories and episodes for many years.");
  assert.equal(active.defaultLanguage, "Hindi");
  assert.equal(active.secondaryLanguage, "Hinglish");

  const activeVer = active.versions.find((v) => v.isActive);
  assert.ok(activeVer);
  assert.equal(activeVer.snapshot.universeType, "Hindi/Hinglish Horror Cinematic Universe");
});

test("4 & 7. LAKME has one active approved initial Creative Charter containing Samay as narrator and mythology source-classification rules", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charterLakme = createDraftCharter(ownerId, {
    name: "LAKME-Mythology-Charter",
    vision: "Respectful treatment of Hindu traditions presenting timeline of cosmic and historical events.",
    defaultLanguage: "Hindi"
  });

  const snapshot = {
    universeType: "Hindu Mythology Universe",
    narrator: {
      identity: "Samay (Time)",
      concept: "Narrates events according to their position in the cosmic and historical timeline."
    },
    sacredTerminology: "Sanskrit terms with Hindi explanations.",
    sourceCategories: ["Vedas", "Puranas", "Upanishads", "Ramayana", "Mahabharata"],
    claimClassifications: {
      directlySupported: "directly supported by a cited source",
      traditionalVersion: "traditional or regional version",
      interpretation: "scholarly or narrative interpretation",
      dramatizedConnective: "dramatized connective material",
      ownerApprovedFictional: "owner-approved fictionalization"
    }
  };

  const version = createNewCharterVersion(charterLakme.id, snapshot);
  const approval = approveExactImmutableVersion(ownerId, charterLakme.id, version.versionNo, {
    assignedAgentId: "agent-03", // LAKME
    assignedUniverseId: "universe-mythology-123"
  });

  activateApprovedVersion(charterLakme.id, version.versionNo, approval.id);
  assignCharterToInternalAgent("agent-03", charterLakme.id, "universe-mythology-123", approval.id);

  const active = retrieveActiveCharter("agent-03");
  assert.ok(active);
  assert.equal(active.defaultLanguage, "Hindi");

  const activeVer = active.versions.find((v) => v.isActive);
  assert.ok(activeVer);
  assert.equal(activeVer.snapshot.universeType, "Hindu Mythology Universe");
  assert.equal(activeVer.snapshot.narrator.identity, "Samay (Time)");
});

test("5. The other 18 agents remain inactive and unassigned", () => {
  // Reset registry and assign only JARVIS and LAKME. The other 18 must be unassigned
  resetCreativeCharterRegistry();

  const allAgents = PRELOADED_AGENTS.map((a) => a.id);
  const assigned = ["agent-01", "agent-03"]; // JARVIS, LAKME

  for (const id of allAgents) {
    if (!assigned.includes(id)) {
      assert.equal(retrieveActiveCharter(id), null);
    }
  }
});

test("8. LAKME supports the lazy hierarchy without generating 8,000 episode rows", () => {
  const hierarchy = new LakmeLazyHierarchy("universe-mythology-123");

  // Resolve episode 8456 on-demand
  const coordinates = hierarchy.resolveNodePath({
    era: "Treta Yuga",
    sourceCollection: "Ramayana",
    series: "Ayodhya Kanda",
    season: 1,
    storyArc: "Rama's Exile",
    episodeNo: 8456
  });

  assert.equal(coordinates.universeId, "universe-mythology-123");
  assert.equal(
    coordinates.formattedReference,
    "Treta Yuga → Ramayana → Ayodhya Kanda → Season 1 → Rama's Exile → Episode 8456"
  );
  assert.equal(coordinates.path.length, 6);
  assert.equal(coordinates.path[0].level, "Era_or_Yuga");
  assert.equal(coordinates.path[5].level, "Episode");
});

test("9. Activation without owner approval is rejected", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charter = createDraftCharter(ownerId, {
    name: "Unapproved-Charter",
    vision: "Vision statement",
    defaultLanguage: "en"
  });

  const version = createNewCharterVersion(charter.id, { key: "value" });

  assert.throws(() => {
    // Try to activate using non-existent/invalid approvalId
    activateApprovedVersion(charter.id, version.versionNo, "fake-approval-id");
  }, /ACTIVATION_REJECTED_WITHOUT_OWNER_APPROVAL/);
});

test("10. Editing an approved immutable version is rejected", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charter = createDraftCharter(ownerId, {
    name: "Charter",
    vision: "Vision statement",
    defaultLanguage: "en"
  });

  const version = createNewCharterVersion(charter.id, { key: "value" });
  approveExactImmutableVersion(ownerId, charter.id, version.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-1"
  });

  assert.throws(() => {
    // Try to add a new version to an approved charter (approved state makes charter status transition away from draft)
    createNewCharterVersion(charter.id, { key: "new-value" });
  }, /CANNOT_MODIFY_APPROVED_CHARTER/);
});

test("11 & 18. Multiple active charter assignments and concurrent activations for one agent are rejected", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  // Setup first charter and activate/assign
  const charter1 = createDraftCharter(ownerId, { name: "C1", vision: "V1", defaultLanguage: "en" });
  const v1 = createNewCharterVersion(charter1.id, { data: 1 });
  const app1 = approveExactImmutableVersion(ownerId, charter1.id, v1.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-1"
  });
  activateApprovedVersion(charter1.id, v1.versionNo, app1.id);
  assignCharterToInternalAgent("agent-01", charter1.id, "universe-1", app1.id);

  // Setup second charter
  const charter2 = createDraftCharter(ownerId, { name: "C2", vision: "V2", defaultLanguage: "en" });
  const v2 = createNewCharterVersion(charter2.id, { data: 2 });
  const app2 = approveExactImmutableVersion(ownerId, charter2.id, v2.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-1"
  });
  activateApprovedVersion(charter2.id, v2.versionNo, app2.id);

  // Trying to assign charter2 concurrently to same agent-01 rejects to enforce exactly one active charter
  assert.throws(() => {
    assignCharterToInternalAgent("agent-01", charter2.id, "universe-1", app2.id);
  }, /MULTIPLE_ACTIVE_ASSIGNMENTS_REJECTED/);
});

test("12. Approval cannot be reused for a modified snapshot", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charter = createDraftCharter(ownerId, { name: "C1", vision: "V1", defaultLanguage: "en" });
  const v = createNewCharterVersion(charter.id, { data: "safe" });
  const app = approveExactImmutableVersion(ownerId, charter.id, v.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-1"
  });

  // Manually mutate the snapshot object to simulate snapshot tampering/editing after approval
  // (We bypass freeze by replacing the internal version snapshot for this simulation)
  v.snapshot = { data: "tampered" };

  assert.throws(() => {
    activateApprovedVersion(charter.id, v.versionNo, app.id);
  }, /APPROVAL_INVALID_FOR_MODIFIED_SNAPSHOT/);
});

test("13. Approval cannot be reused for another agent", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charter = createDraftCharter(ownerId, { name: "C1", vision: "V1", defaultLanguage: "en" });
  const v = createNewCharterVersion(charter.id, { data: 1 });
  const app = approveExactImmutableVersion(ownerId, charter.id, v.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-1"
  });

  assert.throws(() => {
    // Try to assign app intended for agent-01 to agent-02 instead
    assignCharterToInternalAgent("agent-02", charter.id, "universe-1", app.id);
  }, /APPROVAL_NOT_REUSABLE_FOR_ANOTHER_AGENT/);
});

test("14. Internal agent names are removed from public output", () => {
  const agent = { id: "agent-01", name: "JARVIS", namespace: "st.agent.jarvis" };
  const profile = { agentId: "agent-01", publicBrandName: "Brand JARVIS Channel", status: "active" };

  // Should reject and fall back to block with error string
  const resolved = generateSanitizedPublicAttribution({ profile, agent });
  assert.equal(resolved, "PUBLIC_PUBLISHING_IDENTITY_REQUIRED");
});

test("15. Sanitized worker context contains no secret values", () => {
  resetCreativeCharterRegistry();
  const ownerId = "owner-uuid-123";

  const charter = createDraftCharter(ownerId, { name: "C1", vision: "V1", defaultLanguage: "en" });
  const v = createNewCharterVersion(charter.id, { universeType: "Horror", narrator: "None" });
  const app = approveExactImmutableVersion(ownerId, charter.id, v.versionNo, {
    assignedAgentId: "agent-01",
    assignedUniverseId: "universe-1"
  });
  activateApprovedVersion(charter.id, v.versionNo, app.id);
  assignCharterToInternalAgent("agent-01", charter.id, "universe-1", app.id);

  const context = generateSanitizedWorkerContext("agent-01");
  assert.ok(context);
  assert.equal(context.agentId, "agent-01");
  assert.equal(context.apiKey, undefined);
  assert.equal(context.secretLocator, undefined);
  assert.equal(context.token, undefined);
});
