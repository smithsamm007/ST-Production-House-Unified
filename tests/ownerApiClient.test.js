import test from "node:test";
import assert from "node:assert/strict";
import {
  ApiError,
  OwnerApiClient,
  classifyFailure,
  describeFailure,
  extractErrorCode,
} from "../src/api/client.js";

/**
 * The console's shared client owns the session/CSRF/error contract for every
 * screen. These are pure unit tests with a stubbed fetch: no network, no
 * database, no provider.
 */

function jsonResponse(status, body, headers = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: {
      get: (name) => (name.toLowerCase() === "content-type" ? "application/json" : headers[name] ?? null),
    },
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

function recordingFetch(response) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (typeof response === "function") return response(url, init);
    return response;
  };
  impl.calls = calls;
  return impl;
}

test("GET sends same-origin credentials and no CSRF header", async () => {
  const fetchImpl = recordingFetch(jsonResponse(200, { ok: true }));
  const client = new OwnerApiClient({ fetchImpl });
  client.setCsrfToken("csrf-123");

  const payload = await client.get("/api/agents");

  assert.deepEqual(payload, { ok: true });
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].init.credentials, "same-origin");
  assert.equal(fetchImpl.calls[0].init.headers["x-csrf-token"], undefined);
  assert.equal(fetchImpl.calls[0].init.method, "GET");
});

test("mutations carry the in-memory CSRF token and a JSON body", async () => {
  const fetchImpl = recordingFetch(jsonResponse(201, { id: "x" }));
  const client = new OwnerApiClient({ fetchImpl });
  client.setCsrfToken("csrf-abc");

  await client.post("/api/channels", { slug: "a", displayName: "A" });

  const { init } = fetchImpl.calls[0];
  assert.equal(init.method, "POST");
  assert.equal(init.headers["x-csrf-token"], "csrf-abc");
  assert.equal(init.headers["Content-Type"], "application/json");
  assert.deepEqual(JSON.parse(init.body), { slug: "a", displayName: "A" });
});

test("clearing the CSRF token removes the header from later mutations", async () => {
  const fetchImpl = recordingFetch(jsonResponse(200, {}));
  const client = new OwnerApiClient({ fetchImpl });
  client.setCsrfToken("csrf-abc");
  client.clearCsrfToken();

  await client.post("/api/auth/logout");

  assert.equal(fetchImpl.calls[0].init.headers["x-csrf-token"], undefined);
});

test("401 is classified as unauthorized and triggers the session-expired hook", async () => {
  let unauthorizedCalls = 0;
  const client = new OwnerApiClient({
    fetchImpl: recordingFetch(jsonResponse(401, { error: "SESSION_TOKEN_REQUIRED" })),
    onUnauthorized: () => {
      unauthorizedCalls += 1;
    },
  });

  await assert.rejects(
    () => client.get("/api/auth/me"),
    (error) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.status, 401);
      assert.equal(error.kind, "unauthorized");
      assert.equal(error.code, "SESSION_TOKEN_REQUIRED");
      assert.equal(error.retryable, false);
      return true;
    }
  );
  assert.equal(unauthorizedCalls, 1);
});

test("403, 409, 422, 429, 503 and 500 map to distinct kinds", async () => {
  const cases = [
    [403, "CSRF_REJECTED", "forbidden"],
    [409, "CHANNEL_SLUG_EXISTS", "conflict"],
    [422, "VALIDATION", "validation"],
    [429, "TOO_MANY_REQUESTS_TRY_AGAIN_LATER", "rate_limited"],
    [503, "PROVIDER_NOT_CONFIGURED", "unavailable"],
    [500, "INTERNAL_SERVER_ERROR", "server"],
  ];

  for (const [status, code, expectedKind] of cases) {
    const client = new OwnerApiClient({ fetchImpl: recordingFetch(jsonResponse(status, { error: code })) });
    await assert.rejects(
      () => client.get("/api/anything"),
      (error) => {
        assert.equal(error.kind, expectedKind, `${status} should be ${expectedKind}`);
        assert.equal(error.code, code);
        return true;
      }
    );
  }
});

test("readable bodies using { code, message } are still understood", async () => {
  const client = new OwnerApiClient({
    fetchImpl: recordingFetch(jsonResponse(503, { code: "DIRECTOR_FLEET_UNAVAILABLE", message: "no" })),
  });
  await assert.rejects(
    () => client.get("/api/fleet"),
    (error) => error.code === "DIRECTOR_FLEET_UNAVAILABLE" && error.kind === "unavailable"
  );
  assert.equal(extractErrorCode({ code: "X" }), "X");
  assert.equal(extractErrorCode({ error: "Y" }), "Y");
  assert.equal(extractErrorCode(null), null);
});

test("network loss and caller cancellation are distinguishable", async () => {
  const networkClient = new OwnerApiClient({
    fetchImpl: async () => {
      throw new TypeError("Failed to fetch");
    },
  });
  await assert.rejects(
    () => networkClient.get("/api/agents"),
    (error) => error.kind === "network" && error.status === 0
  );

  const abortClient = new OwnerApiClient({
    fetchImpl: async () => {
      const error = new Error("aborted");
      error.name = "AbortError";
      throw error;
    },
  });
  await assert.rejects(
    () => abortClient.get("/api/agents"),
    (error) => error.kind === "aborted"
  );
});

test("no mutation is retried automatically", async () => {
  let attempts = 0;
  const client = new OwnerApiClient({
    fetchImpl: async () => {
      attempts += 1;
      throw new TypeError("Failed to fetch");
    },
  });

  await assert.rejects(() => client.post("/api/productions", { title: "x" }));
  assert.equal(attempts, 1);
});

test("a GET retry happens only when the caller opts in", async () => {
  let attempts = 0;
  const client = new OwnerApiClient({
    fetchImpl: async () => {
      attempts += 1;
      if (attempts === 1) throw new TypeError("Failed to fetch");
      return jsonResponse(200, { ok: true });
    },
  });

  const payload = await client.get("/api/evidence", { retry: 1 });
  assert.deepEqual(payload, { ok: true });
  assert.equal(attempts, 2);
});

test("204 and non-JSON responses do not throw on parse", async () => {
  const emptyClient = new OwnerApiClient({ fetchImpl: recordingFetch(jsonResponse(204, null)) });
  assert.equal(await emptyClient.get("/api/auth/logout"), null);

  const textClient = new OwnerApiClient({
    fetchImpl: recordingFetch({
      ok: true,
      status: 200,
      headers: { get: () => "text/plain" },
      json: async () => {
        throw new Error("not json");
      },
      text: async () => "ok",
    }),
  });
  assert.deepEqual(await textClient.get("/api/health"), { error: null, message: "ok" });
});

test("classifyFailure and describeFailure stay stable and secret-free", () => {
  assert.equal(classifyFailure(401), "unauthorized");
  assert.equal(classifyFailure(403, "MFA_ASSURANCE_REQUIRED"), "forbidden");
  assert.equal(classifyFailure(0), "unknown");
  assert.equal(classifyFailure(418), "unknown");

  assert.match(describeFailure(new ApiError("x", { kind: "unauthorized" })), /authentication is required/i);
  assert.match(describeFailure(new ApiError("x", { kind: "network" })), /could not be reached/i);
  assert.match(
    describeFailure(new ApiError("x", { kind: "unavailable", code: "PROVIDER_NOT_CONFIGURED" })),
    /PROVIDER_NOT_CONFIGURED/
  );
  // An unknown error never echoes its own internals.
  assert.equal(
    describeFailure(new Error("connstring=postgres://secret")),
    "The console could not complete the request."
  );
});
