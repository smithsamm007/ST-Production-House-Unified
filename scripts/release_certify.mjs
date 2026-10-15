#!/usr/bin/env node
/**
 * ST Production House — release certification runner (TASK-5.3).
 *
 * What this produces, from REAL repository state only:
 *   - a CycloneDX-shaped SBOM built from the actual package-lock.json
 *   - the license policy verdict over every component
 *   - the Rule 12 bundled-media scan over the deployed source roots
 *   - the deterministic release certification record (recomputed id)
 *
 * Evidence is written to git-ignored artifacts/release/; exit 0 only when the
 * overall verdict is PASS. Nothing is uploaded; nothing is fabricated.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import {
  applyLicensePolicy,
  buildReleaseCertification,
  buildSbomFromLockfile,
  digestsForCertification,
  scanForBundledMedia,
  toCycloneDx,
} from "../src/release/releaseCertification.js";

const repoRoot = process.cwd();

const packageJson = JSON.parse(await readFile(path.join(repoRoot, "package.json"), "utf8"));
const lockfile = path.join(repoRoot, "package-lock.json");
const lockContent = JSON.parse(await readFile(lockfile, "utf8"));

const components = buildSbomFromLockfile(lockContent);
const licensePolicy = applyLicensePolicy(components);
const bundledMedia = await scanForBundledMedia([
  path.join(repoRoot, "src"),
  path.join(repoRoot, "public"),
  path.join(repoRoot, "scripts"),
  path.join(repoRoot, "docs"),
  path.join(repoRoot, "tests"),
  path.join(repoRoot, "automation"),
]);
const digests = await digestsForCertification(lockfile, { name: packageJson.name, version: packageJson.version, dependencies: packageJson.dependencies });

const certification = buildReleaseCertification({
  components,
  licensePolicy,
  bundledMedia,
  digests,
  repoName: packageJson.name,
  repoVersion: packageJson.version,
});

const artifactDir = path.join(repoRoot, "artifacts", "release");
await mkdir(artifactDir, { recursive: true });
const artifacts = {
  sbom: path.join(artifactDir, "sbom.cdx.json"),
  certification: path.join(artifactDir, "release-certification.json"),
};
await writeFile(artifacts.sbom, JSON.stringify(toCycloneDx(components), null, 2) + "\n", "utf8");
await writeFile(artifacts.certification, JSON.stringify(certification, null, 2) + "\n", "utf8");

const summary = {
  code: certification.overallVerdict === "PASS" ? "RELEASE_CERTIFICATION_PASS" : "RELEASE_CERTIFICATION_FAIL",
  releaseCertificationId: certification.releaseCertificationId,
  componentCount: certification.componentCount,
  licenseSummary: certification.licenseSummary,
  verdicts: certification.verdicts,
  bundledMediaFindings: certification.bundledMediaFindings,
  evidenceFiles: artifacts,
};
console.log(JSON.stringify(summary));
process.exit(summary.code === "RELEASE_CERTIFICATION_PASS" ? 0 : 1);
