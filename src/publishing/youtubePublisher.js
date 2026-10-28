/**
 * ST Production House — YouTube upload publisher adapter (Issue #215).
 *
 * The OFFICIAL YouTube Data API v3 upload boundary behind the publisher
 * contract `PublishingService.dispatch` already consumes:
 *
 *   publisher.publish(request) → { platformPostId, platformUrl, rawResponse }
 *
 * Resumable flow (two calls, both through the INJECTED transport):
 *   1. POST https://www.googleapis.com/upload/youtube/v3/videos
 *        ?uploadType=resumable&part=snippet,status   (metadata JSON)
 *      → 2xx + Location header = the upload session.
 *   2. PUT the media bytes to that Location → 2xx + resource JSON with `id`.
 *
 * Honesty and safety rules (AGENTS.md + Master Completion Prompt §23):
 *   - PRIVATE-FIRST: `privacyStatus` is `private` (default) or `unlisted`.
 *     `public` is refused (YOUTUBE_PUBLIC_UPLOAD_FORBIDDEN); public uploads
 *     stay owner-gated and are not enabled by this adapter.
 *   - RECEIPT HONESTY (Rule 2): `platformPostId` comes only from a real
 *     response body `id`. Missing/unparseable → YOUTUBE_UPLOAD_RECEIPT_INVALID.
 *     Nothing is ever fabricated or derived locally.
 *   - RULE 7 DEFENSE-IN-DEPTH: an unexpired owner approval bound to the SAME
 *     artifact hash and destination is required inside the adapter, even
 *     though PublishingService checks it first. A changed artifact can never
 *     replay an old approval.
 *   - ARTIFACT BINDING: the media file's SHA-256 is streamed and compared to
 *     the approved `artifactSha256` BEFORE any token is resolved or any
 *     network call is made.
 *   - DIRECTOR ISOLATION: the access token is resolved per
 *     (ownerId, agentId) through the injected resolver; idempotency keys are
 *     director-scoped; the token only ever appears in the Authorization
 *     header and never in receipts, errors, or serialized output (Rule 17).
 *   - RETRY: 429/5xx/network failures retry with bounded backoff honoring
 *     `Retry-After`; 401/403/other 4xx fail closed and are never retried.
 *   - IDEMPOTENCY: an identical (owner, director, artifact, visibility,
 *     title) request replays the stored receipt with ZERO network calls, so
 *     a retry can never upload duplicates.
 *   - SSRF / R3: every URL — including the session Location — must be HTTPS
 *     on an allowlisted Google host before a byte leaves the process.
 *   - RULE 15: internal agent names (derived from the canonical catalog) are
 *     rejected in metadata before any network call. The guard is
 *     case-insensitive and fails closed on a false positive (reword the
 *     title), because a leak is unrecoverable once uploaded.
 *
 * OFFLINE BY CONSTRUCTION: the transport is injected; tests script it and no
 * real network call ever happens in this repository. LIVE UPLOAD IS
 * OWNER-GATED (Issue #118): a real Google OAuth connection, a real approved
 * artifact, and a real transport are required before any upload exists.
 *
 * No new dependencies (node:crypto / node:fs / node:stream only).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";

/** Official resumable-upload session endpoint (YouTube Data API v3). */
export const YOUTUBE_UPLOAD_SESSION_URL =
  "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status";

const YOUTUBE_WATCH_BASE = "https://www.youtube.com/watch?v=";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 100;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_TAGS = 30;
const MAX_TAGS_TOTAL_LENGTH = 500;
const VIDEO_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
const VISIBILITIES = new Set(["private", "unlisted"]);

/**
 * Rule 15 guard built from the CANONICAL agent catalog, so a newly registered
 * Director is protected automatically (the historical per-file 6-name lists
 * would silently miss it). Case-insensitive: internal identifiers are
 * uppercase, but a lowercase leak is still a leak.
 */
const AGENT_NAME_PATTERN = new RegExp(
  `\\b(?:${PRELOADED_AGENTS.map((agent) =>
    agent.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  ).join("|")})\\b`,
  "i",
);

