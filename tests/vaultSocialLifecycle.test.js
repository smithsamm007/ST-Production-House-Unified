/**
 * Durable secret custody for the SOCIAL OAuth lifecycle — real Vault adapter,
 * end-to-end (Issue #210, Section 6).
 *
 * Every test here uses DISPOSABLE test credentials, a loopback HTTP server on
 * 127.0.0.1 (playing the official KV v2 API shapes), and OFFLINE scripted
 * provider responses. No real social account is connected, no real network
 * call is made, and the "secrets" are fixed throwaway strings that are never
 * committed as live material. This is the code-side proof that:
 *
 *   - the generic social connect path (facebook/instagram/snapchat/bilibili)
 *     stores token bundles ONLY in the external vault under an owner/Director/
 *     -provider-scoped KV v2 path, while PostgreSQL persists the opaque
 *     locator and nothing else (AGENTS.md Rule 4 / §14);
 *   - publishing-credential read-back resolves the locator through the REAL
 *     vault adapter (default fetch transport, loopback) and returns only the
 *     secret material to the caller;
 *   - owner-authorized revocation DELETES the held secret from the vault;
 *   - an unreachable or empty vault degrades HONESTLY: stable codes, no
 *     fabricated revocation, no secret-shaped strings in errors (Rule 17).
 */

import test from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import http from "node:http";
import {
  createVaultSecretManager,
} from "../src/credentials/vaultSecretManagerAdapter.js";
import {
  guardSecretManagerAdapter,
} from "../src/credentials/oauthSecretManagerAdapter.js";
import {
  SocialOAuthService,
  setSocialOAuthRuntime,
} from "../src/catalog/socialOAuthService.js";
import { SocialOAuthRepository } from "../src/catalog/socialOAuthRepository.js";
import { createDemoStorageAdapter } from "../src/db/demoStorageAdapter.js";
import { runMigrations } from "../src/db/index.js";

// ---------------------------------------------------------------------------
// Disposable environment credentials (throwaway values, cleaned up after).
// ---------------------------------------------------------------------------

const OAUTH_ENV = {
  STPH_SOCIAL_OAUTH_REDIRECT_BASE_URL: "https://dashboard.stproduction.test",
  STPH_FACEBOOK_OAUTH_CLIENT_ID: "metal-de-loop-toast-client-id",
  STPH_FACEBOOK_OAUTH_CLIENT_SECRET: "loopback-disposable-app-secret-value",
};
for (const [key, value] of Object.entries(OAUTH_ENV)) process.env[key] = value;

const LOOPBACK_VAULT_TOKEN = "loopback-vault-token-disposable";
const DISPOSABLE_ACCESS_TOKEN = "loopback-disposable-access-token";

// ---------------------------------------------------------------------------
// Loopback KV v2 vault
// ---------------------------------------------------------------------------

let vaultServer = null;
const vaultData = new Map(); // pathname under /data/ → KV body.data

async function startLoopbackVault() {
  if (vaultServer) return `http://127.0.0.1:${vaultServer.address().port}`;
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", (chunk) => (raw += chunk));
    req.on("end", () => {
      if (req.headers["x-vault-token"] !== LOOPBACK_VAULT_TOKEN) {
        res.writeHead(403, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: ["permission denied"] }));
        return;
      }
      const dataMatch = req.url.match(/^\/v1\/secret\/data\/(.+)$/);
      const metaMatch = req.url.match(/^\/v1\/secret\/metadata\/(.+)$/);
      if (req.method === "POST" && dataMatch) {
        vaultData.set(dataMatch[1], JSON.parse(raw).data);
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ data: { created_time: "2026-10-14T00:00:00Z", version: 1 } }));
      } else if (req.method === "GET" && dataMatch) {
        const data = vaultData.get(dataMatch[1]);
        if (!data) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [] }));
        } else {
          res.writeHead(200, { "content-type": "application/json" });
          res.end(JSON.stringify({ data: { data, metadata: { version: 1 } } }));
        }
      } else if (req.method === "DELETE" && metaMatch) {
        if (!vaultData.has(metaMatch[1])) {
          res.writeHead(404, { "content-type": "application/json" });
          res.end(JSON.stringify({ errors: [] }));
        } else {
          vaultData.delete(metaMatch[1]);
          res.writeHead(204);
          res.end();
        }
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ errors: ["unsupported route"] }));
      }
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  vaultServer = server;
  return `http://127.0.0.1:${server.address().port}`;
}

async function stopLoopbackVault() {
  if (vaultServer) {
    const server = vaultServer;
    vaultServer = null;
    await new Promise((resolve) => server.close(resolve));
  }
  vaultData.clear();
}

// ---------------------------------------------------------------------------
// Harness: REAL guarded vault adapter + demo storage + scripted social provider
// ---------------------------------------------------------------------------

function jsonResponse(status, payload) {
  return { status, body: typeof payload === "string" ? payload : JSON.stringify(payload) };
}

