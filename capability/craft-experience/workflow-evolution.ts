import { validateGraphControl } from "./procedure-graph.ts";
import { randomUUID } from "node:crypto";
import { CraftStore, type JsonObject } from 'craft-common-store-local/store';
import { validateProcedureComposition } from "./procedure-composition.ts";
import { stableDigest, payload } from 'craft-common-base/digest';

const OUTCOMES = new Set(["passed", "failed", "inconclusive"]);
const AXES = new Set(["context", "tools", "generation", "orchestration", "memory", "output"]);
const PROCEDURE_KINDS = new Set(["workflow", "graph", "prompt"]);
const SOURCE_ORIGINS = new Set(["live_hook", "historical_replay", "test_fixture"]);
const REPLAY_BLOCKED_REASONS = new Set(["insufficient_independent_live_evidence", "requires_trusted_host_completion_evidence"]);
const REPLAY_PROJECTION_SOURCE_TYPE = "historical_replay_projection";
const REPLAY_PROJECTION_CLAIM = "Historical replay Evidence reference projection.";
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string { if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`); const result = value.trim(); if (SECRET.test(result)) throw new Error(`${name} must not contain credentials or secrets`); return result; }
function strings(value: unknown, name: string, minimum = 0): string[] { if (!Array.isArray(value)) throw new Error(`${name} must be an array`); const result = value.map((item) => text(item, name)); if (result.length < minimum || new Set(result).size !== result.length) throw new Error(`${name} must contain ${minimum ? `at least ${minimum} unique values` : "unique values"}`); return result.sort(); }

export function normalizeSourceLineage(value: unknown, store: CraftStore, allowReplay: boolean): JsonObject[] {
  if (!Array.isArray(value)) throw new Error("source_lineage must be an array");
  const normalized = value.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) throw new Error(`source_lineage[${index}] must be an object`);
    const item = entry as JsonObject;
    const origin = text(item.origin, `source_lineage[${index}].origin`);
    if (!SOURCE_ORIGINS.has(origin) || !allowReplay && origin === "historical_replay") throw new Error("source_lineage origin is unsupported for this Experience operation");
    const sessionId = text(item.session_id, `source_lineage[${index}].session_id`);
    if (sessionId.length > 256 || /[\r\n\0]/u.test(sessionId)) throw new Error("source_lineage session_id is invalid");
    const projectScopeId = text(item.project_scope_id, `source_lineage[${index}].project_scope_id`);
    if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(projectScopeId)) throw new Error("source_lineage project_scope_id must be a canonical project scope");
    const sourceRefValue = item.source_ref;
    if (!sourceRefValue || typeof sourceRefValue !== "object" || Array.isArray(sourceRefValue)) throw new Error(`source_lineage[${index}].source_ref must be an object`);
    const sourceRef = sourceRefValue as JsonObject;
    const sourceKind = text(sourceRef.kind, `source_lineage[${index}].source_ref.kind`);
    const sourceId = text(sourceRef.id, `source_lineage[${index}].source_ref.id`);
    if (!/^[a-z][a-z0-9_-]{0,63}$/u.test(sourceKind) || sourceId.length > 256 || /[\r\n\0]/u.test(sourceId)) throw new Error("source_lineage source_ref is invalid");
    const sourceVersion = sourceRef.version;
    if (sourceVersion !== undefined && (!Number.isSafeInteger(sourceVersion) || Number(sourceVersion) < 1)) throw new Error("source_lineage source_ref.version must be a positive integer");
    const sourceDigest = sourceRef.digest;
    if (sourceDigest !== undefined && (typeof sourceDigest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(sourceDigest))) throw new Error("source_lineage source_ref.digest must be a sha256 digest");
    if (!Array.isArray(item.evidence_refs) || item.evidence_refs.length < 1 || item.evidence_refs.length > 64) throw new Error(`source_lineage[${index}].evidence_refs must contain one to 64 refs`);
    const evidenceRefs = (item.evidence_refs as unknown[]).map((ref, refIndex) => {
      if (!ref || typeof ref !== "object" || Array.isArray(ref)) throw new Error(`source_lineage[${index}].evidence_refs[${refIndex}] must be an object`);
      const evidence = ref as JsonObject;
      if (evidence.kind !== "evidence") throw new Error("source_lineage Evidence ref kind must be evidence");
      const evidenceId = text(evidence.id, `source_lineage[${index}].evidence_refs[${refIndex}].id`);
      if (!Number.isSafeInteger(evidence.version) || Number(evidence.version) < 1) throw new Error("source_lineage Evidence ref version must be a positive integer");
      store.get("evidence", evidenceId, Number(evidence.version));
      return { kind: "evidence", id: evidenceId, version: Number(evidence.version) };
    });
    const replayRunId = item.replay_run_id === undefined ? undefined : text(item.replay_run_id, `source_lineage[${index}].replay_run_id`);
    if (origin === "historical_replay" && (!allowReplay || !replayRunId || replayRunId.length > 160 || /[\r\n\0]/u.test(replayRunId))) {
      throw new Error("historical_replay source_lineage requires a bounded replay_run_id");
    }
    if (origin !== "historical_replay" && replayRunId !== undefined) throw new Error("replay_run_id is only valid for historical_replay lineage");
    const turnId = item.turn_id === undefined ? undefined : text(item.turn_id, `source_lineage[${index}].turn_id`);
    const taskId = item.task_id === undefined ? undefined : text(item.task_id, `source_lineage[${index}].task_id`);
    if ([turnId, taskId].some(value => value !== undefined && (value.length > 256 || /[\r\n\0]/u.test(value)))) throw new Error("source_lineage turn_id or task_id is invalid");
    const uniqueEvidenceRefs = [...new Map(evidenceRefs.map(ref => [`${ref.id}:${ref.version}`, ref])).values()]
      .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`));
    return { origin, ...(replayRunId ? { replay_run_id: replayRunId } : {}), session_id: sessionId,
      ...(turnId ? { turn_id: turnId } : {}), ...(taskId ? { task_id: taskId } : {}), project_scope_id: projectScopeId,
      source_ref: { kind: sourceKind, id: sourceId, ...(sourceVersion === undefined ? {} : { version: Number(sourceVersion) }), ...(sourceDigest === undefined ? {} : { digest: sourceDigest.toLowerCase() }) },
      evidence_refs: uniqueEvidenceRefs };
  });
  const unique = new Map(normalized.map(item => [stableDigest(item), item]));
  return [...unique.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);
}

