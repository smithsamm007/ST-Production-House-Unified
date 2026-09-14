/**
 * ST Production House — Autonomous backlog feeder (pure module).
 *
 * Turns the machine-readable slice manifest (automation/backlog/slices.json)
 * into governed GitHub issue promotion decisions. All validation and
 * eligibility logic is pure and offline; the runner (.github/scripts/
 * backlog-feeder.mjs) performs the only GitHub side effects.
 *
 * Fail-closed principles:
 * - Manifest schema violations throw stable error codes.
 * - Owner-gated slices are NEVER promotable by automation (AGENTS.md Rules
 *   7, 16, 17: credentials, OAuth, and publishing approvals are owner-only).
 * - Promotion decisions are deterministic: identical inputs produce identical
 *   decisions, and no clocks, randomness, or network access are used here.
 * - Lane concurrency is enforced: at most one in-flight slice per lane and a
 *   bounded total of open ready issues, mirroring the governed three-lane mode.
 * - Rule 15: slice titles/briefs must not carry internal agent names into
 *   what becomes public issue text. The manifest ships titles/briefs only;
 *   internal identifiers stay out of promotable text.
 */

const MANIFEST_TYPE = "st_backlog_manifest";
const SCHEMA_VERSION = 1;
const LANES = Object.freeze(new Set(["lane-1", "lane-2", "lane-3"]));
const SLICE_ID_PATTERN = /^S-[A-Z0-9]+-[A-Z0-9]+$/;

const MAX_TITLE_CHARS = 120;
const MAX_BRIEF_CHARS = 2000;
const MAX_ACCEPTANCE_ITEMS = 12;
const MAX_ACCEPTANCE_ITEM_CHARS = 300;

function feederError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requirePlainObject(value, code) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw feederError(code);
  }
}

function requireNonEmptyString(value, code, max) {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw feederError(code);
  }
  if (value.length > max) {
    throw feederError(code);
  }
  return value;
}

function requireStringArray(value, code, maxItems, maxItemChars) {
  if (!Array.isArray(value) || value.length === 0 || value.length > maxItems) {
    throw feederError(code);
  }
  for (const item of value) {
    requireNonEmptyString(item, code, maxItemChars);
  }
  return value;
}

/**
 * Validates the manifest shape. Throws a stable-coded error on the first
 * violation; returns the manifest unchanged on success (no mutation).
 */
