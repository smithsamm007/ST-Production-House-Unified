# PostgreSQL 15 Rehearsal — Acceptance Record

**Date:** 2026-11-15 · **Driver:** `scripts/director_registry_rehearsal.mjs` · **Evidence:** `artifacts/rehearsal/DIRECTOR_REHEARSAL_EVIDENCE.json` (git-ignored; regenerate with the command below)

This record covers **executed** PostgreSQL work only. `sql/033` and `sql/034` are **not** in the
repository: promotion remains an Owner decision, as required.

## 1. Environment (no production credentials)

| Item | Value |
|---|---|
| Server | `PostgreSQL 15.20 (Ubuntu 15.20-1.pgdg24.04+1) on x86_64-pc-linux-gnu` |
| Provenance | official PGDG `noble-pgdg` packages, extracted unprivileged with `dpkg-deb -x` (no root, no service install) |
| Binding | `listen_addresses=127.0.0.1`, port `55432`, `--auth=trust`, data directory under `scratch/pg15/` (git-ignored) |
| Databases | `st_rehearsal` (integration suite), `st_director_rehearsal` (recreated per run) |
| Credentials | none used, none stored; no production DSN was read or requested |

Reproduce:

```bash
# 1. disposable server (once)
cd scratch/pg15 && export LD_LIBRARY_PATH="$PWD/root/usr/lib/x86_64-linux-gnu"
BIN="$PWD/root/usr/lib/postgresql/15/bin"
"$BIN/initdb" -D data -U postgres --auth=trust --locale=C --encoding=UTF8
"$BIN/pg_ctl" -D "$PWD/data" -o "-k $PWD/sock -p 55432 -c listen_addresses=127.0.0.1 -c fsync=off" -l "$PWD/server.log" -w start

# 2. schema + suite
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/st_rehearsal"
npm run migrate && npm run test:integration

# 3. Director rehearsal (fresh database per run)
psql -h 127.0.0.1 -p 55432 -U postgres -d postgres -c "DROP DATABASE IF EXISTS st_director_rehearsal" -c "CREATE DATABASE st_director_rehearsal"
export DATABASE_URL="postgresql://postgres@127.0.0.1:55432/st_director_rehearsal"
npm run migrate && node scripts/director_registry_rehearsal.mjs
```

The driver refuses any database that is not loopback or whose name does not contain
`rehearsal|test|disposable|scratch|tmp` (`assertDisposable`), so it cannot be aimed at production.

## 2. Migration execution — PASS

| Check | Result |
|---|---|
| `npm run migrate` | `{"code":"MIGRATIONS_COMPLETE","appliedCount":32}` — migrations `001`–`032` applied |
| Ledger | `schema_migrations` = 32 rows |
| `npm run migrate:status` | 32 applied, 0 pending |

This is the first execution of the full migration chain recorded for this project.

## 3. Integration suite (the job whose failure merged anyway) — PASS

`npm run test:integration` against the fresh 001–032 database:

```
ℹ tests 77
ℹ pass 77
ℹ fail 0
ℹ skipped 0
```

All 19 integration files ran; none skipped. **This does not explain the 2026-11-13 red run.**
It establishes that the suite is green on a clean 001–032 database at `HEAD`, which narrows the
original failure to environment or shared-state causes. The CI step log for job
`132118395367` is still required before that incident is closed.

### 3.1 Reproducibility defect found and repaired

A second run against the **same** database failed 1 of 77:

```
test at tests/postgresAuthIntegration.integration.js:18
✖ live PostgreSQL authentication, CSRF, MFA and owner isolation
  Error: OWNER_BOOTSTRAP_ALREADY_COMPLETED (src/catalog/repositories.js:43)
```

Cause: the suite bootstraps **the** owner row, and `OwnerRepository.createInitial` correctly
refuses once any owner exists. The product rule is right; the test assumed a virgin database, so
any job that reuses one (retry in the same container, persistent self-hosted volume, a
re-entered workflow) turns green code red. That is a plausible cause class for the 2026-11-13
failure and, more importantly, it makes the gate non-deterministic.

Repair: the suite now creates its own database per run (`<db>_authtest_<pid>_<ms>`), migrates
it, and drops it (`WITH (FORCE)`) in `finally`. If database creation is not permitted, it
verifies that the shared database has no owner yet and otherwise reports
`AUTH_SUITE_REQUIRES_EMPTY_DATABASE` as a skip — no assertion was weakened and the
single-owner rule was not relaxed.

