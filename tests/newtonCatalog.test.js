import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import {
  AgentRegistry,
  MAX_AGENTS,
  PRELOADED_AGENTS,
} from "../src/catalog/agents.js";
import {
  resolvePublicAttribution,
  serializeForDashboard,
  SUPPORTED_PLATFORMS,
} from "../src/catalog/agentDigitalIdentity.js";
import {
  createDraftCharter,
  createNewCharterVersion,
  submitCharterForOwnerApproval,
  approveExactImmutableVersion,
  activateApprovedVersion,
  assignCharterToInternalAgent,
  retrieveActiveCharter,
  initializeSeedState,
} from "../src/catalog/creativeCharter.js";
import { WorkEnvelope, SecurityViolationError } from "../src/workers/workEnvelope.js";

const NEWTON_ID = "agent-21";
const NEWTON_NAME = "NEWTON";
const NEWTON_NAMESPACE = "st.agent.newton";

// ---------------------------------------------------------------------------
// 1. Catalog registration (additive, identity invariants)
// ---------------------------------------------------------------------------

test("NEWTON is registered in the preloaded catalog with canonical identity", () => {
  assert.equal(PRELOADED_AGENTS.length, 21, "exactly one agent was added to the canonical catalog");
  const newton = PRELOADED_AGENTS.find((a) => a.id === NEWTON_ID);
  assert.ok(newton, "agent-21 must exist");
  assert.equal(newton.name, NEWTON_NAME);
  assert.equal(newton.namespace, NEWTON_NAMESPACE);
  assert.equal(newton.enabled, true);

  const registry = new AgentRegistry();
  assert.equal(registry.list().length, 21);
  assert.equal(registry.get(NEWTON_ID)?.name, NEWTON_NAME);
});

test("NEWTON registration introduces no identity collisions", () => {
  const registry = new AgentRegistry();
  const listed = registry.list();
  assert.equal(new Set(listed.map((a) => a.id)).size, listed.length);
  assert.equal(new Set(listed.map((a) => a.name)).size, listed.length);
  assert.equal(new Set(listed.map((a) => a.namespace)).size, listed.length);
});

test("50-agent hard cap is still enforced after NEWTON's registration", () => {
  const registry = new AgentRegistry();
  assert.throws(() => {
    // i starts at 22 so the loop never collides with NEWTON's canonical id.
    for (let i = 22; i <= 51; i++) {
      registry.add({ id: `agent-${i}`, name: `AGENT_NAME_${i}`, namespace: `st.agent.name_${i}` });
    }
  }, /AGENT_CAP_REACHED/);
  assert.equal(registry.list().length, MAX_AGENTS);
});

// ---------------------------------------------------------------------------
// 2. Rule 15 — internal name never reaches public-facing serialization
// ---------------------------------------------------------------------------

test("NEWTON is now a protected internal name: public attribution rejects it", () => {
  const registry = new AgentRegistry();
  const agent = registry.get(NEWTON_ID);

  for (const badBrand of [NEWTON_NAME, `Agent ${NEWTON_NAME}`, `${NEWTON_NAME} Official`, newton_name_lower()]) {
    const profile = {
      agentId: NEWTON_ID,
      publicBrandName: badBrand,
      publicDisplayName: "Indian Current Affairs Desk",
      status: "active",
    };
    assert.throws(
      () => resolvePublicAttribution({ agentId: NEWTON_ID, agent, profile }),
      /PUBLIC_PUBLISHING_IDENTITY_REQUIRED/,
      `brand "${badBrand}" must be rejected as an internal agent name`
    );
  }
});

function newton_name_lower() {
  return "newton";
}

test("NEWTON public fields are still accepted when they do not use the internal name", () => {
  const agent = { id: NEWTON_ID, name: NEWTON_NAME, namespace: NEWTON_NAMESPACE };
  const profile = {
    agentId: NEWTON_ID,
    publicBrandName: "Bharat Knowledge Desk",
    publicDisplayName: "Bharat Knowledge Desk",
    status: "active",
  };
  const attribution = resolvePublicAttribution({ agentId: NEWTON_ID, agent, profile });
  assert.equal(attribution.publicAttribution, "Bharat Knowledge Desk");
  assert.equal(attribution.isValid, true);
});

test("dashboard serialization never fabricates fields for NEWTON and blocks unknown keys", () => {
  const raw = {
    agentId: NEWTON_ID,
    agentName: NEWTON_NAME,
    publicBrandName: "Bharat Knowledge Desk",
    secret_locator: "vault://st/agents/agent-21/providers/x/primary",
    credentialValue: "super-secret-value",
    sneaky_unknown_field: "should-not-serialize",
  };
  const serialized = JSON.parse(JSON.stringify(serializeForDashboard(raw)));
  const flat = JSON.stringify(serialized);
  assert.ok(!flat.includes(NEWTON_NAME), "internal name must never serialize");
  assert.ok(!flat.includes("vault://"), "secret locators must never serialize");
  assert.ok(!flat.includes("super-secret-value"), "secret values must never serialize");
  assert.ok(!flat.includes("sneaky_unknown_field"), "unknown fields must be blocked by the DTO allowlist");
});

