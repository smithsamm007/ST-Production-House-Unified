# PostgreSQL Persistence and Authenticated API Architecture

This document details the production-grade PostgreSQL persistence layer, real Argon2id password authentication, standards-compliant TOTP MFA, secure CSRF protections, and the REST API server introduced in Task 10.

## 1. Local PostgreSQL Setup
To configure a local PostgreSQL instance:
1. Ensure PostgreSQL is installed (minimum version 15 is recommended).
2. Connect to the database cluster and create a dedicated database owner user and database:
   ```sql
   CREATE USER st_owner WITH SUPERUSER PASSWORD 'st_password';
   CREATE DATABASE st_production OWNER st_owner;
   ```
3. Set the standard `DATABASE_URL` environment variable:
   ```bash
   DATABASE_URL=postgres://st_owner:st_password@localhost:5432/st_production
   MFA_ENCRYPTION_KEY=0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
   USE_PG=true
   ```

## 2. Database Migrations
SQL migrations reside in the `sql/` folder and are run sequentially by `src/catalog/migrate.js`.
- Each migration file runs atomically inside a transaction along with its tracking record in `schema_migrations` to prevent partial deployment states.
- Running migrations is idempotent (repeat-safe).

## 3. Owner Bootstrap
The first privileged owner account is bootstrapped using:
```bash
BOOTSTRAP_OWNER_EMAIL=owner@example.com BOOTSTRAP_OWNER_PASSWORD=SomeSecurePassword123! node src/catalog/bootstrap.js
```
- Weak or compromised passwords are rejected.
- Bootstrap is idempotent and prevents silenty creating multiple superusers/owners once one already exists.

## 4. API Endpoints and Authentication
The API is implemented using Express in `src/catalog/server.js`:

- **Public Routes**:
  - GET `/api/health` — Checks API server health.
  - GET `/api/ready` — Verifies PostgreSQL connection readiness.
  - POST `/api/auth/register` — Registers initial owner (disabled if one already exists).
  - POST `/api/auth/login` — Auths credentials, sets secure cookie, and returns a CSRF token.

- **Private Routes** (Require Authentication Middleware):
  - POST `/api/auth/logout` — Revokes session token.
  - GET `/api/auth/me` — Safe DTO serialization of current owner.
  - GET `/api/auth/sessions` — List active sessions.
  - DELETE `/api/auth/sessions/:id` — Revoke individual session.
  - DELETE `/api/auth/sessions/other` — Revoke all other sessions.
  - POST `/api/auth/mfa/enroll` — Sets up standards-compliant TOTP enrollment.
  - POST `/api/auth/mfa/confirm` — Confirms TOTP setup and outputs recovery codes.
  - POST `/api/auth/mfa/verify` — Elevates session assurance to high.
  - GET `/api/agents` — Lists preloaded and registered agents.
  - GET `/api/agents/:id` — Retreive single agent.
  - POST `/api/agents` — Administer/add new agent (Max 50-agent check).

## 5. Security Measures
- **Argon2id Hashing**: Genuine, native Argon2id password hashing is utilized.
- **Hashed Session & CSRF Tokens**: Session tokens and CSRF materials are only stored as SHA-256 hashes in the database.
- **CSRF Check**: State-mutating requests (POST, DELETE) verified via cookie require a valid `x-csrf-token` header.
- **Lockouts**: 5 consecutive failed logins triggers a 15-minute account lockout.
- **Replay Prevention**: TOTP codes are one-time-use per step window.
- **MFA Encryption**: Plaintext TOTP keys are encrypted using AES-256-GCM.
- **Redacted Errors**: URL connection details are stripped from all database error responses to prevent secret leakage.
