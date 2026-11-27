import { createHash, randomUUID } from "node:crypto";
import { isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { realpathSync } from "node:fs";
import { stableDigest } from "craft-common-base/digest";
import { type CraftStore, type JsonObject } from "craft-common-store-local/store";

export const NOTE_USAGE_THRESHOLD = 3;
export const NOTE_USAGE_WINDOW_DAYS = 30;
export const NOTE_INDEPENDENT_SESSION_THRESHOLD = 2;
export type NoteSubjectType = "device" | "directory" | "file";
export type NoteStatus = "candidate" | "confirmed" | "needs_review" | "revoked" | "legacy_unreviewed";
export interface CraftNoteRecord {
  id: string; subject_type: NoteSubjectType; subject_key: string; text: string; status: NoteStatus;
  version: number; evidence_refs: string[]; verified_at: string | null; created_at: string; updated_at: string;
  device_id?: string; project_id?: string; project_assignment_status?: "pending"; sensitivity?: string; freshness?: "current" | "needs_review" | "path_only";
  qualification_status?: "pending" | "qualified" | "waiting" | "rejected"; qualification_reason?: string; qualified_at?: string | null;
  qualification_pinned?: boolean;
}
export interface NoteQualificationItem { note_id: string; status: "qualified" | "waiting" | "rejected"; reason: string }
export interface NoteQualificationResult { processed: number; qualified: number; waiting: number; rejected: number; items: NoteQualificationItem[] }
export type CraftNoteTextValidator = (value: string) => void;

const SECRET = /(?:\b(?:api[_-]?(?:key|secret)|access[_-]?token|secret[_-]?key|authorization|password|passwd|pwd)\b\s*[:=]\s*\S{4,}|\bsk-[A-Za-z0-9_-]{16,}|\bgh[pousr]_[A-Za-z0-9]{20,}|\b(?:AKIA|ASIA)[0-9A-Z]{16}\b|\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}|-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----|https?:\/\/[^\s/:@]+:[^\s/@]+@)/iu;
const DEVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;
const LINEAGE_ORIGINS = new Set(["live_hook", "historical_replay", "test_fixture"]);
const REPLAY_PROJECTION_SOURCE_TYPE = "historical_replay_projection";
const REPLAY_PROJECTION_CLAIM = "Historical replay Evidence reference projection.";
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
    ...(value.project_assignment_status === "pending" ? { project_assignment_status: "pending" as const } : {}),
    ...(value.sensitivity ? { sensitivity: String(value.sensitivity) } : {}), ...(value.freshness ? { freshness: value.freshness as CraftNoteRecord["freshness"] } : {}),
    ...(value.qualification_status ? { qualification_status: value.qualification_status as CraftNoteRecord["qualification_status"] } : {}),
    ...(value.qualification_reason ? { qualification_reason: String(value.qualification_reason) } : {}),
    ...(value.qualified_at === null || typeof value.qualified_at === "string" ? { qualified_at: value.qualified_at } : {}),
    ...(typeof value.qualification_pinned === "boolean" ? { qualification_pinned: value.qualification_pinned } : {}) };
}

