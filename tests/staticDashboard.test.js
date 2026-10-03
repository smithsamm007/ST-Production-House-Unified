/**
 * Static owner dashboard tests.
 *
 * Verifies, with real HTTP requests against the real app:
 *   1. GET /index.html serves the dashboard HTML (text/html; no-cache).
 *   2. GET /dashboard.js and /styles.css serve the runtime assets.
 *   3. SPA fallback: unknown non-API paths return the dashboard HTML.
 *   4. The / JSON descriptor advertises the dashboard location.
 *   5. Rule 15: public assets contain no internal agent names.
 *   6. Rule 17 hygiene: public JS carries no secret-shaped literals.
 *
 * Honest-evidence notes (contract Rule 1): these tests assert only what the
 * real express stack returns and what the tracked files literally contain.
 * They make no claims about browser rendering, provider calls, or production
 * deployment; they prove the static surface is wired, clean, and reachable.
 */
import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

import app from "../src/catalog/server.js";
import { CANONICAL_REELS } from "../src/pipeline/reelsStage.js";

const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
const indexHtml = await readFile(path.join(publicDir, "index.html"), "utf8");
const dashboardJs = await readFile(path.join(publicDir, "dashboard.js"), "utf8");
const stylesCss = await readFile(path.join(publicDir, "styles.css"), "utf8");

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

test("Static: dashboard HTML wires the sidebar views and loads one external runtime", async () => {
  for (const viewId of [
    "view-overview", "view-directors", "view-communication", "view-memory", "view-production",
    "view-jobs", "view-providers", "view-quotas", "view-connections", "view-publishing",
    "view-approvals", "view-analytics", "view-hermes", "view-evidence", "view-alerts",
    "view-settings",
  ]) {
    assert.ok(indexHtml.includes(`id="${viewId}"`), `missing view container: ${viewId}`);
  }
  assert.ok(indexHtml.includes('<script src="/dashboard.js"></script>'));
  // CSP is script-src 'self': no inline scripts may ship in the HTML.
  assert.doesNotMatch(indexHtml, /<script(?![^>]*src=)[^>]*>/i);
  // Styles must come from the external stylesheet (no big inline style block).
  assert.ok(indexHtml.includes('<link rel="stylesheet" href="/styles.css" />'));
});

test("Static: GET /dashboard.js serves the dashboard runtime script", async () => {
  const res = await request(app)
    .get("/dashboard.js")
    .expect(200)
    .expect("Content-Type", /javascript/);
  assert.ok(res.text.includes("ST Production House — dashboard runtime"));
});

test("Static: GET /styles.css serves the dashboard stylesheet", async () => {
  const res = await request(app)
    .get("/styles.css")
    .expect(200)
    .expect("Content-Type", /text\/css/);
  assert.ok(res.text.includes("ST Production House — Owner Console styles"));
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
  const css = await request(app).get("/styles.css").expect(200);
  assert.equal(html.text, indexHtml);
  assert.equal(js.text, dashboardJs);
  assert.equal(css.text, stylesCss);
});

test("Rule 15: public dashboard assets contain no internal agent names", () => {
  // The canonical internal director names from the seed catalog. These are
  // internal-only identifiers (AGENTS.md Rule 15) and must never appear in
  // any file the dashboard serves publicly.
  const internalNames = [
    "JARVIS", "SHERLOCK", "LAKME", "PANCHI", "VEDA", "BYTE", "CHANAKYA", "KABIR",
    "SHAKTI", "ROHAN", "MAYA", "AAROHI", "VIKRAM", "TARA", "ANANYA", "KARAN",
    "DEV", "AANYA", "ARJUN", "NISHA", "NEWTON",
  ];
  for (const name of internalNames) {
    const pattern = new RegExp(`\\b${name}\\b`);
    assert.doesNotMatch(indexHtml, pattern, `Rule 15 leak in index.html: ${name}`);
    assert.doesNotMatch(dashboardJs, pattern, `Rule 15 leak in dashboard.js: ${name}`);
    assert.doesNotMatch(stylesCss, pattern, `Rule 15 leak in styles.css: ${name}`);
  }
});

