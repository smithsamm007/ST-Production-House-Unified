/**
 * ST Production House — Snapchat publisher adapter (Issue #221).
 *
 * The OFFICIAL Snapchat Public Profile API upload boundary behind the
 * publisher contract `PublishingService.dispatch` already consumes:
 *
 *   publisher.publish(request) → { platformPostId, platformUrl, rawResponse }
 *
 * Official flow (fetched from developers.snap.com — Public Profile API,
 * "Profile Asset Management" + "Get Started", 2026-10; never invented):
 *
 *   1. POST {SNAP_API_BASE}/v1/public_profiles/{profile_id}/media
 *        body: { type: "VIDEO", name, key, iv }
 *        (key = base64 32-byte AES-256-CBC key, iv = base64 16-byte IV —
 *        the media MUST be encrypted client-side per official docs)
 *        → { request_id, request_status, media_id, add_path, finalize_path }
 *   2. POST {SNAP_API_BASE}{add_path}   multipart/form-data
 *        fields: action=ADD, part_number (1..35), file (encrypted chunk
 *        ≤ 32 MB)  → { request_id, request_status }
 *   3. POST {SNAP_API_BASE}{finalize_path}  multipart/form-data
 *        field: action=FINALIZE           → { request_id, request_status }
 *   4. POST {SNAP_API_BASE}/v1/public_profiles/{profile_id}/spotlights
 *        body: { media_id, description(≤160), locale }
 *        → { request_id, spotlight_id, request_status }
 *
 * Spotlight is the ONLY wired surface. Story posting is deliberately NOT
 * implemented: the official post-story response returns only a request_id —
 * no story identifier — so no honest receipt (`platformPostId` bound to a
 * real platform-issued content id) is possible for stories.
 *
 * Honesty and safety rules (AGENTS.md + Master Completion Prompt §26):
 *   - NO INVENTED API: endpoints/params above are taken from the official
 *     Snapchat documentation, and the canonical Spotlight URL base is pinned
 *     in ONE constant below.
 *   - RECEIPT HONESTY (Rule 2): `platformPostId` is ONLY the real
 *     `spotlight_id` returned by the platform's post response. `platformUrl`
 *     is the canonical Spotlight URL shape built from that real id — the
 *     same precedent as the YouTube adapter's `watch?v=` construction (Snap
 *     returns no permalink field; nothing else is ever fabricated).
 *     Missing/unparseable → SNAP_RECEIPT_INVALID.
 *   - RULE 7 DEFENSE-IN-DEPTH: an unexpired owner approval bound to the SAME
 *     artifact hash and destination is required inside the adapter, even
 *     though PublishingService checks it first. A changed artifact can never
 *     replay an old approval.
 *   - ARTIFACT BINDING: the media file's SHA-256 is streamed and compared to
 *     the approved `artifactSha256` BEFORE any credential is resolved or any
 *     network call is made.
 *   - DIRECTOR ISOLATION: credentials are resolved per (ownerId, agentId,
 *     destination) through the injected resolver; the access token appears
 *     ONLY in Authorization headers and never in receipts, errors, or
 *     serialized output (Rule 17). The ephemeral per-publish media
 *     encryption key/iv are protocol fields of the official create-media
 *     call and are likewise never logged or echoed.
 *   - PRIVATE-FIRST BOUNDARY: the adapter sends only the official Spotlight
 *     description/locale fields — no public-visibility parameter exists in
 *     the official API (Spotlight distribution is governed by Snapchat's
 *     own approval process: SUBMITTED → LIVE/REJECTED).
 *   - RETRY: 429/5xx/network failures retry with bounded backoff honoring
 *     `Retry-After`; 401/403/other 4xx fail closed and are never retried.
 *     `MEDIA_EXPIRED` and `MEDIA_POSTING_ALREADY_IN_PROGRESS` fail closed
 *     with no auto re-create — the official resolution is manual, and an
 *     automatic retry could double-publish.
 *   - IDEMPOTENCY: an identical (owner, director, destination, artifact,
 *     description, locale) request replays the stored receipt with ZERO
 *     network calls, so a retry can never publish duplicates.
 *   - SSRF / R3: every URL is HTTPS on the official `businessapi.snapchat.com`
 *     host; platform-provided `add_path`/`finalize_path` are validated as
 *     bounded relative official paths before use; ids are validated against
 *     the official shapes (UUID profile/media ids, Spotlight id alphabet).
 *   - RULE 15: internal agent names (derived from the canonical catalog) are
 *     rejected in public metadata before any network call.
 *
 * OFFLINE BY CONSTRUCTION: the transport is injected; tests script it and no
 * real network call ever happens in this repository. LIVE PUBLISHING IS
 * OWNER-GATED (Issue #118): the Public Profile API is allowlist-only, and
 * real credentials + accounts are required before any publish exists.
 *
 * No new dependencies (node:crypto / node:fs / node:stream only).
 */

