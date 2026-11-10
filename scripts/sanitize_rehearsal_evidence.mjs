#!/usr/bin/env node
/**
 * Issue #264 — turn git-ignored rehearsal evidence into ONE sanitized bundle
 * that CI can retain as an artifact.
 *
 * Usage:
 *   node scripts/sanitize_rehearsal_evidence.mjs [--out=path/to/bundle.json]
 *   npm run evidence:sanitize
 *
 * HONESTY: when no evidence exists this reports EVIDENCE_SKIPPED_NO_EVIDENCE
 * and writes NOTHING. It never fabricates a summary for a run that did not
 * happen (AGENTS.md Rules 1–3) — the workflow then uploads nothing.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  REHEARSAL_EVIDENCE_BUNDLE_VERSION,
  sanitizeRehearsalEvidence,
  serializeRehearsalEvidenceBundle,
} from "../src/evidence/rehearsalEvidenceBundle.js";

const ROOT = "artifacts/rehearsal";
const DEFAULT_OUT = path.join(ROOT, "sanitized", "rehearsal-evidence-bundle.json");

function report(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function collectEvidenceFiles() {
  if (!existsSync(ROOT)) return [];
  return readdirSync(ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(ROOT, entry.name, "rehearsal-evidence.json"))
    .filter((file) => existsSync(file));
}

function main() {
  const outArg = process.argv.find((arg) => arg.startsWith("--out="));
  const outPath = outArg ? outArg.slice("--out=".length) : DEFAULT_OUT;

  const evidenceFiles = collectEvidenceFiles();
  if (evidenceFiles.length === 0) {
    report({
      code: "EVIDENCE_SKIPPED_NO_EVIDENCE",
      searched: ROOT,
      detail: "no rehearsal-evidence.json found; nothing is written or uploaded",
    });
    return;
  }

  const runs = [];
  for (const file of evidenceFiles) {
    const evidence = JSON.parse(readFileSync(file, "utf8"));
    runs.push(sanitizeRehearsalEvidence(evidence, { sourceName: file }));
  }
  runs.sort((left, right) => left.target.targetSeconds - right.target.targetSeconds);

  const bundle = {
    bundleVersion: REHEARSAL_EVIDENCE_BUNDLE_VERSION,
    bundleKind: "sanitized_rehearsal_evidence_collection",
    runCount: runs.length,
    runs,
  };
  const serialized = serializeRehearsalEvidenceBundle(bundle);

  mkdirSync(path.dirname(outPath), { recursive: true });
  writeFileSync(outPath, serialized);
  report({
    code: "EVIDENCE_BUNDLE_WRITTEN",
    bundleVersion: REHEARSAL_EVIDENCE_BUNDLE_VERSION,
    evidenceFiles: runs.length,
    targets: runs.map((run) => run.target.targetSeconds),
    bundlePath: outPath,
    bytes: Buffer.byteLength(serialized),
  });
}

try {
  main();
} catch (error) {
  console.error(JSON.stringify({ code: error.code ?? "EVIDENCE_BUNDLE_FAILED", message: error.message }));
  process.exit(1);
}
