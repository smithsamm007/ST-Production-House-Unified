/**
 * Director registry rehearsal driver.
 *
 * Executes the PHASE_2_INITIAL_SEED_DESIGN steps A–C plus the lifecycle, cap and
 * rollback rehearsals against a DISPOSABLE PostgreSQL 15 database. Nothing here
 * lives in sql/: promotion to sql/033 + sql/034 remains an Owner decision.
 *
 *   DATABASE_URL=postgresql://postgres@127.0.0.1:55432/st_rehearsal \
 *     node scripts/director_registry_rehearsal.mjs
 *
 * The driver refuses any database that is not local and does not have a
 * disposable-sounding name, so it cannot be pointed at production by mistake.
 * It writes a JSON acceptance record and exits non-zero on the first failed check.
 */

import { writeFileSync, mkdirSync } from "node:fs";
import { createPostgresAdapter } from "../src/db/postgresAdapter.js";
import {
  CanonicalDirectorRepository,
  CANONICAL_DIRECTOR_CODES,
  PRESERVED_UNDERLYING_AGENT_IDS,
  NEW_UNDERLYING_AGENT_IDS,
  ACTIVE_DIRECTOR_CAP,
  CANONICAL_DIRECTOR_PUBLIC_CODES as CODES,
} from "../src/catalog/canonicalDirectorRepository.js";
import { enforceOperationalActive } from "../src/catalog/canonicalDirectorLifecycle.js";

const EVIDENCE_PATH = process.env.REHEARSAL_EVIDENCE ?? "artifacts/rehearsal/DIRECTOR_REHEARSAL_EVIDENCE.json";
const checks = [];
const evidence = {
  kind: "director_registry_rehearsal",
  generatedAt: new Date().toISOString(),
  node: process.version,
  steps: {},
  checks,
};

function check(name, condition, detail) {
  checks.push({ name, ok: Boolean(condition), detail: detail ?? null });
  if (!condition) throw new Error(`REHEARSAL_ASSERTION_FAILED:${name}${detail ? ` :: ${detail}` : ""}`);
  console.log(`ok   ${name}${detail ? ` :: ${detail}` : ""}`);
}

async function expectCode(name, fn, code) {
  try {
    await fn();
    check(name, false, "expected a refusal, call resolved");
  } catch (error) {
    check(name, error?.code === code, `code=${error?.code}`);
  }
}

