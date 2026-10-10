#!/usr/bin/env node
/**
 * Real JARVIS deterministic content-package run (offline, no provider calls).
 *
 * This is the ONLY thing the governed system can produce today without
 * owner-provisioned Vault capacity + provider keys (Issue #118): the full
 * 8-stage deterministic plan package. It is labeled `deterministic_local`
 * by the orchestrator itself — mediaStatus stays `not_generated`, no fake
 * media, no fake receipts (AGENTS.md Rules 1–3 are enforced BY the code,
 * not by this script).
 */
import { JarvisContentPackageOrchestrator } from "../src/jarvis/contentPackageOrchestrator.js";
import { WorkerRuntime } from "../src/workers/workerRuntime.js";
import { CheckpointStore } from "../src/checkpoints/checkpointStore.js";
import { EvidenceLedger } from "../src/evidence/evidenceLedger.js";

class MemoryAdapter {
  constructor(name) { this.name = name; this.store = new Map(); }
  async get(k) { return this.store.get(k) ?? null; }
  async set(k, v) { this.store.set(k, v); }
}

// NOTE: Rule 15 — internal director names (JARVIS, LAKME, ...) must never
// appear in public payload text; the governed stages REJECT such input by
// design. Concepts are written in channel-universe terms only.
const concept = process.argv[2]
  ?? "A night-shift guard at an abandoned mansion discovers the sealed record room hums every full moon night — and something inside has started answering.";

const input = {
  packageTaskId: `pkg-jarvis-${Date.now().toString(36)}`,
  publicBrand: "The Cursed Mansion",
  suppliedConcept: concept,
  language: "hinglish",
  targetMinutes: 26
};

console.log("== JARVIS deterministic content package :: REAL offline run ==");
console.log("publicBrand:", input.publicBrand);
console.log("taskId:", input.packageTaskId);

const orchestrator = new JarvisContentPackageOrchestrator({
  runtime: new WorkerRuntime({ idempotencyStore: new MemoryAdapter("idem"), isTestEnv: true }),
  checkpointStore: new CheckpointStore(new MemoryAdapter("ckp")),
  evidenceLedger: new EvidenceLedger()
});

const pkg = await orchestrator.createContentPackage(input);

console.log("\nreadiness:", pkg.readiness);
console.log("outlinePackageId:", pkg.outlinePackageId);
console.log("stages:");
for (const stage of pkg.stages) {
  console.log(" -", stage.stage, "=>", stage.status, stage.reasonCode ?? "", "hash:", stage.resultHash?.slice(0, 16) ?? "—");
}
console.log("\nprovenance (as produced by the governed orchestrator):", JSON.stringify(pkg.provenance, null, 2));
console.log("publication:", JSON.stringify(pkg.publication));
console.log("\nshorts plan slots:", pkg.shortsPlan?.package?.length ?? pkg.shortsPlan?.shorts?.length ?? "n/a");
console.log("visual scenes planned:", pkg.visualScenePlan?.scenes?.length ?? pkg.visualScenePlan?.package?.scenes?.length ?? "see package JSON");

// Dump the real package for inspection.
const outPath = new URL(`../out/${input.packageTaskId}.json`, import.meta.url).pathname;
const { mkdirSync, writeFileSync } = await import("node:fs");
mkdirSync(new URL("../out/", import.meta.url).pathname, { recursive: true });
writeFileSync(outPath, JSON.stringify(pkg, null, 2));
console.log("\nFull real package written (evidence artifact, plan-only):", outPath);