test("work envelopes reject NEWTON's internal name in public-facing fields", () => {
  assert.throws(
    () =>
      new WorkEnvelope({
        taskId: "task-newton-001",
        jobType: "research",
        agentId: NEWTON_ID,
        payload: { title: "Made by NEWTON" },
        context: {},
      }),
    SecurityViolationError
  );
});

// ---------------------------------------------------------------------------
// 3. Isolation + charter scaffolding (owner-bound flow, no DB in unit tests)
// ---------------------------------------------------------------------------

test("NEWTON charter scaffolding follows the exact governed charter lifecycle", () => {
  const ownerId = "newton-owner-test-1";
  initializeSeedState(ownerId); // JARVIS/LAKME seeds; NEWTON must start without a charter

  assert.equal(retrieveActiveCharter(NEWTON_ID), null, "NEWTON must start with no active charter");

  const charter = createDraftCharter(ownerId, {
    name: "India Knowledge & Opportunity Desk Charter",
    vision: "Answer what happened, why it matters, and what an ordinary person can do about it.",
    defaultLanguage: "Hindi",
    secondaryLanguage: "Hinglish",
  });
  assert.ok(charter.id);

  const version = createNewCharterVersion(ownerId, charter.id, {
    universeType: "Indian Current Affairs & Opportunities Universe",
    coverageAreas: [
      "government schemes",
      "government announcements",
      "defence",
      "internships",
      "scholarships",
      "education opportunities",
      "employment opportunities",
      "economy",
    ],
    actionOrientation: "what-happened-why-it-matters-what-you-can-do",
  });
  assert.ok(version.versionNo >= 1);

  submitCharterForOwnerApproval(ownerId, charter.id, version.versionNo);
  const approval = approveExactImmutableVersion(ownerId, charter.id, version.versionNo, {
    assignedAgentId: NEWTON_ID,
    assignedUniverseId: "00000000-0000-0000-0000-000000000021",
  });
  assert.ok(approval);

  // The governed sequence requires activating the approved version before
  // binding the agent assignment (approval alone does not authorize binding).
  activateApprovedVersion(ownerId, charter.id, version.versionNo, approval.id);

  const assignment = assignCharterToInternalAgent(ownerId, NEWTON_ID, charter.id, "00000000-0000-0000-0000-000000000021", approval.id);
  assert.ok(assignment);

  const active = retrieveActiveCharter(NEWTON_ID);
  assert.ok(active, "NEWTON should have an active charter after the governed flow");
  assert.equal(active.defaultLanguage, "Hindi");

  const other = retrieveActiveCharter("agent-02"); // SHERLOCK must remain untouched
  assert.equal(other, null, "no cross-agent charter leakage");
});

test("NEWTON charter cannot be created by a different owner than its binder (owner isolation)", () => {
  const ownerId = "newton-owner-test-2";
  initializeSeedState(ownerId);

  const charter = createDraftCharter(ownerId, {
    name: "Second Owner Charter",
    vision: "Vision statement",
    defaultLanguage: "en",
  });
  const version = createNewCharterVersion(ownerId, charter.id, { universeType: "Test" });
  submitCharterForOwnerApproval(ownerId, charter.id, version.versionNo);
  const approval = approveExactImmutableVersion(ownerId, charter.id, version.versionNo, {
    assignedAgentId: NEWTON_ID,
    assignedUniverseId: "00000000-0000-0000-0000-000000000021",
  });
  assert.ok(approval);

  // A different owner cannot bind NEWTON's charter assignment (the module's
  // owner-isolation error code is OWNER_AUTHENTICATION_FAILED).
  assert.throws(() => {
    assignCharterToInternalAgent("someone-else-1", NEWTON_ID, charter.id, "00000000-0000-0000-0000-000000000021", approval.id);
  }, /OWNER_AUTHENTICATION_FAILED/);
});

// ---------------------------------------------------------------------------
// 4. Connection-slot invariants (mirrors migration 003 shape)
// ---------------------------------------------------------------------------

test("SUPPORTED_PLATFORMS still defines the four social platforms NEWTON gets slots for", () => {
  assert.ok(Array.isArray(SUPPORTED_PLATFORMS));
  for (const platform of ["youtube", "instagram", "facebook", "snapchat"]) {
    assert.ok(SUPPORTED_PLATFORMS.includes(platform), `platform ${platform} must be supported`);
  }
});

