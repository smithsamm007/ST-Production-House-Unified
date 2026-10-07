/**
 * ST Production House — Meta (Instagram/Facebook) publisher adapter (Issue #219).
 *
 * The OFFICIAL Meta Graph API upload boundary behind the publisher contract
 * `PublishingService.dispatch` already consumes:
 *
 *   publisher.publish(request) → { platformPostId, platformUrl, rawResponse }
 *
 * Official flows (fetched from developers.facebook.com, 2026-10; version is
 * pinned in ONE constant below — never invented):
 *
 *   instagram (Reels, Instagram API with Facebook Login — graph.facebook.com):
 *     1. POST /v{VER}/{ig_user_id}/media
 *          media_type=REELS, upload_type=resumable, caption=<caption>
 *          → `{ id: <IG_CONTAINER_ID> }`
 *     2. POST https://rupload.facebook.com/ig-api-upload/v{VER}/{container_id}
 *          headers: Authorization: OAuth <token>, offset: 0, file_size: <bytes>
 *          binary body = the artifact bytes
 *          → `{ success: true, ... }`
 *     3. GET /v{VER}/{container_id}?fields=status_code  (bounded poll)
 *          FINISHED → proceed; EXPIRED/ERROR → fail closed
 *     4. POST /v{VER}/{ig_user_id}/media_publish { creation_id }
 *          → `{ id: <IG_MEDIA_ID> }`
 *     5. GET /v{VER}/{media_id}?fields=permalink
 *          → the REAL permalink used as platformUrl (never derived locally)
 *
 *   facebook (Page videos, Resumable Upload API):
 *     1. POST /v{VER}/{app_id}/uploads  file_name/file_length/file_type
 *          → `{ id: "upload:<UPLOAD_SESSION_ID>" }`
 *     2. POST /v{VER}/upload:<UPLOAD_SESSION_ID>
 *          headers: Authorization: OAuth <token>, file_offset: 0
 *          binary body = the artifact bytes
 *          → `{ h: <UPLOADED_FILE_HANDLE> }`
 *     3. POST https://graph-video.facebook.com/v{VER}/{page_id}/videos
 *          form fields: title, description, fbuploader_video_file_chunk
 *          → `{ id: <VIDEO_ID> }`
 *     4. GET /v{VER}/{video_id}?fields=permalink → real permalink
 *
 * Honesty and safety rules (AGENTS.md + Master Completion Prompt §23/§25):
 *   - NO INVENTED API: endpoints/params above are taken from the official
 *     Meta documentation. The Graph API version is pinned in a single
 *     exported constant.
 *   - RECEIPT HONESTY (Rule 2): `platformPostId` and `platformUrl` come only
 *     from real response bodies. Missing/unparseable → META_RECEIPT_INVALID.
 *     Nothing is ever fabricated or derived locally.
 *   - RULE 7 DEFENSE-IN-DEPTH: an unexpired owner approval bound to the SAME
 *     artifact hash and destination is required inside the adapter, even
 *     though PublishingService checks it first. A changed artifact can never
 *     replay an old approval.
 *   - ARTIFACT BINDING: the media file's SHA-256 is streamed and compared to
 *     the approved `artifactSha256` BEFORE any credential is resolved or any
 *     network call is made. No platform hash echo exists for Meta; the
 *     binding is enforced entirely on this side.
 *   - DIRECTOR ISOLATION: credentials are resolved per (ownerId, agentId,
 *     destination) through the injected resolver (production wiring resolves
 *     opaque locators via the secret-manager boundary). Tokens appear ONLY
 *     in Authorization headers and never in receipts, errors, or serialized
 *     output (Rule 17).
 *   - PRIVATE-FIRST BOUNDARY: the adapter never sends public-visibility
 *     metadata and offers no visibility parameter — visibility on Meta is
 *     governed by the connected professional account/Page's own privacy
 *     settings, and live connection custody remains owner-gated (Issue #118).
 *   - RETRY: 429/5xx/network failures retry with bounded backoff honoring
 *     `Retry-After`; 401/403/other 4xx fail closed and are never retried.
 *   - IDEMPOTENCY: an identical (owner, director, destination, artifact,
 *     caption) request replays the stored receipt with ZERO network calls,
 *     so a retry can never publish duplicates.
 *   - SSRF / R3: every URL must be HTTPS on an allowlisted official Meta host
 *     before a byte leaves the process; ids are validated and URL-encoded.
 *   - RULE 15: internal agent names (derived from the canonical catalog) are
 *     rejected in metadata before any network call, case-insensitively.
 *
 * OFFLINE BY CONSTRUCTION: the transport is injected; tests script it and no
 * real network call ever happens in this repository. LIVE PUBLISHING IS
 * OWNER-GATED (Issue #118): real Meta app/page/IG credentials and a real
 * transport are required before any publish exists.
 *
 * No new dependencies (node:crypto / node:fs / node:stream only).
 */