export function assertDisposable(connectionString) {
  const url = new URL(connectionString);
  const db = (url.pathname || "").replace(/^\//, "");
  const host = url.hostname;
  const disposableName = /(rehearsal|test|disposable|scratch|tmp)/i.test(db);
  const localHost = ["127.0.0.1", "localhost", "::1"].includes(host);
  if (!disposableName || !localHost) {
    throw new Error(
      `REFUSING_NON_DISPOSABLE_DATABASE db=${db} host=${host} — rehearsals only run on a local database whose name contains rehearsal/test/disposable`
    );
  }
  return { db, host };
}

const SEED_AGENTS_SQL = `
INSERT INTO agents (id, name, namespace)
SELECT v.id, v.name, v.namespace
  FROM (VALUES
    ('agent-director-cosmos',      'COSMOS',      'st.agent.cosmos'),
    ('agent-director-aadi',        'AADI',        'st.agent.aadi'),
    ('agent-director-chronos',     'CHRONOS',     'st.agent.chronos'),
    ('agent-director-ai-news',     'AI NEWS',     'st.agent.ai-news'),
    ('agent-director-tech-master', 'TECH MASTER', 'st.agent.tech-master'),
    ('agent-director-butterfly',   'BUTTERFLY',   'st.agent.butterfly')
  ) AS v(id, name, namespace)
 WHERE NOT EXISTS (SELECT 1 FROM agents a WHERE a.id = v.id);`;

const SEED_MAPPINGS_SQL = `
INSERT INTO canonical_director_mappings
  (canonical_director_code, underlying_agent_id, display_name, namespace,
   status, retired_at, retired_reason)
SELECT v.code, v.agent_id, v.display_name, v.namespace,
       'retired', now(), 'pre-cutover seed'
  FROM (VALUES
    ('JARVIS',      'agent-01', 'JARVIS',      'st.agent.jarvis'),
    ('SHERLOCK',    'agent-02', 'SHERLOCK',    'st.agent.sherlock'),
    ('LAKME',       'agent-03', 'LAKME',       'st.agent.lakme'),
    ('NEWTON',      'agent-21', 'NEWTON',      'st.agent.newton'),
    ('COSMOS',      'agent-director-cosmos',      'COSMOS',      'st.agent.cosmos'),
    ('AADI',        'agent-director-aadi',        'AADI',        'st.agent.aadi'),
    ('CHRONOS',     'agent-director-chronos',     'CHRONOS',     'st.agent.chronos'),
    ('AI NEWS',     'agent-director-ai-news',     'AI NEWS',     'st.agent.ai-news'),
    ('TECH MASTER', 'agent-director-tech-master', 'TECH MASTER', 'st.agent.tech-master'),
    ('BUTTERFLY',   'agent-director-butterfly',   'BUTTERFLY',   'st.agent.butterfly')
  ) AS v(code, agent_id, display_name, namespace)
 WHERE NOT EXISTS (
   SELECT 1 FROM canonical_director_mappings m WHERE m.canonical_director_code = v.code
 );`;

const LEGACY_SQL = `SELECT id, name FROM agents WHERE id ~ '^agent-(0[4-9]|1[0-9]|20)$' ORDER BY id;`;
const PRESERVED_SQL = `SELECT id, name, namespace, enabled FROM agents WHERE id = ANY($1::text[]) ORDER BY id;`;

async function main() {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL_REQUIRED");
  evidence.target = assertDisposable(connectionString);

  const db = createPostgresAdapter({ connectionString });
  const repo = new CanonicalDirectorRepository(db);
  const scalar = async (sql, params) => (await db.query(sql, params)).rows[0];

  evidence.steps.server = (await scalar("SELECT version() AS v")).v;
  evidence.steps.migrationLedger = (await scalar("SELECT count(*)::int AS c FROM schema_migrations")).c;

  // ------------------------------------------------------------- baseline
  const base = {
    agents: (await scalar("SELECT count(*)::int AS c FROM agents")).c,
    mappings: (await scalar("SELECT count(*)::int AS c FROM canonical_director_mappings")).c,
    preserved: (await db.query(PRESERVED_SQL, [PRESERVED_UNDERLYING_AGENT_IDS])).rows,
    legacy: (await db.query(LEGACY_SQL)).rows,
  };
  check("post-032: 32 migrations recorded", evidence.steps.migrationLedger === 32, `ledger=${evidence.steps.migrationLedger}`);
  check("post-032: no mapping rows exist", base.mappings === 0, `mappings=${base.mappings}`);
  check("post-032: 21 agent rows", base.agents === 21, `agents=${base.agents}`);
  check("post-032: four preserved keys present", base.preserved.length === 4);
  check("post-032: 17 legacy identities present", base.legacy.length === 17, `legacy=${base.legacy.length}`);
  evidence.steps.baseline = { agents: base.agents, mappings: base.mappings, legacy: base.legacy.length };

  await expectCode(
    "pre-seed: activation without a mapping refuses CANONICAL_DIRECTOR_NOT_FOUND",
    () => repo.activateMapping("JARVIS"),
    CODES.CANONICAL_DIRECTOR_NOT_FOUND
  );

  // -------------------------------------------------------------- step A
  const a1 = await db.query(SEED_AGENTS_SQL);
  const a2 = await db.query(SEED_AGENTS_SQL);
  const afterA = (await scalar("SELECT count(*)::int AS c FROM agents")).c;
  check("step A inserts exactly 6 agent rows", a1.rowCount === 6, `inserted=${a1.rowCount}`);
  check("step A is idempotent (second run inserts 0)", a2.rowCount === 0, `rowCount2=${a2.rowCount}`);
  check("step A raises the total to 27 agents", afterA === 27, `agents=${afterA}`);
  evidence.steps.stepA = { insertedFirst: a1.rowCount, insertedSecond: a2.rowCount, agents: afterA };

  // -------------------------------------------------------------- step B
  const b1 = await db.query(SEED_MAPPINGS_SQL);
  const b2 = await db.query(SEED_MAPPINGS_SQL);
  const byStatus = (
    await db.query("SELECT status, count(*)::int AS c FROM canonical_director_mappings GROUP BY status;")
  ).rows;
  const preservedMappings = (
    await scalar(
      `SELECT count(*)::int AS c FROM canonical_director_mappings WHERE underlying_agent_id = ANY($1::text[]);`,
      [PRESERVED_UNDERLYING_AGENT_IDS]
    )
  ).c;
  check("step B inserts exactly 10 mappings", b1.rowCount === 10, `inserted=${b1.rowCount}`);
  check("step B is idempotent (second run inserts 0)", b2.rowCount === 0, `rowCount2=${b2.rowCount}`);
  check(
    "step B creates every mapping retired",
    byStatus.length === 1 && byStatus[0].status === "retired" && byStatus[0].c === 10,
    JSON.stringify(byStatus)
  );
  check("step B preserves the four existing underlying keys", preservedMappings === 4, `preserved=${preservedMappings}`);
  check(
    "seed never mutates the four preserved agent rows",
    JSON.stringify((await db.query(PRESERVED_SQL, [PRESERVED_UNDERLYING_AGENT_IDS])).rows) === JSON.stringify(base.preserved)
  );
  evidence.steps.stepB = { insertedFirst: b1.rowCount, insertedSecond: b2.rowCount, byStatus };

  // -------------------------------------------------------------- step C
  for (const code of CANONICAL_DIRECTOR_CODES) await repo.activateMapping(code);
  const active = await repo.activeCount();
  const activeCodes = (await repo.listActive()).map((m) => m.canonicalDirectorCode);
  check("all ten canonical Directors activate", active === 10, `active=${active}`);
  check(
    "the active set is exactly the frozen code list",
    JSON.stringify([...activeCodes].sort()) === JSON.stringify([...CANONICAL_DIRECTOR_CODES].sort())
  );
  check(
    "activation never mutates the four preserved agent rows",
    JSON.stringify((await db.query(PRESERVED_SQL, [PRESERVED_UNDERLYING_AGENT_IDS])).rows) === JSON.stringify(base.preserved)
  );
  check(
    "activation clears retirement bookkeeping",
    (await scalar(
      `SELECT count(*)::int AS c FROM canonical_director_mappings
        WHERE status = 'active' AND (retired_at IS NOT NULL OR retired_reason IS NOT NULL OR suspended_note IS NOT NULL);`
    )).c === 0
  );
  evidence.steps.stepC = { active, codes: activeCodes };

  // -------------------------------------------------------------- step D (cap)
  // FINDING: with agents_max_50 capping total agents at 50 and underlying_agent_id
  // UNIQUE, only 33 mappings can ever exist after this seed (27 agents + 23 slots),
  // so the 50-Director cap is unreachable in normal operation. The rehearsal lifts
  // the agent-row ceiling for this disposable run only, to exercise the mapping cap.
  const agentCapTrigger = (
    await scalar(
      `SELECT t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE c.relname = 'agents' AND NOT t.tgisinternal ORDER BY t.tgname LIMIT 1;`
    )
  ).name;
  evidence.steps.agentCapTrigger = agentCapTrigger;
  // FINDING: sql/032 also pins canonical_director_code to the ten frozen codes, so
  // active mappings can never exceed 10 in normal operation and the 50 cap is
  // unreachable twice over. Relax both rehearsal-irrelevant limits on this
  // disposable database only, to prove the cap trigger itself works.
  const codeCheck = (
    await scalar(
      `SELECT conname AS name FROM pg_constraint
        WHERE conrelid = 'canonical_director_mappings'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) LIKE '%canonical_director_code%';`
    )
  ).name;
  evidence.steps.codeCheckConstraint = codeCheck;
  await db.query(`ALTER TABLE agents DISABLE TRIGGER ${agentCapTrigger};`);
  await db.query(`ALTER TABLE canonical_director_mappings DROP CONSTRAINT ${codeCheck};`);
  await db.query(
    `INSERT INTO agents (id, name, namespace)
     SELECT 'agent-cap-' || g, 'CAP ' || g, 'st.agent.cap-' || g FROM generate_series(1, 41) g;`
  );
  await db.query(
    `INSERT INTO canonical_director_mappings
       (canonical_director_code, underlying_agent_id, display_name, namespace, status, retired_at, retired_reason)
     SELECT 'CAP-' || g, 'agent-cap-' || g, 'CAP ' || g, 'st.agent.cap-' || g, 'retired', now(), 'cap rehearsal'
       FROM generate_series(1, 41) g;`
  );
  const mappingTotal = (await scalar("SELECT count(*)::int AS c FROM canonical_director_mappings")).c;
  check("cap rehearsal seeds 51 mappings", mappingTotal === 51, `mappings=${mappingTotal}`);

  // 39 open raw activations -> 49 active, then the cap-locked path takes it to 50.
  await db.query(
    `UPDATE canonical_director_mappings SET status = 'active', retired_at = NULL, retired_reason = NULL
      WHERE canonical_director_code IN (SELECT 'CAP-' || g FROM generate_series(1, 39) g);`
  );
  check("49 mappings active before the cap-locked activation", (await repo.activeCount()) === 49);
  await db.query(
    `UPDATE canonical_director_mappings SET status = 'active', retired_at = NULL, retired_reason = NULL
      WHERE canonical_director_code = 'CAP-40';`
  );
  check("exactly 50 mappings are active at the boundary", (await repo.activeCount()) === ACTIVE_DIRECTOR_CAP);
  // FINDING: the repository's cap branch is unreachable because assertKnownCode runs
  // first, so a non-canonical code is refused before the count is ever consulted.
  await expectCode(
    "the repository refuses a non-canonical code before the cap check",
    () => repo.activateMapping("CAP-41"),
    CODES.CANONICAL_DIRECTOR_CODE_INVALID
  );
  await expectCode(
    "the 51st active row is refused by the database trigger (raw SQL bypass)",
    () =>
      db.query(
        `UPDATE canonical_director_mappings SET status = 'active', retired_at = NULL, retired_reason = NULL
          WHERE canonical_director_code = 'CAP-41';`
      ),
    "P0001"
  );
  await db.query(`UPDATE canonical_director_mappings SET status = 'retired', retired_at = now(), retired_reason = 'cap cleanup' WHERE canonical_director_code LIKE 'CAP-%';`);
  await db.query(`DELETE FROM canonical_director_mappings WHERE canonical_director_code LIKE 'CAP-%';`);
  await db.query(`DELETE FROM agents WHERE id LIKE 'agent-cap-%';`);
  await db.query(`ALTER TABLE agents ENABLE TRIGGER ${agentCapTrigger};`);
  await db.query(
    `ALTER TABLE canonical_director_mappings ADD CONSTRAINT ${codeCheck} CHECK (canonical_director_code IN (
       'JARVIS','COSMOS','NEWTON','AADI','LAKME','SHERLOCK','CHRONOS','AI NEWS','TECH MASTER','BUTTERFLY'));`
  );
  await expectCode(
    "the frozen ten-code constraint is restored after the cap rehearsal",
    () => db.query(`UPDATE canonical_director_mappings SET display_name = display_name WHERE canonical_director_code = 'NOPE';`).then(() => {
      // A constraint violation surfaces as error.code 23514 on write; force a write.
      return db.query(
        `INSERT INTO canonical_director_mappings (canonical_director_code, underlying_agent_id, display_name, namespace)
         VALUES ('NOPE','agent-01','NOPE DIRECTOR','st.agent.nope-director');`
      );
    }),
    "23514"
  );
  check(
    "cap rehearsal restores 10 active / 27 agents",
    (await repo.activeCount()) === 10 && (await scalar("SELECT count(*)::int AS c FROM agents")).c === 27
  );
  evidence.steps.stepD = {
    cap: ACTIVE_DIRECTOR_CAP,
    repositoryRefusal: `${CODES.CANONICAL_DIRECTOR_CODE_INVALID} (cap branch unreachable: frozen-code guard runs first)`,
    databaseRefusal: "P0001",
    findings: [
      "canonical_director_code is constrained to the ten frozen codes, so active mappings can never exceed 10 and the 50 cap is unreachable",
      "even without that constraint, underlying_agent_id is UNIQUE and agents_max_50 caps agents at 50: max 33 mappings after this seed",
      "the 50 cap therefore protects nothing today; it becomes meaningful only if a future migration removes the frozen-code constraint or raises the agent ceiling",
    ],
  };

  // -------------------------------------------------------------- step E
  const retiredCode = "BUTTERFLY";
  const underlying = (await repo.findByCode(retiredCode)).underlyingAgentId;
  await repo.retireMapping(retiredCode, { retiredReason: "rehearsal retirement" });
  const retired = await repo.findByCode(retiredCode);
  check("retirement sets status=retired with a reason", retired.status === "retired" && retired.retiredReason === "rehearsal retirement");
  check("retirement keeps the underlying agent row", (await scalar("SELECT count(*)::int AS c FROM agents WHERE id=$1", [underlying])).c === 1);
  check("retirement never resolves to an active origin", (await repo.findActiveByCode(retiredCode)) === null);
  await expectCode(
    "operational enforcement refuses the retired Director",
    () => enforceOperationalActive(db, underlying),
    CODES.CANONICAL_DIRECTOR_NOT_ACTIVE
  );
  check("the other nine Directors remain active", (await repo.activeCount()) === 9);
  check("a still-active Director passes enforcement", (await enforceOperationalActive(db, "agent-01"))?.status === "active");
  check(
    "the 17 legacy identities stay ungoverned (no mapping, enforcement passes)",
    (await enforceOperationalActive(db, "agent-07")) === null &&
      (await repo.findByUnderlyingAgentId("agent-07")) === null
  );

  const suspCode = "COSMOS";
  const suspUnderlying = (await repo.findByCode(suspCode)).underlyingAgentId;
  await repo.suspendMapping(suspCode, { suspendedNote: "rehearsal suspension" });
  await expectCode(
    "suspension also refuses operational work",
    () => enforceOperationalActive(db, suspUnderlying),
    CODES.CANONICAL_DIRECTOR_NOT_ACTIVE
  );
  await repo.activateMapping(suspCode);
  check("re-activation restores the suspended Director", (await repo.findActiveByCode(suspCode))?.status === "active");
  await repo.activateMapping(retiredCode);
  check("rollback re-activates the retired Director", (await repo.activeCount()) === 10);
  evidence.steps.stepE = { retired: retiredCode, suspended: suspCode, activeAfterReactivation: 10 };

  // -------------------------------------------------------------- step F
  for (const code of CANONICAL_DIRECTOR_CODES) {
    if ((await repo.findByCode(code))?.status === "active") await repo.retireMapping(code, { retiredReason: "seed rollback" });
  }
  await db.query("DELETE FROM canonical_director_mappings WHERE underlying_agent_id = ANY($1::text[]);", [NEW_UNDERLYING_AGENT_IDS]);
  await db.query("DELETE FROM agents WHERE id = ANY($1::text[]);", [NEW_UNDERLYING_AGENT_IDS]);
  const post = {
    mappings: (await scalar("SELECT count(*)::int AS c FROM canonical_director_mappings")).c,
    agents: (await scalar("SELECT count(*)::int AS c FROM agents")).c,
    preserved: (await db.query(PRESERVED_SQL, [PRESERVED_UNDERLYING_AGENT_IDS])).rows,
    legacy: (await db.query(LEGACY_SQL)).rows,
  };
  const postPreserved = (
    await db.query(
      `SELECT underlying_agent_id, status FROM canonical_director_mappings ORDER BY underlying_agent_id;`
    )
  ).rows;
  check(
    "rollback keeps exactly the four preserved mappings, all retired (§8: retire, never delete history)",
    post.mappings === 4 &&
      postPreserved.every((row) => row.status === "retired") &&
      JSON.stringify(postPreserved.map((r) => r.underlying_agent_id).sort()) ===
        JSON.stringify([...PRESERVED_UNDERLYING_AGENT_IDS].sort()),
    `mappings=${post.mappings} ${JSON.stringify(postPreserved)}`
  );
  check("rollback removes the six new agent rows", post.agents === 21, `agents=${post.agents}`);
  check("rollback leaves the four preserved agents byte-identical", JSON.stringify(post.preserved) === JSON.stringify(base.preserved));
  check("rollback leaves all 17 legacy identities intact", JSON.stringify(post.legacy) === JSON.stringify(base.legacy));
  evidence.steps.stepF = { mappings: post.mappings, agents: post.agents, legacy: post.legacy.length, mappingsRetired: postPreserved.length };

  evidence.result = "PASS";
  evidence.summary = { checks: checks.length, failed: checks.filter((c) => !c.ok).length };
  mkdirSync(EVIDENCE_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
  writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  console.log(`\nREHEARSAL_COMPLETE checks=${checks.length} failed=0 evidence=${EVIDENCE_PATH}`);
  if (typeof db.close === "function") await db.close();
}

try {
  await main();
  process.exit(0);
} catch (error) {
  evidence.result = "FAIL";
  evidence.error = { message: error?.message ?? String(error), code: error?.code ?? null };
  try {
    mkdirSync(EVIDENCE_PATH.replace(/\/[^/]+$/, ""), { recursive: true });
    writeFileSync(EVIDENCE_PATH, `${JSON.stringify(evidence, null, 2)}\n`);
  } catch {
    /* evidence path unavailable */
  }
  console.error(`REHEARSAL_FAILED ${error?.message ?? error}`);
  process.exit(1);
}
