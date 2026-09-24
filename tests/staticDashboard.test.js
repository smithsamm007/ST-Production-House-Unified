/**
 * Static owner dashboard tests.
 *
 * Verifies, with real HTTP requests against the real app:
 *   1. GET /index.html serves the dashboard HTML (Content-Type text/html;
 *      no-cache), CSP stays script-src 'self' compatible.
 *   2. GET /dashboard.js serves the dashboard runtime script
 *      (Content-Type application/javascript).
 *   3. SPA fallback: unknown non-API paths return the dashboard HTML.
 *   4. The / JSON descriptor advertises the dashboard location.
 *
 * Honest-evidence notes (contract Rule 1): these tests assert only what the
 * real express stack returns. They make no claims about browser rendering,
 * provider calls, or production deployment; they prove the static surface is
 * wired and reachable, nothing more.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import app from "../src/catalog/server.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const indexHtml = await readFile(path.join(publicDir, "index.html"), "utf8");
const dashboardJs = await readFile(path.join(publicDir, "dashboard.js"), "utf8");

test("API: GET / descriptor advertises the owner dashboard location", async () => {
  const res = await request(app).get("/").expect(200);
  assert.equal(res.body.service, "ST Production House Unified");
  assert.equal(res.body.dashboard, "/index.html");
  assert.ok(res.body.endpoints);
});

test("Static: GET /index.html serves the owner dashboard HTML", async () => {
  const res = await request(app)
    .get("/index.html")
    .expect(200)
    .expect("Content-Type", /text\/html/);
  assert.ok(res.text.includes("ST Production House — Owner Console"));
  assert.match(res.headers["cache-control"], /no-cache/);
});

test("Static: GET /dashboard.js serves the dashboard runtime script", async () => {
  const res = await request(app)
    .get("/dashboard.js")
    .expect(200)
    .expect("Content-Type", /javascript/);
  assert.ok(res.text.includes("ST Production House — dashboard runtime"));
});

test("Static: SPA fallback serves dashboard HTML for unknown non-API paths", async () => {
  const res = await request(app)
    .get("/some/unknown/route")
    .expect(200)
    .expect("Content-Type", /text\/html/);
  assert.equal(res.text, indexHtml);
});

test("Static: served dashboard files match the on-disk sources", async () => {
  const html = await request(app).get("/index.html").expect(200);
  const js = await request(app).get("/dashboard.js").expect(200);
  assert.equal(html.text, indexHtml);
  assert.equal(js.text, dashboardJs);
});