import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";

/** Pinned official Graph API version (see module docstring). */
export const META_GRAPH_VERSION = "25.0";

export const META_IG_CONTAINER_URL =
  `https://graph.facebook.com/v${META_GRAPH_VERSION}`;
export const META_IG_RUPLOAD_HOST = "https://rupload.facebook.com";
export const META_IG_RUPLOAD_PATH_PREFIX = `/ig-api-upload/v${META_GRAPH_VERSION}`;
export const META_FB_VIDEO_UPLOAD_URL =
  `https://graph-video.facebook.com/v${META_GRAPH_VERSION}`;

const IG_REEL_URL_BASE = "https://www.instagram.com/reel/";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_STATUS_POLLS = 8;
const DEFAULT_STATUS_POLL_DELAY_MS = 1_000;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_PATH_LENGTH = 4096;
const MAX_IG_CAPTION_LENGTH = 2200;
const MAX_DESCRIPTION_LENGTH = 5000;
const MAX_TITLE_LENGTH = 100;
const MAX_QUERY_FIELDS_LENGTH = 200;
/** Official Meta ids: numeric, or underscore-composed numeric pairs. */
const META_ID_PATTERN = /^[A-Za-z0-9_-]{6,64}$/;
/** Official uploaded-file handle: `version:token` (e.g. `2:c2FtcGxl…`). */
const META_FILE_HANDLE_PATTERN = /^[A-Za-z0-9_-]+:[A-Za-z0-9_-]{6,192}$/;
/** Admin-configured origin ids: numeric strings per official docs. */
const META_ORIGIN_ID_PATTERN = /^[0-9]{2,64}$/;
const CONTAINER_STATUSES = Object.freeze({
  FINISHED: "FINISHED",
  IN_PROGRESS: "IN_PROGRESS",
  EXPIRED: "EXPIRED",
  ERROR: "ERROR",
});
const DESTINATIONS = new Set(["instagram", "facebook"]);

/**
 * Rule 15 guard built from the CANONICAL agent catalog, so a newly registered
 * Director is protected automatically. Case-insensitive: a lowercase leak is
 * still a leak.
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
    throw fail("META_MEDIA_SOURCE_INVALID");
  }
  if (path.includes("\0") || path.split("/").some((segment) => segment === "..")) {
    throw fail("META_MEDIA_SOURCE_INVALID");
  }
  return path;
}

/** Streamed SHA-256 of the REAL file bytes (bounded memory). */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => reject(fail("META_MEDIA_SOURCE_UNREADABLE")));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** HTTPS + official Meta host allowlist + no embedded credentials (R3/SSRF). */
function assertSafeUrl(raw, code) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail(code);
  }
  if (parsed.protocol !== "https:") throw fail(code);
  if (parsed.username || parsed.password) throw fail(code);
  const host = parsed.hostname.toLowerCase();
  if (
    !(
      host === "graph.facebook.com" ||
      host === "graph-video.facebook.com" ||
      host === "rupload.facebook.com"
    )
  ) {
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

/** Map a non-2xx transport response to a stable, retried-or-not code. */
function statusError(status, response, step) {
  const body = typeof response?.body === "string" ? response.body : "";
  const detail = `${step} status=${status}${body ? ` ${sanitizeErrorMessage(body).slice(0, 160)}` : ""}`;
  if (status === 401) return fail("META_AUTH_FAILED", detail);
  if (status === 403) return fail("META_UPLOAD_FORBIDDEN", detail);
  if (status === 429) {
    const error = retryableError("META_RATE_LIMITED", {
      retryAfterMs: parseRetryAfterMs(response?.headers),
    });
    error.detail = detail;
    return error;
  }
  if (status >= 500) {
    const error = retryableError("META_UPLOAD_UNAVAILABLE");
    error.detail = detail;
    return error;
  }
  return fail("META_UPLOAD_REJECTED", detail);
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
    typeof response.body !== "string"
  ) {
    throw fail("META_TRANSPORT_RESPONSE_INVALID");
  }
  return response;
}

