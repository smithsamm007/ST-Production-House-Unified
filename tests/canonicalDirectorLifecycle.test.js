/**
 * ST Production House — Canonical Director registry tests (Phase 2A).
 *
 * Verifies the corrected invariant chain over the REAL repository implementation:
 *   - the closed canonical code set and unknown-code rejection,
 *   - active-only cap (50) enforced on the cap-locked activation path,
 *   - serialized activation through the dedicated cap-lock row,
 *   - retirement and suspension semantics (history preserved, no reuse),
 *   - operational guards refusing retired/suspended Directors,
 *   - the four preserved keys and the six new underlying IDs.
 *
 * The adapter below is a small in-memory SQL stand-in that answers exactly the
 * statements the repository issues. It is NOT a general SQL engine, and it is not
 * proof of PostgreSQL behaviour: migration/trigger rehearsal against a live
 * PostgreSQL 15 instance remains BLOCKED in this environment (no authorized
 * isolated instance is available).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CanonicalDirectorRepository,
  CANONICAL_DIRECTOR_CODES,
  NEW_UNDERLYING_AGENT_IDS,
  PRESERVED_UNDERLYING_AGENT_IDS,
  ACTIVE_DIRECTOR_CAP,
} from "../src/catalog/canonicalDirectorRepository.js";
import { createCanonicalDirectorGuard } from "../src/catalog/canonicalDirectorLifecycle.js";

function rowFixture(overrides = {}) {
  const code = overrides.canonical_director_code ?? "JARVIS";
  const slug = code.toLowerCase().replace(/[^a-z0-9]/g, "");
  return {
    id: overrides.id ?? `m-${slug}`,
    canonical_director_code: code,
    underlying_agent_id: overrides.underlying_agent_id ?? "agent-01",
    display_name: overrides.display_name ?? code,
    namespace: overrides.namespace ?? `st.agent.${slug}`,
    status: overrides.status ?? "retired",
    retired_at: overrides.retired_at ?? null,
    retired_reason: overrides.retired_reason ?? null,
    suspended_note: overrides.suspended_note ?? null,
    created_at: overrides.created_at ?? new Date().toISOString(),
    updated_at: overrides.updated_at ?? new Date().toISOString(),
  };
}

/**
 * Minimal statement-dispatching adapter. Most specific fragment first.
 * `locks` records every cap-lock acquisition so tests can assert the
 * serialization seam was actually taken.
 */