function mergeLineage(...groups: JsonObject[][]): JsonObject[] {
  const byOccurrence = new Map<string, JsonObject>();
  for (const item of groups.flat()) {
    const occurrence = stableDigest({ origin: item.origin, replay_run_id: item.replay_run_id ?? null, session_id: item.session_id,
      turn_id: item.turn_id ?? null, task_id: item.task_id ?? null, project_scope_id: item.project_scope_id });
    const prior = byOccurrence.get(occurrence);
    if (prior && stableDigest(prior.source_ref) !== stableDigest(item.source_ref)) throw new Error("source lineage source_ref conflicts for the same occurrence");
    const refs = [...(prior?.evidence_refs as JsonObject[] | undefined ?? []), ...(item.evidence_refs as JsonObject[])];
    const evidenceRefs = [...new Map(refs.map(ref => [`${ref.id}:${ref.version}`, ref])).values()]
      .sort((left, right) => `${left.id}:${left.version}`.localeCompare(`${right.id}:${right.version}`));
    byOccurrence.set(occurrence, { ...item, ...(prior ?? {}), evidence_refs: evidenceRefs });
  }
  return [...byOccurrence.entries()].sort(([left], [right]) => left.localeCompare(right)).map(([, item]) => item);
}

function storedLineage(record: JsonObject, store: CraftStore): JsonObject[] | null {
  if (record.source_lineage === undefined) return null;
  try { return normalizeSourceLineage(record.source_lineage, store, true); }
  catch { throw new Error("Experience source_lineage is malformed; cleanup requires reconciliation"); }
}

function sourceReferenceKey(value: unknown): string | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const ref = value as JsonObject;
  if (typeof ref.kind !== "string" || typeof ref.id !== "string") return null;
  return `${ref.kind}\0${ref.id}\0${ref.version ?? ""}`;
}

function lineageReferenceKeys(lineage: JsonObject[]): Set<string> {
  return new Set(lineage.flatMap(entry => {
    const sourceKey = sourceReferenceKey(entry.source_ref);
    const evidenceKeys = (entry.evidence_refs as JsonObject[]).map(sourceReferenceKey);
    return [sourceKey, ...evidenceKeys].filter((key): key is string => key !== null);
  }));
}

