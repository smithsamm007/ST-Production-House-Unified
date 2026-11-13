/**
 * ST Production House — Canonical Director retirement enforcement tests (Phase 2C).
 *
 * Proves the operational write-path rule end to end over the real modules:
 *   - `enforceOperationalActive` passes ungoverned and active Directors, and throws
 *     `CANONICAL_DIRECTOR_NOT_ACTIVE` for a retired/suspended mapping;
 *   - `createHermesJobBridge` refuses to queue production for a retired Director and
 *     records the refusal honestly (no release, no job, no evidence);
 *   - the database trigger path (sql/032) is exercised only by the existing
 *     PostgreSQL integration suite; migration rehearsal against a live PostgreSQL 15
 *     instance remains BLOCKED in this environment.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  enforceOperationalActive,
  createCanonicalDirectorGuard,
} from "../src/catalog/canonicalDirectorLifecycle.js";
import { createHermesJobBridge } from "../src/manager/hermesJobBridge.js";

/** Minimal lifecycle adapter: one mapping lookup, nothing else. */
function lifecycleAdapter(mappings) {
  return {
    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, " ").trim();
      if (s.includes("underlying_agent_id = $1") && s.includes("canonical_director_mappings")) {
        const activeOnly = s.includes("status = 'active'");
        const target = mappings.find(
          (m) => m.underlying_agent_id === params[0] && (!activeOnly || m.status === "active")
        );
        return { rows: target ? [target] : [], rowCount: target ? 1 : 0 };
      }
      throw new Error(`lifecycleAdapter: unsupported statement: ${s.slice(0, 80)}`);
    },
  };
}

const ACTIVE_JARVIS = Object.freeze({
  id: "m-jarvis",
  canonical_director_code: "JARVIS",
  underlying_agent_id: "agent-01",
  display_name: "JARVIS",
  namespace: "st.agent.jarvis",
  status: "active",
  retired_at: null,
  retired_reason: null,
  suspended_note: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-01T00:00:00.000Z",
});

const RETIRED_PANCHI = Object.freeze({
  id: "m-panchi",
  canonical_director_code: "PANCHI-RETIRED",
  underlying_agent_id: "agent-04",
  display_name: "PANCHI",
  namespace: "st.agent.panchi",
  status: "retired",
  retired_at: "2026-02-01T00:00:00.000Z",
  retired_reason: "legacy identity retired in place",
  suspended_note: null,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-02-01T00:00:00.000Z",
});

// ------------------------------------------------- direct guard behaviour

test("Phase 2C: an ungoverned agent passes operational enforcement", async () => {
  const result = await enforceOperationalActive(lifecycleAdapter([ACTIVE_JARVIS]), "agent-77");
  assert.equal(result, null);
});

test("Phase 2C: an active Director passes operational enforcement", async () => {
  const result = await enforceOperationalActive(lifecycleAdapter([ACTIVE_JARVIS]), "agent-01");
  assert.equal(result.canonicalDirectorCode, "JARVIS");
});

test("Phase 2C: a retired Director is refused at operational enforcement", async () => {
  await assert.rejects(
    () => enforceOperationalActive(lifecycleAdapter([RETIRED_PANCHI]), "agent-04"),
    /CANONICAL_DIRECTOR_NOT_ACTIVE/
  );
});

test("Phase 2C: no configured storage degrades to 'not governed'", async () => {
  assert.equal(await enforceOperationalActive(null, "agent-01"), null);
  assert.equal(await enforceOperationalActive(undefined, "agent-01"), null);
});

test("Phase 2C: a pre-migration database (undefined table) does not block writes", async () => {
  const adapter = {
    async query() {
      const error = new Error('relation "canonical_director_mappings" does not exist');
      error.code = "42P01";
      throw error;
    },
  };
  assert.equal(await enforceOperationalActive(adapter, "agent-01"), null);
});

test("Phase 2C: the guard exposes isActive for positive checks", async () => {
  const guard = createCanonicalDirectorGuard(lifecycleAdapter([ACTIVE_JARVIS, RETIRED_PANCHI]));
  assert.equal(await guard.isActive("agent-01"), true);
  assert.equal(await guard.isActive("agent-04"), false);
  assert.equal(await guard.isActive("agent-77"), false);
  assert.equal(await guard.isActive(""), false);
});

// ------------------------------------------------ HERMES bridge refusal

function bridgeFixture({ agentId = "agent-04" } = {}) {
  const appended = [];
  const created = [];
  const completions = [];

  const production = {
    async getChannel(ownerId, channelId) {
      return {
        id: channelId,
        agentId,
        agentEnabled: true,
        ownerId,
      };
    },
    async createReleaseWithJob(ownerId, input) {
      created.push(input);
      return { release: { id: "release-1" }, jobId: "job-1", conflict: false };
    },
  };

  const evidence = {
    async append(event) {
      appended.push(event);
      return { id: "evidence-1", ...event };
    },
  };

  const manager = {
    async getDecision() {
      return {
        decisionNumber: 7,
        action: "production.start",
        outcome: "EXECUTING",
        directorId: agentId,
        payload: { channelId: "channel-1", title: "Ep 1", season: 1, episode: 1 },
      };
    },
    async completeDecision(_number, options) {
      completions.push(options);
      return { decisionNumber: 7, outcome: options.succeeded ? "EXECUTED" : "FAILED" };
    },
  };

  return { production, evidence, manager, created, appended, completions };
}

test("Phase 2C: the bridge refuses to queue production for a retired Director", async () => {
  const fixture = bridgeFixture({ agentId: "agent-04" });
  const guard = createCanonicalDirectorGuard(lifecycleAdapter([RETIRED_PANCHI]));

  const bridge = createHermesJobBridge({
    production: fixture.production,
    evidence: fixture.evidence,
    canonicalGuard: guard,
  });

  const result = await bridge(fixture.manager, "owner-1", 7);

  assert.equal(result.status, "FAILED");
  assert.equal(result.errorCode, "CANONICAL_DIRECTOR_NOT_ACTIVE");
  assert.equal(fixture.created.length, 0, "no release/job is created");
  assert.equal(fixture.appended.length, 0, "no production_queued evidence is written");
  assert.equal(fixture.completions.length, 1, "the refusal is recorded honestly");
  assert.equal(fixture.completions[0].succeeded, false);
});

test("Phase 2C: the bridge still queues production for an active Director", async () => {
  const fixture = bridgeFixture({ agentId: "agent-01" });
  const guard = createCanonicalDirectorGuard(lifecycleAdapter([ACTIVE_JARVIS]));

  const bridge = createHermesJobBridge({
    production: fixture.production,
    evidence: fixture.evidence,
    canonicalGuard: guard,
  });

  const result = await bridge(fixture.manager, "owner-1", 7);

  assert.equal(result.status, "QUEUED");
  assert.equal(fixture.created.length, 1);
  assert.equal(fixture.appended.length, 1);
  assert.equal(fixture.appended[0].kind, "production_queued");
});

test("Phase 2C: without a guard the bridge keeps its pre-cutover behaviour", async () => {
  const fixture = bridgeFixture({ agentId: "agent-04" });
  const bridge = createHermesJobBridge({
    production: fixture.production,
    evidence: fixture.evidence,
  });

  const result = await bridge(fixture.manager, "owner-1", 7);
  assert.equal(result.status, "QUEUED");
});
