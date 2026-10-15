import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  DEFAULT_ALLOWED_LICENSES,
  RELEASE_CERT_ERROR_CODES,
  applyLicensePolicy,
  buildReleaseCertification,
  buildSbomFromLockfile,
  scanForBundledMedia,
  toCycloneDx,
} from "../src/release/releaseCertification.js";

test("SBOM reflects the real lockfile: complete inventory, scopes, licenses, no unknowns", async () => {
  const lockRaw = await readFile(path.join(process.cwd(), "package-lock.json"), "utf8");
  const components = buildSbomFromLockfile(JSON.parse(lockRaw));
  assert.ok(components.length > 100, "every packaged dependency is inventoried");
  const seen = new Set(components.map((c) => `${c.name}@${c.version}`));
  assert.equal(seen.size, components.length, "no duplicate components");
  for (const component of components) {
    assert.ok(DEFAULT_ALLOWED_LICENSES.includes(component.license), `${component.name} must be permissively licensed`);
  }
  const express = components.find((c) => c.name === "express");
  assert.ok(express, "express is inventoried");
  assert.equal(express.license, "MIT");
  const supertest = components.find((c) => c.name === "supertest");
  assert.ok(supertest, "supertest is inventoried");
  assert.equal(supertest.scope, "dev", "supertest is a declared dev dependency");
});

test("SBOM fails closed on a missing or empty license declaration", () => {
  const lockContent = {
    packages: {
      "": { name: "r", version: "1.0.0" },
      "node_modules/good": { name: "good", version: "1.0.0", license: "MIT" },
      "node_modules/shady": { name: "shady", version: "2.0.0" }, // no license at all
    },
  };
  assert.throws(
    () => buildSbomFromLockfile(lockContent),
    (err) => err.code === RELEASE_CERT_ERROR_CODES.LICENSE_UNKNOWN
  );
});

test("license policy passes permissive sets and denies copyleft/unknown with offenders listed", () => {
  const components = [
    { name: "a", version: "1", scope: "production", license: "MIT" },
    { name: "b", version: "2", scope: "production", license: "GPL-3.0-only" },
    { name: "c", version: "3", scope: "dev", license: "AGPL-3.0" },
    { name: "d", version: "4", scope: "production", license: "Custom-Proprietary" },
  ];
  const policy = applyLicensePolicy(components);
  assert.equal(policy.verdict, "FAIL");
  assert.deepEqual(
    policy.denied.map((d) => d.name),
    ["b", "c", "d"]
  );
  // documented exception authorizes exactly one named license
  const policyWithException = applyLicensePolicy(components, {
    licenseExceptions: { "Custom-Proprietary": "owner-owned, not redistributable" },
  });
  assert.deepEqual(
    policyWithException.denied.map((d) => d.name),
    ["b", "c"]
  );
  assert.equal(applyLicensePolicy([{ name: "a", version: "1", license: "MIT" }]).verdict, "PASS");
});

test("Rule 12 scanner reports findings and fails closed on undocumented bundled media", async () => {
  const tmp = await mkdtemp(path.join(os.tmpdir(), "stph_media_scan_"));
  try {
    await mkdir(path.join(tmp, "assets"), { recursive: true });
    await writeFile(path.join(tmp, "assets", "theme.mp3"), "fake-bytes-for-scan-only");
    await writeFile(path.join(tmp, "owner_logo.png"), "fake-png-bytes-ownercreated");

    const result = await scanForBundledMedia([tmp]);
    assert.equal(result.verdict, "FAIL", "an empty manifest cannot wave findings through");
    assert.equal(result.findings.length, 2);
    const extensions = result.findings.map((f) => f.extension).sort();
    assert.deepEqual(extensions, [".mp3", ".png"]);
    assert.equal(result.undocumented.length, 2);

    // a clean (or absent) tree passes honestly
    const clean = await scanForBundledMedia([path.join(tmp, "empty_missing_root")]);
    assert.deepEqual(clean.findings, []);
    assert.equal(clean.verdict, "PASS");
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch(() => {});
  }
});

test("CycloneDX shape and deterministic content-only certification id", () => {
  const components = [
    { name: "a", version: "1.0.0", scope: "production", license: "MIT" },
    { name: "b", version: "2.0.0", scope: "dev", license: "ISC" },
  ];
  const doc = toCycloneDx(components);
  assert.equal(doc.bomFormat, "CycloneDX");
  assert.equal(doc.specVersion, "1.5");
  assert.equal(doc.components.length, 2);
  assert.deepEqual(doc.components[0].licenses, [{ license: { id: "MIT" } }]);

  const policy = applyLicensePolicy(components);
  const media = { findings: [], undocumented: [], verdict: "PASS" };
  const digests = { lockFileSha256: "0".repeat(64), packageJsonSha256: "1".repeat(64) };
  const base = {
    components,
    licensePolicy: policy,
    bundledMedia: media,
    digests,
    repoName: "x",
    repoVersion: "1.0.0",
  };
  const first = buildReleaseCertification(base);
  const second = buildReleaseCertification(base);
  assert.equal(first.releaseCertificationId, second.releaseCertificationId, "same content, same id");
  assert.equal(first.overallVerdict, "PASS");

  const failing = buildReleaseCertification({
    ...base,
    licensePolicy: { ...policy, verdict: "FAIL", denied: [{ name: "b", version: "2.0.0", license: "GPL-3.0-only" }] },
  });
  assert.equal(failing.overallVerdict, "FAIL");
  assert.notEqual(failing.releaseCertificationId, first.releaseCertificationId);
});