import { createCipheriv, createHash, randomBytes } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { PRELOADED_AGENTS } from "../catalog/agents.js";
import { sanitizeErrorMessage } from "../credentials/credentialBroker.js";

/** Official Public Profile API base (see module docstring). */
export const SNAP_API_BASE = "https://businessapi.snapchat.com";
/** Canonical Spotlight URL base — filled ONLY with a real platform spotlight_id. */
export const SNAP_SPOTLIGHT_URL_BASE = "https://www.snapchat.com/spotlight/";

const SNAP_HOST = "businessapi.snapchat.com";
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const MAX_RETRY_AFTER_MS = 60_000;
const MAX_PATH_LENGTH = 4096;
/** Official Spotlight description constraint. */
const MAX_DESCRIPTION_LENGTH = 160;
/** Official multipart upload constraints: ≤32 MB per chunk, ≤1 GB file, parts 1..35. */
const MAX_CHUNK_BYTES = 32 * 1024 * 1024;
const MAX_FILE_BYTES = 1024 * 1024 * 1024;
const MAX_PARTS = 35;
/** Plaintext read block for bounded-memory encryption. */
const ENCRYPT_READ_BLOCK = 4 * 1024 * 1024;
/** Official profile/media ids are UUIDs. */
const SNAP_UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** Official Spotlight id alphabet/shape (e.g. "W7_EDlXWTBiXAEEniNoMPwAAY…"). */
const SNAP_SPOTLIGHT_ID_PATTERN = /^[A-Za-z0-9_-]{20,128}$/;
/** Official locale shape, e.g. "en_US". */
const SNAP_LOCALE_PATTERN = /^[a-z]{2}[_-][A-Z]{2}$/;
const DESTINATIONS = new Set(["snapchat"]);

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
    throw fail("SNAP_MEDIA_SOURCE_INVALID");
  }
  if (path.includes("\0") || path.split("/").some((segment) => segment === "..")) {
    throw fail("SNAP_MEDIA_SOURCE_INVALID");
  }
  return path;
}

/** Streamed SHA-256 of the REAL file bytes (bounded memory). */
function sha256File(path) {
  return new Promise((resolve, reject) => {
    const hash = createHash("sha256");
    const stream = createReadStream(path);
    stream.on("error", () => reject(fail("SNAP_MEDIA_SOURCE_UNREADABLE")));
    stream.on("data", (chunk) => hash.update(chunk));
    stream.on("end", () => resolve(hash.digest("hex")));
  });
}

/** HTTPS + official Snap host + no embedded credentials (R3/SSRF). */
function assertSafeUrl(raw, code) {
  let parsed;
  try {
    parsed = new URL(raw);
  } catch {
    throw fail(code);
  }
  if (parsed.protocol !== "https:") throw fail(code);
  if (parsed.username || parsed.password) throw fail(code);
  if (parsed.hostname.toLowerCase() !== SNAP_HOST) throw fail(code);
  return parsed;
}

/**
 * Platform-provided relative path (add_path/finalize_path). Officially shaped
 * like `/us/v1/public_profiles/{uuid}/media/{uuid}/multipart-upload`. Must
 * stay RELATIVE, bounded, and free of traversal/injection characters — the
 * full URL is rebuilt on the official host only.
 */
