/**
 * ST Production House — Task Envelope & Territory Guard
 * Validates task execution envelopes against the Engineering Contract.
 */

import { randomUUID } from "node:crypto";

const INTERNAL_AGENT_NAMES = Object.freeze([
  "JARVIS",
  "LAKME",
  "SHERLOCK",
  "PANCHI",
  "VEDA",
  "CHITRAGUPTA",
  "CHANAKYA",
  "VALMIKI",
  "KUBERA",
  "INDRA",
  "AGNI",
  "VAYU",
  "SURYA",
  "SOMA",
  "YAMA",
  "VARUNA",
  "BRIHASPATI",
  "SHUKRA",
  "RAHU",
  "KETU"
]);

const TERRITORY_RULES = Object.freeze({
  jules: {
    allowedPrefixes: [
      "src/broker/",
      "src/credentials/",
      "src/providers/",
      "src/quotas/",
      "src/resilience/",
      "src/recovery/",
      "sql/",
      "tests/",
      "docs/"
    ]
  },
  "night-shift": {
    allowedPrefixes: [
      "src/api/",
      "src/catalog/",
      "src/orchestration/",
      "src/checkpoints/",
      "src/jobs/",
      "src/workers/",
      "src/evidence/",
      "src/promotion/",
      "src/publishing/",
      "src/integrations/",
      "src/jarvis/",
      "src/db/",
      "tests/",
      "docs/",
      ".github/",
      "server.js",
      "package.json",
      "metadata.json",
      "ROADMAP.md"
    ]
  }
});

export class TaskEnvelope {
  /**
   * Validate and construct an immutable execution envelope.
   * @param {object} input
   * @returns {object}
   */
  static create(input) {
    if (!input || typeof input !== "object") {
      throw new Error("INVALID_TASK_ENVELOPE_INPUT");
    }

    const {
      taskId,
      lane,
      issueNumber,
      title,
      assignee,
      targetFiles = [],
      metadata = {}
    } = input;

    if (!taskId || typeof taskId !== "string") {
      throw new Error("TASK_ID_REQUIRED");
    }

    if (!["lane-1", "lane-2", "lane-3"].includes(lane)) {
      throw new Error(`INVALID_LANE: ${lane}`);
    }

    if (!assignee || !["jules", "night-shift"].includes(assignee)) {
      throw new Error(`INVALID_ASSIGNEE: ${assignee}`);
    }

    // Verify lane-assignee alignment
    if ((lane === "lane-1" || lane === "lane-2") && assignee !== "jules") {
      throw new Error("LANE_ASSIGNEE_MISMATCH_JULES_REQUIRED");
    }
    if (lane === "lane-3" && assignee !== "night-shift") {
      throw new Error("LANE_ASSIGNEE_MISMATCH_NIGHT_SHIFT_REQUIRED");
    }

    // Validate Territory Boundaries
    const territory = TERRITORY_RULES[assignee];
    for (const file of targetFiles) {
      if (typeof file !== "string") continue;
      const normalized = file.startsWith("/") ? file.slice(1) : file;
      const isAllowed = territory.allowedPrefixes.some((prefix) =>
        normalized.startsWith(prefix)
      );
      if (!isAllowed) {
        throw new Error(`TERRITORY_VIOLATION: ${assignee} cannot modify ${file}`);
      }
    }

    // Rule 15: Agent names internal-only in public title/metadata
    const textToCheck = `${title || ""} ${JSON.stringify(metadata)}`;
    for (const internalName of INTERNAL_AGENT_NAMES) {
      const regex = new RegExp(`\\b${internalName}\\b`, "i");
      if (regex.test(title || "")) {
        throw new Error(`RULE_15_VIOLATION: Internal agent name '${internalName}' detected in task title`);
      }
    }

    // Rule 17: No plaintext passwords or raw secrets
    if (/password\s*[:=]\s*['"][^'"]+['"]/i.test(textToCheck) ||
        /secret\s*[:=]\s*['"][^'"]+['"]/i.test(textToCheck) ||
        /api_key\s*[:=]\s*['"][^'"]+['"]/i.test(textToCheck)) {
      throw new Error("RULE_17_VIOLATION: Plaintext secret detected in task envelope");
    }

    // Rule R8: Derive canonical branch name
    const slug = (title || taskId)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
    const branchName = issueNumber
      ? `task/${issueNumber}-${slug}`
      : `task/${taskId.toLowerCase()}-${slug}`;

    return Object.freeze({
      envelopeId: randomUUID(),
      taskId,
      lane,
      issueNumber: issueNumber ?? null,
      title: title || taskId,
      assignee,
      branchName,
      targetFiles: Object.freeze([...targetFiles]),
      status: "initialized",
      attemptCount: 0,
      createdAt: new Date().toISOString()
    });
  }

  /**
   * Safe DTO serializer that strictly conforms to Rule 17 allowlist.
   * @param {object} envelope
   * @returns {object}
   */
  static toSafeDTO(envelope) {
    if (!envelope || typeof envelope !== "object") return null;
    return Object.freeze({
      taskId: envelope.taskId,
      lane: envelope.lane,
      branchName: envelope.branchName,
      status: envelope.status,
      attemptCount: envelope.attemptCount ?? 0,
      createdAt: envelope.createdAt
    });
  }
}