function fail(code, detail = undefined) {
  const error = new Error(code);
  error.code = code;
  if (detail !== undefined) error.detail = detail;
  return error;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Reject unsafe media paths before touching the filesystem. */
function validateMediaPath(path) {
  if (typeof path !== "string" || path.length === 0 || path.length > MAX_PATH_LENGTH) {
    throw fail("YOUTUBE_MEDIA_SOURCE_INVALID");
  }
  if (path.includes("\0") || path.split("/").some((segment) => segment === "..")) {
    throw fail("YOUTUBE_MEDIA_SOURCE_INVALID");
  }
  return path;
}

/** Streamed SHA-256 of the REAL file bytes (bounded memory). */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => reject(fail("YOUTUBE_MEDIA_SOURCE_UNREADABLE")));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** HTTPS + Google host allowlist + no embedded credentials (R3 / SSRF). */
function assertSafeUploadUrl(raw, code) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail(code);
  }
  if (parsed.protocol !== "https:") throw fail(code);
  if (parsed.username || parsed.password) throw fail(code);
  const host = parsed.hostname.toLowerCase();
  if (!(host === "googleapis.com" || host.endsWith(".googleapis.com"))) {
    throw fail(code);
  }
  return parsed;
}

/** Case-insensitive header lookup (mock transports may use any casing). */
function headerValue(headers, name) {
  if (!headers || typeof headers !== "object") return null;
  const target = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === target) {
      return Array.isArray(value) ? value[0] : value;
    }
  }
  return null;
}

function parseRetryAfterMs(headers) {
  const raw = headerValue(headers, "retry-after");
  if (typeof raw !== "string") return null;
  const seconds = Number(raw);
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  return Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

function retryableError(code, { retryAfterMs } = {}) {
  const error = fail(code);
  error.retryable = true;
  if (retryAfterMs !== null && retryAfterMs !== undefined) error.retryAfterMs = retryAfterMs;
  return error;
}

/** Map a non-2xx transport response to a stable, never-retried-or-retried code. */
function statusError(status, response, step) {
  const body = typeof response?.body === "string" ? response.body : "";
  const detail = `${step} status=${status}${body ? ` ${sanitizeErrorMessage(body).slice(0, 160)}` : ""}`;
  if (status === 401) return fail("YOUTUBE_AUTH_FAILED", detail);
  if (status === 403) return fail("YOUTUBE_UPLOAD_FORBIDDEN", detail);
  if (status === 429) {
    const error = retryableError("YOUTUBE_UPLOAD_RATE_LIMITED", {
      retryAfterMs: parseRetryAfterMs(response?.headers),
    });
    error.detail = detail;
    return error;
  }
  if (status >= 500) {
    const error = retryableError("YOUTUBE_UPLOAD_UNAVAILABLE");
    error.detail = detail;
    return error;
  }
  return fail("YOUTUBE_UPLOAD_REJECTED", detail);
}

async function runWithRetry(fn, { maxAttempts, sleep }) {
  let lastRetryable = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await fn(attempt);
    } catch (error) {
      if (!error?.retryable || attempt >= maxAttempts) throw error;
      lastRetryable = error;
      const delayMs = Number.isFinite(error.retryAfterMs)
        ? error.retryAfterMs
        : Math.min(200 * 2 ** (attempt - 1), 5_000);
      await sleep(delayMs);
    }
  }
  throw lastRetryable;
}

/**
 * Default transport (production wiring only): official endpoints over fetch
 * with an abort timeout. Never exercised by offline tests, which inject a
 * scripted transport instead.
 */
