import { randomUUID } from "node:crypto";
import { isAbsolute, resolve, win32 } from "node:path";
import { type CraftStore, type JsonObject } from "craft-common-store-local/store";

export const NOTE_USAGE_THRESHOLD = 3;
export const NOTE_USAGE_WINDOW_DAYS = 30;
export const NOTE_INDEPENDENT_SESSION_THRESHOLD = 2;
export type NoteSubjectType = "device" | "directory" | "file";
export type NoteStatus = "candidate" | "confirmed" | "needs_review" | "revoked" | "legacy_unreviewed";
export interface CraftNoteRecord {
  id: string; subject_type: NoteSubjectType; subject_key: string; text: string; status: NoteStatus;
  version: number; evidence_refs: string[]; verified_at: string | null; created_at: string; updated_at: string;
  device_id?: string; project_id?: string; sensitivity?: string; freshness?: "current" | "needs_review" | "path_only";
}
export type CraftNoteTextValidator = (value: string) => void;

const SECRET = /(?:\b(?:api[_-]?(?:key|secret)|access[_-]?token|secret[_-]?key|authorization|password|passwd|pwd)\b\s*[:=]\s*\S{4,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|https?:\/\/[^\s/:@]+:[^\s/@]+@)/iu;
const DEVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
function text(value: unknown, name: string, max = 500): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  const valueText = value.trim().replace(/\s+/gu, " ");
  if (valueText.length > max) throw new Error(`${name} must be ${max} characters or fewer`);
  if (SECRET.test(valueText)) throw new Error(`${name} appears to contain a credential`);
  return valueText;
}
function deviceId(value: unknown): string {
  if (typeof value !== "string" || !DEVICE_ID.test(value.trim().toLowerCase())) throw new Error("device_id must be 1-64 lowercase letters, digits, dot, dash or underscore");
  return value.trim().toLowerCase();
}
function absolutePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string");
  const path = value.trim();
  if ((/^[a-z]:[\\/]/iu.test(path) || path.startsWith("\\\\")) && win32.isAbsolute(path)) return win32.normalize(path);
  if (!isAbsolute(path)) throw new Error("path must be an absolute path");
  return resolve(path);
}
function noteRecord(value: JsonObject): CraftNoteRecord {
  return { id: String(value.id), subject_type: value.subject_type as NoteSubjectType, subject_key: String(value.subject_key),
    text: String(value.text), status: value.status as NoteStatus, version: Number(value.version ?? 1),
    evidence_refs: Array.isArray(value.evidence_refs) ? value.evidence_refs.map(String) : [],
    verified_at: value.verified_at == null ? null : String(value.verified_at), created_at: String(value.created_at), updated_at: String(value.updated_at),
    ...(value.device_id ? { device_id: String(value.device_id) } : {}), ...(value.project_id ? { project_id: String(value.project_id) } : {}),
    ...(value.sensitivity ? { sensitivity: String(value.sensitivity) } : {}), ...(value.freshness ? { freshness: value.freshness as CraftNoteRecord["freshness"] } : {}) };
}

/** Seed text for a place without a description: its last path segment, or the path itself for a root. */
export function noteSeedText(path: string): string {
  return path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;
}

/** Unified Notes lifecycle. File metadata is always supplied by the caller; this class never opens a path. */
export class CraftNotesRegistry {
  readonly store: CraftStore;
  readonly validateNoteText: CraftNoteTextValidator | undefined;
  constructor(store: CraftStore, validateNoteText?: CraftNoteTextValidator) { this.store = store; this.validateNoteText = validateNoteText; }