function validateSnapRelativePath(raw, code) {
  if (typeof raw !== "string" || raw.length < 2 || raw.length > 256) throw fail(code);
  if (!raw.startsWith("/")) throw fail(code);
  if (raw.includes("..") || raw.includes("//")) throw fail(code);
  if (!/^\/[A-Za-z0-9/_.-]+$/.test(raw)) throw fail(code);
  return raw;
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
  if (status === 401) return fail("SNAP_AUTH_FAILED", detail);
  if (status === 403) return fail("SNAP_UPLOAD_FORBIDDEN", detail);
  if (status === 429) {
    const error = retryableError("SNAP_RATE_LIMITED", {
      retryAfterMs: parseRetryAfterMs(response?.headers),
    });
    error.detail = detail;
    return error;
  }
  if (status >= 500) {
    const error = retryableError("SNAP_UPLOAD_UNAVAILABLE");
    error.detail = detail;
    return error;
  }
  return fail("SNAP_UPLOAD_REJECTED", detail);
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
async function defaultTransport({ url, method, headers, body, timeoutMs }) {
  assertSafeUrl(url, "SNAP_TRANSPORT_URL_INVALID");
  const init = {
    method,
    headers: { ...headers },
    signal: AbortSignal.timeout(timeoutMs),
  };
  if (body !== undefined) init.body = body;
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
    throw fail("SNAP_TRANSPORT_RESPONSE_INVALID");
  }
  return response;
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

function requireSuccessStatus(parsed, code, step) {
  if (parsed?.request_status !== "SUCCESS") {
    const officialCode = typeof parsed?.error_code === "string" ? parsed.error_code : "(none)";
    const debug = typeof parsed?.debug_message === "string"
      ? sanitizeErrorMessage(parsed.debug_message).slice(0, 160)
      : "";
    throw fail(code, `${step} request_status=${String(parsed?.request_status)} error_code=${officialCode}${debug ? ` ${debug}` : ""}`);
  }
}

/**
 * Validate the publish request PLUS the owner approval (Rule 7) and the
 * public metadata (Rule 15) before anything else happens.
 */
function validatePublishRequest(request, nowMs, defaultLocale) {
  if (!request || typeof request !== "object") {
    throw fail("SNAP_PUBLISH_REQUEST_INVALID");
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
    throw fail("SNAP_PUBLISH_REQUEST_INVALID");
  }

  const destination = request.destination;
  if (!DESTINATIONS.has(destination)) {
    throw fail("SNAP_DESTINATION_REQUIRED");
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
  if (typeof title !== "string" || title.length > MAX_DESCRIPTION_LENGTH) {
    throw fail("SNAP_METADATA_INVALID");
  }
  if (typeof description !== "string" || description.length > MAX_DESCRIPTION_LENGTH) {
    throw fail("SNAP_METADATA_INVALID");
  }
  // Spotlight takes ONE bounded description string (official limit 160,
  // hashtags allowed).
  let spotlightDescription = caption.caption ?? "";
  if (typeof spotlightDescription !== "string") spotlightDescription = "";
  if (spotlightDescription === "") {
    spotlightDescription = [title, description].filter((part) => part.length > 0).join("\n");
  }
  spotlightDescription = spotlightDescription.trim();
  if (spotlightDescription.length === 0) {
    throw fail("SNAP_METADATA_INVALID");
  }
  if (spotlightDescription.length > MAX_DESCRIPTION_LENGTH) {
    throw fail("SNAP_DESCRIPTION_TOO_LONG", `official spotlight description limit is ${MAX_DESCRIPTION_LENGTH}`);
  }

  // Official required locale (e.g. "en_US"). Snapshot may carry it; the
  // factory default applies otherwise.
  const rawLocale = typeof caption.locale === "string" ? caption.locale : defaultLocale;
  if (!SNAP_LOCALE_PATTERN.test(rawLocale)) {
    throw fail("SNAP_LOCALE_INVALID");
  }
  const locale = rawLocale.replace("-", "_");

  // Rule 15: never let an internal agent name reach public metadata.
  if (AGENT_NAME_PATTERN.test(JSON.stringify({ title, description, spotlightDescription }))) {
    throw fail("AGENT_NAME_LEAKAGE_DENIED");
  }

  return Object.freeze({
    ownerId: approval.ownerId,
    agentId,
    destination,
    artifactSha256,
    spotlightDescription,
    locale,
    // Internal, non-public media name (official "human readable name"):
    // derived from the artifact hash — never from public metadata — so no
    // agent name or caption fragment can leak through it (Rule 15).
    mediaName: `stph-${artifactSha256.slice(0, 16)}`,
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
    throw fail("SNAP_MEDIA_SOURCE_UNREADABLE");
  }
  if (!info.isFile() || info.size <= 0) {
    throw fail("SNAP_MEDIA_SOURCE_UNREADABLE");
  }
  if (info.size > MAX_FILE_BYTES) {
    throw fail("SNAP_MEDIA_TOO_LARGE", "official multipart upload limit is 1 GB");
  }
  return Object.freeze({ filePath, size: info.size });
}

/**
 * Validate resolved credentials. Profile ids are UUIDs per official docs;
 * the token never leaves this scope except through the Authorization header
 * below (Rule 17).
 */
function normalizeCredentials(resolved) {
  if (!resolved || typeof resolved !== "object") {
    throw fail("SNAP_CREDENTIALS_INVALID");
  }
  const accessToken = resolved.accessToken;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw fail("SNAP_TOKEN_UNAVAILABLE");
  }
  const profileId = resolved.profileId;
  if (typeof profileId !== "string" || !SNAP_UUID_PATTERN.test(profileId)) {
    throw fail("SNAP_CREDENTIALS_INVALID", "profileId must be the official public profile UUID");
  }
  return Object.freeze({ accessToken, profileId });
}

function idempotencyKeyFor(normalized) {
  return createHash("sha256")
    .update(
      [
        normalized.ownerId,
        normalized.agentId,
        normalized.destination,
        normalized.artifactSha256,
        normalized.spotlightDescription,
        normalized.locale,
      ].join("\n"),
    )
    .digest("hex");
}

/**
 * Official AES-256-CBC media encryption. The key/iv are generated per
 * publish, base64-encoded into the official create-media call, and never
 * logged, stored, or echoed (Rule 17 containment discipline).
 */
function makeMediaCipher() {
  const key = randomBytes(32);
  const iv = randomBytes(16);
  return Object.freeze({
    cipher: createCipheriv("aes-256-cbc", key, iv),
    keyB64: key.toString("base64"),
    ivB64: iv.toString("base64"),
  });
}

/**
 * Encrypt the REAL artifact bytes chunk-by-chunk (bounded memory) and yield
 * official upload parts: ≤32 MB each, part_number 1..35. The cipher state
 * persists across reads so the concatenated parts decrypt to the whole file.
 */
async function* encryptedChunks(cipher, filePath, size) {
  const handle = await open(filePath, "r");
  try {
    let carry = Buffer.alloc(0);
    let partNumber = 0;
    const block = Buffer.alloc(ENCRYPT_READ_BLOCK);
    let offset = 0;
    while (offset < size) {
      const toRead = Math.min(ENCRYPT_READ_BLOCK, size - offset);
      const { bytesRead } = await handle.read(block, 0, toRead, offset);
      if (bytesRead !== toRead) {
        throw fail("SNAP_MEDIA_SOURCE_UNREADABLE", "short read while encrypting");
      }
      offset += bytesRead;
      const encrypted = cipher.update(block.subarray(0, bytesRead));
      carry = carry.length === 0 ? encrypted : Buffer.concat([carry, encrypted]);
      while (carry.length >= MAX_CHUNK_BYTES) {
        partNumber += 1;
        if (partNumber > MAX_PARTS) throw fail("SNAP_MEDIA_TOO_LARGE", "official part_number limit is 35");
        yield { partNumber, data: carry.subarray(0, MAX_CHUNK_BYTES) };
        carry = carry.subarray(MAX_CHUNK_BYTES);
      }
    }
    const tail = Buffer.concat([carry, cipher.final()]);
    if (tail.length > 0) {
      partNumber += 1;
      if (partNumber > MAX_PARTS) throw fail("SNAP_MEDIA_TOO_LARGE", "official part_number limit is 35");
      yield { partNumber, data: tail };
    }
  } finally {
    await handle.close();
  }
}

/** Build a multipart/form-data body per the official ADD/FINALIZE shape. */
function multipartBody({ boundary, fields, file }) {
  const parts = [];
  for (const field of fields) {
    parts.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${field.name}"\r\n\r\n${field.value}\r\n`,
      ),
    );
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.filename}"\r\nContent-Type: ${file.contentType}\r\n\r\n`,
    ),
  );
  parts.push(file.data);
  parts.push(Buffer.from(`\r\n--${boundary}--\r\n`));
  return Buffer.concat(parts);
}

