import { createHash, randomUUID } from "node:crypto";
import type { CraftStore, JsonObject } from 'craft-common-store-local/store';
import { KnowledgeRelationKernel } from '@craft/capability-knowledge/knowledge-relation';
import { knowledgeLineageImpact } from '@craft/capability-knowledge/knowledge-lineage-impact';
import { DOMAIN_ADAPTERS, buildDomainEvaluationSummary, prepareDomainAdapterCandidate } from './domain-adapter-contract.ts';
import { CreationAdapter } from "./creation-adapter.ts";
import { redact } from "craft-common-base/workflow";
import { matchesEvolutionProjectScope, requireEvolutionProjectScope, type EvolutionProjectScope } from "./evolution-project-scope.ts";
import { captureGovernedProgramMemory, independentProgramMemoryObservations, programMemorySubmission, type ProgramMemorySources } from "./program-memory-governance.ts";

export const RESEARCH_LAYERS = ["literature_fact", "experiment_observation", "interpretation"] as const;
export type ResearchLayer = (typeof RESEARCH_LAYERS)[number];
export const RESEARCH_RELATIONS = ["derives_from", "supports", "contradicts", "supersedes"] as const;
export type ResearchRelation = (typeof RESEARCH_RELATIONS)[number];

export const DOMAIN_ADAPTER_NAMES = DOMAIN_ADAPTERS;
export type DomainAdapterName = (typeof DOMAIN_ADAPTER_NAMES)[number];
export type DomainOrGeneral = DomainAdapterName | "general";

/**
 * Adapter hints. They improve extraction accuracy and never gate capture: a
 * statement matching no pattern is still evaluated and stored via `general`.
 */
const DOMAIN_PATTERNS: Readonly<Record<DomainAdapterName, RegExp>> = {
  coding: /(?:报错|错误|失败|debug|fix|patch|test|repo|仓库|构建|编译)/iu,
  office: /(?:会议|决议|模板|文档|表格|ppt|流程|审批|附件)/iu,
  travel: /(?:预算|行程|航班|酒店|入住|出发|到达|签证)/iu,
  creation: /(?:prompt|风格|素材|生成|图片|视频|文章|幻灯片|封面)/iu,
  research: /(?:论文|假设|实验|结果|反例|复现|文献|参数)/iu,
};

export function classifyDomain(statement: string): DomainOrGeneral {
  for (const name of DOMAIN_ADAPTER_NAMES) if (DOMAIN_PATTERNS[name].test(statement)) return name;
  return "general";
}