function normalizeNoteLineage(value: unknown, store: CraftStore, allowReplay: boolean): JsonObject[] {
  if (!Array.isArray(value) || value.length > 100) throw new Error("source_lineage must be an array of at most 100 entries");
  const normalized = value.map((raw, index) => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error(`source_lineage[${index}] must be an object`);
    const item = raw as JsonObject;
    if (Object.keys(item).some(key => !["origin", "replay_run_id", "session_id", "turn_id", "task_id", "project_scope_id", "source_ref", "evidence_refs"].includes(key))) throw new Error(`source_lineage[${index}] contains unsupported fields`);
    const origin = text(item.origin, `source_lineage[${index}].origin`, 40);
    if (!LINEAGE_ORIGINS.has(origin) || !allowReplay && origin === "historical_replay") throw new Error("source_lineage origin is unsupported for this Notes operation");
    const replayRunId = item.replay_run_id === undefined ? undefined : text(item.replay_run_id, "replay_run_id", 160);
    if (origin === "historical_replay" && !replayRunId) throw new Error("historical replay lineage requires replay_run_id");
    if (origin !== "historical_replay" && replayRunId) throw new Error("only historical replay lineage may have replay_run_id");
    const sessionId = text(item.session_id, "session_id", 256);
    const projectScopeId = text(item.project_scope_id, "project_scope_id", 110);
    if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(projectScopeId)) throw new Error("project_scope_id must be canonical");
    if (!item.source_ref || typeof item.source_ref !== "object" || Array.isArray(item.source_ref)) throw new Error("source_ref must be an object");
    const source = item.source_ref as JsonObject;
    if (Object.keys(source).some(key => !["kind", "id", "version", "digest"].includes(key))) throw new Error("source_ref contains unsupported fields");
    const sourceKind = text(source.kind, "source_ref.kind", 64), sourceId = text(source.id, "source_ref.id", 256);
    if (source.version !== undefined && (!Number.isSafeInteger(source.version) || Number(source.version) < 1)) throw new Error("source_ref.version must be a positive integer");
    if (source.digest !== undefined && (typeof source.digest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(source.digest))) throw new Error("source_ref.digest must be a sha256 digest");
    if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length < 1 || item.evidence_refs.length > 64) throw new Error("evidence_refs must contain one to 64 references");
    const evidenceRefs = (item.evidence_refs as unknown[]).map(refValue => {
      if (!refValue || typeof refValue !== "object" || Array.isArray(refValue)) throw new Error("Evidence ref must be an object");
      const ref = refValue as JsonObject;
      if (Object.keys(ref).some(key => !["kind", "id", "version"].includes(key))) throw new Error("Evidence ref contains unsupported fields");
      if (ref.kind !== "evidence" || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1) throw new Error("Evidence ref kind/version is invalid");
      store.get("evidence", text(ref.id, "evidence_ref.id", 256), Number(ref.version));
      return { kind: "evidence", id: String(ref.id), version: Number(ref.version) };
    });
    const turnId = item.turn_id === undefined ? undefined : text(item.turn_id, "turn_id", 256);
    const taskId = item.task_id === undefined ? undefined : text(item.task_id, "task_id", 256);
    const uniqueEvidenceRefs = [...new Map(evidenceRefs.map(ref => [`${ref.id}:${ref.version}`, ref])).values()]
      .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`));
    return { origin, ...(replayRunId ? { replay_run_id: replayRunId } : {}), session_id: sessionId,
      ...(turnId ? { turn_id: turnId } : {}), ...(taskId ? { task_id: taskId } : {}), project_scope_id: projectScopeId,
      source_ref: { kind: sourceKind, id: sourceId, ...(source.version === undefined ? {} : { version: Number(source.version) }), ...(source.digest === undefined ? {} : { digest: String(source.digest).toLowerCase() }) },
      evidence_refs: uniqueEvidenceRefs };
  });
  return [...new Map(normalized.map(item => [stableDigest(item), item])).entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
}

function mergeNoteLineage(...values: JsonObject[][]): JsonObject[] {
  const byOccurrence = new Map<string, JsonObject>();
  for (const item of values.flat()) {
    const occurrence = stableDigest({ origin: item.origin, replay_run_id: item.replay_run_id ?? null, session_id: item.session_id,
      turn_id: item.turn_id ?? null, task_id: item.task_id ?? null, project_scope_id: item.project_scope_id });
    const prior = byOccurrence.get(occurrence);
    if (prior && stableDigest(prior.source_ref) !== stableDigest(item.source_ref)) throw new Error("source lineage source_ref conflicts for the same occurrence");
    const refs = [...(prior?.evidence_refs as JsonObject[] | undefined ?? []), ...(item.evidence_refs as JsonObject[])];
    const evidenceRefs = [...new Map(refs.map(ref => [`${ref.id}:${ref.version}`, ref])).values()]
      .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`));
    byOccurrence.set(occurrence, { ...item, ...(prior ?? {}), evidence_refs: evidenceRefs });
  }
  return [...byOccurrence.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => item);
}

function replayProjectionMetadata(record: JsonObject): JsonObject {
  if (record.source_type !== REPLAY_PROJECTION_SOURCE_TYPE || record.claim !== REPLAY_PROJECTION_CLAIM
    || !record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) throw new Error("Notes replay Evidence projection is malformed; cleanup requires reconciliation");
  const metadata = record.metadata as JsonObject;
  const keys = ["replay_run_id", "source_owner", "source_evidence_id", "source_evidence_version", "semantic_digest", "projection_status"];
  if (Object.keys(metadata).length !== keys.length || Object.keys(metadata).some(key => !keys.includes(key))
    || typeof metadata.replay_run_id !== "string" || !metadata.replay_run_id || typeof metadata.source_owner !== "string" || !metadata.source_owner
    || typeof metadata.source_evidence_id !== "string" || !metadata.source_evidence_id
    || !Number.isSafeInteger(metadata.source_evidence_version) || Number(metadata.source_evidence_version) < 1
    || typeof metadata.semantic_digest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(metadata.semantic_digest)
    || !["active", "revoked"].includes(String(metadata.projection_status))) throw new Error("Notes replay Evidence projection metadata is malformed; cleanup requires reconciliation");
  return metadata;
}