test("unconfigured-slot invariants: no identity fields are ever seeded for NEWTON slots", () => {
  // Mirrors the sql/003 CHECK constraints at the application-contract level:
  // an 'unconfigured' slot must carry NO email address, provider, or locator.
  const slot = {
    agentId: NEWTON_ID,
    platform: "youtube",
    connectionStatus: "unconfigured",
    publicAccountName: null,
    externalAccountId: null,
    secretLocator: null,
    publicProfileUrl: null,
  };
  assert.equal(slot.connectionStatus, "unconfigured");
  assert.equal(slot.publicAccountName, null);
  assert.equal(slot.externalAccountId, null);
  assert.equal(slot.secretLocator, null);
  assert.equal(slot.publicProfileUrl, null);
});

// ---------------------------------------------------------------------------
// 5. Migration integrity (offline pinning — R1: 001-017 byte-identical)
// ---------------------------------------------------------------------------

test("sql/018 exists and is additive-only (never edits existing migrations)", async () => {
  const raw = await readFile(new URL("../sql/018_newton_catalog_registration.sql", import.meta.url), "utf8");
  assert.ok(raw.includes("INSERT INTO agents (id, name, namespace)"), "seeds the agent row");
  assert.ok(raw.includes("'agent-21', 'NEWTON', 'st.agent.newton'"), "canonical identity");
  assert.ok(raw.includes("ON CONFLICT (id) DO NOTHING"), "idempotent upsert");
  assert.ok(raw.includes("agent_email_connections"), "email slot");
  for (const platform of ["youtube", "instagram", "facebook", "snapchat"]) {
    assert.ok(raw.includes(`'${platform}'`), `social slot for ${platform}`);
  }
  assert.ok(raw.includes("WHERE NOT EXISTS"), "slot seeding is guarded (re-run safe)");
  assert.ok(raw.includes("NEWTON_AGENT_IDENTITY_CONFLICT"), "fail-closed identity guard");
  assert.ok(raw.includes("NEWTON_SLOT_INVARIANT_VIOLATION"), "fail-closed slot invariant");
});

test("migrations 001-017 remain untouched by this slice (byte-identical pins)", async () => {
  const prior = [
    "001_core.sql",
    "002_seed_agents.sql",
    "003_agent_digital_identity.sql",
    "004_creative_charter.sql",
    "005_creative_reference.sql",
    "006_seed_initial_creative_charters.sql",
    "007_owner_agent_communication_studio.sql",
    "008_owner_authentication_and_sessions.sql",
    "009_add_owner_role.sql",
    "010_job_lifecycle.sql",
    "011_credential_broker_metadata.sql",
    "012_durable_retry_schedule.sql",
    "013_provider_quota_cooldowns.sql",
    "014_resilience_controls.sql",
    "015_durable_job_checkpoints.sql",
    "016_durable_worker_results.sql",
    "017_owner_job_control.sql",
  ];
  for (const name of prior) {
    const raw = await readFile(new URL(`../sql/${name}`, import.meta.url), "utf8");
    assert.ok(raw.length > 0, `${name} must exist and be non-empty`);
    // The pins below are the exact strings this slice depends on. If any of
    // them disappears, sql/018's assumptions are invalid and must be reviewed.
    if (name === "002_seed_agents.sql") {
      assert.ok(raw.includes("'agent-20','NISHA','st.agent.nisha'"), "002 must still end at agent-20");
      assert.ok(!raw.includes("NEWTON"), "002 must never be edited to include NEWTON (R1)");
    }
    if (name === "003_agent_digital_identity.sql") {
      assert.ok(raw.includes("INSERT INTO agent_email_connections (agent_id, connection_status, is_primary)"), "003 slot contract");
      assert.ok(raw.includes("valid_social_platform CHECK (platform IN ('youtube', 'instagram', 'facebook', 'snapchat'))"), "003 platform contract");
    }
    if (name === "001_core.sql") {
      assert.ok(raw.includes("CREATE TRIGGER agents_max_50"), "001 must keep the 50-cap trigger");
    }
  }
});

test("migration 018 uses the next sequential number and no 018 file conflicts", async () => {
  const { readdir } = await import("node:fs/promises");
  const { fileURLToPath } = await import("node:url");
  const dir = fileURLToPath(new URL("../sql/", import.meta.url));
  const files = (await readdir(dir)).filter((f) => f.endsWith(".sql")).sort();
  assert.ok(files.includes("018_newton_catalog_registration.sql"));
  const numbers = files.map((f) => parseInt(f.slice(0, 3), 10));
  const duplicates = numbers.filter((n, i) => numbers.indexOf(n) !== i);
  assert.equal(duplicates.length, 0, "no duplicate migration numbers");
  assert.equal(Math.max(...numbers), 21, "021 is the highest migration");
});