export function validateManifest(manifest) {
  requirePlainObject(manifest, "BACKLOG_MANIFEST_INVALID");

  if (manifest.schemaVersion !== SCHEMA_VERSION) {
    throw feederError("BACKLOG_MANIFEST_SCHEMA_UNSUPPORTED");
  }
  if (manifest.manifestType !== MANIFEST_TYPE) {
    throw feederError("BACKLOG_MANIFEST_TYPE_MISMATCH");
  }
  requireNonEmptyString(manifest.description, "BACKLOG_MANIFEST_DESCRIPTION_INVALID", 2000);

  requirePlainObject(manifest.limits, "BACKLOG_MANIFEST_LIMITS_INVALID");
  const limits = manifest.limits;
  for (const key of ["maxPerLanePerRun", "maxTotalPerRun", "maxOpenReadyIssues"]) {
    if (!Number.isInteger(limits[key]) || limits[key] < 1 || limits[key] > 50) {
      throw feederError("BACKLOG_MANIFEST_LIMITS_INVALID");
    }
  }

  if (!Array.isArray(manifest.slices) || manifest.slices.length === 0 || manifest.slices.length > 200) {
    throw feederError("BACKLOG_MANIFEST_SLICES_INVALID");
  }

  const seenIds = new Set();
  for (const slice of manifest.slices) {
    requirePlainObject(slice, "BACKLOG_SLICE_INVALID");

    const id = requireNonEmptyString(slice.sliceId, "BACKLOG_SLICE_ID_INVALID", 64);
    if (!SLICE_ID_PATTERN.test(id)) {
      throw feederError("BACKLOG_SLICE_ID_INVALID");
    }
    if (seenIds.has(id)) {
      throw feederError("BACKLOG_SLICE_DUPLICATE");
    }
    seenIds.add(id);

    if (!Number.isInteger(slice.module) || slice.module < 1 || slice.module > 50) {
      throw feederError("BACKLOG_SLICE_MODULE_INVALID");
    }
    if (!LANES.has(slice.lane)) {
      throw feederError("BACKLOG_SLICE_LANE_INVALID");
    }
    if (typeof slice.ownerGated !== "boolean") {
      throw feederError("BACKLOG_SLICE_OWNER_GATED_INVALID");
    }
    requireNonEmptyString(slice.title, "BACKLOG_SLICE_TITLE_INVALID", MAX_TITLE_CHARS);
    requireNonEmptyString(slice.brief, "BACKLOG_SLICE_BRIEF_INVALID", MAX_BRIEF_CHARS);
    requireStringArray(
      slice.acceptance,
      "BACKLOG_SLICE_ACCEPTANCE_INVALID",
      MAX_ACCEPTANCE_ITEMS,
      MAX_ACCEPTANCE_ITEM_CHARS
    );

    if (slice.dependsOn !== undefined) {
      if (!Array.isArray(slice.dependsOn)) {
        throw feederError("BACKLOG_SLICE_DEPENDS_INVALID");
      }
      for (const dependency of slice.dependsOn) {
        requireNonEmptyString(dependency, "BACKLOG_SLICE_DEPENDS_INVALID", 64);
        if (!seenIds.has(dependency)) {
          // Dependencies must reference slices declared EARLIER in the file.
          // This keeps the manifest a topologically ordered work queue and
          // makes cyclic declarations structurally impossible.
          throw feederError("BACKLOG_SLICE_DEPENDS_FORWARD_REFERENCE");
        }
        if (dependency === id) {
          throw feederError("BACKLOG_SLICE_DEPENDS_SELF");
        }
      }
    }
  }

  return manifest;
}

function sliceText(slice) {
  return [slice.title, slice.brief, ...slice.acceptance].join("\n");
}

/**
 * Computes which manifest slices may be promoted right now.
 *
 * @param {object} manifest validated manifest
 * @param {object} state    observed GitHub state, all plain data:
 *   - openReadyIssuesByLane: { lane-1: n, lane-2: n, lane-3: n } count of
 *     open issues labeled ready + that lane (in-flight work)
 *   - existingSliceIssues: array of issue numbers whose title carries a
 *     slice tag "[S-XX-NN]" (any state) — prevents duplicate issue storms
 *   - promotedSliceIds: array of sliceIds already promoted or completed
 * @returns {object} deterministic promotion plan
 */
