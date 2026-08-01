# PostgreSQL Persistence and Authenticated API Architecture

This document details the production-grade PostgreSQL persistence layer, real Argon2id password authentication, standards-compliant TOTP MFA, secure CSRF protections, and the REST API server.

## 1. Local PostgreSQL Setup
To configure a local PostgreSQL instance under least-privilege practices:
1. Ensure PostgreSQL is installed (minimum version 15 is recommended).
2. Connect to the database cluster as an admin and create a dedicated database owner user and database with restricted, database-scope privileges:
   ```sql
   CREATE USER st_owner WITH PASSWORD '<SET-VIA-SECRET-MANAGER>';
   CREATE DATABASE st_production OWNER st_owner;
   GRANT ALL PRIVILEGES ON DATABASE st_production TO st_owner;

   -- Connect to st_production and grant public schema permissions to st_owner
   \c st_production
   GRANT ALL ON SCHEMA public TO st_owner;
   ```
3. Set the standard `DATABASE_URL` environment variable:
   ```bash
   DATABASE_URL=postgres://st_owner:<SET-VIA-SECRET-MANAGER>@localhost:5432/st_production
   MFA_ENCRYPTION_KEY=<SET-VIA-SECRET-MANAGER>
   USE_PG=true
   ```

## 2. Database Migrations
SQL migrations reside in the `sql/` folder and are run sequentially by the canonical migration runner in `src/db/migrationRunner.js` via the standard npm command:
```bash
npm run migrate
```
- Each migration file runs atomically inside a transaction along with its tracking record in `schema_migrations` to prevent partial deployment states.
- Running migrations is idempotent (repeat-safe).

## 3. Owner Bootstrap
The first privileged owner account is bootstrapped using:
```bash
BOOTSTRAP_OWNER_EMAIL=owner@example.com BOOTSTRAP_OWNER_PASSWORD=<SET-VIA-SECRET-MANAGER> node src/catalog/bootstrap.js
```
- Weak or compromised passwords are rejected.
- Bootstrap is idempotent and prevents silently creating multiple superusers/owners once one already exists.

## 4. API Endpoints and Authentication
The API is implemented using Express in `src/catalog/server.js`:

- **Public Routes**:
  - GET `/api/health` — Checks API server health.
  - GET `/api/ready` — Verifies PostgreSQL connection readiness.
  - POST `/api/auth/register` — Registers initial owner (disabled if one already exists).
  - POST `/api/auth/login` — Auths credentials, sets secure cookie, and returns a CSRF token.

- **Private Routes** (Require Authentication Middleware):
  - GET `/api/auth/me` — Retrieves current owner profile.
  - POST `/api/auth/logout` — Revokes current session and clears the cookie.
  - GET `/api/auth/sessions` — Lists active sessions for the current owner.
  - DELETE `/api/auth/sessions/:id` — Revokes a specific session (owner-scoped).
  - DELETE `/api/auth/sessions/other` — Revokes all other sessions for the owner.
  - POST `/api/auth/mfa/enroll` — Initiates TOTP enrollment.
  - POST `/api/auth/mfa/confirm` — Confirms TOTP setup and returns recovery codes.
  - POST `/api/auth/mfa/verify` — Validates TOTP and elevates/rotates the session.
