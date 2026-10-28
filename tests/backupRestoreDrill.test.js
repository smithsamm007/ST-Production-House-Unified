import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  DRILL_ERROR_CODES,
  assertSafeIdentifier,
  canonicalJson,
  digestRows,
  foreignKeyRestoreOrder,
  sha256Hex,
  verifyRestoredAgainstManifest,
} from "../src/recovery/backupRestoreDrill.js";

function fakeAdapter(executor) {
  return { query: async (sql, params) => executor({ sql, params }) };
}

function tableEntry(name, rows, extra = {}) {
  return {
    name,
    columns: Object.keys(rows[0] || { id: null }),
    dependsOn: [],
    rowCount: rows.length,
    digest: digestRows(rows),
    ...extra,
  };
}

test("digestRows is order-independent and detects any row change", () => {
  const rows = [
    { id: 1, label: "a", at: new Date("2026-01-01T00:00:00Z") },
    { id: 2, label: "b", at: new Date("2026-01-02T00:00:00Z") },
    { id: 3, label: "c", at: new Date("2026-01-03T00:00:00Z") },
  ];
  const digestCurrentOrder = digestRows(rows);
  const digestReversed = digestRows([...rows].reverse());
  assert.equal(digestCurrentOrder, digestReversed, "physical row order must not change the digest");

  const mutated = rows.map((r) => (r.id === 2 ? { ...r, label: "b2" } : { ...r }));
  assert.notEqual(digestRows(mutated), digestCurrentOrder, "a one-field edit must change the digest");

  const deleted = rows.slice(0, 2);
  assert.notEqual(digestRows(deleted), digestCurrentOrder, "a deleted row must change the digest");
});

test("digestRows of an empty table is the empty-table digest exactly", () => {
  assert.equal(digestRows([]), sha256Hex("0:"));
});

test("canonicalJson sorts keys recursively — id recomputation is byte-identical", () => {
  const a = { tables: [{ name: "agents", rowCount: 2 }], recordsComplete: true, migrationHistory: [] };
  const b = { recordsComplete: true, migrationHistory: [], tables: [{ rowCount: 2, name: "agents" }] };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(sha256Hex(canonicalJson(a)), sha256Hex(canonicalJson(b)));
});

test("assertSafeIdentifier rejects injection, catalog, path and whitespace shapes", () => {
  for (const bad of [
    "owners; DROP TABLE owners",
    '"owners"',
    "pg_catalog.pg_tables",
    "public/agents",
    "a b",
    "",
    "-x",
    "ONSERS" + "S".repeat(200),
    "x'.join('')",
  ]) {
    assert.throws(() => assertSafeIdentifier(bad, "table"), (err) => err.code === DRILL_ERROR_CODES.UNSAFE_IDENTIFIER);
  }
  assert.throws(() => assertSafeIdentifier("a.b", "column"), /UNSAFE_IDENTIFIER/);
  assert.equal(assertSafeIdentifier("owner", "table"), "owner");
  assert.equal(assertSafeIdentifier("password_hash", "column"), "password_hash");
});

test("foreignKeyRestoreOrder emits referenced tables before dependants and fails closed on cycles", () => {
  const order = foreignKeyRestoreOrder([
    { name: "zz_jobs", dependsOn: ["aa_agents", "aa_owners"] },
    { name: "aa_agents", dependsOn: ["aa_owners"] },
    { name: "aa_jobs", dependsOn: ["aa_agents", "aa_owners"] },
    { name: "aa_owners", dependsOn: [] },
  ]);
  const position = (n) => order.indexOf(n);
  assert.ok(position("aa_owners") < position("aa_agents"));
  assert.ok(position("aa_agents") < position("aa_jobs"));
  assert.ok(position("aa_jobs") < position("zz_jobs"));

  assert.throws(
    () => foreignKeyRestoreOrder([
      { name: "a", dependsOn: ["b"] },
      { name: "b", dependsOn: ["a"] },
    ]),
    (err) => err.code === DRILL_ERROR_CODES.FK_CYCLE
  );
});