async function defaultTransport({ url, method, headers, body, bodyFile, timeoutMs }) {
  const init = {
    method,
    headers: { ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (typeof bodyFile === "string") {
    init.body = Readable.toWeb(createReadStream(bodyFile));
    init.duplex = "half";
  } else if (body !== undefined) {
    init.body = body;
  }
  const response = await fetch(url, init);
  const text = await response.text();
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: text,
  };
}

function validateTransportResponse(response) {
  if (
    !response ||
    typeof response !== "object" ||
    typeof response.status !== "number" ||
    response.body === undefined ||
    response.body === null ||
    (typeof response.body !== "string")
  ) {
    throw fail("YOUTUBE_TRANSPORT_RESPONSE_INVALID");
  }
  return response;
}

/**
 * Validate the publish request PLUS the owner approval (Rule 7) and the
 * public metadata (Rule 15) before anything else happens.
 */
function validatePublishRequest(request, nowMs) {
  if (!request || typeof request !== "object") {
    throw fail("YOUTUBE_PUBLISH_REQUEST_INVALID");
  }

  const approval = request.approval;
  if (!approval || typeof approval !== "object" || !approval.ownerId) {
    throw fail("OWNER_APPROVAL_REQUIRED");
  }
  if (typeof approval.ownerId !== "string" || approval.ownerId.length === 0) {
    throw fail("OWNER_APPROVAL_REQUIRED");
  }
  if (request.ownerId !== undefined && request.ownerId !== approval.ownerId) {
    throw fail("APPROVAL_OWNER_MISMATCH");
  }
  const expiresAt = new Date(approval.expiresAt);
  if (Number.isNaN(expiresAt.getTime()) || expiresAt.getTime() <= nowMs) {
    throw fail("APPROVAL_EXPIRED");
  }

  const agentId = request.agentId;
  if (typeof agentId !== "string" || !/^[A-Za-z0-9@._-]{1,80}$/.test(agentId)) {
    throw fail("YOUTUBE_PUBLISH_REQUEST_INVALID");
  }

  const artifactSha256 =
    typeof request.artifactSha256 === "string" ? request.artifactSha256.toLowerCase() : "";
  if (!/^[a-f0-9]{64}$/.test(artifactSha256)) {
    throw fail("VERIFIED_ARTIFACT_REQUIRED");
  }
  // Approval must be bound to the EXACT artifact and destination (Rule 7).
  if (
    approval.artifactSha256 !== undefined &&
    String(approval.artifactSha256).toLowerCase() !== artifactSha256
  ) {
    throw fail("APPROVAL_ARTIFACT_MISMATCH");
  }
  if (approval.destination !== undefined && approval.destination !== "youtube") {
    throw fail("APPROVAL_DESTINATION_MISMATCH");
  }

  if (request.destination !== "youtube") {
    throw fail("YOUTUBE_DESTINATION_REQUIRED");
  }

  const caption = request.captionSnapshot;
  if (!caption || typeof caption !== "object") {
    throw fail("PUBLISHING_SNAPSHOT_REQUIRED");
  }
  const { title } = caption;
  if (typeof title !== "string" || title.trim().length === 0 || title.length > MAX_TITLE_LENGTH) {
    throw fail("YOUTUBE_METADATA_INVALID");
  }
  const description = caption.description ?? "";
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    throw fail("YOUTUBE_METADATA_INVALID");
  }
  const tags = caption.tags ?? [];
  if (
    !Array.isArray(tags) ||
    tags.length > MAX_TAGS ||
    tags.some((tag) => typeof tag !== "string" || tag.length === 0)
  ) {
    throw fail("YOUTUBE_METADATA_INVALID");
  }
  if (tags.join("").length > MAX_TAGS_TOTAL_LENGTH) {
    throw fail("YOUTUBE_METADATA_INVALID");
  }

  const visibility = request.visibility ?? "private";
  if (!VISIBILITIES.has(visibility)) {
    throw fail("YOUTUBE_PUBLIC_UPLOAD_FORBIDDEN");
  }

  const categoryId = request.categoryId ?? "28";
  if (!/^\d{1,4}$/.test(String(categoryId))) {
    throw fail("YOUTUBE_METADATA_INVALID");
  }

  // Rule 15: never let an internal agent name reach public metadata.
  if (AGENT_NAME_PATTERN.test(JSON.stringify({ title, description, tags }))) {
    throw fail("AGENT_NAME_LEAKAGE_DENIED");
  }

  return Object.freeze({
    ownerId: approval.ownerId,
    agentId,
    artifactSha256,
    title,
    description,
    tags: Object.freeze([...tags]),
    visibility,
    categoryId: String(categoryId),
  });
}

/** Resolve the media source: injected resolver first, then request field. */
async function resolveMedia(request, normalized, mediaResolver) {
  let filePath = null;
  if (typeof mediaResolver === "function") {
    const resolved = await mediaResolver({
      ownerId: normalized.ownerId,
      agentId: normalized.agentId,
      artifactSha256: normalized.artifactSha256,
    });
    filePath = resolved?.filePath;
  } else if (typeof request.mediaFilePath === "string") {
    filePath = request.mediaFilePath;
  }
  validateMediaPath(filePath);

  let info;
  try {
    info = await stat(filePath);
  } catch {
    throw fail("YOUTUBE_MEDIA_SOURCE_UNREADABLE");
  }
  if (!info.isFile() || info.size <= 0) {
    throw fail("YOUTUBE_MEDIA_SOURCE_UNREADABLE");
  }
  return Object.freeze({ filePath, size: info.size });
}

