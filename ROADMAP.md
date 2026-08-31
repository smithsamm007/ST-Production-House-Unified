# ST Production House Unified — Continuous Development Roadmap

## System Architecture Overview

`ST-Production-House-Unified` is a secure multi-agent media production control plane designed for autonomous, continuous execution.

```text
+-----------------------------------------------------------------------+
|                 Autonomous Continuous Development Pipeline            |
|                                                                       |
|  +--------------------+    +--------------------+    +-------------+  |
|  | Task Parser        | -> | Execution Engine   | -> | CI / Merge  |  |
|  | (ROADMAP / Issues) |    | (Zero-Cost Router) |    | Controller  |  |
|  +--------------------+    +--------------------+    +-------------+  |
+-----------------------------------------------------------------------+
                                  |
                                  v
+-----------------------------------------------------------------------+
|                          Control Plane Modules                        |
|                                                                       |
|  [Credential Broker]   [Worker Runtime]   [Zero-Cost Router]          |
|  [Quota Ledger]        [Resilience DB]    [Evidence Ledger]           |
+-----------------------------------------------------------------------+
```

---

## Component Breakdown

1. **Automation & Pipeline Engine (`automation/`)**
   - Autonomous task parsing from `ROADMAP.md` and issue templates.
   - Fault-tolerant execution and retry-loop management.
   - PR merge controller and Governed Three-Lane mode integration.

2. **Credential Broker Contracts (`src/credentials/`)**
   - Opaque locators (`vault://`, `opaque://`) preventing secret leaks.
   - 5D authorization scope: `ownerId`, `agentId`, `provider`, `capability`, `credentialId`.
   - Short-lived, non-serializable, revocable leases (`CredentialLease`).

3. **Recovery Stack & Resilience (`src/recovery/`, `src/resilience/`)**
   - Error classification (`transient` vs `fatal`).
   - Zero-cost multi-provider fallback router (`ZeroCostRouter`).
   - Circuit breaker state machine (`CLOSED` -> `OPEN` -> `HALF_OPEN`).
   - Emergency pauses, dead-letter replay, and output quarantine.

4. **Worker Runtime & Checkpoints (`src/workers/`, `src/checkpoints/`)**
   - Isolated work envelope execution with cooperative cancellation.
   - Durable checkpointing and state persistence across restarts.

---

## Continuous Task Execution Matrix

| Task ID | Component Scope | High-Level Goal | Dependencies | Verification Command |
|---|---|---|---|---|
| **TASK-101** | `automation/continuousPipeline.js` | Continuous task parser and execution orchestration | None | `node --test tests/continuousPipeline.test.js` |
| **TASK-102** | `src/credentials/credentialBroker.js` | Opaque locator broker & lease revocation | TASK-101 | `node --test tests/credentialBroker.test.js` |
| **TASK-103** | `src/recovery/zeroCostRouter.js` | Resilience zero-cost router & circuit breaker | TASK-101 | `node --test tests/quotaRecovery.test.js` |
| **TASK-104** | `src/workers/workerRuntime.js` | Work envelope execution & secret redaction | TASK-102 | `node --test tests/workers.test.js` |

---

## Fault Tolerance & Loop Management Guidelines

1. **Retry Taxonomy**: Transient errors (rate limits, timeouts, 503) trigger exponential backoff. Unknown/fatal errors fail closed immediately.
2. **Circuit Isolation**: Persistent failures trip circuit breaker to `OPEN`, skipping failing routes until cooldown expires.
3. **Rollback & Safety**: DB mutations are transaction-scoped. Evidence DB write failures rollback the entire execution unit.
4. **Zero Runtime Dependencies**: All automation scripts and feature modules use standard Node.js built-in modules (`node:test`, `node:crypto`, `node:fs`, `node:path`).
