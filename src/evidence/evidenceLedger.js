import { createHash, randomUUID } from "node:crypto";

function stable(value) {
  if (Array.isArray(value)) return value.map(stable);
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.keys(value).sort()
      .map((key) => [key, stable(value[key])]));
  }
  return value;
}

export class EvidenceLedger {
  #events = [];

  append(event) {
    if (!event?.subjectId || !event?.kind || !event?.classification) {
      throw new Error("INCOMPLETE_EVIDENCE_EVENT");
    }
    if (event.kind === "platform_publish" &&
        (!event.payload?.platformPostId ||
         !event.payload?.platformUrl ||
         !event.payload?.providerResponseSha256)) {
      throw new Error("VERIFIABLE_PLATFORM_RECEIPT_REQUIRED");
    }
    if (event.kind === "media_verification" &&
        (!event.payload?.artifactSha256 ||
         event.payload?.ffprobeVerified !== true)) {
      throw new Error("FFPROBE_VERIFICATION_EVIDENCE_REQUIRED");
    }

    const previousHash = this.#events.at(-1)?.eventHash ?? null;
    const record = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      previousHash,
      ...event
    };
    record.eventHash = createHash("sha256")
      .update(JSON.stringify(stable(record)))
      .digest("hex");
    const frozen = Object.freeze({
      ...record,
      payload: Object.freeze({ ...(record.payload ?? {}) })
    });
    this.#events.push(frozen);
    return frozen;
  }

  list() {
    return [...this.#events];
  }
}