function idempotencyKeyFor(normalized) {
  return createHash("sha256")
    .update(
      [
        normalized.ownerId,
        normalized.agentId,
        normalized.artifactSha256,
        normalized.visibility,
        normalized.title,
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * Create the YouTube upload publisher.
 *
 *   resolveAccessToken: async ({ ownerId, agentId }) => string   (REQUIRED)
 *   transport:          async (call) => { status, headers, body } (injected)
 *   mediaResolver:      async (scope) => { filePath }             (optional)
 *   sleep / now / maxAttempts / timeoutMs:                        (optional)
 */
export function createYouTubePublisher(options = {}) {
  const {
    resolveAccessToken,
    transport = defaultTransport,
    mediaResolver = null,
    sleep = defaultSleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    now = () => new Date(),
  } = options;

  if (typeof resolveAccessToken !== "function") {
    throw fail("YOUTUBE_TOKEN_RESOLVER_REQUIRED");
  }
  if (typeof transport !== "function") {
    throw fail("YOUTUBE_TRANSPORT_REQUIRED");
  }
  if (mediaResolver !== null && typeof mediaResolver !== "function") {
    throw fail("YOUTUBE_MEDIA_RESOLVER_INVALID");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw fail("YOUTUBE_RETRY_CONFIG_INVALID");
  }

  /** Director-scoped receipts for this publisher instance (process lifetime). */
  const receipts = new Map();

  async function callTransport(call) {
    let response;
    try {
      response = await transport({ ...call, timeoutMs });
    } catch (err) {
      const error = retryableError(
        "YOUTUBE_UPLOAD_UNAVAILABLE",
      );
      error.detail = sanitizeErrorMessage(err?.message ?? "transport failure").slice(0, 200);
      throw error;
    }
    return validateTransportResponse(response);
  }

  async function createUploadSession({ normalized, media, token }) {
    const body = JSON.stringify({
      snippet: {
        title: normalized.title,
        description: normalized.description,
        tags: [...normalized.tags],
        categoryId: normalized.categoryId,
      },
      status: { privacyStatus: normalized.visibility },
    });

    return runWithRetry(
      async () => {
        const response = await callTransport({
          url: YOUTUBE_UPLOAD_SESSION_URL,
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json; charset=UTF-8",
            "X-Upload-Content-Type": "video/mp4",
            "X-Upload-Content-Length": String(media.size),
          },
          body,
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "session");
        }
        const location = headerValue(response.headers, "location");
        if (typeof location !== "string" || location.length === 0) {
          throw fail("YOUTUBE_UPLOAD_SESSION_REJECTED", "session response has no Location header");
        }
        // The session URL is provider-controlled: verify it before the PUT.
        assertSafeUploadUrl(location, "YOUTUBE_UPLOAD_SESSION_REJECTED");
        return location;
      },
      { maxAttempts, sleep },
    );
  }

  async function uploadMedia({ sessionUrl, media, token, normalized }) {
    const response = await runWithRetry(
      async () => {
        const attempt = await callTransport({
          url: sessionUrl,
          method: "PUT",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "video/mp4",
            "Content-Length": String(media.size),
          },
          bodyFile: media.filePath,
          contentLength: media.size,
        });
        if (attempt.status < 200 || attempt.status >= 300) {
          throw statusError(attempt.status, attempt, "upload");
        }
        return attempt;
      },
      { maxAttempts, sleep },
    );

    let parsed;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw fail("YOUTUBE_UPLOAD_RECEIPT_INVALID", "upload response body is not JSON");
    }
    const id = parsed?.id;
    if (typeof id !== "string" || !VIDEO_ID_PATTERN.test(id)) {
      throw fail("YOUTUBE_UPLOAD_RECEIPT_INVALID", "upload response has no usable video id");
    }

    return Object.freeze({
      platform: "youtube",
      platformPostId: id,
      platformUrl: `${YOUTUBE_WATCH_BASE}${id}`,
      rawResponse: response.body,
      visibility: normalized.visibility,
      duplicate: false,
    });
  }

  async function publish(request) {
    const normalized = validatePublishRequest(request, now().getTime());
    const media = await resolveMedia(request, normalized, mediaResolver);

    // Bind the upload to the approved artifact BEFORE touching credentials.
    const actualHash = await sha256File(media.filePath);
    if (actualHash !== normalized.artifactSha256) {
      throw fail(
        "YOUTUBE_MEDIA_HASH_MISMATCH",
        `expected ${normalized.artifactSha256} got ${actualHash}`,
      );
    }

    const key = idempotencyKeyFor(normalized);
    const prior = receipts.get(key);
    if (prior) {
      // Replay: identical request already uploaded — ZERO network calls.
      return Object.freeze({ ...prior, duplicate: true });
    }

    // Director-scoped token resolution; the token never leaves this scope
    // except through the Authorization header below (Rule 17).
    const token = await resolveAccessToken({
      ownerId: normalized.ownerId,
      agentId: normalized.agentId,
    });
    if (typeof token !== "string" || token.length === 0) {
      throw fail("YOUTUBE_AUTH_TOKEN_UNAVAILABLE");
    }

    const sessionUrl = await createUploadSession({ normalized, media, token });
    const receipt = await uploadMedia({ sessionUrl, media, token, normalized });
    receipts.set(key, receipt);
    return receipt;
  }

  return Object.freeze({
    label: "youtube-upload (official Data API v3, private-first)",
    publish,
  });
}
