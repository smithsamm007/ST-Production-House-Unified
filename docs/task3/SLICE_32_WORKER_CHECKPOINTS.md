# Task 3.2 — Worker and Checkpoint Contracts

This document specifies the architecture, components, and contracts implemented for provider-independent worker runtime execution, checkpointing/resume mechanics, heartbeats, and cooperative cancellation.

---

## 1. Architecture Overview

To maintain high security, resilience, and strict isolation, the ST Production House Unified platform separates the control plane from isolated media workers. Task execution uses provider-independent contracts to avoid tight coupling with specific external services (like YouTube, AWS, or rendering engines) and allows testing via pure, deterministic, and mockable constructs.

```
       +---------------------------------------------+
       |               Control Plane                 |
       +---------------------------------------------+
                              |
                     [ Work Envelope ]
                              |
                              v
       +---------------------------------------------+
       |               Worker Runtime                |
       +---------------------------------------------+
         /                    |                    \
 [ Heartbeats ]        [ Checkpoints ]       [ HandlerResult ]
       /                      |                    \
      v                       v                     v
(Monitoring)         (Checkpoint Store)     (Idempotent Cache)
```

---

## 2. Implemented Components

### 2.1 Typed & Validated Work Envelope (`src/workers/workEnvelope.js`)
The `WorkEnvelope` class represents a validated task payload and operational context passed to media workers.
- **Strict Validation**: Enforces presence and string types for `taskId`, `jobType`, and `agentId`, as well as objects for `payload` and `context`.
- **Plaintext Secrets Scanner**: Recursively scans the entire payload and context dictionaries. Any keys indicating sensitive materials (such as `password`, `secret`, `token`, `apikey`, `privatekey`, `auth`) must use opaque locators (e.g. `vault://...` or `opaque://...`). Plaintext passwords/keys trigger an immediate `SecurityViolationError`.
- **Internal Agent Name Leak Check**: To comply with the strictly internal-only agent names requirement, public/user-facing text fields (like `caption`, `description`, `title`, etc.) are scanned recursively. If any normalized preloaded internal agent names (e.g., JARVIS, SHERLOCK, VEDA) are found, execution is blocked.

### 2.2 Checkpoint Store (`src/checkpoints/checkpointStore.js`)
The `CheckpointStore` manages worker state persistence, allowing long-running tasks to write and resume progress safely.
- **Provider-Independent Persistence**: Uses a pluggable storage adapter interface. Falls back to a Map-backed in-memory store by default.
- **Data Integrity Checksum**: Checkpoints are serialized to stable JSON. A SHA-256 payload hash and a full-record checksum are computed and stored. Reading or resuming a tampered/corrupted checkpoint throws `CheckpointCorruptedError`.
- **Strict Immutability**: All read/write checkpoint structures are deep-frozen recursively to prevent in-process state mutations.
- **Write Idempotency**: If a duplicate state checkpoint is written (matching steps, progress, and payload), the store treats the write as an idempotent no-op, preserving original timestamps.

### 2.3 Safe Worker Runtime Executor (`src/workers/workerRuntime.js`)
The `WorkerRuntime` orchestrates worker task handlers safely under a strict "fail-closed" model.
- **Cooperative Cancellation**: Integrates an `AbortSignal`. Context features `checkCancellation()` and `isCanceled()` utilities. Aborts halt immediately and return a structured cancellation status.
- **Progressive Heartbeats**: Dispatches periodic heartbeat callbacks (`onHeartbeat`) containing the task step, progress percentage, custom performance/resource metrics, and exact timestamps.
- **Idempotent Completion**: Successfully completed tasks are cached. Subsequent run requests return the original successful `HandlerResult` immediately, eliminating duplicate execution.
- **Fail-Closed Interfaces**: All unhandled errors are caught, sanitized (sensitive locators/secrets are redacted from stack traces), and converted into a failed `HandlerResult` with `failClosed: true`.

---

## 3. Verification & Testing

### 3.1 Tests Implemented
Comprehensive, deterministic unit and contract tests are defined in:
1. `tests/checkpoints.test.js`:
   - Verification of input constraints, progress boundaries, and nested type constraints.
   - Verification of stable serialization, reading, and resuming.
   - Verification of data corruption checks via direct adapter tampering.
   - Verification of deep copies, deep-freezing, and write idempotency.
2. `tests/workers.test.js`:
   - Validation of `WorkEnvelope` schemas and type assertions.
   - Scanning for plaintext credentials and blocking raw secrets.
   - Dynamic scanning of public fields to prevent agent name leaks.
   - Heartbeat callback timing and metrics structure verification.
   - Checkpoint creation/resume inside active task handlers.
   - Cooperative cancellation and structured abort states.
   - Error sanitization/redaction of sensitive strings in trace dumps.
   - Idempotency checks preventing multiple runs of successful tasks.

### 3.2 Verification Command
To run all tests (including the new worker and checkpoint contracts):
```bash
npm test
```
All **169 tests** pass with **0 failures**, demonstrating deterministic correctness and secure implementation of the slice.
