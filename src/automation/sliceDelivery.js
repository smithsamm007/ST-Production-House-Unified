/**
 * ST Production House — slice delivery reconciler (pure module).
 *
 * Closes the one gap the governed loop cannot close by itself: a slice whose
 * work already sits on a branch but has no open pull request never reaches
 * `autonomous-merge`, `pr-gate`, or `exact-head-merge` — all three react to
 * pull_request events only. Such a slice can neither merge nor be honestly
 * reported as delivered, and duplicate branches for the same slice accumulate
 * unchecked (the observed cause of two competing #263 implementations).
 *
 * This module makes decisions only: no I/O, no clocks, no randomness, no
 * network. The runner (.github/scripts/slice-delivery-reconciler.mjs) performs
 * every GitHub side effect.
 *
 * Fail-closed rules (AGENTS.md Rules 1-3, 7, 16, 17 and the post-merge
 * amendment "ONE PR in flight"):
 * - Owner-gated slices are never actionable by automation, even when a branch
 *   for them exists.
 * - Automation never chooses between two implementations of the same slice
 *   when both carry verification evidence, and never guesses between several
 *   unverified ones. It reports the ambiguity and leaves the decision to the
 *   owner. Silently discarding a competing implementation would destroy work.
 * - While any governed pull request is open, every other slice is held.
 * - The verdict never claims the project is operational. It reports only
 *   whether automatable work remains, and which slices need the owner.
 */

const SLICE_TAG_PATTERN = /\[(S-[A-Z0-9-]+)\]/;
const TASK_BRANCH_PATTERN = /^task\/(\d+)-/;
const SCHEMA_VERSION = 1;

/**
 * Stable action identifiers emitted by the planner. The runner maps each to a
 * side effect (or an explicit no-op) and logs it verbatim.
 */
export const SLICE_DELIVERY_ACTIONS = Object.freeze({
  ALREADY_MERGED: "ALREADY_MERGED",
  OWNER_ACTION_REQUIRED: "OWNER_ACTION_REQUIRED",
  PULL_REQUEST_IN_FLIGHT: "PULL_REQUEST_IN_FLIGHT",
  AMBIGUOUS_DUPLICATE_PULL_REQUESTS: "AMBIGUOUS_DUPLICATE_PULL_REQUESTS",
  OPEN_PULL_REQUEST: "OPEN_PULL_REQUEST",
  HOLD_ONE_PULL_REQUEST_IN_FLIGHT: "HOLD_ONE_PULL_REQUEST_IN_FLIGHT",
  AMBIGUOUS_CANONICAL_BRANCH: "AMBIGUOUS_CANONICAL_BRANCH",
  AWAIT_IMPLEMENTATION: "AWAIT_IMPLEMENTATION",
  AWAIT_PROMOTION: "AWAIT_PROMOTION"
});

export const SLICE_DELIVERY_VERDICTS = Object.freeze({
  AUTOMATABLE_COMPLETE: "AUTOMATABLE_COMPLETE",
  WORK_REMAINING: "WORK_REMAINING"
});

function deliveryError(code) {
  const error = new Error(code);
  error.code = code;
  return error;
}

function requireArray(value, code) {
  if (!Array.isArray(value)) {
    throw deliveryError(code);
  }
  return value;
}

/**
 * Extracts the governed slice tag (`[S-M43-01]`) from an issue title.
 * Returns null when the title carries no tag, so untagged issues can never be
 * mistaken for a governed slice.
 */
export function tagSliceId(title) {
  if (typeof title !== "string") return null;
  const match = title.match(SLICE_TAG_PATTERN);
  return match ? match[1] : null;
}

/**
 * Extracts the issue number from a governed task branch name
 * (`task/263-measured-media-qc` => 263). Non-governed branches return null.
 */