function replayProjectionDigest(record: JsonObject, metadata: JsonObject): string {
  return stableDigest({ source_type: record.source_type, claim: record.claim, metadata });
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
    if (existing?.status === "disabled" && args.status === "active") {
      throw new Error("device must be reactivated through setDeviceStatus with a confirmed Device Note");
    }
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
    return this.#transaction(() => {
      const device = deviceId(args.device_id ?? "local");
      const key = `${device}:${path}`;
      const previous = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === "file" && r.subject_key === key)[0];
      const oldMetadata = previous?.file_metadata as JsonObject | null | undefined;
      const hasMetadata = meta.size !== undefined && meta.modified_at !== undefined;
      const result = this.#observe("file", args, path, true, { metadata: hasMetadata ? { size: meta.size, modified_at: meta.modified_at } : null });
      if (result.duplicate === true) return result;
      const record = result.note as JsonObject;
      const changed = hasMetadata && oldMetadata != null && (oldMetadata.size !== meta.size || oldMetadata.modified_at !== meta.modified_at);
      const freshness = !hasMetadata ? "path_only" : changed ? "needs_review" : "current";
      const written = this.store.find("craft_note", String(record.id));
      const projectScope = written?.notes_project_scope;
      const next = { ...record, ...(projectScope ? { notes_project_scope: projectScope } : {}), ...(changed && record.status === "confirmed" ? { status: "needs_review" } : {}), freshness,
        file_metadata: hasMetadata ? { size: meta.size, modified_at: meta.modified_at } : oldMetadata ?? null };
      return { ...result, note: noteRecord(this.store.save("craft_note", String(record.id), next)) };
    });
  }

  #observe(kind: "directory" | "file", args: JsonObject, path: string, file: boolean, details: JsonObject = {}): JsonObject {
    const device = deviceId(args.device_id ?? "local");
    this.validateNoteText?.(path);
    const deviceRecord = this.store.find("device", device);
    const deviceNote = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === "device" && r.subject_key === device && r.status === "confirmed")[0];
    if (!deviceRecord || deviceRecord.status === "disabled" || !deviceNote) throw new Error("an active device with a confirmed Device Note is required before adding Directory or File Notes");
    const noteText = args.note === undefined && args.description === undefined ? null : this.#noteText(args.note ?? args.description, "note");
    const pinned = args.pin === true;
    const task = args.task_id === undefined ? null : text(args.task_id, "task_id", 160);
    const session = args.session_id === undefined ? null : text(args.session_id, "session_id", 160);
    const project = args.project_id === undefined ? null : text(args.project_id, "project_id", 200);
    let verifiedProject: string | undefined;
    if (project && /^project:[a-f0-9]{64}$/u.test(project) && device === "local") {
      const aliases = this.store.list("scope_alias", 10_000, row => row.status === "active" && row.alias_kind === "path"
        && (row.scope as JsonObject | undefined)?.kind === "project" && (row.scope as JsonObject | undefined)?.id === project
        && typeof row.alias === "string" && row.alias_digest === stableDigest(row.alias));
      try {
        const roots = [...new Set(aliases.map(row => realpathSync(String(row.alias))))];
        const actual = realpathSync(path);
        if (roots.length === 1) {
          const inside = relative(roots[0]!, actual);
          if (inside !== ".." && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)) verifiedProject = project;
        }
      } catch { /* unavailable paths remain pending reconciliation */ }
    }
    const sourceLineage = args.source_lineage === undefined ? [] : normalizeNoteLineage(args.source_lineage, this.store, false);
    if (sourceLineage.some(item => item.origin !== "live_hook" || item.session_id !== session || item.task_id !== undefined && item.task_id !== task)) throw new Error("Notes usage lineage must match the live task and session");
    const evidenceRef = args.evidence_ref === undefined ? null : this.#evidenceRef(args.evidence_ref);
    if (!pinned && (!task || !session || args.outcome !== "completed")) throw new Error("usage evidence requires completed task_id and session_id, or explicit pin");
    if (file && !pinned && args.artifact_ref === undefined && args.confirmed_codebase_ref !== true) throw new Error("file note evidence must reference a completed artifact or confirmed Codebase usage");
    const key = `${device}:${path}`;
    const intentDigest = createHash("sha256").update(JSON.stringify({ kind, key, task, session, project, pinned, noteText,
      outcome: args.outcome ?? null, has_artifact: args.artifact_ref !== undefined,
      confirmed_codebase_ref: args.confirmed_codebase_ref === true, details, evidence_ref: evidenceRef, source_lineage: sourceLineage })).digest("hex");
    const eventId = task && session ? `usage_${Buffer.from(`${kind}\0${key}\0${task}\0${session}`).toString("base64url")}` : null;
    return this.#transaction(() => {
    const previous = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === kind && r.subject_key === key)[0];
    const now = new Date().toISOString();
    const projectScope = previous?.notes_project_scope ?? (!previous ? verifiedProject : undefined);
    if (previous?.status === "revoked") return { note: noteRecord(previous), promoted: false, reason: "revoked" };
    const existingEvent = eventId ? this.store.find("craft_note_usage", eventId) : null;
    if (existingEvent && previous) {
      this.#assertObservationReplay(existingEvent, intentDigest);
      return { note: noteRecord(previous), promoted: false, eligible: false, duplicate: true,
        reason: "duplicate_observation_unchanged",
        evidence_count: Array.isArray(previous.evidence_refs) ? previous.evidence_refs.length : 0,
        session_count: this.#usageCounts(kind, key).sessions };
    }
    if (previous && project && previous.project_id && previous.project_id !== project) throw new Error("Note path belongs to another project");
    if (eventId) {
      if (existingEvent) this.#assertObservationReplay(existingEvent, intentDigest);
      if (!existingEvent) this.store.save("craft_note_usage", eventId, { id: eventId, subject_type: kind, subject_key: key, ...(projectScope ? { notes_project_scope: projectScope } : {}),
        ...(task ? { task_id: task } : {}), ...(session ? { session_id: session } : {}), event_type: pinned && !(task && session) ? "pin" : "usage",
        intent_digest: intentDigest, observed_at: now, ...(evidenceRef ? { evidence_ref: evidenceRef } : {}), ...(sourceLineage.length ? { source_lineage: sourceLineage } : {}) });
    }
    const { events, sessions } = this.#usageCounts(kind, key);
    const evidenceEvents = events.filter(r => r.event_type !== "pin");
    const candidateText = this.#noteText(noteText ?? previous?.text ?? noteSeedText(path), "note");
    const candidate = previous?.status === "confirmed" ? previous : { ...(previous ?? {}), id: previous?.id ?? (typeof args.id === "string" ? args.id : `note_${randomUUID()}`), subject_type: kind,
      subject_key: key, device_id: device, ...(project === null ? {} : { project_id: project }), ...(projectScope ? { notes_project_scope: projectScope } : project && /^project:[a-f0-9]{64}$/u.test(project) ? { project_assignment_status: "pending" } : {}),
      text: candidateText,
      status: "candidate", version: Number(previous?.version ?? 0) + 1, evidence_refs: evidenceEvents.map(r => String(r.id)),
      ...(sourceLineage.length ? { source_lineage: mergeNoteLineage(Array.isArray(previous?.source_lineage) ? normalizeNoteLineage(previous.source_lineage, this.store, false) : [], sourceLineage) } : {}),
      qualification_status: previous?.qualification_status === "qualified" ? "qualified" : "pending",
      qualification_reason: previous?.qualification_status === "qualified" ? previous.qualification_reason : "awaiting_async_qualification",
      qualified_at: previous?.qualification_status === "qualified" ? previous.qualified_at ?? null : null,
      qualification_pinned: pinned || previous?.qualification_pinned === true,
      verified_at: null, created_at: previous?.created_at ?? now, updated_at: now, freshness: file ? "path_only" : undefined };
    const saved = this.#write(candidate as JsonObject);
    return { note: saved, promoted: false, eligible: false, reason: "awaiting_async_qualification", evidence_count: evidenceEvents.length, session_count: sessions };
    });
  }

  /** Recheck a bounded set of Notes candidates. Qualification never confirms or recalls a Note. */
  qualifyCandidates(args: JsonObject = {}): NoteQualificationResult {
    const limit = finiteLimit(args.limit);
    const nowMs = Date.now();
    const recheckBefore = nowMs - NOTE_USAGE_WINDOW_DAYS * 86400000;
    const cursors = new Map(this.store.list("craft_note_qualification_cursor", Number.MAX_SAFE_INTEGER)
      .map(row => [String(row.note_id), row] as const));
    const candidates = this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.status === "candidate"
      && this.#qualificationDue(r, cursors.get(String(r.id))?.checked_at ?? r.qualification_checked_at, nowMs, recheckBefore))
      .sort((left, right) => String(cursors.get(String(left.id))?.checked_at ?? left.qualification_checked_at ?? left.updated_at ?? "")
        .localeCompare(String(cursors.get(String(right.id))?.checked_at ?? right.qualification_checked_at ?? right.updated_at ?? ""))
        || String(left.id).localeCompare(String(right.id)))
      .slice(0, limit);
    const devices = new Map(this.store.list("device", Number.MAX_SAFE_INTEGER).map(row => [String(row.id), row]));
    const deviceNotes = new Set(this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.subject_type === "device" && r.status === "confirmed").map(row => String(row.subject_key)));
    const usageBySubject = new Map<string, JsonObject[]>();
    for (const event of this.store.list("craft_note_usage", Number.MAX_SAFE_INTEGER)) {
      const key = `${event.subject_type}:${event.subject_key}`;
      const existing = usageBySubject.get(key) ?? [];
      if (event.event_type !== "revoked" && Number.isFinite(Date.parse(String(event.observed_at)))
        && Date.parse(String(event.observed_at)) >= Date.now() - NOTE_USAGE_WINDOW_DAYS * 86400000 && !this.#isReplayOnly(event)) existing.push(event);
      usageBySubject.set(key, existing);
    }
    const items: NoteQualificationItem[] = [];
    for (const candidate of candidates) {
      const id = String(candidate.id);
      const device = String(candidate.device_id ?? "");
      const deviceRecord = device ? devices.get(device) : null;
      const deviceNote = deviceNotes.has(device);
      let status: NoteQualificationItem["status"] = "waiting";
      let reason = candidate.project_assignment_status === "pending" ? "project_assignment_pending" : "device_identity_unavailable";
      if (candidate.project_assignment_status !== "pending" && deviceRecord && deviceRecord.status !== "disabled" && deviceNote) {
        try { this.#noteText(candidate.text, "note"); }
        catch {
          status = "rejected";
          reason = "candidate_validation_failed";
        }
        if (status !== "rejected") {
          const events = usageBySubject.get(`${candidate.subject_type}:${candidate.subject_key}`) ?? [];
          const counts = { tasks: new Set(events.map(row => String(row.task_id))).size, sessions: new Set(events.map(row => String(row.session_id))).size };
          if (candidate.qualification_pinned === true) {
            status = "qualified";
            reason = "pinned_review_required";
          } else if (counts.tasks >= NOTE_USAGE_THRESHOLD && counts.sessions >= NOTE_INDEPENDENT_SESSION_THRESHOLD) {
            status = "qualified";
            reason = "threshold_met_review_required";
          } else {
            reason = "insufficient_independent_usage";
          }
        }
      }
      const now = new Date().toISOString();
      const applied = this.#transaction(() => {
        const current = this.store.find("craft_note", id);
        if (!current || current.status !== "candidate" || Number(current.version ?? 0) !== Number(candidate.version ?? 0)) return false;
        const qualifiedAt = status === "qualified" ? now : null;
        const refreshQualifiedAt = status === "qualified" && (current.qualification_status !== "qualified"
          || !Number.isFinite(Date.parse(String(current.qualified_at ?? "")))
          || Date.parse(String(current.qualified_at)) < recheckBefore);
        if (current.qualification_status !== status || current.qualification_reason !== reason || refreshQualifiedAt) {
          this.store.save("craft_note", id, { ...current, qualification_status: status, qualification_reason: reason,
            qualified_at: qualifiedAt, updated_at: now });
        }
        this.store.save("craft_note_qualification_cursor", id, { id, note_id: id, status, reason, checked_at: now, ...(current.notes_project_scope ? { notes_project_scope: current.notes_project_scope } : {}) });
        return true;
      });
      if (!applied) {
        items.push({ note_id: id, status: "waiting", reason: "candidate_changed_during_qualification" });
        continue;
      }
      items.push({ note_id: id, status, reason });
    }
    return { processed: items.length, qualified: items.filter(item => item.status === "qualified").length,
      waiting: items.filter(item => item.status === "waiting").length, rejected: items.filter(item => item.status === "rejected").length, items };
  }

  #qualificationDue(record: JsonObject, checkedAtValue: unknown, nowMs: number, qualifiedBefore: number): boolean {
    const status = record.qualification_status;
    const checkedAt = Date.parse(String(checkedAtValue ?? ""));
    if (status === "qualified") {
      const qualifiedAt = Date.parse(String(record.qualified_at ?? ""));
      return !Number.isFinite(qualifiedAt) || qualifiedAt < qualifiedBefore;
    }
    if (status === "rejected") return !Number.isFinite(checkedAt) || checkedAt < qualifiedBefore;
    if (status === "waiting") return true;
    return true;
  }

  candidateList(args: JsonObject = {}): { items: CraftNoteRecord[] } {
    const device = args.device_id === undefined ? null : deviceId(args.device_id);
    return { items: this.store.list("craft_note", Number.MAX_SAFE_INTEGER, r => r.status === "candidate" || r.status === "needs_review" || r.status === "legacy_unreviewed")
      .filter(r => device === null || String(r.device_id ?? "") === device).map(noteRecord).slice(0, finiteLimit(args.limit)) };
  }

  captureHistoricalReplayCandidate(args: JsonObject): JsonObject {
    const lineage = normalizeNoteLineage(args.source_lineage, this.store, true);
    if (!lineage.length || lineage.some(item => item.origin !== "historical_replay")) throw new Error("Notes replay requires historical_replay lineage");
    if (new Set(lineage.map(item => String(item.replay_run_id))).size !== 1) throw new Error("Notes replay capture must describe one replay run");
    const expectedVersion = Number.isSafeInteger(args.expected_version) ? Number(args.expected_version) : 0;
    if (expectedVersion < 1) return { status: "skipped", reason: "exact_note_version_required" };
    const noteId = text(args.note_id, "note_id", 200);
    const note = this.store.find("craft_note", noteId);
    if (!note || Number(note.version) !== expectedVersion) return { status: "skipped", reason: "exact_note_not_found" };
    const device = String(note.device_id ?? "");
    const deviceRecord = this.store.find("device", device);
    const deviceNote = this.store.list("craft_note", 1000, row => row.subject_type === "device" && row.subject_key === device && row.status === "confirmed")[0];
    if (!deviceRecord || deviceRecord.status === "disabled" || !deviceNote) return { status: "skipped", reason: "active_device_confirmation_required" };
    if (note.status !== "confirmed" && note.status !== "needs_review") return { status: "skipped", reason: "confirmed_object_required" };
    if (args.subject_type !== note.subject_type || args.subject_key !== note.subject_key || args.device_id !== device) return { status: "skipped", reason: "exact_object_identity_required" };
    const projectScope = `project:${String(note.project_id ?? "")}`;
    if (lineage.some(item => item.project_scope_id !== projectScope)) return { status: "skipped", reason: "project_scope_mismatch" };
    const events = this.#usageCounts(String(note.subject_type), String(note.subject_key)).events.filter(row => !this.#isReplayOnly(row));
    if (new Set(events.map(row => String(row.task_id))).size < NOTE_USAGE_THRESHOLD
      || new Set(events.map(row => String(row.session_id))).size < NOTE_INDEPENDENT_SESSION_THRESHOLD) return { status: "skipped", reason: "insufficient_live_usage" };
    if (note.source_lineage === undefined) return { status: "skipped", reason: "legacy_note_identity_unknown" };
    const existingLineage = normalizeNoteLineage(note.source_lineage, this.store, true);
    if (!existingLineage.some(item => item.origin === "live_hook")) return { status: "skipped", reason: "explicit_live_lineage_required" };
    const sourceLineage = mergeNoteLineage(existingLineage, lineage);
    const saved = this.#transaction(() => this.store.updateIfVersion("craft_note", noteId, Number(note.version), { ...note, source_lineage: sourceLineage, updated_at: new Date().toISOString() }));
    return { status: "captured", note_id: String(saved.id), version: Number(saved.version) };
  }

  historicalReplayCleanupPreview(args: JsonObject): JsonObject {
    const replayRunId = text(args.replay_run_id, "replay_run_id", 160);
    const items: JsonObject[] = [];
    for (const kind of ["craft_note", "craft_note_usage"]) {
      for (const record of this.store.list(kind, 10_000, row => row.source_lineage !== undefined, false)) {
        const lineage = normalizeNoteLineage(record.source_lineage, this.store, true);
        if (!lineage.some(item => item.origin === "historical_replay" && item.replay_run_id === replayRunId)) continue;
        const retained = lineage.filter(item => !(item.origin === "historical_replay" && item.replay_run_id === replayRunId));
        items.push({ kind, id: String(record.id), version: Number(record.version), lineage_digest: stableDigest(lineage), action: retained.length ? "remove_replay_lineage" : "revoke" });
      }
    }
    for (const record of this.store.list("evidence", 10_000, row => row.source_type === REPLAY_PROJECTION_SOURCE_TYPE, false)) {
      const metadata = replayProjectionMetadata(record);
      if (metadata.replay_run_id !== replayRunId || metadata.projection_status !== "active") continue;
      items.push({ kind: "evidence_projection", id: String(record.id), version: Number(record.version), lineage_digest: replayProjectionDigest(record, metadata), action: "revoke" });
    }
    items.sort((a, b) => `${a.kind}:${a.id}`.localeCompare(`${b.kind}:${b.id}`));
    const owner = "notes";
    return { owner, replay_run_id: replayRunId, manifest_digest: stableDigest({ owner, replay_run_id: replayRunId, items }), items };
  }

  historicalReplayCleanupApply(args: JsonObject): JsonObject {
    const replayRunId = text(args.replay_run_id, "replay_run_id", 160);
    const expectedDigest = text(args.expected_manifest_digest, "expected_manifest_digest");
    const receiptId = `notes_replay_cleanup_${stableDigest({ replay_run_id: replayRunId, manifest_digest: expectedDigest }).slice(-32)}`;
    const receipt = this.store.find("notes_replay_cleanup_receipt", receiptId);
    if (receipt) return { status: "cleaned", idempotent: true, receipt };
    const preview = this.historicalReplayCleanupPreview({ replay_run_id: replayRunId });
    if (preview.manifest_digest !== expectedDigest) throw new Error("Notes replay cleanup manifest changed; preview again");
    const items = preview.items as JsonObject[];
    const cleaned = this.#transaction(() => {
      const currentReceipt = this.store.find("notes_replay_cleanup_receipt", receiptId);
      if (currentReceipt) return { applied: [], cleanup: currentReceipt, idempotent: true };
      const records = items.map(item => {
        const storageKind = item.kind === "evidence_projection" ? "evidence" : String(item.kind);
        const record = this.store.get(storageKind, String(item.id));
        if (item.kind === "evidence_projection") {
          const metadata = replayProjectionMetadata(record);
          if (Number(record.version) !== Number(item.version) || metadata.replay_run_id !== replayRunId
            || metadata.projection_status !== "active" || replayProjectionDigest(record, metadata) !== item.lineage_digest) throw new Error("Notes replay Evidence projection changed after cleanup preview");
          return { item, storageKind, record, update: { ...record, confidence: "rejected", metadata: { ...metadata, projection_status: "revoked" } } };
        }
        const lineage = normalizeNoteLineage(record.source_lineage, this.store, true);
        if (Number(record.version) !== Number(item.version) || stableDigest(lineage) !== item.lineage_digest) throw new Error("Notes replay object changed after cleanup preview");
        const retained = lineage.filter(entry => !(entry.origin === "historical_replay" && entry.replay_run_id === replayRunId));
        const update: JsonObject = { ...record, source_lineage: retained, updated_at: new Date().toISOString() };
        if (!retained.length) {
          update.status = "revoked"; update.qualification_status = "rejected"; update.qualification_pinned = false;
          update.cleanup_receipt = { replay_run_id: replayRunId, manifest_digest: expectedDigest, content_free: true };
          if (String(item.kind) === "craft_note") { update.text = ""; update.verified_at = null; }
          else update.event_type = "revoked";
        }
        return { item, storageKind, record, update };
      });
      const applied = records.map(({ item, storageKind, record, update }) => ({ kind: String(item.kind),
        record: this.store.updateIfVersion(storageKind, String(record.id), Number(record.version), update) }));
      return { applied, cleanup: this.store.create("notes_replay_cleanup_receipt", receiptId, { owner: "notes", replay_run_id: replayRunId,
        manifest_digest: expectedDigest, cleaned_object_count: applied.length, content_free: true, status: "cleaned" }), idempotent: false };
    });
    return { status: "cleaned", idempotent: cleaned.idempotent, receipt: cleaned.cleanup,
      cleaned: cleaned.applied.map(item => ({ kind: item.kind, id: String(item.record.id), version: Number(item.record.version) })) };
  }

  confirm(args: JsonObject): CraftNoteRecord {
    const id = text(args.id, "id", 200);
    const requestedText = args.note === undefined ? undefined : this.#noteText(args.note, "note");
    return this.#transaction(() => {
      const previous = this.store.find("craft_note", id);
      if (!previous) throw new Error(`Unknown craft_note: ${id}`);
      assertExpectedVersion(args.expected_version, previous);
      if (previous.status === "revoked") throw new Error("revoked Note cannot be confirmed");
      if (previous.project_assignment_status === "pending") throw new Error("Note project assignment requires reconciliation");
      if (previous.status === "candidate") {
        if (previous.qualification_status !== "qualified") throw new Error("Note candidate must pass asynchronous qualification before confirmation");
        const qualifiedAt = Date.parse(String(previous.qualified_at ?? ""));
        if (!Number.isFinite(qualifiedAt) || qualifiedAt < Date.now() - NOTE_USAGE_WINDOW_DAYS * 86400000) throw new Error("Note qualification has expired; re-run qualification");
        const events = this.#usageCounts(String(previous.subject_type), String(previous.subject_key));
        if (previous.qualification_pinned !== true && (events.tasks < NOTE_USAGE_THRESHOLD || events.sessions < NOTE_INDEPENDENT_SESSION_THRESHOLD)) throw new Error("Note qualification has expired; re-run qualification");
        const deviceId = String(previous.device_id ?? "local");
        const hasDeviceNote = previous.subject_type === "device" || this.store.list("craft_note", 1000,
          row => row.subject_type === "device" && row.subject_key === deviceId && row.status === "confirmed").length > 0;
        if (!this.#deviceEnabled(deviceId) || !hasDeviceNote) throw new Error("Note device is not enabled");
      }
      const noteText = requestedText ?? this.#noteText(String(previous.text), "note");
      return this.#write({ ...previous, text: noteText, status: "confirmed", verified_at: new Date().toISOString(),
        version: Number(previous.version ?? 1) + 1, updated_at: new Date().toISOString() } as JsonObject);
    });
  }

  revoke(args: JsonObject): CraftNoteRecord {
    const id = text(args.id, "id", 200);
    const revokedBy = text(args.revoked_by, "revoked_by", 120);
    const reason = text(args.reason, "reason");
    return this.#transaction(() => {
      const previous = this.store.find("craft_note", id);
      if (!previous) throw new Error(`Unknown craft_note: ${id}`);
      assertExpectedVersion(args.expected_version, previous);
      if (previous.status === "revoked") throw new Error("revoked Note cannot be revoked again");
      return this.#write({ ...previous, status: "revoked", revoked_by: revokedBy, revoked_reason: reason,
        version: Number(previous.version ?? 1) + 1, updated_at: new Date().toISOString() });
    });
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
    if (payload.notes_project_scope) {
      const current = this.store.find("craft_note", String(payload.id));
      return noteRecord(this.store.save("craft_note", String(payload.id), { ...payload, version: Number(current?.version ?? 0) }));
    }
    return noteRecord(this.store.save("craft_note", String(payload.id), payload));
  }

  #transaction<T>(operation: () => T): T {
    const store = this.store as CraftStore & { transaction?: (action: () => T) => T };
    return store.transaction ? store.transaction(operation) : operation();
  }

  #assertObservationReplay(existingEvent: JsonObject, intentDigest: string): void {
    if (typeof existingEvent.intent_digest !== "string") {
      throw Object.assign(new Error("legacy observation event cannot verify the repeated input"), { code: "CRAFT_NOTES_OBSERVATION_CONFLICT" });
    }
    if (existingEvent.intent_digest !== intentDigest) {
      throw Object.assign(new Error("observation event was reused with different input"), { code: "CRAFT_NOTES_OBSERVATION_CONFLICT" });
    }
  }

  #evidenceRef(value: unknown): JsonObject {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("evidence_ref must be an object");
    const ref = value as JsonObject;
    if (ref.kind !== "evidence" || typeof ref.id !== "string" || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1) throw new Error("evidence_ref must contain kind, id and positive version");
    this.store.get("evidence", ref.id, Number(ref.version));
    return { kind: "evidence", id: ref.id, version: Number(ref.version) };
  }

  #isReplayOnly(record: JsonObject): boolean {
    if (!Array.isArray(record.source_lineage)) return false;
    const lineage = normalizeNoteLineage(record.source_lineage, this.store, true);
    return lineage.length > 0 && !lineage.some(item => item.origin === "live_hook");
  }

  #usageCounts(kind: string, key: string): { events: JsonObject[]; sessions: number; tasks: number } {
    const cutoff = Date.now() - NOTE_USAGE_WINDOW_DAYS * 86400000;
    const events = this.store.list("craft_note_usage", Number.MAX_SAFE_INTEGER, r => r.subject_type === kind && r.subject_key === key
      && r.event_type !== "revoked" && Number.isFinite(Date.parse(String(r.observed_at)))
      && Date.parse(String(r.observed_at)) >= cutoff && !this.#isReplayOnly(r));
    return { events, sessions: new Set(events.map(r => String(r.session_id))).size, tasks: new Set(events.map(r => String(r.task_id))).size };
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
