/**
 * A self-evolving registry of *places*: a directory on a named device, plus the
 * human name people use for it. People navigate by meaning ("where the billing
 * service lives"), not by absolute paths, so the registry resolves a name to a
 * place and a place to its names.
 *
 * A place is `(device_id, path)`. The same path on two machines is two places;
 * that is the whole reason the device dimension exists. A place may also carry a
 * repository identity (remote URL + commit) when the directory is a git
 * checkout, which lets two devices that hold the same repository agree on one
 * identity without merging their device-local places.
 *
 * Self-evolution rule (from NEEDREAD.md): a directory is only persisted once it
 * has actually been used, and it is only "promoted" to a stable, recallable
 * entry once it has been used often enough. A freshly observed path stays in a
 * low-trust `observed` state until it crosses the use-count threshold, which
 * keeps noise (one-off temp folders, OS defaults) out of the formal index.
 *
 * Device metadata (`device`, health, status) lives alongside places. A disabled
 * device stops being recallable without losing its audit trail or its places.
 */
import { isAbsolute, resolve, win32 } from "node:path";
import { randomUUID } from "node:crypto";
import { type CraftStore, type JsonObject } from 'craft-common-store-local/store';
import { CraftNotesRegistry, type CraftNoteTextValidator } from "./notes.ts";

/** Below this count a directory is only "observed"; at/above it becomes "promoted". */
export const PROMOTION_USE_THRESHOLD = 3;

/** Stable device metadata: who, where and how the device is reached. */
export interface DeviceRecord {
  id: string;
  name: string | null;
  deviceKind: DeviceKind;
  hostKind: "local" | "cloud";
  location: string | null;
  tags: string[];
  health: "healthy" | "degraded" | "offline";
  lastSeenAt: string | null;
  createdAt: string;
  updatedAt: string;
  status: "active" | "disabled";
}

/** Registration for a device; concept tags let the registry speak the shared taxonomy. */
export interface RegisterDeviceArgs {
  id?: string;
  name?: string | null;
  device_kind?: DeviceKind;
  host_kind?: "local" | "cloud";
  location?: string | null;
  tags?: string[];
  health?: "healthy" | "degraded" | "offline";
  status?: "active" | "disabled";
  concept_kind?: "fact" | "rule" | "term";
  body?: string;
  device_note: string;
}

export interface FileDirDescRecord {
  id: string;
  /** Stable device identity; `local` only means "the device running this process". */
  deviceId: string;
  deviceKind: DeviceKind;
  path: string;
  description: string;
  hostKind: "local" | "cloud";
  /** Present only when the directory is a git checkout; enables cross-device recall. */
  repoIdentity: RepoIdentity | null;
  useCount: number;
  status: "observed" | "promoted" | "revoked";
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  /** Set when an entry was withdrawn: who, why and when. */
  revokedBy?: string | null;
  revokedReason?: string | null;
  /** Shared taxonomy concept tag, non-identity metadata. */
  concept_kind: string | null;
  /** Human-readable rationale for why this directory matters (readability contract). */
  rationale?: string | null;
}

export type DeviceKind = "local" | "ssh" | "container" | "remote-workspace" | "cloud";

export interface RepoIdentity {
  /** Normalized remote URL, without credentials. */
  remoteUrl: string;
  /** Commit the place was last observed at, if known. */
  commit: string | null;
}

const DEVICE_KINDS = new Set<DeviceKind>(["local", "ssh", "container", "remote-workspace", "cloud"]);
/** Device ids are user-visible identifiers, not free-form prose. */
const DEVICE_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/u;

function normalizeDeviceId(value: unknown): string {
  if (value === undefined || value === null || value === "") return "local";
  if (typeof value !== "string") throw new Error("device_id must be a string");
  const trimmed = value.trim().toLowerCase();
  if (!DEVICE_ID.test(trimmed)) throw new Error("device_id must be 1-64 lowercase letters, digits, dot, dash or underscore");
  return trimmed;
}