/** OFFICIAL Meta endpoints, scripted. Nothing leaves the process. */
function facebookResponder(request) {
  if (request.url.startsWith("https://graph.facebook.com/v26.0/oauth/access_token")) {
    return jsonResponse(200, {
      access_token: DISPOSABLE_ACCESS_TOKEN,
      token_type: "bearer",
      expires_in: 5184000,
    });
  }
  if (request.url.startsWith("https://graph.facebook.com/v26.0/me/accounts")) {
    return jsonResponse(200, {
      data: [{ id: "page-loop-1", name: "Loopback Page", access_token: "page-token-disposable" }],
    });
  }
  if (request.url.startsWith("https://graph.facebook.com/v26.0/me/permissions")) {
    return jsonResponse(200, { success: true });
  }
  return jsonResponse(404, { error: "unknown_endpoint" });
}

/**
 * Fresh harness per test: demo storage, one disposable owner, and ONE guarded
 * built-in vault adapter wired through the FULL loader contract
 * (guardSecretManagerAdapter, exactly like server boot).
 */
async function buildHarness() {
  const address = await startLoopbackVault();
  const db = createDemoStorageAdapter();
  await runMigrations(db);
  const ownerId = randomUUID();
  await db.query(
    "INSERT INTO owners (id, email, password_hash, role, status) VALUES ($1, $2, $3, $4, $5)",
    [ownerId, `owner-${ownerId.slice(0, 8)}@vault-social.test`, "x".repeat(64), "owner", "authenticated"],
  );
  const vaultAdapter = guardSecretManagerAdapter(createVaultSecretManager({
    address,
    mount: "secret",
    token: LOOPBACK_VAULT_TOKEN,
  }));
  assert.equal(vaultAdapter.nonDurable, false, "custody is durable by construction");
  setSocialOAuthRuntime({ transport: facebookResponder, secretManagerFactory: () => vaultAdapter });
  return {
    db,
    ownerId,
    repo: new SocialOAuthRepository(db),
    service: new SocialOAuthService({ db }),
    vaultAdapter,
  };
}

async function connectFacebook(harness, agentId) {
  const start = await harness.service.start({ ownerId: harness.ownerId, agentId, providerKey: "facebook" });
  const state = new URL(start.authorizationUrl).searchParams.get("state");
  assert.ok(state, "authorization URL carries the state token");
  return harness.service.handleCallback({
    ownerId: harness.ownerId,
    providerKey: "facebook",
    code: "disposable-auth-code",
    state,
  });
}

test.after(async () => {
  for (const key of Object.keys(OAUTH_ENV)) delete process.env[key];
  setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
  await stopLoopbackVault();
});

// ---------------------------------------------------------------------------
// The durable custody proofs
// ---------------------------------------------------------------------------