/** Remove source projections tied only to the replay occurrence being retracted. */
function cleanReplaySourceRefs(sourceRefs: unknown, removed: JsonObject[], retained: JsonObject[], replayRunId: string): JsonObject[] {
  if (!Array.isArray(sourceRefs)) throw new Error("Experience Learning Work Item source_refs is malformed; cleanup requires reconciliation");
  const removedSessions = new Set(removed.map(entry => String(entry.session_id)));
  const retainedSessions = new Set(retained.map(entry => String(entry.session_id)));
  const removedRefs = lineageReferenceKeys(removed);
  const retainedRefs = lineageReferenceKeys(retained);
  const shouldRemoveRef = (value: unknown): boolean => {
    const key = sourceReferenceKey(value);
    return key !== null && removedRefs.has(key) && !retainedRefs.has(key);
  };
  return sourceRefs.flatMap(value => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [value as JsonObject];
    const source = value as JsonObject;
    const sourceRefRemoved = shouldRemoveRef(source.source_ref) || shouldRemoveRef(source);
    const replayRunRemoved = source.replay_run_id === replayRunId
      || source.origin === "historical_replay" && source.replay_run_id === replayRunId;
    const sessionRemoved = typeof source.session_id === "string" && removedSessions.has(source.session_id)
      && !retainedSessions.has(source.session_id);
    if (sourceRefRemoved || replayRunRemoved || sessionRemoved) return [];
    const cleaned: JsonObject = { ...source };
    for (const key of ["trace_ref", "event_refs", "observation_refs", "evidence_refs", "source_ref"]) {
      const valueAtKey = cleaned[key];
      if (Array.isArray(valueAtKey)) cleaned[key] = valueAtKey.filter(ref => !shouldRemoveRef(ref));
      else if (shouldRemoveRef(valueAtKey)) delete cleaned[key];
    }
    return [cleaned];
  });
}

function replayProjectionMetadata(record: JsonObject): JsonObject {
  if (record.source_type !== REPLAY_PROJECTION_SOURCE_TYPE || record.claim !== REPLAY_PROJECTION_CLAIM
    || !record.metadata || typeof record.metadata !== "object" || Array.isArray(record.metadata)) throw new Error("Experience replay Evidence projection is malformed; cleanup requires reconciliation");
  const metadata = record.metadata as JsonObject;
  const keys = ["replay_run_id", "source_owner", "source_evidence_id", "source_evidence_version", "semantic_digest", "projection_status"];
  if (Object.keys(metadata).length !== keys.length || Object.keys(metadata).some(key => !keys.includes(key))
    || typeof metadata.replay_run_id !== "string" || !metadata.replay_run_id || typeof metadata.source_owner !== "string" || !metadata.source_owner
    || typeof metadata.source_evidence_id !== "string" || !metadata.source_evidence_id
    || !Number.isSafeInteger(metadata.source_evidence_version) || Number(metadata.source_evidence_version) < 1
    || typeof metadata.semantic_digest !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(metadata.semantic_digest)
    || !["active", "revoked"].includes(String(metadata.projection_status))) throw new Error("Experience replay Evidence projection metadata is malformed; cleanup requires reconciliation");
  return metadata;
}

function replayProjectionDigest(record: JsonObject, metadata: JsonObject): string {
  return stableDigest({ source_type: record.source_type, claim: record.claim, metadata });
}

/**
 * Turns multiple *sanitized* execution observations into a bounded proposal
 * request. It deliberately does not create, promote, or execute a Workflow:
 * CraftService binds a returned proposal to the existing Workflow/Gate model.
 */
