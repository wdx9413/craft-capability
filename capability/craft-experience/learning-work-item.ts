import { randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from "craft-common-store-local/store";
import { payload, stableDigest } from "craft-common-base/digest";
import { normalizeSourceLineage } from "./workflow-evolution.ts";

export type ExperienceLearningWorkItemStage = "evaluation_contract" | "shadow" | "held_out" | "signoff" | "canary" | "completed";
export type ExperienceLearningWorkItemStatus = "queued" | "processing" | "blocked" | "failed" | "completed" | "revoked";

export interface ExperienceCandidateRef extends JsonObject {
  kind: "experience_procedure";
  id: string;
  version: number;
  digest: string;
}

export interface ExperienceEvaluationContractRef extends JsonObject {
  kind: "evaluation_contract";
  id: string;
  version: number;
  digest: string;
}

export interface ExperienceLearningWorkItem extends JsonObject {
  candidate_ref: ExperienceCandidateRef;
  evaluation_contract_ref: ExperienceEvaluationContractRef | null;
  scope: string;
  source_refs: JsonObject[];
  source_lineage?: JsonObject[];
  replay_run_id?: string;
  stage: ExperienceLearningWorkItemStage;
  status: ExperienceLearningWorkItemStatus;
}

const STAGES = ["shadow", "held_out", "signoff", "canary", "completed"] as const;
const REASONS = new Set([
  "source_unavailable", "evaluation_contract_unavailable", "evaluation_adapter_unavailable",
  "worker_unavailable", "manual_review_required", "evidence_unavailable", "evaluation_gate_failed",
]);
const ID = /^[A-Za-z0-9._:-]{1,192}$/u;
const SHA256 = /^sha256:[a-f0-9]{64}$/iu;

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function text(value: unknown, name: string, max = 192): string {
  if (typeof value !== "string" || !value.trim() || value.length > max || /[\r\n\0]/u.test(value)) {
    throw new Error(`${name} is invalid`);
  }
  return value.trim();
}

function nowValue(value: unknown): string {
  const result = value === undefined ? new Date().toISOString() : text(value, "now", 40);
  if (Number.isNaN(Date.parse(result))) throw new Error("now must be an ISO timestamp");
  return result;
}

function versionedRef(value: unknown, kind: string, name: string): JsonObject {
  const ref = object(value, name);
  if (Object.keys(ref).some(key => !["kind", "id", "version", "digest"].includes(key))
    || ref.kind !== kind || typeof ref.id !== "string" || !ID.test(ref.id)
    || !Number.isSafeInteger(ref.version) || Number(ref.version) < 1
    || typeof ref.digest !== "string" || !SHA256.test(ref.digest)) throw new Error(`${name} is invalid`);
  return { kind, id: ref.id, version: Number(ref.version), digest: String(ref.digest).toLowerCase() };
}

function candidateDigest(candidate: JsonObject): string {
  const value = candidate.definition_digest ?? candidate.content_digest ?? candidate.identity_digest;
  if (typeof value !== "string" || !SHA256.test(value)) throw new Error("Experience Candidate digest is unavailable");
  return value.toLowerCase();
}

function candidateReference(value: unknown): ExperienceCandidateRef {
  return versionedRef(value, "experience_procedure", "candidate_ref") as ExperienceCandidateRef;
}

function contractReference(value: unknown): ExperienceEvaluationContractRef {
  return versionedRef(value, "evaluation_contract", "evaluation_contract_ref") as ExperienceEvaluationContractRef;
}

function itemId(ref: ExperienceCandidateRef, sourceLineage?: JsonObject[]): string {
  return `experience_learning_work_item_${stableDigest(sourceLineage?.length ? { candidate_ref: ref, source_lineage: sourceLineage } : ref).slice(-24)}`;
}

function replayRunIds(sourceLineage: JsonObject[]): string[] {
  return [...new Set(sourceLineage.flatMap(entry => entry.origin === "historical_replay" && typeof entry.replay_run_id === "string"
    ? [entry.replay_run_id] : []))].sort();
}

function contractDigest(contract: JsonObject): string {
  const digest = contract.contract_digest;
  if (typeof digest !== "string" || !SHA256.test(digest)) throw new Error("Evaluation Contract digest is invalid");
  return digest.toLowerCase();
}

function clearLease(item: JsonObject): JsonObject {
  return { ...payload(item), lease_owner: null, lease_token: null, lease_expires_at: null };
}

/**
 * Durable, candidate-level owner queue. Evaluation dispatch records are child
 * attempts; this record pins the Candidate and owns recovery across worker restarts.
 */
export class ExperienceLearningWorkItemOwner {
  readonly store: CraftStore;
  private evaluationContracts: Pick<CraftStore, "get">;

  constructor(store: CraftStore, evaluationContracts: Pick<CraftStore, "get"> = store) {
    this.store = store;
    this.evaluationContracts = evaluationContracts;
  }

  setEvaluationContractSource(source: Pick<CraftStore, "get">): void {
    if (!source || typeof source.get !== "function") throw new Error("Evaluation Contract owner is unavailable");
    this.evaluationContracts = source;
  }

  /** Atomically accept a sanitized Candidate and pin its one project-level queue record. */
  enqueue(args: JsonObject): JsonObject {
    return this.store.transaction(() => this.enqueueInTransaction(args));
  }

  enqueueInTransaction(args: JsonObject): JsonObject {
    const scope = text(args.scope, "scope", 110);
    if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scope)) throw new Error("Learning Work Item requires a canonical project scope");
    const ref = candidateReference(args.candidate_ref);
    // Replay cleanup advances the storage version without changing the pinned candidate version or digest.
    const candidate = this.store.find("experience_procedure", ref.id);
    if (!candidate || candidate.scope !== scope || candidate.provenance !== "explicit_trace_distillation"
      || candidate.lifecycle !== "candidate" || candidate.routeable === true || candidate.publication_allowed === true
      || Number(candidate.candidate_version ?? candidate.version) !== ref.version || candidateDigest(candidate) !== ref.digest) {
      throw new Error("Learning Work Item Candidate reference is unavailable or not an unrouteable Trace Candidate");
    }
    if (!Array.isArray(args.source_refs) || stableDigest(args.source_refs) !== stableDigest(candidate.source_refs)) {
      throw new Error("Learning Work Item sources must match the exact Candidate source references");
    }
    const sourceRefs = structuredClone(args.source_refs as JsonObject[]);
    let candidateLineage: JsonObject[] | undefined;
    let sourceLineage: JsonObject[] | undefined;
    if (candidate.source_lineage !== undefined) {
      candidateLineage = normalizeSourceLineage(candidate.source_lineage, this.store, true);
      if (args.source_lineage !== undefined) {
        const suppliedLineage = normalizeSourceLineage(args.source_lineage, this.store, true);
        if (stableDigest(suppliedLineage) !== stableDigest(candidateLineage)) {
          throw new Error("Learning Work Item lineage must match the exact Candidate source lineage");
        }
      }
      if (candidateLineage.some(entry => entry.origin === "historical_replay")) sourceLineage = candidateLineage;
    } else if (args.source_lineage !== undefined) {
      throw new Error("Learning Work Item lineage must match the exact Candidate source lineage");
    }
    const runIds = sourceLineage ? replayRunIds(sourceLineage) : [];
    const replayRunId = runIds.length === 1 ? runIds[0] : undefined;
    if (args.replay_run_id !== undefined && args.replay_run_id !== replayRunId) {
      throw new Error("Learning Work Item replay_run_id must match its exact historical source lineage");
    }
    const contractRef = args.evaluation_contract_ref === undefined || args.evaluation_contract_ref === null
      ? null : this.validateContract(args.evaluation_contract_ref, ref);
    const id = itemId(ref, sourceLineage);
    const immutable = { candidate_ref: ref, scope, source_refs: sourceRefs,
      ...(sourceLineage ? { source_lineage: sourceLineage, ...(replayRunId ? { replay_run_id: replayRunId } : {}) } : {}) };
    const intentDigest = stableDigest(immutable);
    let existing = this.store.find("experience_learning_work_item", id);
    let foundAfterReplayCleanup = false;
    if (!existing) {
      const sameCandidateItems = this.store.list("experience_learning_work_item", 10_000, item =>
        stableDigest(item.candidate_ref) === stableDigest(ref) && item.scope === scope
        && (item.source_refs_cleanup_applied === true || stableDigest(item.source_refs) === stableDigest(sourceRefs)));
      // Match the full remaining lineage; persisted items may retain live refs absent from their identity.
      const currentLineage = candidateLineage ?? [];
      const cleanupAdjusted = sameCandidateItems.filter(item => {
        const priorLineage = Array.isArray(item.source_lineage)
          ? normalizeSourceLineage(item.source_lineage, this.store, true) : [];
        return stableDigest(priorLineage) === stableDigest(currentLineage);
      });
      if (cleanupAdjusted.length === 1) {
        existing = cleanupAdjusted[0]!;
        foundAfterReplayCleanup = true;
      } else if (cleanupAdjusted.length > 1) {
        throw new Error("Experience Learning Work Item is ambiguous after replay lineage cleanup");
      }
    }
    if (existing) {
      if (!foundAfterReplayCleanup && existing.intent_digest !== intentDigest) {
        throw new Error("Experience Learning Work Item idempotency conflict");
      }
      const expectedContract = contractRef;
      if (stableDigest(existing.evaluation_contract_ref ?? null) !== stableDigest(expectedContract)) {
        throw new Error("Experience Learning Work Item Evaluation Contract binding conflict");
      }
      return { work_item: existing, idempotent: true };
    }
    const stage: ExperienceLearningWorkItemStage = contractRef ? "shadow" : "evaluation_contract";
    const status: ExperienceLearningWorkItemStatus = contractRef ? "queued" : "blocked";
    const workItem = this.store.create("experience_learning_work_item", id, {
      ...immutable, idempotency_key: id, intent_digest: intentDigest, evaluation_contract_ref: contractRef,
      stage, status, blocked_reason: contractRef ? null : "evaluation_contract_unavailable",
      failure_reason: null, retryable: false, attempts: 0, lease_owner: null, lease_token: null, lease_expires_at: null,
      active_dispatch_ref: null, completed_gate_refs: [], created_at: nowValue(args.now), updated_at: nowValue(args.now),
      raw_content_stored: false,
    });
    return { work_item: workItem, idempotent: false };
  }

  get(args: JsonObject): JsonObject {
    return { work_item: this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id")) };
  }

  findForCandidate(value: unknown, sourceLineage?: unknown): JsonObject | null {
    const ref = candidateReference(value);
    if (sourceLineage !== undefined) {
      const lineage = normalizeSourceLineage(sourceLineage, this.store, true);
      const replayLineage = lineage.some(entry => entry.origin === "historical_replay") ? lineage : undefined;
      const byIdentity = this.store.find("experience_learning_work_item", itemId(ref, replayLineage));
      if (byIdentity) return byIdentity;
    }
    const candidate = this.store.find("experience_procedure", ref.id);
    const lineage = candidate?.source_lineage === undefined
      ? undefined : normalizeSourceLineage(candidate.source_lineage, this.store, true);
    const replayLineage = lineage?.some(entry => entry.origin === "historical_replay") ? lineage : undefined;
    const byIdentity = this.store.find("experience_learning_work_item", itemId(ref, replayLineage));
    if (byIdentity) return byIdentity;
    const matches = this.store.list("experience_learning_work_item", 10_000,
      item => stableDigest(item.candidate_ref) === stableDigest(ref));
    if (matches.length === 1) return matches[0]!;
    const currentLineage = lineage ?? [];
    const sameCurrentLineage = matches.filter(item => {
      const itemLineage = Array.isArray(item.source_lineage)
        ? normalizeSourceLineage(item.source_lineage, this.store, true) : [];
      return stableDigest(itemLineage) === stableDigest(currentLineage)
        || !itemLineage.some(entry => entry.origin === "historical_replay")
          && !currentLineage.some(entry => entry.origin === "historical_replay");
    });
    if (sameCurrentLineage.length === 1) return sameCurrentLineage[0]!;
    if (matches.length > 1) throw new Error("Candidate has multiple Learning Work Items; provide source_lineage");
    return null;
  }

  listPending(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    const now = nowValue(args.now);
    const items = this.store.list("experience_learning_work_item", 100_000, item =>
      item.status === "queued" || item.status === "processing" && typeof item.lease_expires_at === "string"
        && Date.parse(item.lease_expires_at) <= Date.parse(now))
      .sort((left, right) => `${String(left.created_at)}\0${String(left.id)}`.localeCompare(`${String(right.created_at)}\0${String(right.id)}`))
      .slice(0, limit);
    return { items, count: items.length };
  }

  /** Claim one item and fence a previous worker whose lease expired during a pause. */
  claimNext(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const worker = text(args.worker_id, "worker_id", 128);
      const now = nowValue(args.now), leaseMs = args.lease_ms === undefined ? 300_000 : Number(args.lease_ms);
      if (!Number.isSafeInteger(leaseMs) || leaseMs < 1_000 || leaseMs > 3_600_000) {
        throw new Error("lease_ms must be an integer between 1000 and 3600000");
      }
      const pending = this.listPending({ now, limit: 1 }).items as JsonObject[];
      const current = pending[0];
      if (!current) {
        const blocked = this.store.list("experience_learning_work_item", 100_000, item => item.status === "blocked")
          .sort((left, right) => `${String(left.created_at)}\0${String(left.id)}`.localeCompare(`${String(right.created_at)}\0${String(right.id)}`))[0];
        return blocked
          ? { status: "blocked", work_item: blocked, blocked_reason: blocked.blocked_reason ?? "learning_work_item_blocked" }
          : { status: "idle", work_item: null };
      }
      const token = randomUUID();
      this.cancelActiveDispatch(current, "lease_expired");
      const claimed = this.store.updateIfVersion("experience_learning_work_item", String(current.id), Number(current.version), {
        ...payload(current), status: "processing", attempts: Number(current.attempts ?? 0) + 1,
        lease_owner: worker, lease_token: token, lease_expires_at: new Date(Date.parse(now) + leaseMs).toISOString(),
        active_dispatch_ref: null, blocked_reason: null, updated_at: now,
      });
      return { status: "claimed", work_item: claimed, lease_token: token };
    });
  }

  attachEvaluationDispatch(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const item = this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id"));
      this.assertLease(item, args);
      const dispatch = this.store.get("experience_evaluation_dispatch", text(args.dispatch_id, "dispatch_id"));
      const candidateRef = item.candidate_ref as ExperienceCandidateRef;
      const candidate = this.store.get("experience_procedure", candidateRef.id);
      if (candidateDigest(candidate) !== candidateRef.digest
        || Number(candidate.candidate_version ?? candidate.version) !== candidateRef.version) {
        throw new Error("Evaluation dispatch Candidate has drifted from the pinned Learning Work Item");
      }
      if (dispatch.learning_work_item_id !== item.id || dispatch.stage !== item.stage
        || dispatch.procedure_id !== candidateRef.id
        || Number(dispatch.procedure_version) !== Number(candidate.version)) {
        throw new Error("Evaluation dispatch does not match the claimed Learning Work Item");
      }
      const ref = { kind: "experience_evaluation_dispatch", id: String(dispatch.id), version: Number(dispatch.version), digest: stableDigest(dispatch), lease_token_digest: stableDigest(item.lease_token) };
      const prior = item.active_dispatch_ref as JsonObject | null | undefined;
      if (prior && stableDigest(prior) !== stableDigest(ref)) throw new Error("Learning Work Item already has a different active Evaluation dispatch");
      const saved = prior ? item : this.store.updateIfVersion("experience_learning_work_item", String(item.id), Number(item.version), {
        ...payload(item), active_dispatch_ref: ref, updated_at: nowValue(args.now),
      });
      return { work_item: saved, dispatch_ref: ref, idempotent: Boolean(prior) };
    });
  }

  assertDispatchClaim(args: JsonObject, stage: ExperienceLearningWorkItemStage, procedure: JsonObject): JsonObject {
    const item = this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id"));
    this.assertLease(item, args);
    const ref = item.candidate_ref as JsonObject;
    if (item.stage !== stage || !item.evaluation_contract_ref || ref.id !== procedure.id
      || ref.digest !== candidateDigest(procedure) || Number(ref.version) !== Number(procedure.candidate_version ?? procedure.version)) {
      throw new Error("Evaluation dispatch requires a claimed Work Item for the exact Candidate stage");
    }
    this.validateContract(item.evaluation_contract_ref, ref as ExperienceCandidateRef);
    return item;
  }

  /** Advance only from the exact successful gate already recorded by Experience. */
  advance(args: JsonObject): JsonObject {
    return this.store.transaction(() => this.advanceInTransaction(args));
  }

  advanceInTransaction(args: JsonObject): JsonObject {
    const item = this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id"));
    if (item.status === "revoked") throw new Error("Revoked Learning Work Item cannot advance");
    const gateId = text(args.gate_id, "gate_id");
    const gate = this.store.get("experience_procedure_gate", gateId);
    const priorGates = item.completed_gate_refs as JsonObject[] | undefined;
    if (Array.isArray(priorGates) && priorGates.some(ref => ref.id === gate.id)) {
      return { work_item: item, idempotent: true };
    }
    const stage = String(item.stage);
    if (!(STAGES as readonly string[]).includes(stage) || stage === "completed" || gate.stage !== stage || gate.passed !== true
      || gate.procedure_id !== (item.candidate_ref as JsonObject).id || !Array.isArray(gate.evidence_ids) || !gate.evidence_ids.length) {
      throw new Error("Learning Work Item requires the exact passed stage Gate and its Evidence");
    }
    const candidate = this.store.find("experience_procedure", String(gate.procedure_id));
    if (!candidate || candidateDigest(candidate) !== (item.candidate_ref as JsonObject).digest
      || Number(candidate.candidate_version ?? candidate.version) !== Number((item.candidate_ref as JsonObject).version)
      || !Array.isArray(candidate.completed_gates) || !(candidate.completed_gates as string[]).includes(stage)) {
      throw new Error("Learning Work Item Candidate has not committed this Gate");
    }
    const previous = STAGES.slice(0, STAGES.indexOf(stage as typeof STAGES[number]));
    if (!previous.every(value => (candidate.completed_gates as string[]).includes(value))) {
      throw new Error("Learning Work Item Candidate Gate order is incomplete");
    }
    const nextStage = STAGES[STAGES.indexOf(stage as typeof STAGES[number]) + 1]!;
    const done = nextStage === "completed";
    if (done && (candidate.routeable !== true || candidate.lifecycle !== "routeable")) {
      throw new Error("Canary Gate did not make the exact Candidate routeable");
    }
    if (!done && candidate.routeable === true) throw new Error("Candidate became routeable before the Canary Gate");
    this.assertGateDispatch(item, gate, args);
    const gateRef = { kind: "experience_procedure_gate", id: String(gate.id), version: Number(gate.version), digest: stableDigest(gate) };
    const saved = this.store.updateIfVersion("experience_learning_work_item", String(item.id), Number(item.version), {
      ...clearLease(item), stage: nextStage, status: done ? "completed" : "queued",
      blocked_reason: null, failure_reason: null, retryable: false, active_dispatch_ref: null,
      completed_gate_refs: [...(Array.isArray(priorGates) ? priorGates : []), gateRef], updated_at: nowValue(args.now),
    });
    return { work_item: saved, idempotent: false };
  }

  failFromGate(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const item = this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id"));
      if (item.status === "revoked") throw new Error("Revoked Learning Work Item cannot accept a Gate result");
      const gate = this.store.get("experience_procedure_gate", text(args.gate_id, "gate_id"));
      if (gate.passed === false && item.failed_gate_id === gate.id) return { work_item: item, idempotent: true };
      if (gate.stage !== item.stage || gate.passed !== false || gate.procedure_id !== (item.candidate_ref as JsonObject).id
        || !Array.isArray(gate.evidence_ids) || !gate.evidence_ids.length) {
        throw new Error("Learning Work Item requires the exact failed stage Gate and its Evidence");
      }
      const candidate = this.store.find("experience_procedure", String(gate.procedure_id));
      if (!candidate || candidateDigest(candidate) !== (item.candidate_ref as JsonObject).digest
        || Number(candidate.candidate_version ?? candidate.version) !== Number((item.candidate_ref as JsonObject).version)
        || candidate.routeable === true) throw new Error("Failed Gate does not match the pinned Candidate");
      this.assertGateDispatch(item, gate, args);
      const saved = this.store.updateIfVersion("experience_learning_work_item", String(item.id), Number(item.version), {
        ...clearLease(item), status: "failed", failure_reason: "evaluation_gate_failed", retryable: false,
        failed_gate_id: gate.id, active_dispatch_ref: null, updated_at: nowValue(args.now),
      });
      return { work_item: saved, idempotent: false };
    });
  }

  block(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const item = this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id"));
      this.assertLease(item, args);
      const reason = text(args.reason, "reason", 64);
      if (!REASONS.has(reason)) throw new Error("Learning Work Item blocked reason is unsupported");
      this.cancelActiveDispatch(item, "work_item_blocked");
      const saved = this.store.updateIfVersion("experience_learning_work_item", String(item.id), Number(item.version), {
        ...clearLease(item), status: "blocked", blocked_reason: reason, failure_reason: null,
        retryable: true, active_dispatch_ref: null, updated_at: nowValue(args.now),
      });
      return { work_item: saved };
    });
  }

  fail(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const item = this.store.get("experience_learning_work_item", text(args.work_item_id, "work_item_id"));
      this.assertLease(item, args);
      const reason = text(args.reason, "reason", 64);
      if (!REASONS.has(reason)) throw new Error("Learning Work Item failure reason is unsupported");
      this.cancelActiveDispatch(item, "work_item_failed");
      const saved = this.store.updateIfVersion("experience_learning_work_item", String(item.id), Number(item.version), {
        ...clearLease(item), status: "failed", blocked_reason: null, failure_reason: reason,
        retryable: args.retryable === true, active_dispatch_ref: null, updated_at: nowValue(args.now),
      });
      return { work_item: saved };
    });
  }

  resume(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const id = text(args.work_item_id, "work_item_id"), item = this.store.get("experience_learning_work_item", id);
      if (!Number.isSafeInteger(args.expected_version) || Number(args.expected_version) !== Number(item.version)) {
        throw new Error("Learning Work Item expected_version is invalid or stale");
      }
      if (item.status !== "blocked" && !(item.status === "failed" && item.retryable === true)) {
        throw new Error("Only blocked or retryable failed Learning Work Items can resume");
      }
      this.assertCandidateCurrent(item);
      if (!item.evaluation_contract_ref) throw new Error("Learning Work Item cannot resume before its Evaluation Contract is bound");
      this.validateContract(item.evaluation_contract_ref, item.candidate_ref as ExperienceCandidateRef);
      const saved = this.store.updateIfVersion("experience_learning_work_item", id, Number(item.version), {
        ...clearLease(item), status: "queued", blocked_reason: null, failure_reason: null, retryable: false,
        active_dispatch_ref: null, updated_at: nowValue(args.now),
      });
      return { work_item: saved, idempotent: false };
    });
  }

  bindEvaluationContract(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const id = text(args.work_item_id, "work_item_id"), item = this.store.get("experience_learning_work_item", id);
      const ref = this.validateContract(args.evaluation_contract_ref, item.candidate_ref as ExperienceCandidateRef);
      if (item.evaluation_contract_ref && stableDigest(item.evaluation_contract_ref) === stableDigest(ref)) {
        return { work_item: item, idempotent: true };
      }
      if (!Number.isSafeInteger(args.expected_version) || Number(args.expected_version) !== Number(item.version)) {
        throw new Error("Learning Work Item expected_version is invalid or stale");
      }
      if (item.stage !== "evaluation_contract" || item.status !== "blocked" || item.evaluation_contract_ref !== null) {
        throw new Error("Evaluation Contract may bind only once before the first learning stage");
      }
      const saved = this.store.updateIfVersion("experience_learning_work_item", id, Number(item.version), {
        ...payload(item), evaluation_contract_ref: ref, stage: "shadow", status: "queued",
        blocked_reason: null, updated_at: nowValue(args.now),
      });
      return { work_item: saved, idempotent: false };
    });
  }

  private assertLease(item: JsonObject, args: JsonObject): void {
    const now = nowValue(args.now);
    if (item.status !== "processing" || item.lease_owner !== text(args.worker_id, "worker_id", 128)
      || item.lease_token !== text(args.lease_token, "lease_token", 128)
      || typeof item.lease_expires_at !== "string" || !Number.isFinite(Date.parse(item.lease_expires_at)) || Date.parse(item.lease_expires_at) <= Date.parse(now)) {
      throw new Error("Learning Work Item lease is missing, expired, or owned by another worker");
    }
  }

  private cancelActiveDispatch(item: JsonObject, reason: string): void {
    const ref = item.active_dispatch_ref as JsonObject | null | undefined;
    if (typeof ref?.id !== "string") return;
    const previous = this.store.find("experience_evaluation_dispatch", ref.id);
    if (previous?.status === "awaiting_adapter") this.store.save("experience_evaluation_dispatch", ref.id, { ...payload(previous), status: "cancelled", cancellation_reason: reason });
  }

  private assertGateDispatch(item: JsonObject, gate: JsonObject, args: JsonObject): void {
    const ref = item.active_dispatch_ref as JsonObject | null | undefined;
    const at = nowValue(args.now);
    if (item.status !== "processing" || typeof item.lease_token !== "string" || typeof item.lease_expires_at !== "string"
      || args.worker_id !== item.lease_owner || args.lease_token !== item.lease_token
      || !Number.isFinite(Date.parse(item.lease_expires_at)) || Date.parse(item.lease_expires_at) <= Date.parse(at) || !ref || ref.lease_token_digest !== stableDigest(item.lease_token)
      || typeof ref.id !== "string") throw new Error("Learning Work Item requires an active dispatch and unexpired lease");
    const original = this.store.find("experience_evaluation_dispatch", ref.id, Number(ref.version));
    const dispatch = this.store.find("experience_evaluation_dispatch", ref.id);
    if (!original || stableDigest(original) !== ref.digest || !dispatch || dispatch.learning_work_item_id !== item.id
      || dispatch.stage !== item.stage || dispatch.procedure_id !== (item.candidate_ref as JsonObject).id
      || dispatch.gate_id !== gate.id || dispatch.status !== (gate.passed === true ? "passed" : "failed")) {
      throw new Error("Learning Work Item Gate does not match its active dispatch");
    }
  }

  private assertCandidateCurrent(item: JsonObject): JsonObject {
    const ref = item.candidate_ref as JsonObject;
    const candidate = this.store.find("experience_procedure", String(ref.id));
    if (!candidate || candidateDigest(candidate) !== ref.digest || Number(candidate.candidate_version ?? candidate.version) !== Number(ref.version)
      || candidate.provenance !== "explicit_trace_distillation" || candidate.routeable === true
      || candidate.lifecycle === "rejected" || candidate.lifecycle === "rolled_back") {
      throw new Error("Learning Work Item Candidate changed or is no longer eligible");
    }
    return candidate;
  }

  private validateContract(value: unknown, ref: ExperienceCandidateRef): ExperienceEvaluationContractRef {
    const contractRef = contractReference(value);
    const contract = this.evaluationContracts.get("evaluation_contract", contractRef.id, contractRef.version);
    if (contractDigest(contract) !== contractRef.digest || contract.effect !== "task_effect"
      || contract.capability_id !== `experience-procedure:${ref.id}` || Number(contract.capability_version) !== ref.version
      || (contract.task_effect as JsonObject | undefined)?.candidate_family !== "experience_procedure") {
      throw new Error("Evaluation Contract must be pinned to the exact Experience Candidate");
    }
    const pinnedCandidate = (contract.task_effect as JsonObject).candidate_ref;
    if (pinnedCandidate !== undefined && stableDigest(pinnedCandidate) !== stableDigest(ref)) {
      throw new Error("Evaluation Contract Candidate digest does not match the exact Candidate reference");
    }
    return contractRef;
  }
}

/** Stable owner-local item id, exposed so the Host can correlate a captured Candidate. */
export function experienceLearningWorkItemId(candidateRef: ExperienceCandidateRef, sourceLineage?: JsonObject[]): string {
  return itemId(candidateReference(candidateRef), sourceLineage?.some(entry => entry.origin === "historical_replay") ? sourceLineage : undefined);
}