test("connect stores the token bundle ONLY in the vault; PostgreSQL holds the locator", async () => {
  const harness = await buildHarness();
  try {
    const callback = await connectFacebook(harness, "agent-01");
    assert.equal(callback.account.status, "connected");

    // Exactly ONE vault entry, under the owner/Director/provider-scoped path.
    const paths = [...vaultData.keys()];
    assert.equal(paths.length, 1, "one immutable KV v2 version per connection");
    assert.match(
      paths[0],
      new RegExp(`^stph/${harness.ownerId}/agent-01/facebook/[0-9a-f]{24}$`),
      "owner/Director/provider-scoped vault path with unguessable suffix",
    );
    const stored = [...vaultData.values()][0];
    assert.equal(stored.payload.access_token, DISPOSABLE_ACCESS_TOKEN);
    assert.equal(stored.payload.refresh_token == null, true, "the official Meta exchange returns no refresh token");

    // PostgreSQL: the row carries vault:// locator material and NOTHING secret.
    const row = await harness.repo.getAccountRow(harness.ownerId, "agent-01", "facebook");
    assert.match(row.token_locator, /^vault:\/\/secret\/stph\//);
    assert.ok(row.account_id === "page-loop-1", "identity verified and stored");
    const rowBlob = JSON.stringify(row);
    assert.ok(!rowBlob.includes(DISPOSABLE_ACCESS_TOKEN), "no token in PostgreSQL");
    assert.ok(!rowBlob.includes(LOOPBACK_VAULT_TOKEN), "no vault token anywhere");

    // The status DTO exposes status + account identity, never custody material.
    const status = await harness.service.getStatus({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
    assert.equal(status.status, "connected");
    const statusBlob = JSON.stringify(status);
    assert.ok(!statusBlob.includes(DISPOSABLE_ACCESS_TOKEN), "tokens never serialize");
    assert.ok(!statusBlob.includes(LOOPBACK_VAULT_TOKEN), "vault token never serializes");
    assert.ok(!statusBlob.includes("vault://"), "the locator itself never serializes");

    // Empty (no credentials stored in config) is impossible here, but the
    // locator shape is asserted through the loader contract above.
    assert.equal(harness.vaultAdapter.label.startsWith("guarded:"), true);
  } finally {
    await stopLoopbackVault();
    setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
  }
});

test("publishing-credential read-back resolves through the REAL vault adapter", async () => {
  const harness = await buildHarness();
  try {
    await connectFacebook(harness, "agent-01");

    const credential = await harness.service.getPublishingCredential({
      ownerId: harness.ownerId,
      agentId: "agent-01",
      providerKey: "facebook",
    });
    assert.equal(credential.accessToken, DISPOSABLE_ACCESS_TOKEN, "only the token material crosses, resolved via the locator");
    assert.equal(credential.providerKey, "facebook");
    assert.equal(credential.accountId, "page-loop-1");

    // A second connection for a DIFFERENT Director lands in its OWN scoped path.
    await connectFacebook(harness, "agent-02");
    const paths = [...vaultData.keys()].sort();
    assert.equal(paths.length, 2, "one vault entry per Director connection");
    assert.ok(paths[0] !== paths[1], "Director isolation inside the vault namespace");
    assert.match(paths[0], /agent-01\/facebook\//);
    assert.match(paths[1], /agent-02\/facebook\//);
  } finally {
    await stopLoopbackVault();
    setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
  }
});

test("owner revocation DELETES the held secret from the vault", async () => {
  const harness = await buildHarness();
  try {
    await connectFacebook(harness, "agent-01");
    assert.equal(vaultData.size, 1);

    // The locator exists at connect time; disconnect clears it from the row.
    const rowBefore = await harness.repo.getAccountRow(harness.ownerId, "agent-01", "facebook");
    const heldLocator = rowBefore.token_locator;

    const revoked = await harness.service.revoke({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
    assert.equal(revoked.status, "disconnected");
    assert.equal(revoked.providerRevoked, true, "provider grant revoked at the official endpoint");
    assert.equal(revoked.secretCleanupFailed, false, "the vault secret was deleted");
    assert.equal(vaultData.size, 0, "durable custody is genuinely emptied");

    const row = await harness.repo.getAccountRow(harness.ownerId, "agent-01", "facebook");
    assert.equal(row.status, "disconnected");
    assert.equal(row.token_locator == null, true, "the locator is cleared from PostgreSQL on disconnect");

    // The previously held locator no longer resolves — nothing lingers in custody.
    await assert.rejects(
      () => harness.vaultAdapter.readSecret({ locator: heldLocator }),
      (err) => err.code === "SECRET_MANAGER_ENTRY_NOT_FOUND",
      "the disconnected connection's secret no longer resolves",
    );

    // Repeat revoke is idempotent and still honest.
    const again = await harness.service.revoke({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" });
    assert.equal(again.alreadyDisconnected, true);
    assert.equal(again.status, "disconnected");
  } finally {
    await stopLoopbackVault();
    setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
  }
});

test("an unreachable vault degrades honestly on read AND revoke (no fabricated custody)", async () => {
  const harness = await buildHarness();
  try {
    // Director A connects and stays connected; Director B connects then the
    // loopback vault is stopped — the durable dependency is unavailable.
    await connectFacebook(harness, "agent-01");
    await connectFacebook(harness, "agent-02");
    await stopLoopbackVault();

    // Read-back for the still-connected Director: stable failure code, no
    // secret-shaped detail, and the row is NOT silently changed.
    await assert.rejects(
      () => harness.service.getPublishingCredential({ ownerId: harness.ownerId, agentId: "agent-01", providerKey: "facebook" }),
      (err) => {
        assert.equal(err.code, "SECRET_MANAGER_UNREACHABLE");
        assert.ok(!JSON.stringify(err).includes(DISPOSABLE_ACCESS_TOKEN), "no token material in the failure");
        return true;
      },
    );
    const intactRow = await harness.repo.getAccountRow(harness.ownerId, "agent-01", "facebook");
    assert.equal(intactRow.status, "connected", "a storage outage never flips an account to disconnected by itself");

    // Revocation of Director B: the token cannot be resolved, so the service
    // reports the honest state — storage marked disconnected ONLY as a dead
    // grant, provider revoked FALSE, and no vault cleanup is claimed.
    const revoked = await harness.service.revoke({ ownerId: harness.ownerId, agentId: "agent-02", providerKey: "facebook" });
    assert.equal(revoked.status, "disconnected");
    assert.equal(revoked.providerRevoked, false);
    assert.equal(revoked.errorCode, "OAUTH_SECRET_READ_FAILED");
    assert.equal(revoked.secretCleanupFailed, false, "cleanup was not attempted, so it is not claimed as failed either");
    const deadRow = await harness.repo.getAccountRow(harness.ownerId, "agent-02", "facebook");
    assert.equal(deadRow.status, "disconnected");
  } finally {
    await stopLoopbackVault();
    setSocialOAuthRuntime({ transport: null, secretManagerFactory: null });
  }
});