function createAdapter(initialRows = []) {
  const rows = initialRows.map((row) => ({ ...row }));
  const locks = [];

  const adapter = {
    rows,
    locks,

    async query(sql, params = []) {
      const s = sql.replace(/\s+/g, " ").trim();

      if (s.includes("canonical_director_cap_lock") && s.includes("FOR UPDATE")) {
        locks.push(params);
        return { rows: [{ id: "active_director_cap" }], rowCount: 1 };
      }

      if (s.includes("count(*)::int AS count")) {
        const count = rows.filter((r) => r.status === "active").length;
        return { rows: [{ count }], rowCount: 1 };
      }

      if (s.startsWith("INSERT INTO canonical_director_mappings")) {
        const [id, code, underlying, displayName, namespace, status, retiredAt, reason, note] = params;
        if (rows.some((r) => r.canonical_director_code === code)) {
          const error = new Error("duplicate key value violates unique constraint");
          error.code = "23505";
          throw error;
        }
        if (rows.some((r) => r.underlying_agent_id === underlying)) {
          const error = new Error("duplicate key value violates unique constraint");
          error.code = "23505";
          throw error;
        }
        const created = {
          id,
          canonical_director_code: code,
          underlying_agent_id: underlying,
          display_name: displayName,
          namespace,
          status,
          retired_at: retiredAt,
          retired_reason: reason,
          suspended_note: note,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        };
        rows.push(created);
        return { rows: [{ ...created }], rowCount: 1 };
      }

      if (s.startsWith("UPDATE canonical_director_mappings") && s.includes("status = 'active'")) {
        const target = rows.find((r) => r.canonical_director_code === params[0]);
        if (!target) return { rows: [], rowCount: 0 };
        target.status = "active";
        target.retired_at = null;
        target.retired_reason = null;
        target.suspended_note = null;
        target.updated_at = new Date().toISOString();
        return { rows: [{ ...target }], rowCount: 1 };
      }

      if (s.startsWith("UPDATE canonical_director_mappings") && s.includes("status = 'retired'")) {
        const target = rows.find((r) => r.canonical_director_code === params[0]);
        if (!target) return { rows: [], rowCount: 0 };
        target.status = "retired";
        target.retired_at = new Date().toISOString();
        target.retired_reason = params[1] ?? null;
        target.suspended_note = null;
        target.updated_at = new Date().toISOString();
        return { rows: [{ ...target }], rowCount: 1 };
      }

      if (s.startsWith("UPDATE canonical_director_mappings") && s.includes("status = 'suspended'")) {
        const target = rows.find((r) => r.canonical_director_code === params[0]);
        if (!target) return { rows: [], rowCount: 0 };
        target.status = "suspended";
        target.suspended_note = params[1] ?? null;
        target.retired_at = null;
        target.retired_reason = null;
        target.updated_at = new Date().toISOString();
        return { rows: [{ ...target }], rowCount: 1 };
      }

      // --- status-only read (activation/retirement/suspension under the lock) ---
      if (s.startsWith("SELECT status") && s.includes("canonical_director_mappings")) {
        const target = rows.find((r) => r.canonical_director_code === params[0]);
        return {
          rows: target
            ? [{ status: target.status, underlying_agent_id: target.underlying_agent_id }]
            : [],
          rowCount: target ? 1 : 0,
        };
      }

      // --- by canonical code, active only ---
      if (s.includes("canonical_director_code = $1") && s.includes("status = 'active'")) {
        const target = rows.find(
          (r) => r.canonical_director_code === params[0] && r.status === "active"
        );
        return { rows: target ? [{ ...target }] : [], rowCount: target ? 1 : 0 };
      }

      // --- by underlying agent, active only ---
      if (s.includes("underlying_agent_id = $1") && s.includes("status = 'active'")) {
        const target = rows.find(
          (r) => r.underlying_agent_id === params[0] && r.status === "active"
        );
        return { rows: target ? [{ ...target }] : [], rowCount: target ? 1 : 0 };
      }

      // --- by canonical code, any status ---
      if (s.includes("canonical_director_code = $1")) {
        const target = rows.find((r) => r.canonical_director_code === params[0]);
        return { rows: target ? [{ ...target }] : [], rowCount: target ? 1 : 0 };
      }

      // --- by underlying agent, any status ---
      if (s.includes("underlying_agent_id = $1")) {
        const target = rows.find((r) => r.underlying_agent_id === params[0]);
        return { rows: target ? [{ ...target }] : [], rowCount: target ? 1 : 0 };
      }

      // --- listAll: active first, then canonical code ---
      if (s.includes("(status = 'active')::int DESC")) {
        const ordered = [...rows].sort((a, b) => {
          if (a.status === "active" && b.status !== "active") return -1;
          if (a.status !== "active" && b.status === "active") return 1;
          return a.canonical_director_code.localeCompare(b.canonical_director_code);
        });
        return { rows: ordered.map((r) => ({ ...r })), rowCount: ordered.length };
      }

      // --- listActive ---
      if (s.includes("canonical_director_mappings") && s.includes("status = 'active'")) {
        const ordered = rows
          .filter((r) => r.status === "active")
          .sort((a, b) => a.canonical_director_code.localeCompare(b.canonical_director_code));
        return { rows: ordered.map((r) => ({ ...r })), rowCount: ordered.length };
      }

      throw new Error(`adapter: unimplemented statement: ${s.slice(0, 90)}`);
    },

    async withTransaction(callback) {
      // Single-threaded transport: the lock acquisition is recorded so tests can
      // assert the seam, but no real concurrency is simulated here.
      return callback(adapter);
    },
  };

  return adapter;
}

function repoWith(rows = []) {
  const adapter = createAdapter(rows);
  return { adapter, repo: new CanonicalDirectorRepository(adapter) };
}