  #noteText(value: unknown, name: string): string {
    const result = text(value, name);
    this.validateNoteText?.(result);
    return result;
  }

  createDevice(args: JsonObject): CraftNoteRecord {
    const id = deviceId(args.id ?? args.device_id);
    const noteText = this.#noteText(args.note ?? args.description, "note");
    const existing = this.store.find("device", id);
    const now = new Date().toISOString();
    const device = { ...(existing ?? {}), ...args, id, device_note: noteText,
      status: args.status === "disabled" || existing?.status === "disabled" && args.status !== "active" ? "disabled" : "active", updated_at: now };
    this.store.save("device", id, device);
    const previous = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === "device" && r.subject_key === id)[0];
    return this.#write({ ...(previous ?? {}), id: previous?.id ?? `note_${randomUUID()}`, subject_type: "device", subject_key: id,
      device_id: id, text: noteText, status: "confirmed", verified_at: now, version: Number(previous?.version ?? 0) + 1,
      evidence_refs: previous?.evidence_refs ?? [], created_at: previous?.created_at ?? now, updated_at: now });
  }

  observeDirectory(args: JsonObject): JsonObject {
    return this.#observe("directory", args, absolutePath(args.path), false);
  }

  observeFileReference(args: JsonObject): JsonObject {
    const path = absolutePath(args.path);
    const metadata = args.metadata;
    if (metadata !== undefined && (metadata === null || typeof metadata !== "object" || Array.isArray(metadata))) throw new Error("metadata must be an object");
    const meta = (metadata ?? {}) as JsonObject;
    if (meta.size !== undefined && (!Number.isSafeInteger(meta.size) || Number(meta.size) < 0)) throw new Error("metadata.size must be a non-negative safe integer");
    if (meta.modified_at !== undefined && (typeof meta.modified_at !== "string" || !Number.isFinite(Date.parse(meta.modified_at)))) throw new Error("metadata.modified_at must be a valid timestamp");
    const device = deviceId(args.device_id ?? "local");
    const key = `${device}:${path}`;
    const previous = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === "file" && r.subject_key === key)[0];
    const oldMetadata = previous?.file_metadata as JsonObject | null | undefined;
    const result = this.#observe("file", args, path, true);
    const record = result.note as JsonObject;
    const hasMetadata = meta.size !== undefined && meta.modified_at !== undefined;
    const changed = hasMetadata && oldMetadata != null && (oldMetadata.size !== meta.size || oldMetadata.modified_at !== meta.modified_at);
    const freshness = !hasMetadata ? "path_only" : changed ? "needs_review" : "current";
    const next = { ...record, ...(changed && record.status === "confirmed" ? { status: "needs_review" } : {}), freshness,
      file_metadata: hasMetadata ? { size: meta.size, modified_at: meta.modified_at } : oldMetadata ?? null };
    this.store.save("craft_note", String(record.id), next);
    return { ...result, note: noteRecord(next) };
  }

  #observe(kind: "directory" | "file", args: JsonObject, path: string, file: boolean): JsonObject {
    const device = deviceId(args.device_id ?? "local");
    this.validateNoteText?.(path);
    const deviceRecord = this.store.find("device", device);
    const deviceNote = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === "device" && r.subject_key === device && r.status === "confirmed")[0];
    if (!deviceRecord || deviceRecord.status === "disabled" || !deviceNote) throw new Error("an active device with a confirmed Device Note is required before adding Directory or File Notes");
    const noteText = args.note === undefined && args.description === undefined ? null : this.#noteText(args.note ?? args.description, "note");
    const pinned = args.pin === true;
    const task = args.task_id === undefined ? null : text(args.task_id, "task_id", 160);
    const session = args.session_id === undefined ? null : text(args.session_id, "session_id", 160);
    if (!pinned && (!task || !session || args.outcome !== "completed")) throw new Error("usage evidence requires completed task_id and session_id, or explicit pin");
    if (file && !pinned && args.artifact_ref === undefined && args.confirmed_codebase_ref !== true) throw new Error("file note evidence must reference a completed artifact or confirmed Codebase usage");
    const key = `${device}:${path}`;
    const previous = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === kind && r.subject_key === key)[0];
    const now = new Date().toISOString();
    if (previous?.status === "revoked") return { note: noteRecord(previous), promoted: false, reason: "revoked" };
    const eventId = task && session ? `usage_${Buffer.from(`${kind}\0${key}\0${task}\0${session}`).toString("base64url")}` : null;
    if (eventId) this.store.save("craft_note_usage", eventId, { id: eventId, subject_type: kind, subject_key: key, task_id: task, session_id: session, observed_at: now });
    const events = this.store.list("craft_note_usage", Number.MAX_SAFE_INTEGER, r => r.subject_type === kind && r.subject_key === key && Date.parse(String(r.observed_at)) >= Date.now() - NOTE_USAGE_WINDOW_DAYS * 86400000);
    const sessions = new Set(events.map(r => String(r.session_id)));
    const tasks = new Set(events.map(r => String(r.task_id)));
    const eligible = pinned || (tasks.size >= NOTE_USAGE_THRESHOLD && sessions.size >= NOTE_INDEPENDENT_SESSION_THRESHOLD);
    const candidateText = this.#noteText(noteText ?? previous?.text ?? noteSeedText(path), "note");
    const candidate = previous?.status === "confirmed" ? previous : { ...(previous ?? {}), id: previous?.id ?? (typeof args.id === "string" ? args.id : `note_${randomUUID()}`), subject_type: kind,
      subject_key: key, device_id: device, ...(args.project_id === undefined ? {} : { project_id: String(args.project_id) }),
      text: candidateText,
      status: eligible ? "candidate" : "candidate", version: Number(previous?.version ?? 0) + 1, evidence_refs: events.map(r => String(r.id)),
      verified_at: null, created_at: previous?.created_at ?? now, updated_at: now, freshness: file ? "path_only" : undefined };
    const saved = this.#write(candidate as JsonObject);
    return { note: saved, promoted: false, eligible, reason: pinned ? "pinned_review_required" : eligible ? "threshold_met_review_required" : "insufficient_independent_usage", evidence_count: events.length, session_count: sessions.size };
  }

  candidateList(args: JsonObject = {}): { items: CraftNoteRecord[] } {
    const device = args.device_id === undefined ? null : deviceId(args.device_id);
    return { items: this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.status === "candidate" || r.status === "needs_review" || r.status === "legacy_unreviewed")
      .filter(r => device === null || String(r.device_id ?? "") === device).map(noteRecord).slice(0, finiteLimit(args.limit)) };
  }

  confirm(args: JsonObject): CraftNoteRecord {
    const id = text(args.id, "id", 200);
    const previous = this.store.find("craft_note", id);
    if (!previous) throw new Error(`Unknown craft_note: ${id}`);
    assertExpectedVersion(args.expected_version, previous);
    if (previous.status === "revoked") throw new Error("revoked Note cannot be confirmed");
    const noteText = args.note === undefined ? this.#noteText(String(previous.text), "note") : this.#noteText(args.note, "note");
    return this.#write({ ...previous, text: noteText, status: "confirmed", verified_at: new Date().toISOString(), version: Number(previous.version ?? 1) + 1, updated_at: new Date().toISOString() });
  }

  revoke(args: JsonObject): CraftNoteRecord {
    const id = text(args.id, "id", 200);
    const previous = this.store.find("craft_note", id);
    if (!previous) throw new Error(`Unknown craft_note: ${id}`);
    assertExpectedVersion(args.expected_version, previous);
    return this.#write({ ...previous, status: "revoked", revoked_by: text(args.revoked_by, "revoked_by", 120), revoked_reason: text(args.reason, "reason"), version: Number(previous.version ?? 1) + 1, updated_at: new Date().toISOString() });
  }

  resolve(args: JsonObject): { items: CraftNoteRecord[] } {
    const device = args.device_id === undefined ? null : deviceId(args.device_id);
    const project = args.project_id === undefined ? null : String(args.project_id);
    const path = args.path === undefined ? null : absolutePath(args.path);
    return { items: this.store.list("craft_note", 1000, r => (r.status === "confirmed" || r.status === "legacy_unreviewed")
      && this.#deviceEnabled(String(r.device_id ?? "local")) && (device === null || r.device_id === device)
      && (r.subject_type === "device" || project === null || r.project_id === undefined || r.project_id === project)
      && (r.subject_type === "device" ? (device === null ? r.device_id === "local" : r.device_id === device)
        : path !== null && r.subject_key === `${device ?? "local"}:${path}`)).map(noteRecord).slice(0, finiteLimit(args.limit)) };
  }

  list(args: JsonObject = {}): { items: CraftNoteRecord[] } {
    const status = args.status;
    return { items: this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => status === undefined || r.status === status).map(noteRecord).slice(0, finiteLimit(args.limit)) };
  }

  #write(payload: JsonObject): CraftNoteRecord {
    this.store.save("craft_note", String(payload.id), payload);
    return noteRecord(payload);
  }

  #deviceEnabled(id: string): boolean {
    const device = this.store.find("device", id);
    return device ? device.status !== "disabled" : id === "local";
  }
}

function finiteLimit(value: unknown): number {
  if (value === undefined || value === null) return 50;
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000) throw new Error("limit must be an integer between 1 and 1000");
  return limit;
}

function assertExpectedVersion(value: unknown, record: JsonObject): void {
  if (!Number.isSafeInteger(value) || Number(value) < 1) throw new Error("expected_version must be a positive integer");
  if (Number(value) !== Number(record.version ?? 1)) throw new Error("stale Note version; reload the current candidate before deciding");
}