test("verifyRestoredAgainstManifest fails closed for every tamper shape and passes untouched restore", () => {
  const rows = [
    { id: "o1", email: "a@x", n: 1 },
    { id: "o2", email: "b@x", n: 2 },
  ];
  const agentRows = [{ id: "ag1", name: "AG" }];
  const manifest = {
    manifestId: sha256Hex("m"),
    tables: [tableEntry("owners", rows), tableEntry("agents", agentRows)],
    migrationHistory: [{ filename: "001.sql", checksum: "c1", applied_at: 1, execution_time_ms: 5 }],
    recordsComplete: true,
  };

  const honestProbe = {
    manifestId: sha256Hex("m"),
    tables: [tableEntry("owners", rows), tableEntry("agents", agentRows)],
    migrationHistory: manifest.migrationHistory,
    recordsComplete: true,
  };
  const pass = verifyRestoredAgainstManifest(honestProbe, manifest);
  assert.equal(pass.verdict, "PASS");
  assert.equal(pass.tables.filter((r) => r.ok === true).length, 2);

  // 1: a substituted row (tampering) — digest mismatch
  const tampered = {
    manifestId: sha256Hex("m2"),
    tables: [
      tableEntry("owners", [{ ...rows[0] }, { ...rows[1], email: "hacker@x" }]),
      tableEntry("agents", agentRows),
    ],
    migrationHistory: manifest.migrationHistory,
  };
  const r1 = verifyRestoredAgainstManifest(tampered, manifest);
  assert.equal(r1.verdict, "FAIL");
  assert.ok(r1.tables.some((t) => t.table === "owners" && t.code === DRILL_ERROR_CODES.VERIFY_DIGEST_MISMATCH));

  // 2: a missing restored table
  const r2 = verifyRestoredAgainstManifest(
    { tables: [tableEntry("agents", agentRows)], migrationHistory: manifest.migrationHistory, recordsComplete: true },
    manifest
  );
  assert.ok(r2.tables.some((t) => t.table === "owners" && t.code === DRILL_ERROR_CODES.VERIFY_MISSING_TABLE));
  assert.equal(r2.verdict, "FAIL");

  // 3: row-count drift (extra restored row)
  const r3 = verifyRestoredAgainstManifest(
    {
      tables: [tableEntry("owners", [...rows, { id: "o3", email: "c@x", n: 3 }]), tableEntry("agents", agentRows)],
      migrationHistory: manifest.migrationHistory,
      recordsComplete: true,
    },
    manifest
  );
  assert.ok(r3.tables.some((t) => t.table === "owners" && t.code === DRILL_ERROR_CODES.VERIFY_COUNT_MISMATCH));

  // 4: migration-history divergence (checksum rewritten on the restored side)
  const r4 = verifyRestoredAgainstManifest(
    {
      tables: [tableEntry("owners", rows), tableEntry("agents", agentRows)],
      migrationHistory: [{ filename: "001.sql", checksum: "TAMPERED", applied_at: 1, execution_time_ms: 5 }],
      recordsComplete: true,
    },
    manifest
  );
  assert.ok(r4.tables.some((t) => t.table === "schema_migrations" && t.code === DRILL_ERROR_CODES.VERIFY_MIGRATION_HISTORY_MISMATCH));
  assert.equal(r4.verdict, "FAIL");

  // 5: an incomplete (truncated) backup can never verify
  const r5 = verifyRestoredAgainstManifest(
    honestProbe,
    { ...manifest, tables: manifest.tables.map((t) => ({ ...t, recordsComplete: false })) }
  );
  assert.ok(r5.tables.some((t) => t.code === DRILL_ERROR_CODES.VERIFY_INCOMPLETE_BACKUP));
  assert.equal(r5.verdict, "FAIL");

  // 6: a foreign table on the restored side is unexpected — fail closed
  const r6 = verifyRestoredAgainstManifest(
    {
      tables: [tableEntry("owners", rows), tableEntry("agents", agentRows), tableEntry("strangers", [{ id: 1 }])],
      migrationHistory: manifest.migrationHistory,
      recordsComplete: true,
    },
    manifest
  );
  assert.equal(r6.verdict, "FAIL");

  // Offline reuse: fake adapter probes used by the integration runner share this exact contract
  const adapter = fakeAdapter(() => { throw new Error("not used in verify"); });
  assert.equal(typeof adapter.query, "function");
});

test("row hash helper never collides on the protected per-row canonical form", () => {
  const row = { id: 1, name: "x" };
  const neighbor = { id: 1, name: "y" };
  assert.notEqual(digestRows([row]), digestRows([neighbor]));
});

test("assertSafeIdentifier accepts a random uuid-shaped namespace prefix honestly", () => {
  const name = `stph_drill_src_${crypto.randomUUID().replace(/-/g, "_")}`;
  assert.equal(assertSafeIdentifier(name, "table"), name);
});