/** `count` active rows using non-canonical seed codes (so canonical codes stay free). */
function activeSeeds(count) {
  const rows = [];
  for (let i = 0; i < count; i += 1) {
    rows.push(
      rowFixture({
        id: `seed-${i}`,
        canonical_director_code: `SEED-${String(i).padStart(2, "0")}`,
        underlying_agent_id: `agent-seed-${i}`,
        display_name: `SEED ${i}`,
        namespace: `st.agent.seed-${String(i).padStart(2, "0")}`,
        status: "active",
      })
    );
  }
  return rows;
}

// ---------------------------------------------------------------- code set

test("canonical Director code set is exactly the frozen ten", () => {
  assert.deepEqual([...CANONICAL_DIRECTOR_CODES], [
    "JARVIS", "COSMOS", "NEWTON", "AADI", "LAKME",
    "SHERLOCK", "CHRONOS", "AI NEWS", "TECH MASTER", "BUTTERFLY",
  ]);
  assert.equal(ACTIVE_DIRECTOR_CAP, 50);
  assert.deepEqual([...PRESERVED_UNDERLYING_AGENT_IDS], [
    "agent-01", "agent-02", "agent-03", "agent-21",
  ]);
  assert.deepEqual([...NEW_UNDERLYING_AGENT_IDS], [
    "agent-director-cosmos",
    "agent-director-aadi",
    "agent-director-chronos",
    "agent-director-ai-news",
    "agent-director-tech-master",
    "agent-director-butterfly",
  ]);
});

test("unknown canonical code is rejected on read and on write", async () => {
  const { repo } = repoWith();

  await assert.rejects(() => repo.findByCode("NOT_A_DIRECTOR"), /CANONICAL_DIRECTOR_CODE_INVALID/);
  await assert.rejects(
    () => repo.createMapping({
      canonicalDirectorCode: "NOT_A_DIRECTOR",
      underlyingAgentId: "agent-nope",
      displayName: "Nope",
      namespace: "st.agent.nope",
    }),
    /CANONICAL_DIRECTOR_CODE_INVALID/
  );
  await assert.rejects(() => repo.activateMapping("NOT_A_DIRECTOR"), /CANONICAL_DIRECTOR_CODE_INVALID/);
  await assert.rejects(
    () => repo.resolveActiveUnderlyingAgentId("NOT_A_DIRECTOR"),
    /CANONICAL_DIRECTOR_CODE_INVALID/
  );
});

// ---------------------------------------------------------- mapping writes

test("createMapping records a retired mapping with no cap impact", async () => {
  const { repo } = repoWith();

  const created = await repo.createMapping({
    canonicalDirectorCode: "COSMOS",
    underlyingAgentId: "agent-director-cosmos",
    displayName: "COSMOS",
    namespace: "st.agent.cosmos",
    retiredReason: "pre-cutover",
  });

  assert.equal(created.canonicalDirectorCode, "COSMOS");
  assert.equal(created.underlyingAgentId, "agent-director-cosmos");
  assert.equal(created.status, "retired");
  assert.equal(created.retiredReason, "pre-cutover");
  assert.ok(created.retiredAt, "retirement timestamp is recorded");
  assert.equal(await repo.activeCount(), 0);
});

test("createMapping refuses to smuggle activation past the cap-locked path", async () => {
  const { repo } = repoWith();
  await assert.rejects(
    () => repo.createMapping({
      canonicalDirectorCode: "COSMOS",
      underlyingAgentId: "agent-director-cosmos",
      displayName: "COSMOS",
      namespace: "st.agent.cosmos",
      status: "active",
    }),
    /ACTIVE_DIRECTOR_CAP_REACHED/
  );
});

test("createMapping rejects an invalid status and an invalid underlying id", async () => {
  const { repo } = repoWith();

  await assert.rejects(
    () => repo.createMapping({
      canonicalDirectorCode: "COSMOS",
      underlyingAgentId: "agent-director-cosmos",
      displayName: "COSMOS",
      namespace: "st.agent.cosmos",
      status: "archived",
    }),
    /STATUS_INVALID/
  );

  await assert.rejects(
    () => repo.createMapping({
      canonicalDirectorCode: "COSMOS",
      underlyingAgentId: "",
      displayName: "COSMOS",
      namespace: "st.agent.cosmos",
    }),
    /UNDERLYING_AGENT_INVALID/
  );
});