export function issueNumberFromBranch(branch) {
  if (typeof branch !== "string") return null;
  const match = branch.match(TASK_BRANCH_PATTERN);
  if (!match) return null;
  const parsed = Number.parseInt(match[1], 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
}

/**
 * Maps slice ids to their governed issue. Deterministic: when several issues
 * carry the same slice tag (a stale duplicate), the lowest issue number wins,
 * so identical repository state always yields an identical mapping.
 *
 * @returns {Record<string, { number: number, title: string, state: string }>}
 */
export function mapSliceToIssue(issues) {
  requireArray(issues, "SLICE_DELIVERY_INPUT_INVALID");
  const mapping = {};
  const ordered = issues
    .filter((issue) => issue && Number.isInteger(issue.number))
    .slice()
    .sort((a, b) => a.number - b.number);

  for (const issue of ordered) {
    const sliceId = tagSliceId(issue.title);
    if (!sliceId) continue;
    if (mapping[sliceId]) continue;
    mapping[sliceId] = {
      number: issue.number,
      title: String(issue.title ?? ""),
      state: String(issue.state ?? "unknown")
    };
  }
  return mapping;
}

/**
 * Chooses the single canonical branch for a slice.
 *
 * Selection order: exactly one candidate is always canonical; with several,
 * a single candidate carrying verification evidence wins; anything else is
 * ambiguous and yields no selection. Comparisons use branch name only, so the
 * outcome is reproducible.
 *
 * @param {Array<{ branch: string, headSha?: string, aheadBy?: number, verifiedHead?: boolean }>} candidates
 */
export function selectCanonicalCandidate(candidates) {
  const list = requireArray(candidates, "SLICE_DELIVERY_INPUT_INVALID")
    .filter((candidate) => candidate && typeof candidate.branch === "string" && candidate.branch.length > 0)
    .map((candidate) => ({
      branch: candidate.branch,
      headSha: typeof candidate.headSha === "string" ? candidate.headSha : "",
      aheadBy: Number.isInteger(candidate.aheadBy) ? candidate.aheadBy : Number.MAX_SAFE_INTEGER,
      verifiedHead: candidate.verifiedHead === true
    }))
    .sort((a, b) => a.branch.localeCompare(b.branch));

  if (list.length === 0) {
    return { status: "NONE", reason: "NO_CANDIDATE_BRANCH", selected: null, duplicates: [], ambiguousBranches: [] };
  }
  if (list.length === 1) {
    return { status: "SELECTED", reason: "SINGLE_CANDIDATE", selected: list[0], duplicates: [], ambiguousBranches: [] };
  }

  const verified = list.filter((candidate) => candidate.verifiedHead);
  if (verified.length === 1) {
    return {
      status: "SELECTED",
      reason: "SINGLE_VERIFIED_CANDIDATE",
      selected: verified[0],
      duplicates: list.filter((candidate) => candidate.branch !== verified[0].branch),
      ambiguousBranches: []
    };
  }
  return {
    status: "AMBIGUOUS",
    reason: verified.length > 1 ? "MULTIPLE_VERIFIED_CANDIDATES" : "MULTIPLE_UNVERIFIED_CANDIDATES",
    selected: null,
    duplicates: [],
    ambiguousBranches: (verified.length > 1 ? verified : list).map((candidate) => candidate.branch).sort()
  };
}

/**
 * Plans the delivery of every manifest slice from real observed state.
 *
 * @param {object} input
 * @param {Array<object>} input.slices             manifest slices (sliceId, ownerGated)
 * @param {Array<string>} input.promotedSliceIds   lifecycle record of merged slices
 * @param {Array<object>} input.issues             [{ number, title, state }]
 * @param {Array<object>} input.openPullRequests   [{ number, headRefName, headSha }]
 * @param {Record<string, Array<object>>} [input.candidatesBySlice] candidate branches per slice
 */
export function planSliceDelivery(input) {
  const {
    slices,
    promotedSliceIds,
    issues,
    openPullRequests,
    candidatesBySlice = {}
  } = input ?? {};

  requireArray(slices, "SLICE_DELIVERY_INPUT_INVALID");
  requireArray(issues, "SLICE_DELIVERY_INPUT_INVALID");
  requireArray(openPullRequests, "SLICE_DELIVERY_INPUT_INVALID");
  const promotedIds = requireArray(promotedSliceIds, "SLICE_DELIVERY_INPUT_INVALID").map(String);
  const promoted = new Set(promotedIds);
  if (candidatesBySlice === null || typeof candidatesBySlice !== "object" || Array.isArray(candidatesBySlice)) {
    throw deliveryError("SLICE_DELIVERY_INPUT_INVALID");
  }

  const sliceToIssue = mapSliceToIssue(issues);
  const issueToSlice = new Map();
  for (const [sliceId, issue] of Object.entries(sliceToIssue)) {
    issueToSlice.set(issue.number, sliceId);
  }

  // Only pull requests whose head branch belongs to a governed slice take part:
  // human or unrelated branches must never trip the one-PR rule.
  const pullRequestsBySlice = new Map();
  for (const pullRequest of openPullRequests) {
    if (!pullRequest || !Number.isInteger(pullRequest.number)) continue;
    const issueNumber = issueNumberFromBranch(pullRequest.headRefName);
    const sliceId = issueNumber === null ? null : issueToSlice.get(issueNumber);
    if (!sliceId) continue;
    if (!pullRequestsBySlice.has(sliceId)) pullRequestsBySlice.set(sliceId, []);
    pullRequestsBySlice.get(sliceId).push({
      number: pullRequest.number,
      headRefName: String(pullRequest.headRefName ?? ""),
      headSha: String(pullRequest.headSha ?? "")
    });
  }

  const governedInFlight = [...pullRequestsBySlice.values()]
    .flat()
    .sort((a, b) => a.number - b.number);

  const actions = [];

  for (const slice of slices) {
    if (!slice || typeof slice.sliceId !== "string") {
      throw deliveryError("SLICE_DELIVERY_INPUT_INVALID");
    }
    const sliceId = slice.sliceId;
    const ownerGated = slice.ownerGated === true;
    const issue = sliceToIssue[sliceId] ?? null;
    const pullRequests = pullRequestsBySlice.get(sliceId) ?? [];
    const base = { sliceId, ownerGated, issueNumber: issue ? issue.number : null };

    if (promoted.has(sliceId)) {
      actions.push({ ...base, action: SLICE_DELIVERY_ACTIONS.ALREADY_MERGED });
      continue;
    }
    if (ownerGated) {
      // Rule 7/16/17: credentials, OAuth and publishing approvals are owner-only.
      actions.push({ ...base, action: SLICE_DELIVERY_ACTIONS.OWNER_ACTION_REQUIRED });
      continue;
    }
    if (pullRequests.length > 1) {
      actions.push({
        ...base,
        action: SLICE_DELIVERY_ACTIONS.AMBIGUOUS_DUPLICATE_PULL_REQUESTS,
        pullRequests
      });
      continue;
    }
    if (pullRequests.length === 1) {
      actions.push({ ...base, action: SLICE_DELIVERY_ACTIONS.PULL_REQUEST_IN_FLIGHT, pullRequests });
      continue;
    }

    const choice = selectCanonicalCandidate(candidatesBySlice[sliceId] ?? []);
    if (choice.status === "AMBIGUOUS") {
      actions.push({
        ...base,
        action: SLICE_DELIVERY_ACTIONS.AMBIGUOUS_CANONICAL_BRANCH,
        reason: choice.reason,
        candidateBranches: choice.ambiguousBranches
      });
      continue;
    }
    if (choice.status === "SELECTED") {
      const selection = {
        ...base,
        branch: choice.selected.branch,
        headSha: choice.selected.headSha,
        aheadBy: choice.selected.aheadBy,
        verificationEvidence: choice.selected.verifiedHead,
        duplicateBranches: choice.duplicates.map((candidate) => candidate.branch)
      };
      actions.push({
        ...selection,
        action:
          governedInFlight.length > 0
            ? SLICE_DELIVERY_ACTIONS.HOLD_ONE_PULL_REQUEST_IN_FLIGHT
            : SLICE_DELIVERY_ACTIONS.OPEN_PULL_REQUEST
      });
      continue;
    }
    actions.push({
      ...base,
      action: issue ? SLICE_DELIVERY_ACTIONS.AWAIT_IMPLEMENTATION : SLICE_DELIVERY_ACTIONS.AWAIT_PROMOTION
    });
  }

  const automatableRemaining = slices.filter(
    (slice) => !promoted.has(slice.sliceId) && slice.ownerGated !== true
  ).length;
  const ownerGatedRemaining = slices
    .filter((slice) => !promoted.has(slice.sliceId) && slice.ownerGated === true)
    .map((slice) => slice.sliceId)
    .sort();

  return {
    schemaVersion: SCHEMA_VERSION,
    verdict:
      automatableRemaining === 0
        ? SLICE_DELIVERY_VERDICTS.AUTOMATABLE_COMPLETE
        : SLICE_DELIVERY_VERDICTS.WORK_REMAINING,
    automatableRemaining,
    ownerGatedRemaining,
    governedPullRequestsInFlight: governedInFlight,
    actions,
    slices: slices.map((slice) => ({
      sliceId: slice.sliceId,
      lane: slice.lane ?? null,
      ownerGated: slice.ownerGated === true,
      merged: promoted.has(slice.sliceId),
      issueNumber: sliceToIssue[slice.sliceId] ? sliceToIssue[slice.sliceId].number : null
    }))
  };
}

/**
 * One-line, human-readable statement of what happens next. Returns null when
 * no automatable work remains (the owner-only remainder is reported
 * separately by `ownerGatedRemaining`).
 */
export function summarizeDelivery(report) {
  if (!report || !Array.isArray(report.actions)) {
    throw deliveryError("SLICE_DELIVERY_REPORT_INVALID");
  }
  const priority = [
    SLICE_DELIVERY_ACTIONS.AMBIGUOUS_DUPLICATE_PULL_REQUESTS,
    SLICE_DELIVERY_ACTIONS.AMBIGUOUS_CANONICAL_BRANCH,
    SLICE_DELIVERY_ACTIONS.OPEN_PULL_REQUEST,
    SLICE_DELIVERY_ACTIONS.PULL_REQUEST_IN_FLIGHT,
    SLICE_DELIVERY_ACTIONS.HOLD_ONE_PULL_REQUEST_IN_FLIGHT,
    SLICE_DELIVERY_ACTIONS.AWAIT_IMPLEMENTATION,
    SLICE_DELIVERY_ACTIONS.AWAIT_PROMOTION
  ];
  for (const actionId of priority) {
    const match = report.actions
      .filter((action) => action.action === actionId)
      .sort((a, b) => a.sliceId.localeCompare(b.sliceId))[0];
    if (!match) continue;
    if (actionId === SLICE_DELIVERY_ACTIONS.OPEN_PULL_REQUEST) {
      return `open the pull request for ${match.sliceId} from ${match.branch}`;
    }
    if (actionId === SLICE_DELIVERY_ACTIONS.AMBIGUOUS_CANONICAL_BRANCH) {
      return `owner must choose between ${match.candidateBranches.length} candidate branches for ${match.sliceId} (${match.reason})`;
    }
    if (actionId === SLICE_DELIVERY_ACTIONS.AMBIGUOUS_DUPLICATE_PULL_REQUESTS) {
      return `owner must choose between ${match.pullRequests.length} open pull requests for ${match.sliceId}`;
    }
    return `${actionId} for ${match.sliceId}`;
  }
  return null;
}