export function planPromotions(manifest, state) {
  requirePlainObject(manifest, "BACKLOG_MANIFEST_INVALID");
  requirePlainObject(state, "BACKLOG_STATE_INVALID");

  const openReadyIssuesByLane = state.openReadyIssuesByLane ?? {};
  for (const lane of Object.keys(openReadyIssuesByLane)) {
    if (!LANES.has(lane) || !Number.isInteger(openReadyIssuesByLane[lane]) || openReadyIssuesByLane[lane] < 0) {
      throw feederError("BACKLOG_STATE_LANE_COUNT_INVALID");
    }
  }
  if (
    state.existingSliceIssues !== undefined &&
    (!Array.isArray(state.existingSliceIssues) || state.existingSliceIssues.some((n) => !Number.isInteger(n) || n < 1))
  ) {
    throw feederError("BACKLOG_STATE_EXISTING_INVALID");
  }
  if (
    state.promotedSliceIds !== undefined &&
    (!Array.isArray(state.promotedSliceIds) || state.promotedSliceIds.some((id) => typeof id !== "string"))
  ) {
    throw feederError("BACKLOG_STATE_PROMOTED_INVALID");
  }

  const promoted = new Set(state.promotedSliceIds ?? []);
  const openByLane = {
    "lane-1": openReadyIssuesByLane["lane-1"] ?? 0,
    "lane-2": openReadyIssuesByLane["lane-2"] ?? 0,
    "lane-3": openReadyIssuesByLane["lane-3"] ?? 0
  };
  let totalOpen = openByLane["lane-1"] + openByLane["lane-2"] + openByLane["lane-3"];

  const promotable = [];
  const ownerGated = [];
  const skipped = [];

  for (const slice of manifest.slices) {
    if (slice.ownerGated) {
      ownerGated.push(slice.sliceId);
      continue;
    }

    if (promoted.has(slice.sliceId)) {
      skipped.push({ sliceId: slice.sliceId, reason: "ALREADY_PROMOTED" });
      continue;
    }

    // Dependencies must be satisfied: every dependsOn slice already promoted
    // or at least previously promoted-and-completed (tracked via promoted).
    const unsatisfied = (slice.dependsOn ?? []).filter((dependency) => !promoted.has(dependency));
    if (unsatisfied.length > 0) {
      skipped.push({ sliceId: slice.sliceId, reason: "DEPENDENCY_UNSATISFIED", detail: unsatisfied });
      continue;
    }

    if (openByLane[slice.lane] >= manifest.limits.maxPerLanePerRun) {
      skipped.push({ sliceId: slice.sliceId, reason: "LANE_BUSY" });
      continue;
    }
    if (totalOpen >= manifest.limits.maxOpenReadyIssues) {
      skipped.push({ sliceId: slice.sliceId, reason: "OPEN_READY_LIMIT" });
      continue;
    }

    promotable.push(slice.sliceId);
    openByLane[slice.lane] += 1;
    totalOpen += 1;
  }

  return Object.freeze({
    promotable: Object.freeze(promotable),
    ownerGated: Object.freeze(ownerGated),
    skipped: Object.freeze(skipped.map((entry) => Object.freeze(entry)))
  });
}

/**
 * Builds the exact issue payload for a promotable slice. Deterministic:
 * the same slice always yields the same title and body. The slice tag in
 * the title allows the runner to detect duplicates idempotently.
 * Rule 15: fails closed if internal agent names appear in promotable text.
 */
export function buildIssuePayload(manifest, sliceId, internalAgentNames) {
  requirePlainObject(manifest, "BACKLOG_MANIFEST_INVALID");
  if (typeof sliceId !== "string") {
    throw feederError("BACKLOG_SLICE_ID_INVALID");
  }
  const slice = manifest.slices.find((candidate) => candidate.sliceId === sliceId);
  if (!slice) {
    throw feederError("BACKLOG_SLICE_NOT_FOUND");
  }
  if (slice.ownerGated) {
    // Automation must not promote owner-gated slices, ever.
    throw feederError("BACKLOG_SLICE_OWNER_GATED");
  }

  const text = sliceText(slice);
  for (const name of internalAgentNames ?? []) {
    if (typeof name === "string" && name.length > 2) {
      const pattern = new RegExp(`\\b${name.toLowerCase()}\\b`, "i");
      if (pattern.test(text)) {
        throw feederError("BACKLOG_SLICE_INTERNAL_NAME_REJECTED");
      }
    }
  }

  const labels = [slice.lane, "ready"];
  const title = `[${slice.sliceId}] ${slice.title}`;
  const acceptance = slice.acceptance.map((item) => `- [ ] ${item}`).join("\n");
  const dependencies = (slice.dependsOn ?? []).join(", ") || "none";
  const body = [
    "Automated backlog slice. Implement fully under AGENTS.md; one PR per slice;",
    "branch `task/<issue#>-<slug>`; PR body needs `Closes #<issue>` plus real pasted",
    "test output (R6). No mocks, placeholders, fake evidence, or skipped tests.",
    "",
    `**Module**: ${slice.module}`,
    `**Lane**: ${slice.lane}`,
    `**Depends on**: ${dependencies}`,
    "",
    "## Brief",
    "",
    slice.brief,
    "",
    "## Acceptance criteria",
    "",
    acceptance
  ].join("\n");

  return Object.freeze({ title, body, labels: Object.freeze([...labels]) });
}