test("duplicate canonical code or underlying key is refused", async () => {
  const { repo } = repoWith([
    rowFixture({ canonical_director_code: "JARVIS", underlying_agent_id: "agent-01" }),
  ]);

  await assert.rejects(
    () => repo.createMapping({
      canonicalDirectorCode: "JARVIS",
      underlyingAgentId: "agent-01-other",
      displayName: "JARVIS TWO",
      namespace: "st.agent.jarvis2",
    }),
    /MAPPING_ALREADY_EXISTS/
  );

  await assert.rejects(
    () => repo.createMapping({
      canonicalDirectorCode: "SHERLOCK",
      underlyingAgentId: "agent-01",
      displayName: "SHERLOCK",
      namespace: "st.agent.sherlock",
    }),
    /MAPPING_ALREADY_EXISTS/
  );
});

// --------------------------------------------------------------------- cap

test("activation at the cap raises ACTIVE_DIRECTOR_CAP_REACHED", async () => {
  const rows = activeSeeds(ACTIVE_DIRECTOR_CAP);
  rows.push(
    rowFixture({
      id: "candidate",
      canonical_director_code: "BUTTERFLY",
      underlying_agent_id: "agent-director-butterfly",
      display_name: "BUTTERFLY",
      namespace: "st.agent.butterfly",
      status: "retired",
    })
  );

  const { repo } = repoWith(rows);
  assert.equal(await repo.activeCount(), ACTIVE_DIRECTOR_CAP);

  await assert.rejects(() => repo.activateMapping("BUTTERFLY"), /ACTIVE_DIRECTOR_CAP_REACHED/);
  assert.equal(await repo.activeCount(), ACTIVE_DIRECTOR_CAP, "cap is not exceeded");
});

test("activation under the cap succeeds and takes the cap lock", async () => {
  const { repo, adapter } = repoWith([
    rowFixture({
      canonical_director_code: "TECH MASTER",
      underlying_agent_id: "agent-director-tech-master",
      display_name: "TECH MASTER",
      namespace: "st.agent.techmaster",
      status: "retired",
      retired_reason: "pre-cutover",
      retired_at: new Date().toISOString(),
    }),
  ]);

  assert.equal(await repo.activeCount(), 0);
  const activated = await repo.activateMapping("TECH MASTER");

  assert.equal(activated.status, "active");
  assert.equal(activated.underlyingAgentId, "agent-director-tech-master");
  assert.equal(activated.retiredReason, null);
  assert.equal(activated.retiredAt, null);
  assert.equal(await repo.activeCount(), 1);
  assert.equal(adapter.locks.length, 1, "activation must take the dedicated cap lock");
});

test("activating an already-active mapping is idempotent", async () => {
  const { repo } = repoWith([
    rowFixture({
      canonical_director_code: "CHRONOS",
      underlying_agent_id: "agent-director-chronos",
      status: "active",
    }),
  ]);

  const again = await repo.activateMapping("CHRONOS");
  assert.equal(again.status, "active");
  assert.equal(await repo.activeCount(), 1);
});

test("activation with a mismatched underlying agent id is refused", async () => {
  const { repo } = repoWith([
    rowFixture({
      canonical_director_code: "AADI",
      underlying_agent_id: "agent-director-aadi",
      status: "retired",
    }),
  ]);

  await assert.rejects(
    () => repo.activateMapping("AADI", { underlyingAgentId: "agent-01" }),
    /UNDERLYING_AGENT_INVALID/
  );
});

test("activating an unknown Director code is refused", async () => {
  const { repo } = repoWith();
  await assert.rejects(() => repo.activateMapping("COSMOS"), /CANONICAL_DIRECTOR_NOT_FOUND/);
});

// --------------------------------------------------------- retire / suspend

