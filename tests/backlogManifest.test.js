import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

/**
 * Repository backlog manifest integrity (drift protection).
 *
 * The governed feeder (`.github/scripts/backlog-feeder.mjs`) promotes slices
 * from `automation/backlog/slices.json` into labeled issues. These tests pin
 * the manifest so the autonomous loop's source of truth cannot silently
 * regress: canonical offline slices must exist, owner-gated slices must stay
 * recorded-but-never-promoted, and every dependency must resolve.
 */

const CANONICAL_OFFLINE_SLICES = ["S-M02-01", "S-M23-01", "S-M30-01"];
const OWNER_GATED_SLICES = ["S-M20-LIVE", "S-M19-LIVE", "S-M24-LIVE", "S-M26-LIVE"];
const LANE_LABELS = new Set(["lane-1", "lane-2", "lane-3"]);

test("repository backlog manifest is valid JSON with the expected envelope", async () => {
  const raw = await readFile(new URL("../automation/backlog/slices.json", import.meta.url), "utf8");
  const manifest = JSON.parse(raw);
  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.manifestType, "st_backlog_manifest");
  assert.ok(Array.isArray(manifest.slices) && manifest.slices.length > 0);
  // Owner-gated slices exist purely for tracking; the feeder must never promote them.
  assert.equal(manifest.limits.maxPerLanePerRun, 1);
});

test("manifest slice ids are unique and well-formed", async () => {
  const manifest = JSON.parse(await readFile(new URL("../automation/backlog/slices.json", import.meta.url), "utf8"));
  const ids = manifest.slices.map((slice) => slice.sliceId);
  assert.equal(new Set(ids).size, ids.length, "duplicate sliceId in manifest");
  for (const id of ids) {
    assert.match(id, /^S-[A-Z0-9-]+$/, `malformed slice id ${id}`);
  }
});

test("canonical offline slices from the owner's specification are recorded", async () => {
  const manifest = JSON.parse(await readFile(new URL("../automation/backlog/slices.json", import.meta.url), "utf8"));
  const ids = new Set(manifest.slices.map((slice) => slice.sliceId));
  for (const required of CANONICAL_OFFLINE_SLICES) {
    assert.ok(ids.has(required), `canonical slice ${required} missing from the governed manifest`);
  }
});

test("every manifest slice carries a lane label and fail-closed acceptance criteria", async () => {
  const manifest = JSON.parse(await readFile(new URL("../automation/backlog/slices.json", import.meta.url), "utf8"));
  for (const slice of manifest.slices) {
    assert.ok(LANE_LABELS.has(slice.lane), `${slice.sliceId} has no governed lane`);
    assert.equal(typeof slice.ownerGated, "boolean", `${slice.sliceId} ownerGated must be boolean`);
    const minAcceptance = slice.ownerGated ? 1 : 2; // gated slices are tracking records, promotable slices need full criteria
    assert.ok(Array.isArray(slice.acceptance) && slice.acceptance.length >= minAcceptance, `${slice.sliceId} lacks acceptance criteria`);
    assert.equal(typeof slice.brief, "string", `${slice.sliceId} brief must be a string`);
    assert.ok(slice.brief.length > 40, `${slice.sliceId} brief too short`);
  }
});

test("all dependsOn references resolve to manifest slices (no dangling dependencies)", async () => {
  const manifest = JSON.parse(await readFile(new URL("../automation/backlog/slices.json", import.meta.url), "utf8"));
  const ids = new Set(manifest.slices.map((slice) => slice.sliceId));
  for (const slice of manifest.slices) {
    for (const dep of slice.dependsOn ?? []) {
      assert.ok(ids.has(dep), `${slice.sliceId} depends on unknown slice ${dep}`);
    }
  }
});

test("owner-gated slices are present but recorded for tracking only", async () => {
  const manifest = JSON.parse(await readFile(new URL("../automation/backlog/slices.json", import.meta.url), "utf8"));
  const gated = manifest.slices.filter((slice) => slice.ownerGated === true);
  const ids = new Set(gated.map((slice) => slice.sliceId));
  for (const required of OWNER_GATED_SLICES) {
    assert.ok(ids.has(required), `owner-gated slice ${required} missing (tracking must not silently drop it)`);
  }
  for (const slice of gated) {
    assert.match(slice.brief, /owner|Owner/, `${slice.sliceId} must state its owner dependency`);
  }
});
