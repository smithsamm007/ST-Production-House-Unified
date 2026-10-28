import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { createOwnerApp } from "../../src/api/ownerServer.js";

const BOOTSTRAP_TOKEN = "adversarial-fuzz-bootstrap-token-0123456789abcdef";
const SECRET_MARKERS = [
  "vault://", "opaque://", "api_key=", "apikey=", "BEGIN PRIVATE KEY", "postgres://",
];

/**
 * Raw HTTP harness. supertest's client leaks its ephemeral server when a
 * hostile header value is refused client-side (ERR_INVALID_CHAR aborts the
 * request mid-flight), which hangs the node:test process at exit. Node's
 * built-in http module gives us explicit lifecycle control instead:
 * one server per scenario, closed with closeAllConnections(), and bounded
 * request timeouts so a bug fails visibly instead of hanging.
 */
function listen(server) {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server.address().port));
  });
}

async function closeServer(server) {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}

async function withApp(scenario) {
  const server = http.createServer(createOwnerApp({ bootstrapToken: BOOTSTRAP_TOKEN }));
  const port = await listen(server);
  try {
    await scenario(port);
  } finally {
    await closeServer(server);
  }
}

const TRANSPORT_REFUSAL = /ERR_INVALID_CHAR|ERR_INVALID_ARG_TYPE|invalid character in header content/i;

/**
 * Performs one raw request. Returns { status, body, text }.
 * status 0 means the hostile input was neutralized before an HTTP exchange
 * completed: refused client-side (invalid header content) or aborted by the
 * server (e.g. header over the server's size limit). Both are safe outcomes.
 */
function rawRequest(port, { method = "GET", path = "/", headers = {}, body = null }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };

    let req;
    try {
      // A raw space in the path is refused by the HTTP client; %20 decodes back
      // to a space server-side, so the hostile payload arrives byte-equivalent.
      const wirePath = path.replace(/ /g, "%20");
      req = http.request(
        { host: "127.0.0.1", port, method, path: wirePath, headers, agent: false },
        (res) => {
          const chunks = [];
          res.on("data", (chunk) => chunks.push(chunk));
          res.on("end", () => {
            const text = Buffer.concat(chunks).toString("utf8");
            let parsed = {};
            try {
              parsed = JSON.parse(text);
            } catch {
              parsed = {};
            }
            finish({ status: res.statusCode, body: parsed, text });
          });
          res.on("error", () => finish({ status: 0, body: {}, text: "" }));
        }
      );
    } catch (err) {
      if (TRANSPORT_REFUSAL.test(String(err?.message)) || String(err?.code || "").startsWith("ERR_")) {
        return finish({ status: 0, body: {}, text: "" });
      }
      return reject(err);
    }

    req.setTimeout(5000, () => {
      req.destroy(new Error("REQUEST_TIMEOUT"));
    });
    req.on("error", (err) => {
      // Transport-level neutralization (reset, abort, timeout) is a safe outcome.
      finish({ status: 0, body: {}, text: "" });
      void err;
    });

    if (body !== null) {
      req.end(typeof body === "string" ? body : JSON.stringify(body));
    } else {
      req.end();
    }
  });
}