function digest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 50) : [];
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function programMemoryProse(value: unknown, field: string): string {
  const input = text(value);
  if (!input || input.length > 1_000 || redact(input) !== input
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]|\{\{|(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]|\bbearer\s+\S+|-----BEGIN [A-Z ]*PRIVATE KEY-----/iu.test(input)) {
    throw new Error(`Program Memory ${field} is missing or unsafe`);
  }
  const result = input.replace(/https?:\/\/\S+|[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:\/[\w.-]+){2,}|[a-z]:\\[^\s]+|\b[a-f0-9]{32,}\b/giu, "[redacted]")
    .replace(/\s+/gu, " ").slice(0, 320).trim();
  return result;
}

export interface DomainAdapterRecord {
  name: DomainAdapterName;
  version: string;
  status: "candidate" | "active";
  extraction_patterns: string[];
  value_threshold: number;
  evidence_types: string[];
  eval_case_ids: string[];
  digest: string;
}

const DEFAULT_ADAPTERS: Record<DomainAdapterName, Omit<DomainAdapterRecord, "digest">> = {
  coding: { name: "coding", version: "v1", status: "active", extraction_patterns: ["error", "fix", "test", "repo"], value_threshold: 2, evidence_types: ["test", "patch", "verification"], eval_case_ids: ["coding.write", "coding.recall", "coding.apply", "coding.forget", "coding.scope_leak"] },
  office: { name: "office", version: "v1", status: "active", extraction_patterns: ["meeting", "template", "document", "decision"], value_threshold: 2, evidence_types: ["document", "decision", "principal"], eval_case_ids: ["office.write", "office.recall", "office.apply", "office.forget", "office.scope_leak"] },
  travel: { name: "travel", version: "v1", status: "active", extraction_patterns: ["budget", "date", "location", "booking"], value_threshold: 2, evidence_types: ["booking", "time", "location"], eval_case_ids: ["travel.write", "travel.recall", "travel.apply", "travel.forget", "travel.scope_leak"] },
  creation: { name: "creation", version: "v1", status: "active", extraction_patterns: ["prompt", "style", "artifact", "version"], value_threshold: 2, evidence_types: ["artifact", "user_choice", "tool"], eval_case_ids: ["creation.write", "creation.recall", "creation.apply", "creation.forget", "creation.scope_leak"] },
  research: { name: "research", version: "v1", status: "active", extraction_patterns: ["hypothesis", "experiment", "result", "counterexample"], value_threshold: 2, evidence_types: ["paper", "experiment", "verification"], eval_case_ids: ["research.write", "research.recall", "research.apply", "research.forget", "research.scope_leak"] },
};

/**
 * Self-evolution state owned by the Context capability.
 *
 * The kernel keeps only the Value Gate contract and hook triggers; this class
 * owns program memory, adapter hints, artifact lineage, prospective intentions
 * and research links, and composes the other capabilities' stores rather than
 * duplicating them.
 */
export class SelfEvolutionKernel {
  readonly store: CraftStore;
  private programMemorySources: ProgramMemorySources = {};
  configureProgramMemorySources(sources: ProgramMemorySources): void { this.programMemorySources = sources; }
  private readonly relations: KnowledgeRelationKernel;
  constructor(store: CraftStore) { this.store = store; this.relations = new KnowledgeRelationKernel(store); }

  ensureAdapters(): JsonObject {
    for (const [name, adapter] of Object.entries(DEFAULT_ADAPTERS)) {
      const id = `domain_adapter_${name}`;
      if (this.store.find("domain_adapter", id)) continue;
      this.store.create("domain_adapter", id, { ...adapter, digest: digest(adapter) });
    }
    return { items: this.store.list("domain_adapter", 10, undefined, false), general_fallback: true };
  }

  registerAdapter(args: JsonObject): JsonObject {
    const candidate = prepareDomainAdapterCandidate({ ...args, name: args.name, version: text(args.version) || "v1" });
    const id = `domain_adapter_${candidate.name}_candidate_${randomUUID().slice(0, 8)}`;
    const record = { ...candidate, digest: digest(candidate) };
    this.store.create("domain_adapter", id, record);
    return this.store.get("domain_adapter", id);
  }

  captureDomainStatement(args: JsonObject): JsonObject {
    const statement = programMemoryProse(args.statement, "statement");
    const requested = text(args.domain);
    if (requested && requested !== "general" && !(DOMAIN_ADAPTER_NAMES as readonly string[]).includes(requested))
      throw new Error("unsupported domain adapter");
    const domain: DomainOrGeneral = requested === "general" || !requested ? classifyDomain(statement) : requested as DomainAdapterName;
    const matched = domain !== "general" && DOMAIN_PATTERNS[domain].test(statement);
    const effective: DomainOrGeneral = matched ? domain : "general";
    const candidate = this.captureProgramMemory({ ...args, statement, domain: effective,
      scenario_key: text(args.scenario_key) || `${effective}_${digest(statement).slice(-12)}`,
      steps: stringArray(args.steps), evidence_ids: stringArray(args.evidence_ids) });
    return { status: "candidate", domain: effective, adapter_match: matched, candidate };
  }

  captureProgramMemory(args: JsonObject): JsonObject {
    const statement = programMemoryProse(args.statement, "statement");
    const scenarioKey = text(args.scenario_key) || `general_${digest(statement).slice(-12)}`;
    if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/iu.test(scenarioKey)) throw new Error("Program Memory requires a stable scenario key");
    const domain = text(args.domain) || "general";
    if (domain !== "general" && !(DOMAIN_ADAPTER_NAMES as readonly string[]).includes(domain)) throw new Error("unsupported domain adapter");
    const scope = requireEvolutionProjectScope(args.scope);
    const steps = stringArray(args.steps).map(step => programMemoryProse(step, "step"));
    return captureGovernedProgramMemory(this.store, { ...args, statement, scenario_key: scenarioKey, domain, scope,
      steps, evidence_ids: stringArray(args.evidence_ids) }, this.programMemorySources);
  }

  listProgramMemory(args: JsonObject): JsonObject {
    const scope = requireEvolutionProjectScope(args.scope);
    const status = text(args.status);
    return { items: this.store.list("program_memory_candidate", 100, (item) =>
      (!status || item.status === status) && this.programMemoryInScope(item, scope), false, undefined, `project:${scope.id}`) };
  }

  getProgramMemory(args: JsonObject): JsonObject {
    return { candidate: this.scopedProgramMemory(text(args.id), args.scope) };
  }

  private programMemoryInScope(candidate: JsonObject, scope: EvolutionProjectScope): boolean {
    if (!matchesEvolutionProjectScope(candidate.scope, scope)) return false;
    if (candidate.scope_provenance === "project_binding" || typeof candidate.content_digest === "string") return true;
    // Old tools accepted caller-supplied scope. Until verified observations
    // establish ownership, retain the row for repair without exposing its prose.
    return independentProgramMemoryObservations(this.store, stringArray(candidate.evidence_ids), scope, candidate.scenario_key, this.programMemorySources).length > 0;
  }

  submitProgramMemory(id: string, scope?: JsonObject): JsonObject {
    const candidate = this.scopedProgramMemory(id, scope);
    const { design, observations } = programMemorySubmission(this.store, candidate, this.programMemorySources);
    return { candidate, design, observations };
  }

  promoteProgramMemory(args: JsonObject): JsonObject {
    const candidate = this.scopedProgramMemory(text(args.id), args.scope);
    if (candidate.status !== "submitted" && candidate.status !== "promoted") throw new Error("program memory candidate is not submitted");
    const procedure = (this.programMemorySources.observations ?? this.store).find("experience_procedure", String(candidate.procedure_id));
    const release = (this.programMemorySources.observations ?? this.store).find("experience_release", String(candidate.procedure_id));
    if (!procedure || procedure.scope !== object(candidate.scope).id || procedure.request_id !== candidate.request_id
      || procedure.lifecycle !== "routeable" || procedure.routeable !== true || release?.status !== "active"
      || release.record_version !== procedure.version
      || [procedure.valid_until, release.valid_until].some(value => typeof value === "string" && !(Date.parse(value) > Date.now()))
      || !text(args.evaluation_ref) || procedure.evaluation_id !== args.evaluation_ref) {
      throw new Error("Program Memory requires the current qualified Experience release");
    }
    if (candidate.status === "promoted" && candidate.evaluation_ref === procedure.evaluation_id
      && candidate.procedure_version === procedure.version) return candidate;
    return this.store.save("program_memory_candidate", String(candidate.id), { ...candidate, status: "promoted",
      evaluation_ref: procedure.evaluation_id, procedure_version: procedure.version, promoted_at: new Date().toISOString() });
  }

  private scopedProgramMemory(id: string, value: unknown): JsonObject {
    const scope = requireEvolutionProjectScope(value);
    const candidate = this.store.find("program_memory_candidate", id);
    if (!candidate || !this.programMemoryInScope(candidate, scope)) throw new Error("Program Memory candidate unavailable in this project");
    return candidate;
  }

  recordProgramMemoryFeedback(args: JsonObject): JsonObject {
    const id = text(args.id);
    const outcome = text(args.outcome);
    if (!["confirmed", "degraded", "revoked"].includes(outcome)) throw new Error("outcome must be confirmed, degraded or revoked");
    const current = this.scopedProgramMemory(id, args.scope);
    if (current.status === "revoked") return current;
    const feedback = Array.isArray(current.feedback) ? current.feedback as JsonObject[] : [];
    const status = outcome === "revoked" ? "revoked" : outcome === "degraded" ? "rejected" : current.status;
    return this.store.save("program_memory_candidate", id, { ...current, status,
      feedback: [...feedback, { outcome, at: new Date().toISOString(), evidence_ids: stringArray(args.evidence_ids) }] });
  }

  captureFailureCandidate(args: JsonObject): JsonObject {
    const failureClass = text(args.failure_class);
    if (!failureClass || failureClass === "unattributed") throw new Error("an attributed failure_class is required");
    if (!/^[a-z0-9][a-z0-9._:/-]{0,127}$/iu.test(failureClass)) throw new Error("a stable failure_class is required");
    const remedy = programMemoryProse(args.remedy, "remedy");
    const evidenceIds = stringArray(args.evidence_ids);
    if (!evidenceIds.length) throw new Error("failure attribution requires evidence");
    const scope = requireEvolutionProjectScope(args.scope);
    const id = `program_memory_failure_${digest({ failureClass, remedy, evidenceIds, scope }).slice(-24)}`;
    const prior = this.store.find("program_memory_candidate", id);
    if (prior) return prior;
    const record = { id, scenario_key: `failure:${failureClass}`, domain: "general", kind: "failure_pattern",
      statement: `Failure pattern ${failureClass}: ${remedy}`, steps: [], evidence_ids: evidenceIds,
      repetitions: 1, status: "diagnostic", scope, scope_provenance: "project_binding", failure_class: failureClass,
      digest: digest({ failureClass, remedy, evidenceIds }) };
    return this.store.create("program_memory_candidate", id, record);
  }

  recordArtifactLineage(args: JsonObject): JsonObject {
    return new CreationAdapter(this.store).write(args);
  }

  recallArtifactLineage(args: JsonObject): JsonObject {
    // A general artifact inventory can contain many unrelated assets of one type.
    return new CreationAdapter(this.store).recall(args, false);
  }

  applyArtifactLineage(args: JsonObject): JsonObject {
    return new CreationAdapter(this.store).apply(args);
  }

  forgetArtifactLineage(args: JsonObject): JsonObject {
    return new CreationAdapter(this.store).forget(args);
  }

  createProspectiveIntention(args: JsonObject): JsonObject {
    const intention = redact(text(args.intention)).slice(0, 500);
    if (!intention) throw new Error("intention must not be empty");
    const trigger = object(args.trigger);
    const encodedTrigger = JSON.stringify(trigger);
    if (!Object.keys(trigger).length || encodedTrigger.length > 1000 || redact(encodedTrigger) !== encodedTrigger
      || Object.keys(trigger).some(key => /token|secret|password|cookie|authorization|api.?key/iu.test(key)))
      throw new Error("trigger must be nonempty, bounded and free of credentials");
    const expiresAt = Date.parse(text(args.expires_at));
    const notBefore = args.not_before === undefined ? null : Date.parse(text(args.not_before));
    if (!Number.isFinite(expiresAt) || expiresAt <= Date.now()
      || notBefore !== null && (!Number.isFinite(notBefore) || notBefore >= expiresAt))
      throw new Error("intention requires a future expires_at after any not_before");
    const scope = requireEvolutionProjectScope(args.scope);
    const timing = { expires_at: new Date(expiresAt).toISOString(), not_before: notBefore === null ? null : new Date(notBefore).toISOString() };
    const id = `prospective_${digest({ intention, trigger, scope, ...timing }).slice(-24)}`;
    return this.store.transaction(() => this.store.find("prospective_intention", id)
      ?? this.store.create("prospective_intention", id, { id, intention, trigger, scope, ...timing,
        evidence_ids: stringArray(args.evidence_ids), status: "pending", receipts: [] }));
  }

  listProspectiveIntentions(args: JsonObject): JsonObject {
    const scope = requireEvolutionProjectScope(args.scope);
    const status = text(args.status);
    const now = Date.now();
    const items = this.store.list("prospective_intention", 100,
      item => matchesEvolutionProjectScope(item.scope, scope) && (!status || this.intentionStatus(item, now) === status), false)
      .map(item => ({ ...item, status: this.intentionStatus(item, now) }));
    return { items };
  }

  fireProspectiveIntention(args: JsonObject): JsonObject {
    const trigger = object(args.trigger);
    return this.store.transaction(() => {
      const current = this.scopedIntention(args);
      const now = Date.now();
      const status = this.intentionStatus(current, now);
      if (status !== "pending") return { ...current, status };
      if (Date.parse(text(current.not_before)) > now) return { ...current, reason: "not_before" };
      const matched = Object.entries(object(current.trigger)).every(([key, value]) => digest(trigger[key] ?? null) === digest(value));
      if (!matched) return { ...current, reason: "trigger_mismatch" };
      const receipt = { at: new Date(now).toISOString(), matched, action_authorized: false };
      return this.store.save("prospective_intention", String(current.id), { ...current, status: "awaiting_host",
        receipt, receipts: [...(current.receipts as JsonObject[]), receipt] });
    });
  }

  revokeProspectiveIntention(args: JsonObject): JsonObject {
    return this.store.transaction(() => {
      const current = this.scopedIntention(args);
      if (current.status === "revoked") return current;
      return this.store.save("prospective_intention", String(current.id), { ...current, status: "revoked",
        revoked_at: new Date().toISOString() });
    });
  }

  private scopedIntention(args: JsonObject): JsonObject {
    const scope = requireEvolutionProjectScope(args.scope);
    const current = this.store.find("prospective_intention", text(args.id));
    if (!current || !matchesEvolutionProjectScope(current.scope, scope)) throw new Error("prospective intention is not in scope");
    return current;
  }

  private intentionStatus(item: JsonObject, now: number): string {
    const status = text(item.status);
    const expiresAt = Date.parse(text(item.expires_at));
    return (status === "pending" || status === "awaiting_host") && (!Number.isFinite(expiresAt) || expiresAt <= now)
      ? "expired" : status;
  }

  private activeResearchNode(id: string, scope: EvolutionProjectScope): JsonObject | null {
    const claim = this.store.find("knowledge_claim", id, undefined, false);
    return claim && typeof claim.research_layer === "string" && claim.research_status !== "forgotten"
      && matchesEvolutionProjectScope(claim.research_scope, scope) ? claim : null;
  }

  private researchEvidenceInScope(id: string, scope: EvolutionProjectScope): boolean {
    const evidence = this.store.find("evidence", id, undefined, false);
    const metadata = object(evidence?.metadata);
    return evidence !== null && evidence.record_origin !== "caller_asserted"
      && (evidence.confidence === "bounded" || evidence.confidence === "confirmed")
      && metadata.revoked !== true && metadata.retracted !== true
      && matchesEvolutionProjectScope(evidence.scope ?? metadata.scope ?? metadata.project_scope_id, scope);
  }

  captureResearchNode(args: JsonObject): JsonObject {
    const id = text(args.id), layer = text(args.layer) as ResearchLayer, content = redact(text(args.content)).slice(0, 2000);
    if (!id || !content) throw new Error("id and content are required");
    if (!(RESEARCH_LAYERS as readonly string[]).includes(layer)) throw new Error(`layer must be one of ${RESEARCH_LAYERS.join(", ")}`);
    const scope = requireEvolutionProjectScope(args.scope);
    const sourceRefs = stringArray(args.source_refs).map(ref => redact(ref).slice(0, 500));
    return this.store.transaction(() => {
      const existing = this.store.find("knowledge_claim", id, undefined, false);
      if (existing && (existing.research_layer !== layer || !matchesEvolutionProjectScope(existing.research_scope, scope)))
        throw new Error("research node layer or scope mismatch");
      if (existing?.research_status === "forgotten") throw new Error("research node is unavailable");
      const saved = this.store.save("knowledge_claim", id, {
        kind: layer === "experiment_observation" ? "decision" : layer === "interpretation" ? "rule" : "fact",
        content, scope: `project:${scope.id}`, source_refs: sourceRefs,
        research_layer: layer, research_scope: scope,
      });
      return { node: { kind: "knowledge_claim", id: String(saved.id), version: Number(saved.version) },
        id: String(saved.id), layer, content, source_refs: sourceRefs, scope };
    });
  }

  recallResearch(args: JsonObject = {}): JsonObject {
    const scope = requireEvolutionProjectScope(args.scope);
    const query = text(args.query).toLowerCase();
    const items = this.store.list("knowledge_claim", 200, (item) =>
      typeof item.research_layer === "string" && item.research_status !== "forgotten"
      && matchesEvolutionProjectScope(item.research_scope, scope)
      && (!query || text(item.content).toLowerCase().includes(query)), false)
      .map((claim) => ({ node: { kind: "knowledge_claim", id: String(claim.id), version: Number(claim.version) },
        id: String(claim.id), layer: claim.research_layer, content: claim.content,
        source_refs: Array.isArray(claim.source_refs) ? claim.source_refs : [], scope: object(claim.research_scope) }));
    return { items, denied: false, scope };
  }

  applyResearchImpact(args: JsonObject): JsonObject {
    const nodeId = text(args.node_id);
    if (!nodeId) throw new Error("node_id is required");
    const scope = requireEvolutionProjectScope(args.scope);
    return this.store.readSnapshot(() => {
      if (!this.activeResearchNode(nodeId, scope)) throw new Error("research node is unavailable or not in scope");
      return knowledgeLineageImpact(this.store, { node: { kind: "knowledge_claim", id: nodeId },
        as_of: args.as_of, max_nodes: args.max_nodes }, edge => {
        const link = this.store.find("research_memory_link", String(edge.id), undefined, false);
        if (!link || !matchesEvolutionProjectScope(link.scope, scope)) return false;
        const source = this.activeResearchNode(text(link.source_id), scope);
        const target = this.activeResearchNode(text(link.target_id), scope);
        return source !== null && target !== null
          && object(edge.source).id === source.id && object(edge.target).id === target.id
          && (link.source_version === undefined || link.source_version === source.version)
          && (link.target_version === undefined || link.target_version === target.version)
          && stringArray(edge.evidence_ids).every(id => this.researchEvidenceInScope(id, scope));
      });
    });
  }

  forgetResearchNode(args: JsonObject): JsonObject {
    const id = text(args.id), scope = requireEvolutionProjectScope(args.scope);
    return this.store.transaction(() => {
      const claim = this.store.find("knowledge_claim", id, undefined, false);
      if (!claim || typeof claim.research_layer !== "string" || !matchesEvolutionProjectScope(claim.research_scope, scope))
        throw new Error("research node is not in scope");
      const links = this.store.list("research_memory_link", Number.MAX_SAFE_INTEGER,
        link => matchesEvolutionProjectScope(link.scope, scope) && (link.source_id === id || link.target_id === id), false);
      const retracted: string[] = [];
      for (const link of links) {
        const relationId = String(link.relation_id);
        if (this.store.find("knowledge_relation", relationId, undefined, false)?.valid_to === null) {
          this.relations.retract({ relation_id: relationId, reason: "research node forgotten" });
          retracted.push(relationId);
        }
      }
      const current = claim.research_status === "forgotten" ? claim : this.store.save("knowledge_claim", id, {
        kind: claim.kind, scope: claim.scope, research_layer: claim.research_layer, research_scope: scope,
        research_status: "forgotten", forgotten_at: new Date().toISOString(),
      });
      return { node: { kind: "knowledge_claim", id, version: Number(current.version) }, status: "forgotten", retracted_relation_ids: retracted };
    });
  }

  linkResearch(args: JsonObject): JsonObject {
    const sourceId = text(args.source_id), targetId = text(args.target_id), relation = text(args.relation);
    if (!sourceId || !targetId || !relation) throw new Error("source_id, target_id and relation are required");
    if (!(RESEARCH_RELATIONS as readonly string[]).includes(relation)) throw new Error("unsupported research relation");
    if (text(args.layer) && !(RESEARCH_LAYERS as readonly string[]).includes(text(args.layer)))
      throw new Error(`layer must be one of ${RESEARCH_LAYERS.join(", ")}`);
    const scope = args.scope === undefined ? null : requireEvolutionProjectScope(args.scope);
    const layer = text(args.layer) || "experiment_observation";
    // Legacy unscoped links remain diagnostic and cannot access either endpoint.
    if (!scope) return { source_id: sourceId, target_id: targetId, relation, layer, scope: {}, status: "diagnostic" };
    return this.store.transaction(() => {
      const source = this.activeResearchNode(sourceId, scope);
      const target = this.activeResearchNode(targetId, scope);
      if (!source || !target) throw new Error("research node is unavailable or not in scope");
      const evidenceIds = stringArray(args.evidence_ids);
      if (!evidenceIds.every(id => this.researchEvidenceInScope(id, scope)))
        throw new Error("research evidence is unavailable in this project");
      const identity = { source_id: sourceId, target_id: targetId, relation, scope, source_version: source.version, target_version: target.version };
      const identityDigest = digest(identity);
      const id = text(args.relation_id) || `research_link_${identityDigest.slice(-24)}`;
      const previous = this.store.find("research_memory_link", id, undefined, false);
      if (previous && previous.digest !== identityDigest) throw new Error("research relation is unavailable or has changed");
      this.relations.relate({ relation_id: id, source: { kind: "knowledge_claim", id: sourceId },
        target: { kind: "knowledge_claim", id: targetId }, relation,
        confidence: "bounded", evidence_ids: evidenceIds });
      const saved = previous ?? this.store.create("research_memory_link", id, { ...identity, relation_id: id, digest: identityDigest });
      return { ...saved, layer };
    });
  }

  proposeReplicationProcedure(args: JsonObject): JsonObject {
    const id = text(args.id), title = text(args.title), sourceId = text(args.source_id);
    const steps = stringArray(args.steps);
    if (!id || !title || !sourceId || !steps.length) throw new Error("id, title, source_id and steps are required");
    const scope = requireEvolutionProjectScope(args.scope);
    return this.store.transaction(() => {
      const source = this.activeResearchNode(sourceId, scope);
      const existing = this.store.find("replication_candidate", id, undefined, false);
      if (!source || existing && !matchesEvolutionProjectScope(existing.scope, scope))
        throw new Error("research node or replication candidate is not in scope");
      const sourceRef = { kind: "knowledge_claim", id: sourceId, version: source.version };
      const candidate = this.captureProgramMemory({ scenario_key: "research", domain: "research",
        statement: `Replicate: ${title}`, steps, evidence_ids: stringArray(args.evidence_ids),
        evaluation_contract_id: args.evaluation_contract_id, scope, source_refs: [sourceRef] });
      return this.store.save("replication_candidate", id, { ...candidate, replication_id: id,
        program_memory_id: String(candidate.id), title: redact(title).slice(0, 500), source_id: sourceId, source_ref: sourceRef });
    });
  }

  evalSummary(): JsonObject {
    return buildDomainEvaluationSummary() as unknown as JsonObject;
  }
}