After the repair, on the same reused database, two consecutive full runs:

```
RUN 1: tests 77  pass 77  fail 0  skipped 0
exit 0
RUN 2: tests 77  pass 77  fail 0  skipped 0
exit 0
```

## 4. Director registry rehearsal — PASS (39/39 checks)

Steps A–C, the cap boundary, lifecycle enforcement and the rollback from
`PHASE_2_INITIAL_SEED_DESIGN.md` were executed against a fresh 001–032 database.

| Phase | Checks | Result |
|---|---|---|
| Baseline | 32 migrations, 0 mappings, 21 agents, 4 preserved keys, 17 legacy identities | PASS |
| Pre-seed | `activateMapping("JARVIS")` ⇒ `CANONICAL_DIRECTOR_NOT_FOUND` | PASS |
| A — six agents | inserts 6, second run inserts **0**, total 27 | PASS |
| B — ten mappings | inserts 10 **all retired**, second run inserts **0**, four preserved keys reused | PASS |
| C — activation | all ten active, active set = frozen code list, retirement bookkeeping cleared | PASS |
| Preserved rows | `agent-01/02/03/21` byte-identical (`id,name,namespace,enabled`) after seed **and** after activation | PASS |
| Cap | 51 rows seeded, exactly 50 active, 51st refused by the DB trigger (`P0001`), ten-code constraint restored (`23514`) | PASS |
| Retirement | `status=retired` + reason, agent row kept, no active origin, enforcement refuses (`CANONICAL_DIRECTOR_NOT_ACTIVE`), other nine active | PASS |
| Suspension | enforcement refuses, re-activation restores | PASS |
| 17 legacy identities | **ungoverned**: no mapping row, enforcement passes, history intact | PASS (see §5) |
| Rollback (§8) | 4 preserved mappings retired (not deleted), six new agents removed, 21 agents, legacy rows intact | PASS |

## 5. Findings that must be resolved before promoting 033/034

1. **The 50-active-Director cap protects nothing today.** Three independent reasons:
   - `canonical_director_code` is `CHECK … IN (<ten codes>)`, so active mappings can never
     exceed 10;
   - `CanonicalDirectorRepository.activateMapping` calls `assertKnownCode` first, so the
     repository's cap branch (`ACTIVE_DIRECTOR_CAP_REACHED`) is unreachable — a non-canonical
     code is refused as `CANONICAL_DIRECTOR_CODE_INVALID` before the count is read;
   - even with both relaxed, `underlying_agent_id` is `UNIQUE` and `agents_max_50` caps agents
     at 50, so at most 33 mappings can exist after this seed.
   The cap was exercised only by temporarily dropping the code constraint and the agent
   ceiling **on the disposable database**; the trigger itself is correct and refuses the 51st.
   Decision needed: either remove the cap as dead code, or make it meaningful (raise the agent
   ceiling / allow future codes).
2. **The 17 legacy identities are not retired by this design.** Today they remain operational
   ungoverned agents: no mapping row, `enforceOperationalActive` returns `null`, and the sql/032
   triggers do not cover them. "Prevented from new production operations while history stays
   readable" needs its own mechanism (a `legacy_director_identities` table consulted by the
   guard, or mapping rows in a `legacy` state). This is **not implemented** and must be designed
   and rehearsed before `sql/033` is written.
3. **Seeding is not idempotent-by-constraint for names.** Steps A/B re-run cleanly here, but a
   pre-existing agent holding `COSMOS` or `st.agent.cosmos` fails the seed with `23505` instead
   of being reported as a conflict to resolve.

## 6. Acceptance boundary

| Level | Status |
|---|---|
| Implemented | migrations 001–032, registry, guards, gate repair — present |
| Verified (this record) | migrations 001–032 execute; 19 integration files 77/77 twice on the same reused database; seed/cap/retirement/rollback 39/39 on PostgreSQL 15.20 |
| Not verified | `sql/033`/`sql/034` (not written), legacy-identity prevention (not implemented), live providers/OAuth/publishing receipts, deployment, autonomous merge on a live PR |
| Operational | **not demonstrated** — no cloud deployment, no monitoring, no delivered episode |

Promotion of `033`/`034` stays blocked until findings 1–3 are decided and the legacy-identity
mechanism is designed and rehearsed here. Live provider work needs owner-held accounts and
never a pasted credential.