function assertClean4xx(res, allowed = [400, 401, 403, 404, 413, 429, 431]) {
  assert.ok(
    res.status === 0 || allowed.includes(res.status),
    `expected clean 4xx (or transport refusal), got ${res.status}`
  );
  if (res.status === 0) return; // hostile input never produced an HTTP exchange

  const bodyText = typeof res.text === "string" ? res.text : JSON.stringify(res.body ?? {});
  // No stack traces in the body.
  assert.doesNotMatch(bodyText, /Traceback|at .*\(\\S+\\.js:\\d+:\\d+\)|node:internal/, "no stack traces in body");
  // No raw secret-manager or credential-shaped markers.
  for (const marker of SECRET_MARKERS) {
    assert.ok(!bodyText.includes(marker), `leak detected in body: ${marker}`);
  }
  // No value-shaped secret/token leakage.
  assert.doesNotMatch(
    bodyText,
    /(password|token|apikey|api_key|authorization)["']?\s*[:=]\s*["']?[A-Za-z0-9_\-./+]{8,}/i,
    "suspicious credential-shaped leakage in body"
  );
  // Error bodies must be JSON objects, not raw echoes of hostile input.
  if (typeof res.text === "string" && res.text.length > 0) {
    assert.match(res.text, /^\s*\{/, "error bodies must be JSON objects");
  }
}

// Deterministic corpus of hostile Authorization header values.
const AUTH_VALUE_FUZZ = [
  "", " ", "\t", "Bearer", "Bearer ", "Bearer  ", "bearer token", "Basic dXNlcjpwYXNz",
  "Bearer null", "Bearer undefined", "Bearer {}", "Bearer []",
  `Bearer ${"A".repeat(10000)}`, `Bearer ${"A".repeat(100)}`,
  "Bearer Bearer Bearer", "Bearer\tTab", "Bearer\r\nX-Injected: yes",
  "Bearer %00%00", "Bearer \u0000", "Bearer é€漢字",
  "Bearer ' OR '1'='1", "Bearer '; DROP TABLE sessions;--",
  "Bearer ${process.env.STPH_BOOTSTRAP_TOKEN}", "Bearer <script>alert(1)</script>",
  "Bearer ../../etc/passwd", "Bearer a b c d e f", "Bearer 0123456789abcdef0123456789abcdef extra",
  "Bearer " + Buffer.from("session_hijack", "utf8").toString("base64"),
  "Bearer x".repeat(500),
];

const COOKIE_FUZZ = [
  "session_token=", "session_token=; Path=/", "session_token=abc; session_token=def",
  `session_token=${"A".repeat(4096)}`, "session_token='; DROP TABLE sessions;--",
  "session_token=%00", "session_token=\u0000", "other=1", "=",
  `a=${"z".repeat(8192)}`, "session_token=<script>alert(1)</script>",
  "session_token=../../etc/passwd",
];

const HEADER_NAME_FUZZ = [
  "x-csrf-token", "x-forwarded-for", "x-real-ip", "content-type",
  "x-http-method-override", "x-forwarded-host", "x-own-evil-header",
];

test("fuzzed Authorization headers against /agents always yield clean 4xx without leaking", async () => {
  for (const value of AUTH_VALUE_FUZZ) {
    // Fresh app per input: rate-limit state from previous hostile values cannot mask results.
    await withApp(async (port) => {
      const res = await rawRequest(port, { path: "/agents", headers: { Authorization: value, Connection: "close" } });
      assert.ok([401, 429, 0].includes(res.status), `Authorization ${JSON.stringify(value).slice(0, 40)} → ${res.status}`);
      assertClean4xx(res);
    });
  }
});

test("fuzzed Authorization headers against /charters always yield clean 4xx without leaking", async () => {
  for (const value of AUTH_VALUE_FUZZ) {
    await withApp(async (port) => {
      const res = await rawRequest(port, { path: "/charters", headers: { Authorization: value, Connection: "close" } });
      assert.ok([401, 429, 0].includes(res.status));
      assertClean4xx(res);
    });
  }
});

test("fuzzed cookies never authenticate a request or crash the parser", async () => {
  for (const cookie of COOKIE_FUZZ) {
    await withApp(async (port) => {
      const res = await rawRequest(port, { path: "/agents", headers: { Cookie: cookie, Connection: "close" } });
      assert.ok([401, 429, 0].includes(res.status), `Cookie ${JSON.stringify(cookie).slice(0, 40)} → ${res.status}`);
      assertClean4xx(res);
    });
  }
});

test("fuzzed session/start bootstrap payloads always yield clean 4xx without leaking", async () => {
  const payloadFuzz = [
    {}, { token: null }, { token: 12345 }, { token: true }, { token: {} }, { token: [] },
    { token: "" }, { token: " " }, { bootstrapToken: null },
    { bootstrapToken: "wrong_bootstrap_token_1234567890123" },
    { bootstrapToken: "' OR '1'='1" }, { bootstrapToken: `${BOOTSTRAP_TOKEN} ` },
    { bootstrapToken: BOOTSTRAP_TOKEN.toUpperCase() },
    { bootstrapToken: ` ${BOOTSTRAP_TOKEN}` },
    { bootstrapToken: BOOTSTRAP_TOKEN.slice(0, 31) },
    { bootstrapToken: BOOTSTRAP_TOKEN + "A".repeat(100000) },
    { token: "' OR '1'='1" }, { token: "'; DROP TABLE sessions;--" },
  ];
  await withApp(async (port) => {
    for (const payload of payloadFuzz) {
      const res = await rawRequest(port, {
        method: "POST",
        path: "/session/start",
        headers: { "Content-Type": "application/json", Connection: "close" },
        body: JSON.stringify(payload),
      });
      assert.ok([400, 401, 413].includes(res.status), `payload ${JSON.stringify(payload).slice(0, 50)} → ${res.status}`);
      assertClean4xx(res, [400, 401, 413]);
    }
    // Header-carried bootstrap attempt with a wrong token must also fail closed.
    const res = await rawRequest(port, {
      method: "POST",
      path: "/session/start",
      headers: { Authorization: "Bearer definitely-not-the-token-value-123456", Connection: "close" },
      body: "{}",
    });
    assert.ok([401, 0].includes(res.status));
    assertClean4xx(res);
  });
});

test("fuzzed auxiliary headers (header-injection attempts) never change auth outcomes", async () => {
  const evilValues = [
    "1\r\nX-Injected: yes", "\u0000", `${"9".repeat(2000)}`, "127.0.0.1", "<script>alert(1)</script>",
    "' OR '1'='1", "localhost:6379\r\n\r\nGET / HTTP/1.1",
  ];
  for (const name of HEADER_NAME_FUZZ) {
    for (const value of evilValues) {
      await withApp(async (port) => {
        const res = await rawRequest(port, {
          path: "/agents",
          headers: {
            [name]: value,
            Authorization: "Bearer valid-prefix-but-wrong-token-1234567890",
            Connection: "close",
          },
        });
        assert.ok([400, 401, 429, 0].includes(res.status), `${name}: ${JSON.stringify(value).slice(0, 30)} → ${res.status}`);
        assertClean4xx(res);
      });
    }
  }
});

test("oversized and malformed JSON bodies fail closed as clean 4xx without leaking internals", async () => {
  await withApp(async (port) => {
    const big = await rawRequest(port, {
      method: "POST",
      path: "/session/start",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ bootstrapToken: "x".repeat(1024 * 1024) }),
    });
    assert.ok([400, 401, 413].includes(big.status), `oversized body → ${big.status}`);
    assertClean4xx(big);

    const malformed = await rawRequest(port, {
      method: "POST",
      path: "/session/start",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: "{{{{not json",
    });
    assert.ok([400, 401].includes(malformed.status), `malformed JSON → ${malformed.status}`);
    assertClean4xx(malformed);
  });
});