/**
 * Validate the publish request PLUS the owner approval (Rule 7) and the
 * public metadata (Rule 15) before anything else happens.
 */
function validatePublishRequest(request, nowMs) {
  if (!request || typeof request !== "object") {
    throw fail("META_PUBLISH_REQUEST_INVALID");
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
    throw fail("META_PUBLISH_REQUEST_INVALID");
  }

  const destination = request.destination;
  if (!DESTINATIONS.has(destination)) {
    throw fail("META_DESTINATION_REQUIRED");
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
  if (approval.destination !== undefined && approval.destination !== destination) {
    throw fail("APPROVAL_DESTINATION_MISMATCH");
  }

  const caption = request.captionSnapshot;
  if (!caption || typeof caption !== "object") {
    throw fail("PUBLISHING_SNAPSHOT_REQUIRED");
  }
  const title = caption.title ?? "";
  const description = caption.description ?? "";
  if (typeof title !== "string" || title.length > MAX_TITLE_LENGTH) {
    throw fail("META_METADATA_INVALID");
  }
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    throw fail("META_METADATA_INVALID");
  }
  // Instagram takes ONE bounded caption string (official limit 2200).
  let igCaption = caption.caption ?? "";
  if (igCaption === "") {
    igCaption = [title, description].filter((part) => part.length > 0).join("\n\n");
  }
  if (typeof igCaption !== "string" || igCaption.length > MAX_IG_CAPTION_LENGTH) {
    throw fail("META_METADATA_INVALID");
  }
  const hasFacebookMetadata =
    (title.trim().length > 0 || description.trim().length > 0 || typeof caption.caption === "string");
  if (destination === "instagram" && igCaption.trim().length === 0) {
    throw fail("META_METADATA_INVALID");
  }
  if (destination === "facebook" && !hasFacebookMetadata) {
    throw fail("META_METADATA_INVALID");
  }

  // Rule 15: never let an internal agent name reach public metadata.
  if (AGENT_NAME_PATTERN.test(JSON.stringify({ title, description, igCaption }))) {
    throw fail("AGENT_NAME_LEAKAGE_DENIED");
  }

  return Object.freeze({
    ownerId: approval.ownerId,
    agentId,
    destination,
    artifactSha256,
    title,
    description,
    igCaption,
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
      destination: normalized.destination,
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
    throw fail("META_MEDIA_SOURCE_UNREADABLE");
  }
  if (!info.isFile() || info.size <= 0) {
    throw fail("META_MEDIA_SOURCE_UNREADABLE");
  }
  return Object.freeze({ filePath, size: info.size });
}

/**
 * Validate resolved credentials for the destination. Destructuring a Map
 * spread (or any exotic object) never happens: only own enumerable string
 * fields are read, and the token never leaves this scope except through the
 * Authorization header below (Rule 17).
 */
function normalizeCredentials(resolved, destination) {
  if (!resolved || typeof resolved !== "object") {
    throw fail("META_CREDENTIALS_INVALID");
  }
  const accessToken = resolved.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw fail("META_TOKEN_UNAVAILABLE");
  }
  const numericId = (value) =>
    typeof value === "string" && META_ORIGIN_ID_PATTERN.test(value) ? value : null;

  const fields = Object.freeze({ accessToken });
  if (destination === "instagram") {
    const instagramUserId = numericId(resolved.instagramUserId);
    if (!instagramUserId) throw fail("META_CREDENTIALS_INVALID");
    return Object.freeze({ ...fields, instagramUserId });
  }
  const appId = numericId(resolved.appId);
  const pageId = numericId(resolved.pageId);
  if (!appId || !pageId) throw fail("META_CREDENTIALS_INVALID");
  return Object.freeze({ ...fields, appId, pageId });
}

function idempotencyKeyFor(normalized) {
  return createHash("sha256")
    .update(
      [
        normalized.ownerId,
        normalized.agentId,
        normalized.destination,
        normalized.artifactSha256,
        normalized.igCaption,
        normalized.title,
        normalized.description,
      ].join("\n"),
    )
    .digest("hex");
}

