# Phase 2 — Runnable Control Plane Implementation

Estimated: 3–5 weeks (with focused AI assistance and two experienced engineers)

## Objectives

Transform the verified foundation (Tasks 1–3.8) into a working control plane that:

1. **Exposes all domain policies via a secure API**
2. **Provides owner dashboard UI** (separate repository recommended)
3. **Enforces authentication, authorization, and CSRF protection**
4. **Wires PostgreSQL repositories** to all business logic
5. **Adds Redis or PostgreSQL worker leases** with concurrency observability
6. **Integrates credential broker** per-agent task-provider configuration
7. **Supports email and social account management** (connections only, no live OAuth yet)

## Architecture

### 2.1 API Server Foundation (1 week)

**Repository**: This codebase  
**Entry Point**: `src/catalog/server.js` → Express app wired to all repositories  
**Auth**: Argon2id password + optional passkey WebAuthn  
**Session**: PostgreSQL session store with CSRF token protection  
**Endpoints**:

#### Owner Authentication
```
POST   /auth/register              Create owner account
POST   /auth/login                 Authenticate and create session
POST   /auth/login/mfa             Complete MFA/TOTP challenge
POST   /auth/passkey/challenge     WebAuthn registration challenge
POST   /auth/passkey/verify        WebAuthn attestation verification
POST   /auth/logout                Destroy session
GET    /auth/status                Check session status
```

#### Owner Account Management
```
GET    /owners/:ownerId            Get owner profile
PUT    /owners/:ownerId            Update owner profile
GET    /owners/:ownerId/sessions   List active sessions
DELETE /owners/:ownerId/sessions/:sessionId  Revoke specific session
POST   /owners/:ownerId/mfa/enable Enable TOTP
POST   /owners/:ownerId/mfa/verify Verify TOTP setup
POST   /owners/:ownerId/mfa/disable Disable TOTP
POST   /owners/:ownerId/recovery-codes  Get new recovery codes
```

#### Agent Management
```
GET    /owners/:ownerId/agents                          List all agents (canonical 20)
GET    /owners/:ownerId/agents/:agentId                Get agent details
PUT    /owners/:ownerId/agents/:agentId                Update agent public profile
GET    /owners/:ownerId/agents/:agentId/email-accounts List email connections
POST   /owners/:ownerId/agents/:agentId/email-accounts Add email connection
DELETE /owners/:ownerId/agents/:agentId/email-accounts/:emailId Remove email
GET    /owners/:ownerId/agents/:agentId/social-accounts List social connections
POST   /owners/:ownerId/agents/:agentId/social-accounts Add social connection
DELETE /owners/:ownerId/agents/:agentId/social-accounts/:accountId Remove social
```

#### Creative Charter Management
```
GET    /owners/:ownerId/charters                       List creative charters
POST   /owners/:ownerId/charters                       Create new charter
GET    /owners/:ownerId/charters/:charterId            Get charter
PUT    /owners/:ownerId/charters/:charterId            Update draft charter
POST   /owners/:ownerId/charters/:charterId/approve    Owner approve (lock version)
GET    /owners/:ownerId/charters/:charterId/versions   List charter versions
GET    /owners/:ownerId/charters/:charterId/versions/:versionId Specific version
POST   /owners/:ownerId/charters/:charterId/preview    Preview sanitized worker context
```

#### Reference Library Management
```
GET    /owners/:ownerId/references                     List all references
POST   /owners/:ownerId/references                     Submit new reference
GET    /owners/:ownerId/references/:refId              Get reference details
PUT    /owners/:ownerId/references/:refId              Update reference metadata
POST   /owners/:ownerId/references/:refId/analyze      Trigger analysis workflow
GET    /owners/:ownerId/references/:refId/analysis     Get analysis results
POST   /owners/:ownerId/references/:refId/approve      Approve reference
DELETE /owners/:ownerId/references/:refId              Remove reference
```

#### Credential and Provider Configuration
```
GET    /owners/:ownerId/credentials                    List credential locators (safe view)
POST   /owners/:ownerId/credentials                    Register credential in secret manager
DELETE /owners/:ownerId/credentials/:credentialId      Revoke credential
GET    /owners/:ownerId/providers                      List provider configurations
POST   /owners/:ownerId/providers                      Configure provider slot
PUT    /owners/:ownerId/providers/:providerId          Update provider configuration
DELETE /owners/:ownerId/providers/:providerId          Remove provider
POST   /owners/:ownerId/providers/:providerId/test     Test provider connectivity
```

#### Resilience and Control
```
GET    /owners/:ownerId/circuit-breakers               List all circuit breaker states
GET    /owners/:ownerId/quarantines                    List active quarantines
POST   /owners/:ownerId/quarantines/:quarantineId/resolve Resolve quarantine
GET    /owners/:ownerId/alerts                         List owner alerts
POST   /owners/:ownerId/alerts/:alertId/acknowledge    Acknowledge alert
POST   /owners/:ownerId/alerts/:alertId/resolve        Resolve alert
GET    /owners/:ownerId/emergency-pause                Get pause status
POST   /owners/:ownerId/emergency-pause/activate       Invoke emergency pause
POST   /owners/:ownerId/emergency-pause/resume         Resume operations
```

