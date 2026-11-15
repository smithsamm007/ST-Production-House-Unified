# Migration failure diagnostics

## Why this exists

`MigrationRunner` now distinguishes two failures that used to look identical:

| Failure | What it means |
|---|---|
| `MigrationExecutionError` | the migration referenced something that does not exist at all |
| `MigrationSearchPathMismatchError` | the object **does** exist, but in a schema this session cannot reach |

The second case is a real trap. A guard written as

```sql
IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'x') THEN
  CREATE TYPE x AS ENUM (...);
END IF;
```

checks the **whole catalog**, while a later unqualified `column x` resolves
through **`search_path`**. If a stale copy of `x` exists in any schema the
session cannot see, creation is skipped and the reference then fails with the
misleading message `type "x" does not exist`. `sql/032_canonical_director_mappings.sql`
uses exactly this pattern (immutable, and not edited to work around it).

## Measured behaviour

Rehearsed on disposable PostgreSQL 15 databases:

| Scenario | Result |
|---|---|
| Fresh database, migrate into a fresh schema | applies |
| New schema while `public` owns the enum | applies (the column binds to `public`'s type) |
| Enum exists only in a schema outside the effective `search_path` | fails, now reported as `MigrationSearchPathMismatchError` |

The third case is what the old message hid, and it is why the backup/restore
drill isolates each leg in its own **database** rather than its own schema.

## What the error tells you

`MigrationSearchPathMismatchError` carries:

- `filename` — the migration that failed,
- `objectName` — the type that could not be resolved,
- `existingSchemas` — every schema that actually owns it,
- `searchPath` — the effective `search_path` of the failing session.

The message states the fix (migrate into `public`, or put the owning schema on
`search_path`) and repeats that **applied migration files must not be edited**.

## Guarantees

- No migration file is modified, and no checksum changes.
- The diagnostic only fires for SQLSTATE `42704` (`undefined_object`) when the
  object is found in at least one unreachable schema; every other failure keeps
  its previous error type and message.
- The probe runs **after** the failed transaction has rolled back and released
  its client, so it can never observe or extend an aborted session.
- A failed migration still leaves no partial state.

Acceptance: `tests/migrationSearchPathDiagnostic.integration.js` reproduces the
trap inside a disposable database, asserts the structured fields, and asserts a
genuinely missing object still raises the ordinary error.