function normalizeDeviceKind(value: unknown): DeviceKind {
  if (value === undefined || value === null || value === "") return "local";
  if (typeof value !== "string" || !DEVICE_KINDS.has(value as DeviceKind)) {
    throw new Error(`device_kind must be one of: ${[...DEVICE_KINDS].join(", ")}`);
  }
  return value as DeviceKind;
}

function normalizeTag(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("tag must be a non-empty string");
  const trimmed = value.trim();
  if (trimmed.length > 64) throw new Error("tag must be 64 characters or fewer");
  return trimmed;
}

function normalizeTags(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => normalizeTag(item)))];
}

function normalizeHealth(value: unknown): DeviceRecord["health"] {
  if (value === undefined || value === null) return "healthy";
  if (typeof value !== "string" || !new Set(["healthy", "degraded", "offline"]).has(value)) {
    throw new Error("health must be healthy, degraded or offline");
  }
  return value as DeviceRecord["health"];
}

function normalizeDeviceStatus(value: unknown): DeviceRecord["status"] {
  if (value === undefined || value === null) return "active";
  if (typeof value !== "string" || !new Set(["active", "disabled"]).has(value)) {
    throw new Error("status must be active or disabled");
  }
  return value as DeviceRecord["status"];
}

/** Canonicalize a host path so two spellings of the same directory never split into places. */
export function canonicalizePath(path: string): string {
  const trimmed = path.trim();
  if (!trimmed) throw new Error("path must be a non-empty string");
  const windowsRooted = /^[a-z]:[\\/]/iu.test(trimmed) || trimmed.startsWith("\\\\");
  let normalized: string;
  if (windowsRooted && win32.isAbsolute(trimmed)) normalized = win32.normalize(trimmed);
  else if (!isAbsolute(trimmed)) throw new Error("path must be an absolute path");
  else normalized = resolve(trimmed);
  return normalized.replace(/\/$/u, "").replace(/\\+$/u, "");
}

function toDeviceRecord(payload: JsonObject): DeviceRecord {
  return {
    id: String(payload.id),
    name: payload.name === undefined || payload.name === null ? null : String(payload.name),
    deviceKind: DEVICE_KINDS.has(payload.device_kind as DeviceKind) ? payload.device_kind as DeviceKind : "local",
    hostKind: payload.host_kind === "cloud" ? "cloud" : "local",
    location: payload.location === undefined || payload.location === null ? null : String(payload.location),
    tags: Array.isArray(payload.tags) ? payload.tags.map(String) : [],
    health: normalizeHealth(payload.health),
    lastSeenAt: payload.last_seen_at === undefined || payload.last_seen_at === null ? null : String(payload.last_seen_at),
    createdAt: String(payload.created_at),
    updatedAt: String(payload.updated_at),
    status: normalizeDeviceStatus(payload.status),
  };
}

function repoPayload(value: RepoIdentity | null): JsonObject | null {
  return value === null ? null : { remote_url: value.remoteUrl, commit: value.commit };
}

function toRecord(payload: JsonObject): FileDirDescRecord {
  return {
    id: String(payload.id),
    deviceId: String(payload.device_id ?? "local"),
    deviceKind: DEVICE_KINDS.has(payload.device_kind as DeviceKind) ? payload.device_kind as DeviceKind : "local",
    path: String(payload.path),
    description: String(payload.description),
    hostKind: payload.host_kind === "cloud" ? "cloud" : "local",
    repoIdentity: normalizeRepoIdentity(payload.repo_identity ?? null),
    useCount: Number(payload.use_count ?? 0),
    status: payload.status === "promoted" ? "promoted" : payload.status === "revoked" ? "revoked" : "observed",
    createdAt: String(payload.created_at),
    updatedAt: String(payload.updated_at),
    lastUsedAt: payload.last_used_at === undefined || payload.last_used_at === null ? null : String(payload.last_used_at),
    revokedBy: payload.revoked_by === undefined || payload.revoked_by === null ? null : String(payload.revoked_by),
    revokedReason: payload.revoked_reason === undefined || payload.revoked_reason === null ? null : String(payload.revoked_reason),
    concept_kind: payload.concept_kind === undefined || payload.concept_kind === null ? null : String(payload.concept_kind),
    rationale: payload.rationale === undefined || payload.rationale === null ? null : String(payload.rationale),
  };
}