export class WorkflowEvolutionKernel {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  observe(args: JsonObject): JsonObject {
    if (args.sanitized !== true || args.content_stored === true) throw new Error("Workflow Evolution observations must be sanitized and content-free");
    if (args.source_lineage !== undefined) {
      const lineage = normalizeSourceLineage(args.source_lineage, this.store, false);
      if (!lineage.length || lineage.some(item => item.origin !== "live_hook")) throw new Error("Workflow Evolution observations require explicit live_hook lineage");
      if (args.source_session_id !== undefined && lineage.some(item => item.session_id !== args.source_session_id)) throw new Error("Workflow Evolution source session does not match live lineage");
    }
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); for (const evidenceId of evidenceIds) this.assertEvidence(evidenceId);
    const outcome = text(args.outcome, "outcome"); if (!OUTCOMES.has(outcome)) throw new Error("Workflow Evolution outcome is unsupported");
    const sourceSessionId = args.source_session_id === undefined ? null : text(args.source_session_id, "source_session_id");
    if (sourceSessionId && (sourceSessionId.length > 256 || /[\r\n\0]/u.test(sourceSessionId))) throw new Error("source_session_id must be a bounded Host session identifier");
    const source = { kind: text(args.source_kind, "source_kind"), id: text(args.source_id, "source_id"), digest: text(args.source_digest, "source_digest"),
      ...(sourceSessionId ? { session_id: sourceSessionId } : {}), scope: args.scope === undefined ? null : text(args.scope, "scope") };
    let verification: JsonObject | null = null;
    if (args.verification !== undefined) {
      const receipt = args.verification as JsonObject;
      if (!receipt || typeof receipt !== "object" || Array.isArray(receipt)) throw new Error("Verification receipt must be an object");
      const startedAt = text(receipt.started_at, "verification.started_at"), completedAt = text(receipt.completed_at, "verification.completed_at");
      if (!Number.isFinite(Date.parse(startedAt)) || !Number.isFinite(Date.parse(completedAt)) || Date.parse(completedAt) < Date.parse(startedAt)) throw new Error("Verification receipt timestamps are invalid");
      if (!Number.isInteger(receipt.exit_code) || (outcome === "passed" && receipt.exit_code !== 0) || (outcome === "failed" && receipt.exit_code === 0)) throw new Error("Verification outcome contradicts exit_code");
      verification = { contract_ref: text(receipt.contract_ref, "verification.contract_ref"), workspace_revision: text(receipt.workspace_revision, "verification.workspace_revision"), evidence_digest: text(receipt.evidence_digest, "verification.evidence_digest"), producer: text(receipt.producer, "verification.producer"), started_at: startedAt, completed_at: completedAt, exit_code: receipt.exit_code, provenance: "host_attested", independently_verified: false };
    }
    const executionShape = args.execution_shape === undefined ? [] : strings(args.execution_shape, "execution_shape");
    const allowedShapes = new Set(["branch", "parallel_join", "approval", "recovery", "compensation", "retry"]);
    if (executionShape.some((shape) => !allowedShapes.has(shape))) throw new Error("Workflow Evolution execution_shape is unsupported");
    const scenarioKey = text(args.scenario_key, "scenario_key");
    const scenarioSignature = args.scenario_signature === undefined ? { digest: stableDigest(scenarioKey), source: "legacy_scenario_key" } : args.scenario_signature;
    if (!scenarioSignature || typeof scenarioSignature !== "object" || Array.isArray(scenarioSignature)) throw new Error("Workflow Evolution Scenario Signature is invalid");
    const sourceLineage = args.source_lineage === undefined ? undefined : mergeLineage([], normalizeSourceLineage(args.source_lineage, this.store, false));
    if (sourceLineage && (!sourceLineage.length || sourceLineage.some(item => item.origin !== "live_hook"
      || !(item.evidence_refs as JsonObject[]).every(ref => evidenceIds.includes(String(ref.id)))))) throw new Error("Workflow Evolution live lineage must reference observation Evidence");
    const identity = { scenario_key: scenarioKey, scenario_signature: scenarioSignature, source, outcome, ...(verification ? { verification } : {}), failure_type: args.failure_type === undefined ? null : text(args.failure_type, "failure_type"), evidence_ids: evidenceIds, execution_shape: executionShape, ...(sourceLineage ? { source_lineage: sourceLineage } : {}), sanitized: true, content_stored: false };
    const observationId = String(args.observation_id ?? `workflow_evolution_observation_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("workflow_evolution_observation", observationId); const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest === identityDigest) return { observation: existing, idempotent: true };
      const priorSignature = existing.scenario_signature as JsonObject | undefined;
      const sameTerminalEvidence = stableDigest({ source: existing.source, outcome: existing.outcome, evidence_ids: existing.evidence_ids,
        verification: existing.verification ?? null, failure_type: existing.failure_type ?? null, execution_shape: existing.execution_shape ?? [],
        sanitized: existing.sanitized, content_stored: existing.content_stored })
        === stableDigest({ source, outcome, evidence_ids: evidenceIds, verification, failure_type: identity.failure_type,
          execution_shape: executionShape, sanitized: true, content_stored: false });
      // scenario_signature has passed object validation above. A refinement
      // also needs an explicit classified signature and unchanged Evidence.
      const nextSignature = identity.scenario_signature as JsonObject;
      const hasHostClassification = args.scenario_signature !== undefined && nextSignature.source !== "unclassified";
      const isClassificationUpgrade = priorSignature?.source === "unclassified" && hasHostClassification && sameTerminalEvidence;
      if (!isClassificationUpgrade) throw new Error("Workflow Evolution observation idempotency conflict");
      const observation = this.store.updateIfVersion("workflow_evolution_observation", observationId, Number(existing.version),
        { ...identity, identity_digest: identityDigest, lifecycle: existing.lifecycle });
      this.store.appendEvent(`workflow-evolution:${identity.scenario_key}`, "workflow_evolution.classified", { observation_id: observation.id, outcome });
      return { observation, idempotent: false, refined: true };
    }
    const observation = this.store.create("workflow_evolution_observation", observationId, { ...identity, identity_digest: identityDigest, lifecycle: "accepted" });
    this.store.appendEvent(`workflow-evolution:${identity.scenario_key}`, "workflow_evolution.observed", { observation_id: observation.id, outcome });
    return { observation, idempotent: false };
  }

  propose(args: JsonObject): JsonObject {
    const scenarioKey = text(args.scenario_key, "scenario_key"); const selectedIds = args.observation_ids === undefined ? null : strings(args.observation_ids, "observation_ids", 2);
    const observations = (selectedIds === null ? this.store.list("workflow_evolution_observation", 10_000, (item) => item.scenario_key === scenarioKey && item.lifecycle === "accepted") : selectedIds.map((id) => this.store.get("workflow_evolution_observation", id)))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)));
    if (observations.length < 2) throw new Error("Workflow Evolution requires at least two observations");
    if (observations.some((item) => item.scenario_key !== scenarioKey || item.lifecycle !== "accepted")) throw new Error("Workflow Evolution observations do not match the scenario");
    if (observations.some(item => {
      const lineage = storedLineage(item, this.store);
      return lineage !== null && (!lineage.length || lineage.some(entry => entry.origin !== "live_hook"));
    })) throw new Error("Workflow Evolution proposals require observations with explicit live_hook lineage");
    if (new Set(observations.map((item) => stableDigest(item.scenario_signature ?? { digest: stableDigest(String(item.scenario_key)), source: "legacy_scenario_key" }))).size !== 1) throw new Error("Workflow Evolution observations do not share a Scenario Signature");
    if (new Set(observations.map((item) => `${(item.source as JsonObject).kind}:${(item.source as JsonObject).id}:${(item.source as JsonObject).digest}`)).size < 2) throw new Error("Workflow Evolution requires independent source records");
    const hostSources = observations.filter(item => String((item.source as JsonObject).kind).startsWith("host:"));
    if (hostSources.length > 0) {
      if (hostSources.some(item => typeof (item.source as JsonObject).session_id !== "string" || !(item.source as JsonObject).session_id)) {
        throw new Error("Workflow Evolution Host observations require source session identifiers");
      }
      if (new Set(hostSources.map(item => String((item.source as JsonObject).session_id))).size !== hostSources.length) {
        throw new Error("Workflow Evolution requires independent Host sessions");
      }
    }
    const axes = strings(args.design_axes, "design_axes", 1); if (axes.length > 2 || axes.some((axis) => !AXES.has(axis))) throw new Error("Workflow Evolution may change at most two supported design axes");
    const procedureKind = text(args.procedure_kind ?? "workflow", "procedure_kind"); if (!PROCEDURE_KINDS.has(procedureKind)) throw new Error("Workflow Evolution procedure_kind is unsupported");
    const graphEvidence = observations.some((item) => Array.isArray(item.execution_shape) && (item.execution_shape as unknown[]).some((shape) => ["branch", "parallel_join", "approval", "recovery", "compensation"].includes(String(shape))));
    if (procedureKind === "graph" && !graphEvidence) throw new Error("Graph Procedure requires observed branch, join, approval, recovery, or compensation evidence");
    const identity = { scenario_key: scenarioKey, scenario_signature: observations[0]!.scenario_signature ?? args.scenario_signature ?? { digest: stableDigest(scenarioKey), source: "legacy_scenario_key" }, observation_refs: observations.map((item) => ({ id: item.id, version: item.version, source: item.source, outcome: item.outcome, evidence_ids: item.evidence_ids, execution_shape: item.execution_shape ?? [] })), hypothesis: text(args.hypothesis, "hypothesis"), design_axes: axes, procedure_kind: procedureKind, output_contract_ref: text(args.output_contract_ref, "output_contract_ref"), lifecycle: "awaiting_model", content_stored: false };
    const requestId = String(args.request_id ?? `workflow_evolution_request_${stableDigest(identity).slice(-20)}`); const existing = this.store.find("workflow_evolution_request", requestId); const identityDigest = stableDigest(identity);
    if (existing) { if (existing.identity_digest !== identityDigest) throw new Error("Workflow Evolution request idempotency conflict"); return { request: existing, idempotent: true }; }
    const request = this.store.create("workflow_evolution_request", requestId, { ...identity, identity_digest: identityDigest });
    this.store.appendEvent(`workflow-evolution:${scenarioKey}`, "workflow_evolution.proposed", { request_id: request.id, observation_count: observations.length });
    return { request, idempotent: false, next_action: procedureKind === "graph" ? "issue_a_model_ticket_or_submit_a_host_distilled_graph_draft" : procedureKind === "prompt" ? "issue_a_model_ticket_or_submit_a_host_distilled_prompt_procedure" : "issue_a_model_ticket_or_submit_a_host_distilled_workflow_draft" };
  }

  submit(args: JsonObject): JsonObject {
    const request = this.store.get("workflow_evolution_request", text(args.request_id, "request_id"));
    const explicitProposalId = args.proposal_id === undefined ? null : text(args.proposal_id, "proposal_id");
    const prior = explicitProposalId === null ? null : this.store.find("workflow_evolution_proposal", explicitProposalId);
    if (prior) {
      const priorControl = (prior.graph as JsonObject | undefined)?.graph_control;
      if (priorControl !== undefined || args.graph_control !== undefined) {
        if (priorControl === undefined || args.graph_control === undefined || stableDigest(priorControl) !== stableDigest(validateGraphControl(args.graph_control, args.nodes, args.edges))) throw new Error("Graph proposal idempotency conflict: graph_control changed or missing");
      }
      if (prior.composition !== undefined || args.composition !== undefined) {
        const priorBody = { composition: prior.composition, steps: prior.steps };
        const retryBody = { composition: args.composition, steps: args.steps };
        if (stableDigest(priorBody) !== stableDigest(retryBody)) throw new Error("Workflow Evolution composition idempotency conflict");
      }
      if (prior.request_id !== request.id) throw new Error("Workflow Evolution proposal idempotency conflict");
      return { proposal: prior, request, idempotent: true };
    }
    const ticketId = args.model_ticket_id === undefined ? null : text(args.model_ticket_id, "model_ticket_id");
    if (ticketId) {
      const ticket = this.store.get("evaluation_model_ticket", ticketId);
      if (ticket.purpose !== "workflow_evolution") throw new Error("Model Ticket is not a Workflow Evolution ticket");
      const target = ticket.target as JsonObject;
      if (target.id !== request.id || Number(target.version) !== Number(request.version)) throw new Error("Model Ticket does not belong to this Workflow Evolution request");
    }
    const procedureKind = text(request.procedure_kind ?? "workflow", "procedure_kind"); if (!PROCEDURE_KINDS.has(procedureKind)) throw new Error("Workflow Evolution procedure_kind is unsupported");
    const composition = args.composition === undefined ? undefined : validateProcedureComposition(procedureKind, args.composition, args.steps);
    const replacementKind = procedureKind === "graph" ? "workflow_dag" : "workflow";
    const replacement = procedureKind === "prompt" || args.replaces_workflow_id === undefined ? null : this.store.get(replacementKind, text(args.replaces_workflow_id, "replaces_workflow_id"));
    const graph = procedureKind === "graph" ? { nodes: args.nodes, edges: args.edges ?? [], outputs: args.outputs ?? {}, checkpoint_policy: args.checkpoint_policy ?? { mode: "step" }, ...(args.graph_control === undefined ? {} : { graph_control: validateGraphControl(args.graph_control, args.nodes, args.edges) }) } : null;
    const identity = { request_id: request.id, request_version: request.version, model_ticket_id: ticketId, procedure_kind: procedureKind, workflow_id: procedureKind === "prompt" ? String(args.workflow_id ?? `prompt_${stableDigest({ request: request.id, name: args.name }).slice(-16)}`) : text(args.workflow_id, "workflow_id"), name: text(args.name, "name"), description: text(args.description, "description"), inputs: strings(args.inputs ?? [], "inputs"), steps: procedureKind === "workflow" ? args.steps : null, ...(composition ? { composition } : {}), graph, prompt: procedureKind === "prompt" ? text(args.prompt ?? args.description, "prompt") : null, replaces_workflow: replacement === null ? null : { kind: replacementKind, id: replacement.id, version: replacement.version }, lifecycle: "draft" };
    if (procedureKind === "workflow" && (!Array.isArray(identity.steps) || !identity.steps.length)) throw new Error("steps must be a non-empty array");
    if (procedureKind === "graph" && (!Array.isArray(graph!.nodes) || !graph!.nodes.length)) throw new Error("graph nodes must be a non-empty array");
    const proposalId = String(args.proposal_id ?? `workflow_evolution_proposal_${stableDigest(identity).slice(-20)}`); const identityDigest = stableDigest(identity);
    if (request.lifecycle !== "awaiting_model") throw new Error("Workflow Evolution request is no longer awaiting a proposal");
    const proposal = this.store.create("workflow_evolution_proposal", proposalId, { ...identity, identity_digest: identityDigest, publication_allowed: false });
    const savedRequest = this.store.save("workflow_evolution_request", String(request.id), { ...payload(request), lifecycle: "draft_submitted", proposal_id: proposal.id, proposal_version: proposal.version });
    this.store.appendEvent(`workflow-evolution:${request.scenario_key}`, "workflow_evolution.draft_submitted", { request_id: request.id, proposal_id: proposal.id });
    return { proposal, request: savedRequest, idempotent: false };
  }

  get(args: JsonObject): JsonObject { return { proposal: this.store.get("workflow_evolution_proposal", text(args.proposal_id, "proposal_id")), request: args.request_id === undefined ? null : this.store.get("workflow_evolution_request", text(args.request_id, "request_id")) }; }

  captureHistoricalReplayCandidate(args: JsonObject): JsonObject {
    const lineage = normalizeSourceLineage(args.source_lineage, this.store, true);
    if (!lineage.length || lineage.some(item => item.origin !== "historical_replay")) throw new Error("Experience replay requires historical_replay lineage");
    const blockedReason = text(args.blocked_reason, "blocked_reason");
    if (!REPLAY_BLOCKED_REASONS.has(blockedReason)) throw new Error("Experience replay blocked_reason is unsupported");
    const scopes = new Set(lineage.map(item => String(item.project_scope_id)));
    if (scopes.size !== 1) throw new Error("Experience replay candidate must have one project scope");
    const scope = [...scopes][0]!;
    const sourceKeys = [...new Set(lineage.map(item => stableDigest({ session_id: item.session_id, project_scope_id: item.project_scope_id, source_ref: item.source_ref })))].sort();
    const candidateId = String(args.candidate_id ?? `experience_replay_${stableDigest({ project_scope_id: scope, source_keys: sourceKeys }).slice(-24)}`);
    if (!/^experience_replay_[A-Za-z0-9_-]{1,96}$/u.test(candidateId)) throw new Error("Experience replay candidate_id is invalid");
    return this.store.transaction(() => {
      const existing = this.store.find("experience_replay_candidate", candidateId);
      if (existing && existing.source_lineage === undefined) throw new Error("Experience replay candidate identity is unknown; cleanup requires reconciliation");
      const prior = existing ? normalizeSourceLineage(existing.source_lineage, this.store, true) : [];
      if (existing && (existing.project_scope_id !== scope || stableDigest(prior.map(item => stableDigest({ session_id: item.session_id, project_scope_id: item.project_scope_id, source_ref: item.source_ref })).sort()) !== stableDigest(sourceKeys))) {
        throw new Error("Experience replay candidate identity conflict");
      }
      const merged = mergeLineage(prior, lineage);
      const candidate = existing
        ? this.store.updateIfVersion("experience_replay_candidate", candidateId, Number(existing.version), { ...payload(existing), source_lineage: merged })
        : this.store.create("experience_replay_candidate", candidateId, { project_scope_id: scope, source_lineage: merged,
          blocked_reason: blockedReason, status: "awaiting_evidence", routeable: false, content_stored: false });
      return { candidate, status: "awaiting_evidence", idempotent: Boolean(existing) };
    });
  }

  historicalReplayCleanupPreview(args: JsonObject): JsonObject {
    const replayRunId = text(args.replay_run_id, "replay_run_id");
    const items: JsonObject[] = [];
    for (const kind of ["experience_replay_candidate", "workflow_evolution_observation", "workflow_evolution_request", "workflow_evolution_proposal", "experience_procedure", "experience_learning_work_item"]) {
      for (const record of this.store.list(kind, 10_000, item => item.source_lineage !== undefined, false)) {
        const lineage = storedLineage(record, this.store)!;
        const matching = lineage.filter(item => item.origin === "historical_replay" && item.replay_run_id === replayRunId);
        if (!matching.length) continue;
        const retained = lineage.filter(item => !(item.origin === "historical_replay" && item.replay_run_id === replayRunId));
        items.push({ kind, id: String(record.id), version: Number(record.version), lineage_digest: stableDigest(lineage),
          action: retained.length ? "remove_replay_lineage" : "revoke" });
      }
    }
    for (const record of this.store.list("evidence", 10_000, item => item.source_type === REPLAY_PROJECTION_SOURCE_TYPE, false)) {
      const metadata = replayProjectionMetadata(record);
      if (metadata.replay_run_id !== replayRunId || metadata.projection_status !== "active") continue;
      items.push({ kind: "evidence_projection", id: String(record.id), version: Number(record.version), lineage_digest: replayProjectionDigest(record, metadata), action: "revoke" });
    }
    items.sort((left, right) => `${left.kind}:${left.id}`.localeCompare(`${right.kind}:${right.id}`));
    const owner = "experience";
    return { owner, replay_run_id: replayRunId, manifest_digest: stableDigest({ owner, replay_run_id: replayRunId, items }), items };
  }

  historicalReplayCleanupApply(args: JsonObject): JsonObject {
    const replayRunId = text(args.replay_run_id, "replay_run_id");
    const expectedDigest = text(args.expected_manifest_digest, "expected_manifest_digest");
    const receiptId = `experience_replay_cleanup_${stableDigest({ replay_run_id: replayRunId, manifest_digest: expectedDigest }).slice(-32)}`;
    const priorReceipt = this.store.find("experience_replay_cleanup_receipt", receiptId);
    if (priorReceipt) return { status: "cleaned", idempotent: true, receipt: priorReceipt };
    const preview = this.historicalReplayCleanupPreview({ replay_run_id: replayRunId });
    if (preview.manifest_digest !== expectedDigest) throw new Error("Experience replay cleanup manifest changed; preview again");
    const items = preview.items as JsonObject[];
    const result = this.store.transaction(() => {
      const existingReceipt = this.store.find("experience_replay_cleanup_receipt", receiptId);
      if (existingReceipt) return { cleaned: [], receipt: existingReceipt, idempotent: true };
      const cleaned = items.map(item => {
        const storageKind = item.kind === "evidence_projection" ? "evidence" : String(item.kind);
        const record = this.store.get(storageKind, String(item.id));
        if (item.kind === "evidence_projection") {
          const metadata = replayProjectionMetadata(record);
          if (Number(record.version) !== Number(item.version) || metadata.replay_run_id !== replayRunId
            || metadata.projection_status !== "active" || replayProjectionDigest(record, metadata) !== item.lineage_digest) throw new Error("Experience replay Evidence projection changed after cleanup preview");
          return { kind: String(item.kind), record: this.store.updateIfVersion(storageKind, String(record.id), Number(record.version), { ...payload(record), confidence: "rejected",
            metadata: { ...metadata, projection_status: "revoked" } }) };
        }
        const lineage = storedLineage(record, this.store);
        if (Number(record.version) !== Number(item.version) || lineage === null || stableDigest(lineage) !== item.lineage_digest) throw new Error("Experience replay object changed after cleanup preview");
        const retained = lineage.filter(entry => !(entry.origin === "historical_replay" && entry.replay_run_id === replayRunId));
        const patch: JsonObject = { ...payload(record), source_lineage: retained, updated_at: new Date().toISOString() };
        if (String(item.kind) === "experience_learning_work_item") {
          const removed = lineage.filter(entry => entry.origin === "historical_replay" && entry.replay_run_id === replayRunId);
          const sourceRefs = cleanReplaySourceRefs(record.source_refs, removed, retained, replayRunId);
          if (stableDigest(sourceRefs) !== stableDigest(record.source_refs)) {
            patch.source_refs = sourceRefs;
            patch.source_refs_cleanup_applied = true;
          }
          const replayRunIds = [...new Set(retained.flatMap(entry => entry.origin === "historical_replay" && typeof entry.replay_run_id === "string"
            ? [entry.replay_run_id] : []))].sort();
          if (replayRunIds.length === 1) patch.replay_run_id = replayRunIds[0];
          else delete patch.replay_run_id;
          if (!retained.length) {
            patch.status = "revoked";
            patch.blocked_reason = null;
            patch.failure_reason = "source_unavailable";
            patch.retryable = false;
            patch.lease_owner = null;
            patch.lease_token = null;
            patch.lease_expires_at = null;
            patch.active_dispatch_ref = null;
          }
        }
        if (!retained.length) {
          patch.status = "revoked";
          patch.routeable = false;
          patch.content_stored = false;
          patch.lifecycle = String(item.kind) === "experience_procedure" ? "rolled_back" : "revoked";
          if (String(item.kind) === "workflow_evolution_proposal") patch.publication_allowed = false;
          patch.cleanup_receipt = { replay_run_id: replayRunId, manifest_digest: expectedDigest, content_free: true };
          delete patch.candidate_content; delete patch.summary; delete patch.transcript; delete patch.outcome; delete patch.verification;
        }
        return { kind: String(item.kind), record: this.store.updateIfVersion(storageKind, String(item.id), Number(record.version), patch) };
      });
      const receipt = this.store.create("experience_replay_cleanup_receipt", receiptId, { owner: "experience", replay_run_id: replayRunId,
        manifest_digest: expectedDigest, cleaned_object_count: cleaned.length, content_free: true, status: "cleaned" });
      return { cleaned, receipt, idempotent: false };
    });
    return { status: "cleaned", idempotent: result.idempotent,
      receipt: result.receipt,
      cleaned: result.cleaned.map(item => ({ kind: item.kind, id: String(item.record.id), version: Number(item.record.version) })) };
  }

  observations(args: JsonObject = {}): JsonObject { const scenario = args.scenario_key === undefined ? null : text(args.scenario_key, "scenario_key"); return { observations: this.store.list("workflow_evolution_observation", Number(args.limit ?? 100), (item) => scenario === null || item.scenario_key === scenario) }; }
  /** Bounded list of proposals (drafts awaiting gates), optionally by lifecycle. */
  proposals(args: JsonObject = {}): JsonObject {
    const limit = args.limit === undefined ? 100 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 1_000) throw new Error("limit must be an integer between 1 and 1000");
    const lifecycle = args.lifecycle === undefined ? null : text(args.lifecycle, "lifecycle");
    return { proposals: this.store.list("workflow_evolution_proposal", limit, (item) => lifecycle === null || item.lifecycle === lifecycle) };
  }
  private assertEvidence(id: string): void { const evidence = this.store.get("evidence", id); if (!new Set(["confirmed", "bounded"]).has(String(evidence.confidence))) throw new Error("Workflow Evolution Evidence must be confirmed or bounded"); }
}