test("Rule 17 hygiene: dashboard runtime carries no secret-shaped literals", () => {
  const secretLiteral =
    /(?:api[_-]?key|secret|password|token)\s*[:=]\s*["'][A-Za-z0-9_\-+/]{12,}["']/i;
  assert.doesNotMatch(dashboardJs, secretLiteral);
  assert.doesNotMatch(indexHtml, secretLiteral);
});

test("Static: pipeline strip uses the real durable stage enum only", () => {
  // The runtime's PIPELINE_STAGES literal must equal the durable stage enum
  // exactly (sql/020 + sql/024 + sql/025 CHECK constraint) — no fabricated
  // mockup-only stages (Research, Characters, BGM/SFX, Thumbnail, …).
  const block = /const PIPELINE_STAGES = \[([\s\S]*?)\];/.exec(dashboardJs);
  assert.ok(block, "PIPELINE_STAGES literal must exist");
  const stages = Array.from(block[1].matchAll(/\["([a-z]+)"/g)).map((m) => m[1]);
  assert.deepEqual(stages, ["story", "visual", "audio", "assembly", "reels", "packaging", "qc", "complete"]);
});

test("Channel cards: media slots use exactly the canonical reel identities", () => {
  // The card slot grid mirrors the S-M34-01 canonical package: one main
  // video plus CANONICAL_REELS (2 content reels + 1 brand reel) from
  // src/pipeline/reelsStage.js — no invented mockup slots.
  const block = /const MEDIA_SLOTS = \[([\s\S]*?)\];/.exec(dashboardJs);
  assert.ok(block, "MEDIA_SLOTS literal must exist");
  const slotKeys = Array.from(block[1].matchAll(/key: "([a-z0-9_]+)"/g)).map((m) => m[1]);
  const labels = Array.from(block[1].matchAll(/label: "([^"]+)"/g)).map((m) => m[1]);
  assert.deepEqual(slotKeys, ["main_video", ...CANONICAL_REELS.map((reel) => reel.key)]);
  assert.deepEqual(labels, ["Main Video", "Short 1", "Short 2", "Brand Reel"]);
});

test("Channel cards: slots fill only from durable evidence with honest empty states", () => {
  // Empty slots are explicit; no slot may render invented media metadata.
  assert.ok(dashboardJs.includes("no media yet — ffprobe verification pending"));
  assert.ok(dashboardJs.includes("no release planned yet"));
  assert.ok(dashboardJs.includes("release detail unavailable (lookup failed)"));
  // Reel slots bind through the succeeded reels event's detail.reel, matched
  // to the artifact by sha256 — never by list order or invention.
  assert.match(dashboardJs, /event\.stage === "reels" && event\.status === "succeeded"/);
  assert.match(dashboardJs, /reelArtifacts\.set\(detail\.reel, artifactBySha\.get\(detail\.sha256\)/);
  // The main video slot binds to the real assembly-stage video artifact.
  assert.match(dashboardJs, /a\.kind === "video" && a\.stage === "assembly"/);
});

test("Channel cards: platform chips derive from real destinations only", () => {
  assert.match(dashboardJs, /function platformChips\(entry\)/);
  assert.match(dashboardJs, /entry\.detail\.destinations/);
  assert.ok(dashboardJs.includes("no destinations configured"));
  assert.ok(dashboardJs.includes("destination lookup failed"));
});

test("Directors: detail buttons bind through explicit card options, not string surgery", () => {
  assert.doesNotMatch(dashboardJs, /\.replace\("<\/div>"/);
  assert.ok(dashboardJs.includes("actionsButton"));
  assert.ok(dashboardJs.includes("mediaSlots"));
});