function termMatch(haystack: string, needle: string): boolean {
  // A description resolves to a path when every whitespace-separated term in the
  // query appears in the stored description. Empty queries match nothing.
  const terms = needle.toLowerCase().split(/\s+/u).filter(Boolean);
  if (terms.length === 0) return false;
  const lower = haystack.toLowerCase();
  return terms.every((term) => lower.includes(term));
}

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

function boundedActor(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must name the operator`);
  const trimmed = value.trim();
  if (trimmed.length > 120 || /[\r\n\0]/u.test(trimmed)) throw new Error(`${name} must be a single line, 120 chars or fewer`);
  return trimmed;
}

function finiteLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return 50;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1_000) throw new Error("limit must be an integer between 1 and 1000");
  return parsed;
}

/** A disabled device must not make its places recallable. */
function deviceActive(store: CraftStore, deviceId: string): boolean {
  const record = store.find("device", deviceId);
  return record ? record.status === "active" : deviceId === "local";
}

export class FileDirDescRegistry {
  readonly store: CraftStore;
  readonly notes: CraftNotesRegistry;
  constructor(store: CraftStore, validateNoteText?: CraftNoteTextValidator) {
    this.store = store;
    this.notes = new CraftNotesRegistry(store, validateNoteText);
  }

  /** Register or update device metadata. Disabled devices stop being recallable. */
  registerDevice(args: RegisterDeviceArgs): DeviceRecord {
    const id = String(args.id ?? `device_${randomUUID()}`);
    const existing = this.store.find("device", id);
    if (existing?.status === "disabled" && args.status === "active" && !args.device_note?.trim()) {
      throw new Error("device reactivated requires a Device Note");
    }
    if (typeof args.device_note !== "string" || !args.device_note.trim()) throw new Error("device_note is required");
    this.notes.createDevice({ ...args, id, note: args.device_note });
    return toDeviceRecord(this.store.find("device", id)!);
  }

  /** Read one device's metadata. */
  device(id: string): DeviceRecord | null {
    const record = this.store.find("device", id);
    if (!record) return null;
    return toDeviceRecord(record);
  }

  /** Disable or re-enable a device; disabling stops its places from being recalled. */
  setDeviceStatus(id: string, status: "active" | "disabled"): DeviceRecord {
    const existing = this.store.find("device", id);
    if (!existing) throw new Error(`Unknown device: ${id}`);
    if (existing.status === "disabled" && status === "active") {
      const note = this.store.list("craft_note", Number.MAX_SAFE_INTEGER,
        (item) => item.subject_type === "device" && item.subject_key === id && item.status === "confirmed")[0];
      if (!note?.text) throw new Error("device cannot be reactivated without a confirmed Device Note");
    }
    const now = new Date().toISOString();
    const payload = { ...existing, status, updated_at: now,
      ...(status === "disabled" ? { health: "offline", last_seen_at: existing.last_seen_at } : { health: "healthy", last_seen_at: now }) };
    this.store.save("device", id, payload);
    return toDeviceRecord(payload);
  }

  /** List registered devices, optionally filtered by kind/host/status. */
  listDevices(args: JsonObject = {}): JsonObject {
    const kind = args.device_kind === undefined || args.device_kind === null ? null : normalizeDeviceKind(args.device_kind);
    const hostKind = args.host_kind === undefined || args.host_kind === null ? null : normalizeHostKind(args.host_kind);
    const status = args.status === undefined || args.status === null ? null : normalizeDeviceStatus(args.status);
    const items = this.store.list("device", 1_000, (item) => {
      const record = toDeviceRecord(item);
      return (kind === null || record.deviceKind === kind)
        && (hostKind === null || record.hostKind === hostKind)
        && (status === null || record.status === status);
    }).map(toDeviceRecord).sort((a, b) => b.updatedAt < a.updatedAt ? 1 : -1);
    return { items };
  }

  /** Disable a device so all its places stop being recallable, without deleting them. */
  disableDevice(id: string): DeviceRecord { return this.setDeviceStatus(id, "disabled"); }

  /** Re-enable a disabled device so its places become recallable again. */
  enableDevice(id: string): DeviceRecord { return this.setDeviceStatus(id, "active"); }

  /** Report health for one device. */
  reportDeviceHealth(id: string, health: "healthy" | "degraded" | "offline"): DeviceRecord {
    const existing = this.store.find("device", id);
    if (!existing) throw new Error(`Unknown device: ${id}`);
    const now = new Date().toISOString();
    const payload = { ...existing, health, last_seen_at: now, updated_at: now };
    this.store.save("device", id, payload);
    return toDeviceRecord(payload);
  }

  /**
   * Record (or reinforce) a directory↔description link. The first touch only
   * "observes" the path; repeat uses bump the count and promote it once it
   * crosses the threshold. An explicit `promote: true` forces promotion.
   *
   * This is the human-facing entry point: it is the one place where a
   * description may be corrected. Automatic reinforcement must go through
   * `observe`, which never rewrites the description.
   */
  record(args: JsonObject): JsonObject {
    const deviceId = normalizeDeviceId(args.device_id);
    const deviceKind = normalizeDeviceKind(args.device_kind);
    const path = normalizePath(args.path);
    const description = normalizeDescription(args.description);
    const hostKind = normalizeHostKind(args.host_kind);
    const repoIdentity = normalizeRepoIdentity(args.repo_identity);
    const conceptKind = args.concept_kind === undefined || args.concept_kind === null ? null : String(args.concept_kind);
    const rationale = args.rationale === undefined || args.rationale === null ? null : normalizeDescription(args.rationale);
    const forcePromote = args.promote === true;
    const now = new Date().toISOString();
    // A device that is disabled must not gain new places: a host that is gone
    // cannot be reasoned about, only re-enabled deliberately.
    const deviceRecord = this.store.find("device", deviceId);
    if (deviceRecord && String(deviceRecord.status) !== "active") throw new Error(`device ${deviceId} is not active; enable it before recording places`);
    // A predicate scan is not LIMIT-bound in the store, so use an effectively
    // unbounded cap: 1_000 would silently create duplicate entries per place.
    // The identity of a place is (device, path); two devices may legitimately
    // hold the same absolute path and must not be merged.
    const existing = this.store.list("file_dir_desc", Number.MAX_SAFE_INTEGER,
      (item) => item.path === path && String(item.device_id ?? "local") === deviceId)[0];
    if (existing) {
      const useCount = Number(existing.use_count ?? 0) + 1;
      // A withdrawn entry stays withdrawn: only an explicit promote revives it.
      const withdrawn = existing.status === "revoked";
      const promoted = !withdrawn && (forcePromote || useCount >= PROMOTION_USE_THRESHOLD);
      const payload = { ...existing, device_id: deviceId, device_kind: deviceKind, description, host_kind: hostKind,
        repo_identity: repoPayload(repoIdentity), use_count: useCount,
        status: withdrawn ? "revoked" : promoted ? "promoted" : "observed", updated_at: now, last_used_at: now,
        concept_kind: conceptKind ?? existing.concept_kind, rationale: rationale ?? existing.rationale };
      this.store.save("file_dir_desc", String(existing.id), payload);
      return toRecord(payload) as unknown as JsonObject;
    }
    const id = String(args.id ?? `fdd_${randomUUID()}`);
    const useCount = 1;
    const promoted = forcePromote || useCount >= PROMOTION_USE_THRESHOLD;
    const payload = { id, device_id: deviceId, device_kind: deviceKind, path, description, host_kind: hostKind,
      repo_identity: repoPayload(repoIdentity), use_count: useCount,
      status: promoted ? "promoted" : "observed", created_at: now, updated_at: now, last_used_at: now,
      concept_kind: conceptKind ?? null, rationale };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Automatic reinforcement from real use (NEEDREAD 13.2: "使用过才会存，用的多
   * 才会推到正式"). Unlike `record` this never rewrites the description - a later
   * task title is not the meaning of a directory - and it refuses to inflate an
   * entry that was withdrawn.
   */
  observe(args: JsonObject): JsonObject {
    const deviceId = normalizeDeviceId(args.device_id);
    const deviceKind = normalizeDeviceKind(args.device_kind);
    const path = normalizePath(args.path);
    const hostKind = normalizeHostKind(args.host_kind);
    const repoIdentity = normalizeRepoIdentity(args.repo_identity);
    const conceptKind = args.concept_kind === undefined || args.concept_kind === null ? null : String(args.concept_kind);
    const rationale = args.rationale === undefined || args.rationale === null ? null : normalizeDescription(args.rationale);
    const now = new Date().toISOString();
    const existing = this.store.list("file_dir_desc", Number.MAX_SAFE_INTEGER,
      (item) => item.path === path && String(item.device_id ?? "local") === deviceId)[0];
    if (existing) {
      const useCount = Number(existing.use_count ?? 0) + 1;
      const withdrawn = existing.status === "revoked";
      const promoted = !withdrawn && useCount >= PROMOTION_USE_THRESHOLD;
      const payload = { ...existing, device_id: deviceId, device_kind: deviceKind, host_kind: hostKind,
        repo_identity: repoPayload(repoIdentity) ?? existing.repo_identity ?? null, use_count: useCount,
        status: withdrawn ? "revoked" : promoted ? "promoted" : "observed", updated_at: now, last_used_at: now,
        concept_kind: existing.concept_kind ?? conceptKind ?? null,
        rationale: existing.rationale ?? rationale ?? null };
      this.store.save("file_dir_desc", String(existing.id), payload);
      return toRecord(payload) as unknown as JsonObject;
    }
    // Seeding needs a description; callers without one are recorded with the
    // directory's own name so the entry is still findable and reviewable.
    const description = args.description === undefined || args.description === null
      ? (path.split(/[\\/]/u).filter(Boolean).pop() ?? path)
      : normalizeDescription(args.description);
    const id = String(args.id ?? `fdd_${randomUUID()}`);
    const payload = { id, device_id: deviceId, device_kind: deviceKind, path, description, host_kind: hostKind,
      repo_identity: repoPayload(repoIdentity), use_count: 1, status: "observed", concept_kind: conceptKind ?? null, rationale,
      created_at: now, updated_at: now, last_used_at: now };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Relocate a directory after it moved (rename, clone, drive change). Identity
   * and accumulated use survive; the previous path is kept for audit. A conflict
   * with an existing entry for the new path is refused rather than merged away.
   */
  relocate(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const toPath = normalizePath(args.path);
    const existing = this.store.find("file_dir_desc", id);
    if (!existing) throw new Error(`Unknown file_dir_desc: ${id}`);
    // Relocation stays on the same device; moving a place to another machine is
    // a new place, not a rename.
    const deviceId = normalizeDeviceId(args.device_id ?? existing.device_id);
    if (deviceId !== String(existing.device_id ?? "local")) throw new Error("relocate cannot move a place to another device; record it on that device instead");
    const conflict = this.store.list("file_dir_desc", Number.MAX_SAFE_INTEGER,
      (item) => item.path === toPath && String(item.device_id ?? "local") === deviceId && String(item.id) !== id)[0];
    if (conflict) throw new Error(`another entry already describes ${toPath}; withdraw it first`);
    const now = new Date().toISOString();
    const payload = { ...existing, path: toPath, relocated_from: String(existing.path), relocated_at: now, updated_at: now,
      concept_kind: existing.concept_kind ?? null, rationale: existing.rationale ?? null };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /**
   * Withdraw an entry. Revocation is attributed and keeps the record: a
   * withdrawn directory must stop being recallable without losing the audit
   * trail that would let it be corrected or revived deliberately.
   */
  revoke(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const actor = boundedActor(args.revoked_by, "revoked_by");
    const reason = text(args.reason, "reason");
    const existing = this.store.find("file_dir_desc", id);
    if (!existing) throw new Error(`Unknown file_dir_desc: ${id}`);
    const now = new Date().toISOString();
    const conceptKind = args.concept_kind === undefined || args.concept_kind === null ? null : String(args.concept_kind);
    const rationale = args.rationale === undefined || args.rationale === null ? null : normalizeDescription(args.rationale);
    const payload = { ...existing, status: "revoked", revoked_by: actor, revoked_reason: reason,
      revoked_at: now, updated_at: now, concept_kind: conceptKind, rationale };
    this.store.save("file_dir_desc", id, payload);
    return toRecord(payload) as unknown as JsonObject;
  }

  /** Promote an observed entry regardless of use count (explicit user action). */
  promote(args: JsonObject): JsonObject {
    const id = text(args.id, "id");
    const existing = this.store.find("file_dir_desc", id);
    if (!existing) throw new Error(`Unknown file_dir_desc: ${id}`);
    const now = new Date().toISOString();
    const conceptKind = args.concept_kind === undefined || args.concept_kind === null ? null : String(args.concept_kind);
    const rationale = args.rationale === undefined || args.rationale === null ? null : normalizeDescription(args.rationale);
    this.store.save("file_dir_desc", id, { ...existing, status: "promoted", updated_at: now,
      revoked_by: null, revoked_reason: null, concept_kind: conceptKind ?? existing.concept_kind ?? null,
      rationale: rationale ?? existing.rationale ?? null });
    const saved = this.store.find("file_dir_desc", id);
    if (!saved) throw new Error(`Promoted entry ${id} disappeared`);
    return toRecord(saved) as unknown as JsonObject;
  }

  /**
   * Bidirectional resolve. With `description`, return ranked matching places
   * (only promoted entries on active devices are recallable; observed ones are
   * too noisy). With `path`, return the names for that path.
   *
   * Recall is device-scoped by default: a place on another machine is not
   * returned unless the caller either asks for that device explicitly or the
   * record carries a repository identity that matches `repo_identity`. That is
   * the only case where two devices legitimately describe the same place.
   */
  resolve(args: JsonObject): JsonObject {
    if (args.description !== undefined && args.description !== null) {
      const description = normalizeDescription(args.description);
      const limit = finiteLimit(args.limit);
      const deviceId = args.device_id === undefined || args.device_id === null ? null : normalizeDeviceId(args.device_id);
      const repoIdentity = normalizeRepoIdentity(args.repo_identity);
      const matches = this.store
        .list("file_dir_desc", 1_000, (item) => item.status === "promoted"
          && termMatch(String(item.description), description)
          && (deviceId === null ? true : String(item.device_id ?? "local") === deviceId)
          && (repoIdentity === null ? true : sameRepo(item.repo_identity, repoIdentity))
          && (String(item.status) !== "revoked" ? deviceActive(this.store, String(item.device_id ?? "local")) : true))
        .map(toRecord)
        .sort((a, b) => b.useCount - a.useCount);
      return { kind: "by_description", query: description, results: matches.slice(0, limit) };
    }
    if (args.path !== undefined && args.path !== null) {
      const path = normalizePath(args.path);
      const deviceId = args.device_id === undefined || args.device_id === null ? null : normalizeDeviceId(args.device_id);
      const entries = this.store.list("file_dir_desc", 1_000, (item) => item.path === path
        && (deviceId === null ? true : String(item.device_id ?? "local") === deviceId)
        && (String(item.status) !== "revoked" ? deviceActive(this.store, String(item.device_id ?? "local")) : true)).map(toRecord);
      return { kind: "by_path", path, results: entries };
    }
    throw new Error("resolve requires description or path");
  }

  list(args: JsonObject = {}): JsonObject {
    const status = args.status === "observed" || args.status === "promoted" || args.status === "revoked" ? args.status : null;
    const hostKind = args.host_kind === "cloud" ? "cloud" : args.host_kind === "local" ? "local" : null;
    const deviceId = args.device_id === undefined || args.device_id === null ? null : normalizeDeviceId(args.device_id);
    const limit = finiteLimit(args.limit);
    const items = this.store
      // The predicate scan ignores SQL LIMIT, so this bound only guards the
      // in-memory sort; a small cap here would hide entries from `record`.
      .list("file_dir_desc", Number.MAX_SAFE_INTEGER, (item) => (status === null || item.status === status)
        && (hostKind === null || (hostKind === "cloud" ? item.host_kind === "cloud" : item.host_kind !== "cloud"))
        && (deviceId === null || String(item.device_id ?? "local") === deviceId))
      .map(toRecord)
      .sort((a, b) => b.useCount - a.useCount || (a.updatedAt < b.updatedAt ? 1 : -1));
    return { items: items.slice(0, limit) };
  }
}

/** Two places describe the same repository when their normalized remotes agree. */
function sameRepo(value: unknown, expected: RepoIdentity): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const item = value as JsonObject;
  const remote = String(item.remote_url ?? "").trim().replace(/\.git$/iu, "").replace(/\/+$/u, "");
  const wanted = expected.remoteUrl.trim().replace(/\.git$/iu, "").replace(/\/+$/u, "");
  return remote === wanted;
}

/** Reject credentials in a remote URL; the registry stores identity, never secrets. */
function normalizeRepoIdentity(value: unknown): RepoIdentity | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "object" || Array.isArray(value)) throw new Error("repo_identity must be an object");
  const item = value as JsonObject;
  // A stored record may carry an empty placeholder; treat it as "no repository"
  // instead of failing to read back an otherwise valid place.
  if (item.remote_url === undefined || item.remote_url === null || item.remote_url === "") return null;
  const remoteUrl = String(item.remote_url ?? "").trim();
  if (!remoteUrl) throw new Error("repo_identity.remote_url must be a non-empty string");
  if (/\/\/[^/@\s]+:[^/@\s]+@/u.test(remoteUrl)) throw new Error("repo_identity.remote_url must not contain credentials");
  if (remoteUrl.length > 500) throw new Error("repo_identity.remote_url must be 500 characters or fewer");
  const commit = item.commit === undefined || item.commit === null ? null : String(item.commit).trim();
  if (commit !== null && !/^[0-9a-f]{7,64}$/iu.test(commit)) throw new Error("repo_identity.commit must be a hexadecimal object id");
  return { remoteUrl, commit };
}

function normalizePath(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("path must be a non-empty string");
  const trimmed = value.trim();
  // Directory hints may describe a remote Windows workspace even when the
  // local Craft process runs on POSIX. Preserve that path with Windows rules;
  // never resolve it relative to the current host's working directory.
  const windowsRooted = /^[a-z]:[\\/]/iu.test(trimmed) || trimmed.startsWith("\\\\");
  if (windowsRooted && win32.isAbsolute(trimmed)) return win32.normalize(trimmed);
  // Reject relative paths before resolving: resolve() would silently anchor a
  // relative path to the process cwd and wrongly accept it.
  if (!isAbsolute(trimmed)) throw new Error("path must be an absolute path");
  return resolve(trimmed);
}

function normalizeDescription(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error("description must be a non-empty string");
  const trimmed = value.trim().replace(/\s+/gu, " ");
  if (trimmed.length > 500) throw new Error("description must be 500 characters or fewer");
  return trimmed;
}

function normalizeHostKind(value: unknown): "local" | "cloud" {
  if (value === undefined || value === null || value === "local") return "local";
  if (value === "cloud") return "cloud";
  throw new Error("host_kind must be local or cloud");
}