/**
 * Create the Snapchat (Spotlight) publisher.
 *
 *   resolveCredentials: async ({ ownerId, agentId, destination }) =>
 *     { accessToken, profileId }  (REQUIRED — production resolution goes
 *     through the secret-manager boundary on opaque locators; tests inject
 *     fixture values)
 *   transport:          async (call) => { status, headers, body } (injected)
 *   mediaResolver:      async (scope) => { filePath }             (optional)
 *   sleep / now / maxAttempts / timeoutMs / defaultLocale
 */
export function createSnapchatPublisher(options = {}) {
  const {
    resolveCredentials,
    transport = defaultTransport,
    mediaResolver = null,
    sleep = defaultSleep,
    maxAttempts = DEFAULT_MAX_ATTEMPTS,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    defaultLocale = "en_US",
    now = () => new Date(),
  } = options;

  if (typeof resolveCredentials !== "function") {
    throw fail("SNAP_CREDENTIAL_RESOLVER_REQUIRED");
  }
  if (typeof transport !== "function") {
    throw fail("SNAP_TRANSPORT_REQUIRED");
  }
  if (mediaResolver !== null && typeof mediaResolver !== "function") {
    throw fail("SNAP_MEDIA_RESOLVER_INVALID");
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 5) {
    throw fail("SNAP_RETRY_CONFIG_INVALID");
  }
  if (!SNAP_LOCALE_PATTERN.test(defaultLocale)) {
    throw fail("SNAP_LOCALE_INVALID");
  }

  /** Director-scoped receipts for this publisher instance (process lifetime). */
  const receipts = new Map();

  async function callTransport(call) {
    let response;
    try {
      response = await transport({ ...call, timeoutMs });
    } catch (err) {
      const error = retryableError("SNAP_UPLOAD_UNAVAILABLE");
      error.detail = sanitizeErrorMessage(err?.message ?? "transport failure").slice(0, 200);
      throw error;
    }
    return validateTransportResponse(response);
  }

  /** Official step 1: create the encrypted-media container. */
  async function createMediaObject({ normalized, mediaCipher, credentials }) {
    return runWithRetry(
      async () => {
        const response = await callTransport({
          url: `${SNAP_API_BASE}/v1/public_profiles/${credentials.profileId}/media`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            type: "VIDEO",
            name: normalized.mediaName,
            key: mediaCipher.keyB64,
            iv: mediaCipher.ivB64,
          }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "snap-media");
        }
        const parsed = parseJsonObject(response.body, "SNAP_MEDIA_CONTAINER_REJECTED");
        requireSuccessStatus(parsed, "SNAP_MEDIA_CONTAINER_REJECTED", "snap-media");
        const mediaId = parsed?.media_id;
        if (typeof mediaId !== "string" || !SNAP_UUID_PATTERN.test(mediaId)) {
          throw fail("SNAP_MEDIA_CONTAINER_REJECTED", "response has no usable media_id");
        }
        // Platform-provided relative paths — validated strictly, rebuilt on
        // the official host only (SSRF defense).
        const addPath = validateSnapRelativePath(parsed?.add_path, "SNAP_MEDIA_CONTAINER_REJECTED");
        const finalizePath = validateSnapRelativePath(parsed?.finalize_path, "SNAP_MEDIA_CONTAINER_REJECTED");
        return Object.freeze({ mediaId, addPath, finalizePath });
      },
      { maxAttempts, sleep },
    );
  }

  /** Official step 2: upload ONE encrypted chunk (same part_number is safe to retry). */
  async function uploadChunk({ addPath, chunk, credentials }) {
    return runWithRetry(
      async () => {
        const boundary = randomBytes(16).toString("hex");
        const response = await callTransport({
          url: `${SNAP_API_BASE}${addPath}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody({
            boundary,
            fields: [
              { name: "action", value: "ADD" },
              { name: "part_number", value: String(chunk.partNumber) },
            ],
            file: {
              filename: `part-${chunk.partNumber}.bin`,
              contentType: "application/octet-stream",
              data: chunk.data,
            },
          }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, `snap-upload-${chunk.partNumber}`);
        }
        const parsed = parseJsonObject(response.body, "SNAP_UPLOAD_RECEIPT_INVALID");
        requireSuccessStatus(parsed, "SNAP_UPLOAD_REJECTED", `snap-upload-${chunk.partNumber}`);
        return chunk.partNumber;
      },
      { maxAttempts, sleep },
    );
  }

  /** Official step 3: finalize the multipart upload. */
  async function finalizeUpload({ finalizePath, credentials }) {
    return runWithRetry(
      async () => {
        const boundary = randomBytes(16).toString("hex");
        const response = await callTransport({
          url: `${SNAP_API_BASE}${finalizePath}`,
          method: "POST",
          headers: {
            Authorization: `Bearer ${credentials.accessToken}`,
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          body: multipartBody({
            boundary,
            fields: [{ name: "action", value: "FINALIZE" }],
            file: { filename: "finalize.txt", contentType: "text/plain", data: Buffer.alloc(0) },
          }),
        });
        if (response.status < 200 || response.status >= 300) {
          throw statusError(response.status, response, "snap-finalize");
        }
        const parsed = parseJsonObject(response.body, "SNAP_UPLOAD_RECEIPT_INVALID");
        requireSuccessStatus(parsed, "SNAP_UPLOAD_REJECTED", "snap-finalize");
        return true;
      },
      { maxAttempts, sleep },
    );
  }

  /**
   * Official step 4: post the spotlight. SINGLE attempt (mirrors the Meta
   * media_publish step): `MEDIA_POSTING_ALREADY_IN_PROGRESS` exists precisely
   * because duplicate posts are rejected server-side — an automatic retry
   * here could double-publish.
   */
  async function postSpotlight({ normalized, mediaId, credentials }) {
    const response = await callTransport({
      url: `${SNAP_API_BASE}/v1/public_profiles/${credentials.profileId}/spotlights`,
      method: "POST",
      headers: {
        Authorization: `Bearer ${credentials.accessToken}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        media_id: mediaId,
        description: normalized.spotlightDescription,
        locale: normalized.locale,
      }),
    });
    if (response.status < 200 || response.status >= 300) {
      throw statusError(response.status, response, "snap-spotlight");
    }
    const parsed = parseJsonObject(response.body, "SNAP_RECEIPT_INVALID");
    // Official logical error codes arrive as HTTP 200 + request_status ERROR.
    if (parsed?.request_status !== "SUCCESS") {
      const officialCode = typeof parsed?.error_code === "string" ? parsed.error_code : "";
      if (officialCode === "MEDIA_EXPIRED") {
        throw fail("SNAP_MEDIA_EXPIRED", "official resolution: create a new media object and re-upload (never auto-retried)");
      }
      if (officialCode === "MEDIA_POSTING_ALREADY_IN_PROGRESS") {
        throw fail("SNAP_MEDIA_POSTING_IN_PROGRESS", "official resolution: do NOT retry the duplicate request (never auto-retried)");
      }
      const debug = typeof parsed?.debug_message === "string"
        ? sanitizeErrorMessage(parsed.debug_message).slice(0, 160)
        : "";
      throw fail("SNAP_SPOTLIGHT_REJECTED", `error_code=${officialCode || "(none)"}${debug ? ` ${debug}` : ""}`);
    }
    const spotlightId = parsed?.spotlight_id;
    if (typeof spotlightId !== "string" || !SNAP_SPOTLIGHT_ID_PATTERN.test(spotlightId)) {
      throw fail("SNAP_RECEIPT_INVALID", "response has no usable spotlight_id");
    }
    return Object.freeze({ spotlightId, rawResponse: response.body });
  }

  async function publish(request) {
    const normalized = validatePublishRequest(request, now().getTime(), defaultLocale);
    const media = await resolveMedia(request, normalized, mediaResolver);

    // Bind the upload to the approved artifact BEFORE touching credentials.
    const actualHash = await sha256File(media.filePath);
    if (actualHash !== normalized.artifactSha256) {
      throw fail(
        "SNAP_MEDIA_HASH_MISMATCH",
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
    );

    // Official AES-256-CBC media encryption (fresh per publish).
    const mediaCipher = makeMediaCipher();

    // Official step 1: container (carries the base64 key/iv per protocol).
    const container = await createMediaObject({ normalized, mediaCipher, credentials });

    // Official step 2: upload every encrypted chunk (bounded memory).
    for await (const chunk of encryptedChunks(mediaCipher.cipher, media.filePath, media.size)) {
      await uploadChunk({ addPath: container.addPath, chunk, credentials });
    }

    // Official step 3: finalize.
    await finalizeUpload({ finalizePath: container.finalizePath, credentials });

    // Official step 4: post the spotlight; receipt from REAL platform id only.
    const attempt = await postSpotlight({ normalized, mediaId: container.mediaId, credentials });

    const receipt = Object.freeze({
      platformPostId: attempt.spotlightId,
      platformUrl: `${SNAP_SPOTLIGHT_URL_BASE}${attempt.spotlightId}`,
      rawResponse: attempt.rawResponse,
    });
    receipts.set(key, receipt);
    return receipt;
  }

  return Object.freeze({ publish });
}
