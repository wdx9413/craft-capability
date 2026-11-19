import { validateGraphControl } from "./procedure-graph.ts";
/**
 * The routeable Procedure store for Experience.
 *
 * Observations and diagnostic patterns remain evidence-only.  This small state
 * machine is the only path that turns a bounded evolution proposal into a
 * routeable Procedure. Workflow and Graph keep a structured JSON definition
 * as their authority; Markdown is only their human-review view. Prompt
 * Procedures remain Markdown-native. All three stay separate from Skill
 * installation and active Capability Workflows.
 */
import { lstatSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { CraftStore, JsonObject } from 'craft-common-store-local/store';
import { stableDigest, payload } from 'craft-common-base/digest';
import { ProcedureDefinitionStore, procedureDefinitionRef, type ProcedureDefinition, type ProcedureKind } from "./procedure-definition.ts";
import { activeProcedure, belongsToRetiredScenario, preserveProcedureRelease, updateProcedureRelease, selectedProcedure } from "./procedure-release.ts";
import { syncGraphVersionManifest } from "./graph-version-manifest.ts";
import { ProcedurePlanner, validateProcedureComposition } from "./procedure-composition.ts";
import { scopeEnvelope } from 'craft-common-base/scope-policy';
import { validateConcept } from 'craft-common-ontology/validation';
import { projectExperienceDirectory } from "./project-experience-directory.ts";
import { EvaluationContractKernel } from "craft-common-log/evaluation-contract";
import { procedureEvaluationBinding } from "./procedure-evaluation-binding.ts";

const STAGES = ["shadow", "held_out", "signoff", "canary"] as const;
type Stage = typeof STAGES[number];
const KINDS = new Set(["workflow", "graph", "prompt"]);
const RUNBOOK_FIELDS = ["applies_when", "exclude_when", "pitfall", "cause", "correct_method", "synthetic_example", "done_criteria", "failure_handling"] as const;
const RUNBOOK_SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{8,}/iu;

function text(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value.trim();
}
function strings(value: unknown, name: string, minimum = 0): string[] {
  if (!Array.isArray(value)) throw new Error(`${name} must be an array`);
  const result = [...new Set(value.map((item) => text(item, name)))].sort();
  if (result.length < minimum) throw new Error(`${name} must contain at least ${minimum} unique values`);
  return result;
}
function yaml(value: unknown): string { return JSON.stringify(value); }
function scopeRef(value: string): { kind: string; id: string } {
  const separator = value.indexOf(":");
  if (separator < 1 || separator === value.length - 1) throw new Error("Experience Procedure scope is malformed");
  return { kind: value.slice(0, separator), id: value.slice(separator + 1) };
}

/**
 * Owns Craft-learned Procedure assets. It intentionally does not own installed
 * Capability Skills or Workflows: those stay in the Capability registry.
 */
export class ProcedureStore {
  readonly store: CraftStore;
  readonly definitions: ProcedureDefinitionStore;
  private evaluationVerifier: { verifyTaskEffectEvaluation(input: JsonObject): JsonObject };
  constructor(store: CraftStore) {
    this.store = store; this.definitions = new ProcedureDefinitionStore(store);
    this.evaluationVerifier = new EvaluationContractKernel(store);
  }

  /** Use the Runtime's immutable evaluator trust registry for every promotion check. */
  setEvaluationVerifier(verifier: { verifyTaskEffectEvaluation(input: JsonObject): JsonObject }): void {
    if (!verifier || typeof verifier.verifyTaskEffectEvaluation !== "function") throw new Error("Procedure promotion requires the verified task-effect Evaluation Contract service");
    this.evaluationVerifier = verifier;
  }

  /** Save a sanitized, project-local Runbook candidate from one verified Host observation. */
  runbookCapture(args: JsonObject): JsonObject {
    return this.store.transaction(() => this.captureRunbook(args));
  }

  private captureRunbook(args: JsonObject): JsonObject {
    const observationId = text(args.observation_id, "observation_id");
    const observation = this.store.get("workflow_evolution_observation", observationId);
    const source = observation.source as JsonObject | undefined;
    const scope = typeof source?.scope === "string" ? source.scope : "";
    if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scope) || observation.outcome !== "passed" || observation.lifecycle !== "accepted"
      || typeof source?.kind !== "string" || !source.kind.startsWith("host:") || typeof source.session_id !== "string" || !source.session_id) {
      throw new Error("Runbook capture requires one accepted, passing project-scoped Host observation");
    }
    projectExperienceDirectory(this.store, scope, undefined, true);
    const evidenceIds = strings(observation.evidence_ids, "observation.evidence_ids", 1);
    for (const id of evidenceIds) {
      const evidence = this.store.get("evidence", id), metadata = evidence.metadata as JsonObject | undefined;
      if (metadata?.provenance !== "host_completion_signal" || metadata?.verification_outcome !== "passed"
        || metadata?.project_scope_id !== scope || metadata?.source_session_id !== source.session_id || metadata?.task_id !== source.id
        || typeof metadata?.turn_id !== "string" || typeof metadata?.context_receipt_id !== "string" || metadata?.content_stored !== false) {
        throw new Error("Runbook capture Evidence is not a matching verified Host completion signal");
      }
    }
    const priorCandidate = this.store.list("experience_procedure", 1, item => item.runbook_candidate === true && item.observation_id === observation.id);
    const priorDecision = this.store.list("experience_runbook_decision", 1, item => item.observation_id === observation.id);
    if (args.decision === "no_new_learning") {
      if (priorCandidate.length) throw new Error("A Runbook candidate already exists for this Observation");
      const reason = text(args.reason, "reason");
      if (!["no_reusable_learning", "insufficient_evidence", "too_sensitive", "other"].includes(reason)) throw new Error("Runbook skip reason is unsupported");
      const identity = { observation_id: observation.id, observation_version: observation.version, scope, decision: "no_new_learning", reason };
      const id = `experience_runbook_decision_${stableDigest(identity).slice(-20)}`;
      const existing = this.store.find("experience_runbook_decision", id);
      if (existing) return { decision: existing, idempotent: true };
      if (priorDecision.length) throw new Error("A different no_new_learning decision already exists for this Observation");
      return { decision: this.store.create("experience_runbook_decision", id, { ...identity, content_stored: false }), idempotent: false };
    }
    if (args.decision !== "capture") throw new Error("Runbook decision must be capture or no_new_learning");
    if (priorDecision.length) throw new Error("A no_new_learning decision already exists for this Observation");
    const fields = {} as Record<(typeof RUNBOOK_FIELDS)[number], string>;
    for (const field of RUNBOOK_FIELDS) {
      const value = text(args[field], field);
      if (value.length > (field === "synthetic_example" ? 3_000 : 1_000) || RUNBOOK_SECRET.test(value) || /[\0]/u.test(value)) throw new Error(`${field} is unsafe or exceeds its size limit`);
      fields[field] = value;
    }
    const title = text(args.title, "title");
    if (title.length > 120 || RUNBOOK_SECRET.test(title)) throw new Error("Runbook title is unsafe or too long");
    const signature = observation.scenario_signature as JsonObject | undefined;
    const domain = typeof signature?.domain === "string" ? signature.domain : null;
    const identity = { runbook_candidate: true, provenance: "verified_host_task", observation_id: observation.id, observation_version: observation.version,
      session_id: source.session_id, scope, title, ...fields, evidence_ids: evidenceIds, domain, scenario_signature: signature ?? null };
    const id = `experience_procedure_runbook_${stableDigest(identity).slice(-20)}`;
    const existing = this.store.find("experience_procedure", id);
    if (existing) {
      if (existing.identity_digest !== stableDigest(identity)) throw new Error("Runbook capture idempotency conflict");
      return { procedure: existing, idempotent: true };
    }
    if (priorCandidate.length) throw new Error("A different Runbook candidate already exists for this Observation");
    const body = ["# " + title, "", "> 待验证：仅供同项目参考，不是可执行 Procedure。", "",
      "## 适用范围", fields.applies_when, "", "## 不适用", fields.exclude_when, "", "## 踩坑现象", fields.pitfall,
      "", "## 原因", fields.cause, "", "## 正确做法", fields.correct_method, "", "## 合成示例", "```text", fields.synthetic_example, "```",
      "", "## 完成判据", fields.done_criteria, "", "## 失败处置", fields.failure_handling, "", "## 来源", `Observation: ${observation.id}@${observation.version}`,
      `Evidence: ${evidenceIds.join(", ")}`, "", "## 实测时间与规模", "未测量：捕获来源不包含可核验的时间或规模数据。", ""].join("\n");
    const contentRef = this.store.contentStore.writeSync({ kind: "experience", record_id: id, version: 1, scope, status: "candidate", sensitivity: "internal",
      source_id: `host-observation:${String(observation.id)}`, title, body, folder: "prompts", frontmatter: { runbook_candidate: "true", routeable: "false" } });
    const procedure = this.store.create("experience_procedure", id, { ...identity, version: 1, lifecycle: "candidate", completed_gates: [], procedure_kind: "prompt",
      trigger: fields.applies_when, preconditions: [fields.exclude_when], allowed_effects: ["read"], acceptance_ref: fields.done_criteria,
      failure_disposition: fields.failure_handling, evidence_ids: evidenceIds, content_ref: contentRef, content_digest: contentRef.digest,
      identity_digest: stableDigest(identity), concept_kind: "procedure", routeable: false, publication_allowed: false, execution_visible: false });
    return { procedure, idempotent: false, advisory_only: true };
  }

  /** Revoke an unpromoted Runbook candidate after human review. */
  runbookRevoke(args: JsonObject): JsonObject {
    return this.store.transaction(() => this.revokeRunbook(args));
  }

  private revokeRunbook(args: JsonObject): JsonObject {
    const id = text(args.procedure_id, "procedure_id"), current = this.store.get("experience_procedure", id);
    if (current.runbook_candidate !== true || current.lifecycle !== "candidate" || current.routeable === true) throw new Error("Only an unpromoted Runbook candidate can be revoked");
    if (!Number.isSafeInteger(args.expected_version) || Number(args.expected_version) !== current.version) throw new Error("Runbook candidate version is stale");
    const reason = text(args.reason, "reason");
    if (!["not_reusable", "unsafe_content", "incorrect", "duplicate", "other"].includes(reason)) throw new Error("Runbook revocation reason is unsupported");
    const procedure = this.store.updateIfVersion("experience_procedure", id, Number(current.version), { ...payload(current), lifecycle: "rolled_back",
      routeable: false, publication_allowed: false, revoked_by: "explicit_user_review", revocation_reason: reason });
    this.store.appendEvent(`experience-runbook:${id}`, "experience.runbook_revoked", { procedure_id: id, version: procedure.version, reason, content_stored: false });
    return { procedure, revoked: true };
  }

  /** Create a candidate Procedure from an existing bounded proposal record. */
  draft(args: JsonObject): JsonObject {
    const result = this.store.transaction(() => this.draftCandidate(args)), procedure = result.procedure as JsonObject;
    return procedureDefinitionRef(procedure.definition_ref) ? { ...result, ...syncGraphVersionManifest(this.store, String(procedure.id)) } : result;
  }

  private draftCandidate(args: JsonObject): JsonObject {
    const proposal = this.store.get("workflow_evolution_proposal", text(args.proposal_id, "proposal_id"));
    const request = this.store.get("workflow_evolution_request", String(proposal.request_id), Number(proposal.request_version));
    const procedureKind = text(args.procedure_kind ?? proposal.procedure_kind ?? "workflow", "procedure_kind");
    if (!KINDS.has(procedureKind)) throw new Error("Experience Procedure kind is unsupported");
    const scenarioSignature = args.scenario_signature ?? request.scenario_signature;
    if (!scenarioSignature || typeof scenarioSignature !== "object" || Array.isArray(scenarioSignature)) throw new Error("Experience Procedure requires Scenario Signature");
    const signature = scenarioSignature as JsonObject;
    const project = signature.project as JsonObject | undefined;
    const projectId = typeof project?.id === "string" ? project.id.replace(/^project:/u, "") : "";
    if (projectId && typeof signature.scenario_key === "string"
      && belongsToRetiredScenario(this.store, { scope: `project:${projectId}`, scenario_signature: signature })) {
      throw new Error("Experience scenario is retired and cannot produce a Procedure");
    }
    const composition = proposal.composition === undefined ? null : validateProcedureComposition(procedureKind, proposal.composition, proposal.steps);
    const graph = proposal.graph as JsonObject | null;
    const control = graph?.graph_control === undefined ? null : validateGraphControl(graph.graph_control, graph.nodes, graph.edges);
    const procedureScope = this.scope(request);
    const envelope = scopeEnvelope(args.scope_envelope ?? request.scope_envelope, scopeRef(procedureScope));
    const identity = {
      proposal_id: proposal.id, proposal_version: proposal.version, request_id: request.id, request_version: request.version,
      procedure_kind: procedureKind, scenario_signature: scenarioSignature,
      scope: procedureScope, scope_envelope: envelope,
      ...(composition ? { entrypoints: composition.entries, exits: composition.exits } : {}),
      ...(control ? { scenario_id: control.scenario_id, graph_control: control, entrypoints: (control.entries as JsonObject[]).map(entry => ({ ...entry, routes: (control.subscenarios as JsonObject[]).filter(s => s.entry_id === entry.id).map(s => ({ exit_id: s.exit_id, subscenario_id: s.id })) })), exits: control.exits } : {}),
      trigger: text(args.trigger ?? request.scenario_key, "trigger"), preconditions: strings(args.preconditions ?? [], "preconditions"),
      allowed_effects: strings(args.allowed_effects ?? (control ? (graph!.nodes as JsonObject[]).map(node => node.side_effect) : composition ? (proposal.steps as JsonObject[]).map(step => step.side_effect) : ["read"]), "allowed_effects", 1),
      acceptance_ref: text(args.acceptance_ref ?? request.output_contract_ref, "acceptance_ref"),
      failure_disposition: text(args.failure_disposition ?? "checkpoint_and_handoff", "failure_disposition"),
      evidence_ids: strings(args.evidence_ids ?? (request.observation_refs as JsonObject[]).flatMap((item) => item.evidence_ids as string[]), "evidence_ids", 1),
      title: text(args.title ?? proposal.name, "title"), description: text(args.description ?? proposal.description, "description"),
    };
    // A Procedure is the taxonomy's `procedure` concept: its human-readable
    // name must pass the same readability contract as every other durable
    // record, or later readers get titles that only made sense to the writer.
    validateConcept("procedure", identity.title);
    const id = String(args.procedure_id ?? `experience_procedure_${stableDigest(identity).slice(-20)}`);
    const existing = this.store.find("experience_procedure", id);
    const identityDigest = stableDigest(identity);
    if (existing) {
      if (existing.identity_digest === identityDigest) return { procedure: existing, idempotent: true };
      const sameScenario = existing.scope === procedureScope && existing.procedure_kind === procedureKind
        && stableDigest(existing.scenario_signature) === stableDigest(scenarioSignature);
      if (args.evolve !== true || !sameScenario) throw new Error("Experience Procedure idempotency conflict");
    }
    const version = Number(existing?.version ?? 0) + 1;
    const body = this.markdown(identity);
    const definition = procedureKind === "prompt" ? null : this.definition(id, version, procedureKind as ProcedureKind, identity, proposal);
    const definitionRef = definition ? this.definitions.write(definition, String(identity.title)) : null;
    const ref = this.store.contentStore.writeSync({ kind: "experience", record_id: id, version,
      scope: String(identity.scope), status: "candidate", sensitivity: "internal", source_id: `workflow-evolution:${String(proposal.id)}`,
      title: identity.title, body, folder: this.folder(procedureKind),
      frontmatter: {
        procedure_kind: procedureKind,
        trigger: String(identity.trigger),
        preconditions: JSON.stringify(identity.preconditions),
        allowed_effects: JSON.stringify(identity.allowed_effects),
        acceptance_ref: String(identity.acceptance_ref),
        failure_disposition: String(identity.failure_disposition),
        scenario_signature: JSON.stringify(identity.scenario_signature),
        evidence_refs: JSON.stringify(identity.evidence_ids),
        lifecycle: "candidate",
        procedure_digest: identityDigest,
        scope_envelope: JSON.stringify(envelope),
        definition_digest: definitionRef?.digest ?? "",
        revoked_by: "",
      } });
    const next = { ...identity, proposal_id: proposal.id, proposal_version: proposal.version, candidate_version: version, lifecycle: "candidate", completed_gates: [],
      content_ref: ref, content_digest: ref.digest, definition_ref: definitionRef, definition_digest: definitionRef?.digest ?? null,
      // Concept tag is non-identity metadata: the taxonomy already validated the
      // title as a procedure, so downstream context/relations can see it.
      concept_kind: "procedure", identity_digest: identityDigest, routeable: false, publication_allowed: false };
    if (existing?.routeable === true) preserveProcedureRelease(this.store, existing);
    const procedure = existing ? this.store.save("experience_procedure", id, next) : this.store.create("experience_procedure", id, next);
    return { procedure, idempotent: false };
  }

  /** Persist one independently evidenced promotion gate. Gates are ordered and append-only. */
  gate(args: JsonObject): JsonObject {
    const result = this.store.transaction(() => {
      if (args.release_channel !== "current") return this.recordGate(args);
      if (args.passed !== false || args.stage !== "canary") throw new Error("Current release operation only supports explicit canary revocation");
      const active = activeProcedure(this.store, text(args.procedure_id, "procedure_id"));
      if (!active || args.expected_version !== active.version) throw new Error("Current release version conflict or unavailable");
      const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); evidenceIds.forEach(id => this.assertEvidence(id));
      preserveProcedureRelease(this.store, active);
      const release = this.store.get("experience_release", String(active.id));
      this.store.save("experience_release", String(active.id), { ...payload(release), status: "revoked", evidence_ids: evidenceIds });
      const latest = this.store.get("experience_procedure", String(active.id));
      if (latest.routeable === true) this.store.save("experience_procedure", String(active.id), { ...payload(latest), lifecycle: "rolled_back", routeable: false });
      return { procedure: this.store.get("experience_procedure", String(active.id)), release_revoked: true, candidate_preserved: latest.routeable !== true };
    }), procedure = result.procedure as JsonObject;
    return procedureDefinitionRef(procedure.definition_ref) ? { ...result, ...syncGraphVersionManifest(this.store, String(procedure.id)) } : result;
  }

  private recordGate(args: JsonObject): JsonObject {
    const procedure = this.store.get("experience_procedure", text(args.procedure_id, "procedure_id"));
    if (procedure.runbook_candidate === true && args.passed === true) throw new Error("Runbook candidates cannot pass Procedure gates directly; submit their learning through the multi-observation evaluation flow");
    if (belongsToRetiredScenario(this.store, procedure)) throw new Error("Experience scenario is retired; Procedure cannot qualify");
    const stage = text(args.stage, "stage") as Stage; if (!(STAGES as readonly string[]).includes(stage)) throw new Error("Experience Procedure gate is unsupported");
    const expected = STAGES.indexOf(stage);
    const invalidated = procedure.lifecycle === "rejected" || procedure.lifecycle === "rolled_back";
    const completed = !invalidated && Array.isArray(procedure.completed_gates) ? procedure.completed_gates.map(String) : [];
    const evidenceIds = strings(args.evidence_ids, "evidence_ids", 1); for (const evidenceId of evidenceIds) this.assertEvidence(evidenceId);
    const passed = args.passed === true;
    let qualification: JsonObject | undefined;
    if (passed && stage === "held_out") {
      qualification = this.verifyProcedureEvaluation(procedure, text(args.evaluation_contract_id, "evaluation_contract_id"), text(args.evaluation_id, "evaluation_id"));
    } else if (passed && (stage === "signoff" || stage === "canary")) {
      qualification = this.verifyProcedureEvaluation(procedure,
        text(args.evaluation_contract_id ?? procedure.evaluation_contract_id, "evaluation_contract_id"),
        text(args.evaluation_id ?? procedure.evaluation_id, "evaluation_id"), procedure);
    }
    const identity = { procedure_id: procedure.id, procedure_version: procedure.version, stage, evidence_ids: evidenceIds, passed,
      ...(qualification ? { qualification } : {}), verdict: text(args.verdict ?? (passed ? "passed" : "failed"), "verdict") };
    // A retry binds the request and immutable asset, not the version the first
    // successful transition itself incremented. Replays never reapply a gate.
    const requestDigest = stableDigest({ ...identity, procedure_version: null, asset_digest: procedure.identity_digest });
    const id = String(args.gate_id ?? `experience_procedure_gate_${requestDigest.slice(-20)}`);
    const existing = this.store.find("experience_procedure_gate", id);
    if (existing) {
      const matches = existing.request_digest === undefined
        ? existing.identity_digest === stableDigest({ ...identity, procedure_version: existing.procedure_version })
          && this.store.get("experience_procedure", String(procedure.id), Number(existing.procedure_version)).identity_digest === procedure.identity_digest
        : existing.request_digest === requestDigest;
      if (!matches) throw new Error("Experience Procedure gate idempotency conflict");
      return { gate: existing, procedure, idempotent: true };
    }
    if (args.expected_version !== undefined && (!Number.isSafeInteger(args.expected_version) || args.expected_version !== procedure.version)) throw new Error("Experience Procedure expected_version is invalid or stale");
    if (!STAGES.slice(0, expected).every(prior => completed.includes(prior))) throw new Error("Experience Procedure gate order is invalid");
    if (passed && Array.isArray(procedure.entrypoints)) {
      for (const entry of procedure.entrypoints as JsonObject[]) for (const route of entry.routes as JsonObject[]) {
        const covered = evidenceIds.some(id => {
          const metadata = this.store.get("evidence", id).metadata as JsonObject | undefined;
          return metadata?.procedure_definition_digest === procedure.definition_digest && metadata?.entry_id === entry.id
            && metadata?.exit_id === route.exit_id && (route.subscenario_id === undefined || metadata?.subscenario_id === route.subscenario_id) && metadata?.stage === stage && metadata?.status === "passed";
        });
        if (!covered) throw new Error(`Composition gate requires route Evidence: ${entry.id}/${route.exit_id}/${stage}`);
      }
    }
    const gate = this.store.create("experience_procedure_gate", id, { ...identity, identity_digest: stableDigest(identity), request_digest: requestDigest });
    // A failure invalidates the complete qualification. Rerunning an earlier
    // stage invalidates downstream passes even when the new result is positive.
    const next = passed ? [...STAGES.slice(0, expected), stage] : [];
    const lifecycle = !passed ? (stage === "canary" ? "rolled_back" : "rejected") : stage === "canary" ? "routeable" : "candidate";
    const resetQualification = !passed || stage === "shadow";
    const saved = this.store.save("experience_procedure", String(procedure.id), { ...payload(procedure), ...(qualification ?? {}),
      ...(resetQualification ? { evaluation_contract_id: null, evaluation_contract_digest: null, evaluation_id: null, candidate_ref: null } : {}),
      completed_gates: next, lifecycle, routeable: lifecycle === "routeable", rollback_gate_id: lifecycle === "rolled_back" ? gate.id : null });
    updateProcedureRelease(this.store, saved);
    this.refreshMarkdown(saved);
    return { gate, procedure: saved, idempotent: false };
  }

  private verifyProcedureEvaluation(procedure: JsonObject, contractId: string, evaluationId: string, prior?: JsonObject): JsonObject {
    const contract = this.store.get("evaluation_contract", contractId);
    const digest = String(procedure.definition_digest ?? procedure.content_digest ?? procedure.identity_digest ?? "");
    const candidateRef = { kind: "experience_procedure", id: String(procedure.id), version: Number(procedure.candidate_version ?? procedure.version), digest };
    const evaluation = this.evaluationVerifier.verifyTaskEffectEvaluation({ contract_id: contractId, evaluation_id: evaluationId, candidate_ref: candidateRef });
    return procedureEvaluationBinding({ procedure, contract, evaluation: evaluation as never, evaluationId, ...(prior ? { prior } : {}) });
  }

  plan(args: JsonObject): JsonObject { return new ProcedurePlanner(this.store).plan(args); }

  get(args: JsonObject): JsonObject {
    const id = text(args.procedure_id, "procedure_id");
    const procedure = args.release_channel === undefined ? this.store.get("experience_procedure", id, args.version === undefined ? undefined : Number(args.version)) : selectedProcedure(this.store, id, args.release_channel);
    if (!procedure) throw new Error("Procedure release unavailable");
    if (procedure.runbook_candidate === true && procedure.content_ref) {
      const content = this.store.contentStore.readCompatSync(procedure.content_ref as never);
      return { procedure, runbook: { status: "待验证", executable: false, body: content.body } };
    }
    return { procedure };
  }

  list(args: JsonObject = {}): JsonObject {
    const scope = args.scope === undefined ? null : text(args.scope, "scope");
    return { procedures: this.store.list("experience_procedure", Number(args.limit ?? 100), (item) => scope === null || item.scope === scope) };
  }

  /** Export only a routeable Procedure and keep it disabled until a Host installs it. */
  skillExport(args: JsonObject): JsonObject {
    const procedure = activeProcedure(this.store, text(args.procedure_id, "procedure_id"));
    if (!procedure || procedure.lifecycle !== "routeable" || procedure.routeable !== true) throw new Error("Only routeable Experience Procedures can be exported as Skills");
    const exportId = String(args.export_id ?? `experience_skill_export_${stableDigest({ procedure_id: procedure.id, version: procedure.version }).slice(-20)}`);
    const definition = procedureDefinitionRef(procedure.definition_ref) ? this.definitions.read(procedure.definition_ref) : null;
    if (!procedure.content_ref && !definition) throw new Error("Procedure has no checked export content");
    // User-authored configurations keep checked JSON as their content authority.
    const source = procedure.content_ref ? this.store.contentStore.readCompatSync(procedure.content_ref as never).body : this.markdown(procedure);
    const name = text(args.skill_name ?? String(procedure.id).replace(/^experience_procedure_/u, "craft-procedure-"), "skill_name");
    const markdown = `---\nname: ${yaml(name)}\ndescription: ${yaml(`Disabled Craft Procedure export: ${String(procedure.title)}`)}\ncraft_procedure_id: ${yaml(String(procedure.id))}\ncraft_procedure_version: ${Number(procedure.version)}\nenabled: false\n---\n\n# ${String(procedure.title)}\n\n${source}`;
    const contentDigest = stableDigest(markdown);
    const existing = this.store.find("experience_skill_export", exportId);
    if (existing) {
      if (existing.procedure_id !== procedure.id || existing.procedure_version !== procedure.version || existing.content_digest !== contentDigest) throw new Error("Experience Skill export idempotency conflict");
      return { export: existing, idempotent: true };
    }
    const root = resolve(this.store.paths.experienceDir);
    if (lstatSync(root).isSymbolicLink()) throw new Error("Experience export root must not be a symbolic link");
    const skills = join(root, "skills"); mkdirSync(skills, { recursive: true, mode: 0o700 });
    if (lstatSync(skills).isSymbolicLink()) throw new Error("Experience skills directory must not be a symbolic link");
    // IDs are ledger keys, never paths. Claim a new directory exclusively;
    // pre-existing files/directories (including symlinks) belong to their owner.
    const directory = join(skills, stableDigest(exportId).slice(7));
    mkdirSync(directory, { mode: 0o700 });
    const path = join(directory, "SKILL.md");
    const definitionPath = definition ? join(directory, "PROCEDURE.json") : null;
    try {
      writeFileSync(path, markdown, { encoding: "utf8", mode: 0o600, flag: "wx" });
      if (definitionPath) writeFileSync(definitionPath, `${JSON.stringify(definition, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      return { export: this.store.create("experience_skill_export", exportId, { procedure_id: procedure.id, procedure_version: procedure.version, path, definition_path: definitionPath, content_digest: contentDigest, enabled: false, status: "draft" }), idempotent: false };
    } catch (error) {
      rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private scope(request: JsonObject): string {
    const observation = (request.observation_refs as JsonObject[])[0];
    const source = observation?.source as JsonObject | undefined;
    const scope = typeof source?.scope === "string" ? source.scope : null;
    return scope ?? "project:unresolved";
  }

  private folder(kind: string): "workflows" | "graphs" | "prompts" {
    if (kind === "workflow") return "workflows";
    if (kind === "graph") return "graphs";
    return "prompts";
  }

  private definition(id: string, version: number, kind: ProcedureKind, identity: JsonObject, proposal: JsonObject): ProcedureDefinition {
    const graph = proposal.graph as JsonObject | null;
    const definition = kind === "workflow"
      ? { inputs: ((proposal.inputs ?? []) as unknown[]).map(input => typeof input === "string" ? { name: input, required: true } : input), steps: proposal.steps ?? [], ...(proposal.composition === undefined ? {} : { composition: proposal.composition }) }
      : { inputs: proposal.inputs ?? [], nodes: graph?.nodes ?? [], edges: graph?.edges ?? [], outputs: graph?.outputs ?? {}, checkpoint_policy: graph?.checkpoint_policy ?? { mode: "step" }, ...(graph?.graph_control === undefined ? {} : { graph_control: graph.graph_control }) };
    return {
      schema_version: "craft.procedure.v1", procedure_id: id, procedure_version: version, kind,
      scope: String(identity.scope), trigger: String(identity.trigger), preconditions: identity.preconditions as string[],
      allowed_effects: identity.allowed_effects as string[], acceptance_ref: String(identity.acceptance_ref),
      failure_disposition: String(identity.failure_disposition), scenario_signature: identity.scenario_signature as JsonObject,
      evidence_ids: identity.evidence_ids as string[], proposal_ref: { id: String(proposal.id), version: Number(proposal.version) }, definition,
    };
  }

  private markdown(value: JsonObject): string {
    const contracts = Array.isArray(value.entrypoints) ? `\n\n## Entry / Exit contracts\n\n\`\`\`json\n${JSON.stringify({ entries: value.entrypoints, exits: value.exits }, null, 2)}\n\`\`\`` : "";
    return `# ${String(value.title)}\n\n## Trigger\n${String(value.trigger)}\n\n## Preconditions\n${((value.preconditions ?? []) as string[]).map((item) => `- ${item}`).join("\n") || "- None"}\n\n## Allowed effects\n${((value.allowed_effects ?? []) as string[]).map((item) => `- ${item}`).join("\n")}\n\n## Acceptance\n${String(value.acceptance_ref)}\n\n## Failure disposition\n${String(value.failure_disposition)}\n\n## Evidence\n${((value.evidence_ids ?? []) as string[]).map((item) => `- ${item}`).join("\n")}\n\n${String(value.description)}${contracts}`;
  }

  /** The Markdown review view stays human-inspectable after promotion. */
  private refreshMarkdown(procedure: JsonObject): void {
    const ref = procedure.content_ref as { kind?: string; record_id?: string; version?: number; path?: string } | undefined;
    const version = ref?.version;
    if (!ref || ref.kind !== "experience" || typeof ref.record_id !== "string" || typeof version !== "number" || !Number.isSafeInteger(version) || typeof ref.path !== "string") return;
    this.store.contentStore.rewriteSync({
      kind: "experience", record_id: ref.record_id, version, current_path: ref.path,
      scope: String(procedure.scope), status: String(procedure.lifecycle), sensitivity: "internal",
      source_id: `workflow-evolution:${String(procedure.proposal_id)}`, title: String(procedure.title), body: this.markdown(procedure),
      frontmatter: {
        procedure_kind: String(procedure.procedure_kind), trigger: String(procedure.trigger),
        preconditions: JSON.stringify(procedure.preconditions ?? []), allowed_effects: JSON.stringify(procedure.allowed_effects ?? []),
        acceptance_ref: String(procedure.acceptance_ref), failure_disposition: String(procedure.failure_disposition),
        scenario_signature: JSON.stringify(procedure.scenario_signature), evidence_refs: JSON.stringify(procedure.evidence_ids ?? []),
        lifecycle: String(procedure.lifecycle), procedure_digest: String(procedure.identity_digest),
        scope_envelope: JSON.stringify(procedure.scope_envelope ?? {}),
        definition_digest: procedure.definition_digest === null || procedure.definition_digest === undefined ? "" : String(procedure.definition_digest),
        revoked_by: procedure.rollback_gate_id === null || procedure.rollback_gate_id === undefined ? "" : String(procedure.rollback_gate_id),
      },
    });
  }

  private assertEvidence(id: string): void {
    const evidence = this.store.get("evidence", id);
    if (!["bounded", "confirmed"].includes(String(evidence.confidence))) throw new Error("Experience Procedure requires bounded or confirmed Evidence");
  }
}

/** @deprecated Internal compatibility name. Prefer `ProcedureStore`. */
export { ProcedureStore as ExperienceProcedureKernel };