test("retirement drops the active slot and preserves history", async () => {
  const { repo } = repoWith([
    rowFixture({
      canonical_director_code: "AADI",
      underlying_agent_id: "agent-director-aadi",
      status: "active",
    }),
  ]);

  assert.equal(await repo.activeCount(), 1);
  const retired = await repo.retireMapping("AADI", { retiredReason: "retired in place" });

  assert.equal(retired.status, "retired");
  assert.equal(retired.retiredReason, "retired in place");
  assert.ok(retired.retiredAt);
  assert.equal(await repo.activeCount(), 0);

  const stillThere = await repo.findByCode("AADI");
  assert.ok(stillThere, "mapping row survives retirement");
  assert.equal(stillThere.underlyingAgentId, "agent-director-aadi");
});

test("retiring a non-active mapping is refused", async () => {
  const { repo } = repoWith([
    rowFixture({ canonical_director_code: "AADI", underlying_agent_id: "agent-director-aadi" }),
  ]);

  await assert.rejects(() => repo.retireMapping("AADI"), /CANONICAL_DIRECTOR_NOT_ACTIVE/);
});

test("suspension is distinct from retirement and round-trips its note", async () => {
  const { repo } = repoWith([
    rowFixture({
      canonical_director_code: "CHRONOS",
      underlying_agent_id: "agent-director-chronos",
      status: "active",
    }),
  ]);

  const suspended = await repo.suspendMapping("CHRONOS", { suspendedNote: "temporary admin hold" });

  assert.equal(suspended.status, "suspended");
  assert.equal(suspended.suspendedNote, "temporary admin hold");
  assert.equal(suspended.retiredAt, null);
  assert.equal(await repo.activeCount(), 0);
});

// ------------------------------------------------------ operational guards

test("a retired Director can never resolve to an active production origin", async () => {
  const { repo, adapter } = repoWith([
    rowFixture({
      canonical_director_code: "LAKME",
      underlying_agent_id: "agent-03",
      status: "retired",
      retired_at: new Date().toISOString(),
      retired_reason: "retired in place",
    }),
  ]);

  await assert.rejects(() => repo.requireActiveUnderlyingAgent("agent-03"), /CANONICAL_DIRECTOR_NOT_ACTIVE/);
  await assert.rejects(() => repo.resolveActiveUnderlyingAgentId("LAKME"), /CANONICAL_DIRECTOR_NOT_ACTIVE/);

  const guard = createCanonicalDirectorGuard(adapter);
  await assert.rejects(() => guard.assertActive("agent-03"), /CANONICAL_DIRECTOR_NOT_ACTIVE/);
  assert.equal(await guard.isActive("agent-03"), false);
});

test("a suspended Director is blocked at the operational guard", async () => {
  const { adapter } = repoWith([
    rowFixture({
      canonical_director_code: "BUTTERFLY",
      underlying_agent_id: "agent-director-butterfly",
      status: "suspended",
      suspended_note: "hold",
    }),
  ]);

  const guard = createCanonicalDirectorGuard(adapter);
  await assert.rejects(() => guard.assertActive("agent-director-butterfly"), /CANONICAL_DIRECTOR_NOT_ACTIVE/);
  assert.equal(await guard.isActive("agent-director-butterfly"), false);
});

test("the operational guard passes an active Director and an ungoverned agent", async () => {
  const { adapter } = repoWith([
    rowFixture({
      canonical_director_code: "JARVIS",
      underlying_agent_id: "agent-01",
      status: "active",
    }),
  ]);

  const guard = createCanonicalDirectorGuard(adapter);

  const jarvis = await guard.assertActive("agent-01");
  assert.equal(jarvis.canonicalDirectorCode, "JARVIS");
  assert.equal(await guard.isActive("agent-01"), true);

  // No mapping row: pre-cutover agent, preserved behaviour (the DB trigger in
  // sql/032 uses the same rule).
  const ungoverned = await guard.assertActive("agent-99");
  assert.equal(ungoverned, null);
  assert.equal(await guard.isActive("agent-99"), false);

  const byCode = await guard.assertActiveCode("JARVIS");
  assert.equal(byCode.underlyingAgentId, "agent-01");
  await assert.rejects(() => guard.assertActiveCode("COSMOS"), /CANONICAL_DIRECTOR_NOT_ACTIVE/);
});