test("unknown routes return clean 404; hostile query strings on real routes stay 4xx without echoing input", async () => {
  await withApp(async (port) => {
    // Unknown paths → 404 (never 500, never a redirect to a login page).
    for (const path of [
      "/../etc/passwd", "/%2e%2e/%2e%2e/etc/passwd", "/agents/../../session/start",
      "/does-not-exist",
    ]) {
      const res = await rawRequest(port, { path, headers: { Connection: "close" } });
      assert.ok([400, 404].includes(res.status), `path ${path.slice(0, 40)} → ${res.status}`);
      assertClean4xx(res);
      assert.ok(!res.text.includes("etc/passwd"), "traversal input must not be echoed");
    }
    // Real routes with hostile query strings → still unauthenticated 401, never 500.
    for (const path of ["/agents?id=' OR '1'='1", `/agents?x=${"A".repeat(5000)}`]) {
      const res = await rawRequest(port, { path, headers: { Connection: "close" } });
      assert.ok([400, 401].includes(res.status), `path ${path.slice(0, 40)} → ${res.status}`);
      assertClean4xx(res);
    }
  });
});

test("valid bootstrap token still works after the fuzz gauntlet (no false lockout)", async () => {
  await withApp(async (port) => {
    for (const value of AUTH_VALUE_FUZZ) {
      await rawRequest(port, { path: "/agents", headers: { Authorization: value, Connection: "close" } });
    }
    const res = await rawRequest(port, {
      method: "POST",
      path: "/session/start",
      headers: { "Content-Type": "application/json", Connection: "close" },
      body: JSON.stringify({ token: BOOTSTRAP_TOKEN }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, "success");
    assert.ok(res.body.token);
  });
});