#### Job and Worker Management (Phase 2 extension)
```
GET    /owners/:ownerId/jobs                           List jobs
GET    /owners/:ownerId/jobs/:jobId                    Get job details
GET    /owners/:ownerId/jobs/:jobId/evidence           Get job evidence
GET    /owners/:ownerId/workers                        List active workers
GET    /owners/:ownerId/workers/:workerId/status       Get worker status
POST   /owners/:ownerId/workers/:workerId/cancel       Cancel worker task
```

### 2.2 Authentication & Authorization (1 week)

**Files**:
- `src/catalog/ownerAuthentication.js` ← Extend with PostgreSQL session store
- `src/auth/passwordHash.js` — Argon2id hashing with configurable strength
- `src/auth/sessionManager.js` — PostgreSQL session store and rotation
- `src/auth/csrfProtection.js` — CSRF token validation

**Features**:
- ✅ Owner registration (email validation, password strength)
- ✅ Login with session creation and token rotation
- ✅ TOTP MFA with recovery codes
- ✅ WebAuthn passkey support (challenge/attestation/assertion)
- ✅ Session expiration and revocation
- ✅ CSRF protection on all mutations
- ✅ Secure cookie handling (HttpOnly, SameSite, Secure in production)

**Migration**: Extend `sql/009_add_owner_role.sql` with:
- `owner_sessions` table (tokens, CSRF, expiration)
- `owner_password_hashes` table (Argon2id with salt/cost parameters)
- `owner_totp_secrets` table (encrypted TOTP seeds)
- `owner_recovery_codes` table (BCRYPT hashed codes)
- `owner_passkeys` table (WebAuthn credentials)
- `owner_security_audit` table (login attempts, MFA events, sessions)

### 2.3 PostgreSQL Repositories (1.5 weeks)

Wire all domain logic to PostgreSQL:

**Agent Identity Repositories**:
- `src/db/repositories/AgentPublicProfileRepository.js`
- `src/db/repositories/AgentEmailConnectionRepository.js`
- `src/db/repositories/AgentSocialAccountRepository.js`

**Creative Charter Repositories**:
- `src/db/repositories/CreativeCharterRepository.js`
- `src/db/repositories/CreativeUniverseRepository.js`
- `src/db/repositories/CharterVersioningRepository.js`

**Reference Library Repositories**:
- `src/db/repositories/CreativeReferenceRepository.js`
- `src/db/repositories/NicheProfileRepository.js`
- `src/db/repositories/VisualProfileRepository.js`
- `src/db/repositories/ReferenceAnalysisRepository.js`

**Provider & Credential Repositories**:
- `src/db/repositories/ProviderConfigurationRepository.js`
- `src/db/repositories/CredentialRegistryRepository.js`
- `src/db/repositories/CredentialBrokerRepository.js` (extend existing)

**Job & Worker Repositories**:
- `src/db/repositories/JobLifecycleRepository.js` (extend existing)
- `src/db/repositories/WorkerLeaseRepository.js` (extend checkpoint manager)
- `src/db/repositories/JobEvidenceRepository.js`

**Resilience Repositories**:
- `src/db/repositories/CircuitBreakerRepository.js` (extend existing)
- `src/db/repositories/QuarantineRepository.js` (extend existing)
- `src/db/repositories/OwnerAlertsRepository.js` (extend existing)
- `src/db/repositories/EmergencyPauseRepository.js` (extend existing)

### 2.4 Worker Lease Management (1 week)

**PostgreSQL or Redis Worker Leases** for executing jobs safely:

**Files**:
- `src/workers/workerLeaseManager.js` — Atomic lease claiming with timeout
- `src/workers/workerPool.js` — Pool management and health checks
- `src/workers/workerHeartbeat.js` — Periodic heartbeat to extend leases
- `src/observability/workerMetrics.js` — Concurrency, latency, error rates

**Features**:
- ✅ Atomic `SELECT ... FOR UPDATE SKIP LOCKED` job claiming
- ✅ Per-agent concurrency limits (configurable, default 10)
- ✅ Bounded lease duration (default 5 minutes, configurable per job type)
- ✅ Lease renewal during execution (heartbeat)
- ✅ Expired lease reclamation and job re-queuing
- ✅ Worker pool health monitoring (CPU, memory, queue depth)
- ✅ Graceful worker shutdown (finish current lease, drain queue)
- ✅ Observability: Prometheus metrics and structured logs

### 2.5 Per-Agent Provider Configuration (0.5 weeks)

**UI/API for owner to configure provider slots per agent**:

```
POST /owners/:ownerId/agents/:agentId/provider-config
{
  "slot": "primary",
  "provider": "gemini",
  "credentialId": "uuid-of-vault-locator",
  "apiVersion": "v1",
  "timeoutMs": 30000,
  "retryLimit": 3
}
```

**Database**: Extend `sql/010_job_lifecycle.sql` with:
- `agent_provider_configurations` table
- Per-agent fallback ordering and policy

### 2.6 Email and Social Account Management (0.5 weeks)

**UI/API for owner to register channels** (OAuth config deferred to Phase 4):

```
POST /owners/:ownerId/agents/:agentId/social-accounts
{
  "platform": "youtube",
  "channelName": "My Channel",
  "channelId": "UCxxxxx",
  "accountType": "unconfigured"  # or "oauth_pending", "live", "paused"
}
```

## Acceptance Criteria

Run:

```bash
npm ci
npm run verify
npm test
npm run test:integration
npm run server:start  # Should start on port 3000 or env PORT
```

### API Requirements

- ✅ All owner authentication endpoints functional
- ✅ All agent/charter/reference endpoints return safe data (no secrets)
- ✅ CSRF tokens validated on all mutations
- ✅ Sessions enforce timeout and revocation
- ✅ MFA/passkey endpoints complete full flow
- ✅ Circuit breaker and quarantine queries work
- ✅ Emergency pause enforced on all job claims

### Security Requirements

- ✅ No plaintext passwords stored (Argon2id with configurable cost)
- ✅ No credentials in API responses (only opaque vault locators)
- ✅ HTTPS enforced in production (configurable via env)
- ✅ CSRF tokens are cryptographically random and short-lived
- ✅ Sessions use secure, HttpOnly cookies
- ✅ Audit trail of auth events (login, MFA, logout, session revocation)
- ✅ Rate limiting on auth endpoints (default 10 attempts per minute)

### Observability Requirements

- ✅ Structured JSON logs (request ID, owner ID, timestamp, duration, status)
- ✅ Prometheus metrics (request latency, error rate, active sessions)
- ✅ Slow query logging for PostgreSQL (>100ms queries logged)
- ✅ Worker pool health dashboard (query via GET /admin/health)

## Implementation Order

1. **Week 1**: Authentication server, password hash, session store, CSRF protection
2. **Week 1–2**: PostgreSQL repositories (parallel implementation by second engineer)
3. **Week 2**: Integration of repositories with API endpoints
4. **Week 2–3**: Worker lease manager and pool
5. **Week 3–4**: Per-agent provider configuration and social account management
6. **Week 4–5**: Full integration test suite, hardening, CI/CD pipeline
7. **Week 5**: Staging burn-in and documentation

## What Happens After Phase 2

- ✅ Authenticated, HTTPS-only control plane is ready for deployment
- ✅ Owner can configure agents, charters, references, and providers
- ✅ Worker pool can claim and execute jobs safely
- ✅ Resilience controls are enforced (quarantine, emergency pause, alerts)
- ✅ PostgreSQL-backed durable state machine is live

→ **Phase 3 begins**: Implement real media workers (story, voice, assembly)

## Technology Stack

- **Framework**: Express 5.x
- **Database**: PostgreSQL 15+
- **Password Hashing**: Argon2id (via `argon2` npm package)
- **Sessions**: PostgreSQL session store
- **CSRF**: Double-submit cookies with nonce validation
- **MFA**: TOTP (time-based one-time passwords) and WebAuthn
- **Logging**: Structured JSON via `console.log()` or pino
- **Monitoring**: Prometheus metrics
- **Testing**: Node test runner (built-in)

## Not in Phase 2 Scope

- Live OAuth (deferred to Phase 4)
- Email/SMS OTP (deferred to Phase 4)
- YouTube/Instagram/Facebook OAuth callbacks (deferred to Phase 4)
- Postiz integration (deferred to Phase 4)
- Real media worker execution (deferred to Phase 3)
- Public dashboard UI (separate repository, can start in parallel)
- Load testing (Phase 5)
- Security audit (Phase 5)

## Success Metrics

By end of Phase 2:

- ✅ Owner can register, log in, and access their profile
- ✅ Owner can create and manage agents, charters, and references
- ✅ Owner can configure provider slots and view status
- ✅ Owner alerts and emergency pause are operational
- ✅ All endpoints are covered by integration tests
- ✅ System can handle 100 concurrent authenticated sessions
- ✅ No plaintext secrets in logs or API responses
- ✅ All business policies enforced at database level
- ✅ Code is ready for security audit

## Effort Estimation

- 1 experienced engineer: 3–4 weeks (Phase 2 only)
- 2 experienced engineers: 2–3 weeks (Phase 2 parallel)
- With focused AI assistance: 1–2 weeks (rapid prototyping + hardening)

Total effort per lane: ~80–160 engineer-hours.