// ------------------------------------------- preserved + new identifiers

test("the four preserved underlying keys can host their canonical mappings", async () => {
  const { repo } = repoWith();

  const preserved = [
    { code: "JARVIS", id: "agent-01", name: "JARVIS", ns: "st.agent.jarvis" },
    { code: "SHERLOCK", id: "agent-02", name: "SHERLOCK", ns: "st.agent.sherlock" },
    { code: "LAKME", id: "agent-03", name: "LAKME", ns: "st.agent.lakme" },
    { code: "NEWTON", id: "agent-21", name: "NEWTON", ns: "st.agent.newton" },
  ];

  for (const entry of preserved) {
    const created = await repo.createMapping({
      canonicalDirectorCode: entry.code,
      underlyingAgentId: entry.id,
      displayName: entry.name,
      namespace: entry.ns,
      retiredReason: "preserved underlying key; activate explicitly",
    });
    assert.equal(created.canonicalDirectorCode, entry.code);
    assert.equal(created.underlyingAgentId, entry.id);
  }

  const activated = await repo.activateMapping("JARVIS");
  assert.equal(activated.status, "active");
  assert.equal(await repo.activeCount(), 1);
});

test("the six new underlying IDs can host their canonical mappings", async () => {
  const { repo } = repoWith();

  const six = [
    { code: "COSMOS", id: "agent-director-cosmos", ns: "st.agent.cosmos" },
    { code: "AADI", id: "agent-director-aadi", ns: "st.agent.aadi" },
    { code: "CHRONOS", id: "agent-director-chronos", ns: "st.agent.chronos" },
    { code: "AI NEWS", id: "agent-director-ai-news", ns: "st.agent.ai-news" },
    { code: "TECH MASTER", id: "agent-director-tech-master", ns: "st.agent.tech-master" },
    { code: "BUTTERFLY", id: "agent-director-butterfly", ns: "st.agent.butterfly" },
  ];

  for (const entry of six) {
    const created = await repo.createMapping({
      canonicalDirectorCode: entry.code,
      underlyingAgentId: entry.id,
      displayName: entry.code,
      namespace: entry.ns,
      retiredReason: "new underlying id; activate explicitly",
    });
    assert.equal(created.underlyingAgentId, entry.id);
  }

  const activated = await repo.activateMapping("AI NEWS");
  assert.equal(activated.status, "active");
  assert.equal(activated.underlyingAgentId, "agent-director-ai-news");
});

// ------------------------------------------------------------------ reads

test("listAll puts active mappings first and listActive excludes the rest", async () => {
  const { repo } = repoWith([
    rowFixture({ canonical_director_code: "CHRONOS", underlying_agent_id: "agent-director-chronos", status: "retired" }),
    rowFixture({ canonical_director_code: "COSMOS", underlying_agent_id: "agent-director-cosmos", status: "active" }),
  ]);

  const all = await repo.listAll();
  assert.equal(all.length, 2);
  assert.equal(all[0].status, "active");
  assert.equal(all[0].canonicalDirectorCode, "COSMOS");
  assert.equal(all[1].status, "retired");

  const active = await repo.listActive();
  assert.equal(active.length, 1);
  assert.equal(active[0].canonicalDirectorCode, "COSMOS");
});

test("mapping DTOs expose only allowlisted fields", async () => {
  const { repo } = repoWith([
    rowFixture({ canonical_director_code: "COSMOS", underlying_agent_id: "agent-director-cosmos", status: "active" }),
  ]);

  const [mapping] = await repo.listActive();
  assert.deepEqual(Object.keys(mapping).sort(), [
    "canonicalDirectorCode",
    "createdAt",
    "displayName",
    "id",
    "namespace",
    "retiredAt",
    "retiredReason",
    "status",
    "suspendedNote",
    "underlyingAgentId",
    "updatedAt",
  ]);
});