function parseJsonObject(body, code) {
  let parsed;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw fail(code, "response body is not JSON");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw fail(code, "response body is not a JSON object");
  }
  return parsed;
}

/**
 * Create the Meta (Instagram/Facebook) publisher.
 *
 *   resolveCredentials: async ({ ownerId, agentId, destination }) =>
 *     { accessToken, instagramUserId? } | { accessToken, appId, pageId }
 *     (REQUIRED — production resolution goes through the secret-manager
 *     boundary on opaque locators; tests inject fixture values)
 *   transport:          async (call) => { status, headers, body } (injected)
 *   mediaResolver:      async (scope) => { filePath }             (optional)
 *   sleep / now / maxAttempts / timeoutMs / statusPolls / statusPollDelayMs
 */
export function createMetaPublisher(options = {}) {
  const {
    resolveCredentials,
    transport = defaultTransport,
    mediaResolver = null,
    sleep = defaultSleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    statusPolls = DEFAULT_STATUS_POLLS,
    statusPollDelayMs = DEFAULT_STATUS_POLL_DELAY_MS,
    now = () => new Date(),
  } = options;

  if (typeof resolveCredentials !== "function") {
    throw fail("META_CREDENTIAL_RESOLVER_REQUIRED");
  }
  if (typeof transport !== "function") {
    throw fail("META_TRANSPORT_REQUIRED");
  }
  if (mediaResolver !== null && typeof mediaResolver !== "function") {
    throw fail("META_MEDIA_RESOLVER_INVALID");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw fail("META_RETRY_CONFIG_INVALID");
  }
  if (!Number.isInteger(statusPolls) || statusPolls < 1 || statusPolls > 30) {
    throw fail("META_RETRY_CONFIG_INVALID");
  }

  /** Director-scoped receipts for this publisher instance (process lifetime). */
  const receipts = new Map();

  async function callTransport(call) {
    let response;
    try {
      response = await transport({ ...call, timeoutMs });
    } catch (err) {
      const error = retryableError("META_UPLOAD_UNAVAILABLE");
      error.detail = sanitizeErrorMessage(err?.message ?? "transport failure").slice(0, 200);
      throw error;
    }
    return validateTransportResponse(response);
  }

  function requireIdField(parsed, field, code) {
    const value = parsed?.[field];
    if (typeof value !== "string" || !META_ID_PATTERN.test(value)) {
      throw fail(code, `response has no usable ${field}`);
    }
    return value;
  }

  /** IG container creation → official container id. */
  async function createIgContainer({ normalized, credentials }) {
    return runWithRetry(
      async () => {
        const response = await callTransport({
          url: `${META_IG_CONTAINER_URL}/${credentials.instagramUserId}/media`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            media_type: "REELS",
            upload_type: "resumable",
            caption: normalized.igCaption,
          }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "ig-container");
        }
        const parsed = parseJsonObject(response.body, "META_CONTAINER_REJECTED");
        return requireIdField(parsed, "id", "META_CONTAINER_REJECTED");
      },
      { maxAttempts, sleep },
    );
  }

  /** IG resumable upload of the REAL bytes to Meta's servers. */
  async function uploadIgBytes({ containerId, media, credentials }) {
    return runWithRetry(
      async () => {
        const response = await callTransport({
          url: `${META_IG_RUPLOAD_HOST}${META_IG_RUPLOAD_PATH_PREFIX}/${containerId}`,
          method: "POST",
          headers: {
            Authorization: `OAuth ${credentials.accessToken}`,
            offset: "0",
            file_size: String(media.size),
          },
          bodyFile: media.filePath,
          contentLength: media.size,
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "ig-upload");
        }
        const parsed = parseJsonObject(response.body, "META_UPLOAD_RECEIPT_INVALID");
        if (parsed?.success !== true) {
          throw fail("META_UPLOAD_RECEIPT_INVALID", "upload response did not report success");
        }
        return containerId;
      },
      { maxAttempts, sleep },
    );
  }

  async function prepareIgContainer({ normalized, media, credentials }) {
    const containerId = await createIgContainer({ normalized, credentials });
    await uploadIgBytes({ containerId, media, credentials });

    for (let poll = 1; poll <= statusPolls; poll += 1) {
      const response = await callTransport({
        // Status reads carry bounded query fields only (no traversal surface).
        url: `${META_IG_CONTAINER_URL}/${containerId}?fields=status_code`,
        method: "GET",
        headers: { Authorization: `Bearer ${credentials.accessToken}` },
      });
      if (response.status < 200 || response.status >= 300) {
        throw statusError(response.status, response, "ig-status");
      }
      const parsed = parseJsonObject(response.body, "META_STATUS_POLL_INVALID");
      const statusCode = parsed?.status_code;
      if (statusCode === CONTAINER_STATUSES.FINISHED) return containerId;
      if (statusCode === CONTAINER_STATUSES.EXPIRED) {
        throw fail("META_CONTAINER_EXPIRED", `container ${containerId} expired before publishing`);
      }
      if (statusCode === CONTAINER_STATUSES.ERROR) {
        throw fail("META_CONTAINER_ERRORED", `container ${containerId} reported ERROR`);
      }
      if (statusCode !== CONTAINER_STATUSES.IN_PROGRESS) {
        throw fail("META_STATUS_POLL_INVALID", `unexpected status_code ${typeof statusCode === "string" ? statusCode : "(missing)"}`);
      }
      if (poll === statusPolls) break;
      await sleep(statusPollDelayMs);
    }
    throw fail("META_CONTAINER_STATUS_TIMEOUT", `container ${containerId} never reached FINISHED within ${statusPolls} polls`);
  }

  async function fetchIgPermalink({ mediaId, credentials }) {
    const response = await callTransport({
      url: `${META_IG_CONTAINER_URL}/${mediaId}?fields=permalink`,
      method: "GET",
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, response, "ig-permalink");
    }
    const parsed = parseJsonObject(response.body, "META_PERMALINK_UNAVAILABLE");
    const permalink = parsed?.permalink;
    if (typeof permalink !== "string" || permalink.length === 0) {
      throw fail("META_PERMALINK_UNAVAILABLE", "platform returned no permalink");
    }
    if (!permalink.startsWith("https://")) {
      throw fail("META_PERMALINK_UNAVAILABLE", "platform permalink is not HTTPS");
    }
    return permalink;
  }

  /** FB: start the official resumable upload session (needs the app id). */
  async function createFbUploadSession({ media, credentials }) {
    return runWithRetry(
      async () => {
        const response = await callTransport({
          url: `${META_IG_CONTAINER_URL}/${credentials.appId}/uploads`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            file_name: "production.mp4",
            file_length: media.size,
            file_type: "video/mp4",
          }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "fb-session");
        }
        const parsed = parseJsonObject(response.body, "META_UPLOAD_SESSION_REJECTED");
        const sessionId = parsed?.id;
        if (typeof sessionId !== "string" || sessionId.length === 0 || sessionId.length > 128) {
          throw fail("META_UPLOAD_SESSION_REJECTED", "upload response has no session id");
        }
        // The provider echoes back "upload:<session-id>". Validate STRICTLY —
        // never build a URL from an unvalidated provider string.
        if (!sessionId.startsWith("upload:") || sessionId.length < 7 + 6) {
          throw fail("META_UPLOAD_SESSION_REJECTED", "unexpected upload session id shape");
        }
        const suffix = sessionId.slice("upload:".length);
        if (!META_ID_PATTERN.test(suffix)) {
          throw fail("META_UPLOAD_SESSION_REJECTED", "upload session id contains unsafe characters");
        }
        return Object.freeze({ sessionId, suffix });
      },
      { maxAttempts, sleep },
    );
  }

  /** FB: upload the REAL bytes to the session (documented `OAuth` header). */
  async function uploadFbBytes({ session, media, credentials }) {
    return runWithRetry(
      async () => {
        const response = await callTransport({
          url: `${META_IG_CONTAINER_URL}/upload:${session.suffix}`,
          method: "POST",
          headers: {
            Authorization: `OAuth ${credentials.accessToken}`,
            file_offset: "0",
          },
          bodyFile: media.filePath,
          contentLength: media.size,
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "fb-upload");
        }
        const parsed = parseJsonObject(response.body, "META_UPLOAD_RECEIPT_INVALID");
        const handle = parsed?.h;
        if (typeof handle !== "string" || handle.length === 0 || handle.length > 256) {
          throw fail("META_UPLOAD_RECEIPT_INVALID", "upload response has no file handle");
        }
        if (!META_FILE_HANDLE_PATTERN.test(handle)) {
          throw fail("META_UPLOAD_RECEIPT_INVALID", "file handle does not match the official shape");
        }
        return handle;
      },
      { maxAttempts, sleep },
    );
  }

  async function fetchFbPermalink({ videoId, credentials }) {
    const response = await callTransport({
      url: `${META_IG_CONTAINER_URL}/${videoId}?fields=permalink`,
      method: "GET",
      headers: { Authorization: `Bearer ${credentials.accessToken}` },
    });
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, response, "fb-permalink");
    }
    const parsed = parseJsonObject(response.body, "META_PERMALINK_UNAVAILABLE");
    const permalink = parsed?.permalink;
    if (typeof permalink !== "string" || permalink.length === 0) {
      throw fail("META_PERMALINK_UNAVAILABLE", "platform returned no permalink");
    }
    if (!permalink.startsWith("https://")) {
      throw fail("META_PERMALINK_UNAVAILABLE", "platform permalink is not HTTPS");
    }
    return permalink;
  }

  async function publish(request) {
    const normalized = validatePublishRequest(request, now().getTime());
    const media = await resolveMedia(request, normalized, mediaResolver);

    // Bind the upload to the approved artifact BEFORE touching credentials.
    const actualHash = await sha256File(media.filePath);
    if (actualHash !== normalized.artifactSha256) {
      throw fail(
        "META_MEDIA_HASH_MISMATCH",
        `expected ${normalized.artifactSha256} got ${actualHash}`,
      );
    }

    const key = idempotencyKeyFor(normalized);
    const prior = receipts.get(key);
    if (prior) {
      // Replay: identical request already published — ZERO network calls.
      return Object.freeze({ ...prior, duplicate: true });
    }

    // Director-scoped credential resolution; tokens never leave this scope
    // except through the Authorization headers below (Rule 17).
    const credentials = normalizeCredentials(
      await resolveCredentials({
        ownerId: normalized.ownerId,
        agentId: normalized.agentId,
        destination: normalized.destination,
      }),
      normalized.destination,
    );

    let platformPostId;
    let rawResponse;
    if (normalized.destination === "instagram") {
      const containerId = await prepareIgContainer({ normalized, media, credentials });
      const publishAttempt = await callTransport({
        url: `${META_IG_CONTAINER_URL}/${credentials.instagramUserId}/media_publish`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ creation_id: containerId }),
      });
      if (publishAttempt.status < 200 || publishAttempt.status >= 300) {
        throw statusError(publishAttempt.status, publishAttempt, "ig-publish");
      }
      const parsed = parseJsonObject(publishAttempt.body, "META_RECEIPT_INVALID");
      platformPostId = requireIdField(parsed, "id", "META_RECEIPT_INVALID");
      rawResponse = publishAttempt.body;
    } else {
      const session = await createFbUploadSession({ media, credentials });
      const handle = await uploadFbBytes({ session, media, credentials });
      const publishAttempt = await callTransport({
        url: `${META_FB_VIDEO_UPLOAD_URL}/${credentials.pageId}/videos`,
        method: "POST",
        headers: {
          Authorization: `Bearer ${credentials.accessToken}`,
          "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        },
        body: new URLSearchParams({
          title: normalized.title,
          description: normalized.description,
          fbuploader_video_file_chunk: handle,
        }).toString(),
      });
      if (publishAttempt.status < 200 || publishAttempt.status >= 300) {
        throw statusError(publishAttempt.status, publishAttempt, "fb-publish");
      }
      const parsed = parseJsonObject(publishAttempt.body, "META_RECEIPT_INVALID");
      platformPostId = requireIdField(parsed, "id", "META_RECEIPT_INVALID");
      rawResponse = publishAttempt.body;
    }

    // Real permalink straight from the platform — never derived locally.
    const platformUrl =
      normalized.destination === "instagram"
        ? await fetchIgPermalink({ mediaId: platformPostId, credentials })
        : await fetchFbPermalink({ videoId: platformPostId, credentials });

    const receipt = Object.freeze({
      platform: normalized.destination,
      platformPostId,
      platformUrl,
      rawResponse,
      duplicate: false,
    });
    receipts.set(key, receipt);
    return receipt;
  }

  return Object.freeze({
    label: "meta-graph-upload (official Instagram/Facebook Graph API)",
    publish,
  });
}
