import type { CraftStore, JsonObject } from "craft-common-store-local/store";
import { stableDigest } from "craft-common-base/digest";
import { EVAL_DOMAINS, type EvalDomain } from "craft-common-base/capability-protocol";
import { projectExperienceDirectory } from "./project-experience-directory.ts";
import { ExperienceLearningWorkItemOwner } from "./learning-work-item.ts";

const PROVENANCE = new Set(["host_observed", "user_stated", "inferred"]);
const SECRET = /(?:api[_-]?key|authorization|cookie|password|secret|token)\s*[:=]\s*[^\s]{4,}|bearer\s+[A-Za-z0-9._~-]{8,}/iu;
const UNSAFE_CONTENT = /https?:\/\/|[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}|\b(?:curl|wget|bash|sh|python|node)\s|\/(?:Users|home|private|tmp)\/|(?:^|\s)--[A-Za-z][\w-]*(?:=|\s)|\b(?:BEGIN|END)\s+(?:PROMPT|TRANSCRIPT|PRIVATE KEY)\b/iu;
const SECTION_KEYS = ["text", "provenance", "source_refs"];
const CANDIDATE_KEYS = ["title", "applies_when", "exclude_when", "steps", "pitfalls", "done_criteria", "failure_handling", "focus", "exclude_topics"];

function object(value: unknown, name: string): JsonObject {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as JsonObject;
}

function exactKeys(value: JsonObject, allowed: string[], name: string): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error(`${name} contains unsupported fields`);
}

function boundedText(value: unknown, name: string, max = 1_000): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  const result = value.trim();
  if (result.length > max || /[\r\n\0]/u.test(result) || SECRET.test(result) || UNSAFE_CONTENT.test(result)) {
    throw new Error(`${name} is unsafe or exceeds its size limit`);
  }
  return result;
}

function digest(value: unknown, name: string): string {
  if (typeof value !== "string" || !/^sha256:[a-f0-9]{64}$/iu.test(value)) throw new Error(`${name} must be a sha256 digest`);
  return value.toLowerCase();
}

function reference(value: unknown, kind: string, name: string): JsonObject {
  const item = object(value, name);
  exactKeys(item, ["kind", "id", "version", "digest", "sequence", "event_kind", "operation_id", "status", "tool_category", "tool_name", "verification_digest"], name);
  if (item.kind !== kind || typeof item.id !== "string" || !/^[A-Za-z0-9._:-]{1,192}$/u.test(item.id)
    || !Number.isSafeInteger(item.version) || Number(item.version) < 1) throw new Error(`${name} is invalid`);
  const result: JsonObject = { kind, id: item.id, version: Number(item.version), digest: digest(item.digest, `${name}.digest`) };
  if (kind === "trace_event") {
    if (!Number.isSafeInteger(item.sequence) || Number(item.sequence) < 1 || typeof item.event_kind !== "string"
      || typeof item.operation_id !== "string" || typeof item.status !== "string") throw new Error(`${name} is invalid`);
    result.sequence = Number(item.sequence);
    result.event_kind = boundedText(item.event_kind, `${name}.event_kind`, 80);
    result.operation_id = boundedText(item.operation_id, `${name}.operation_id`, 80);
    result.status = boundedText(item.status, `${name}.status`, 40);
    if (item.tool_category !== undefined || item.tool_name !== undefined) {
      if (item.tool_category !== "api_mcp" || item.operation_id !== "codex_tool_mcp"
        || typeof item.tool_name !== "string" || !/^mcp__[A-Za-z0-9_.-]{1,64}__[A-Za-z0-9_.-]{1,96}$/u.test(item.tool_name)) {
        throw new Error(`${name} MCP tool metadata is invalid`);
      }
      result.tool_category = "api_mcp";
      result.tool_name = item.tool_name;
    }
    if (item.verification_digest !== undefined) {
      if (item.operation_id !== "codex_tool_bash" || typeof item.verification_digest !== "string"
        || !/^sha256:[a-f0-9]{64}$/iu.test(item.verification_digest)) throw new Error(`${name} verification digest is invalid`);
      result.verification_digest = item.verification_digest.toLowerCase();
    }
  }
  return result;
}

function evidenceReference(value: unknown, store: CraftStore, source: JsonObject, name: string): JsonObject {
  const ref = reference(value, "evidence", name);
  const evidence = store.get("evidence", String(ref.id), Number(ref.version));
  const metadata = evidence.metadata as JsonObject | undefined;
  if (stableDigest(evidence) !== ref.digest || metadata?.content_stored !== false
    || metadata?.project_scope_id !== source.project_scope_id || metadata?.task_id !== source.task_id
    || metadata?.source_session_id !== source.session_id || metadata?.turn_id !== source.turn_id) {
    throw new Error(`${name} does not match the sanitized project Host Evidence`);
  }
  return ref;
}

function normalizeSources(value: unknown, store: CraftStore, scope: string): JsonObject[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > 8) throw new Error("sources must contain one to eight Trace references");
  const sources = value.map((raw, index) => {
    const name = `sources[${index}]`, source = object(raw, name);
    exactKeys(source, ["host", "project_scope_id", "task_id", "session_id", "turn_id", "trace_status", "terminal_outcome",
      "trace_ref", "event_refs", "observation_refs", "evidence_refs"], name);
    if (source.host !== "codex" || source.project_scope_id !== scope || !/^project:[A-Za-z0-9_-]{1,96}$/u.test(scope)) {
      throw new Error(`${name} Host source must use the canonical project scope`);
    }
    const taskId = boundedText(source.task_id, `${name}.task_id`, 256);
    const sessionId = boundedText(source.session_id, `${name}.session_id`, 256);
    const turnId = boundedText(source.turn_id, `${name}.turn_id`, 256);
    const traceStatus = boundedText(source.trace_status, `${name}.trace_status`, 32);
    const terminalOutcome = boundedText(source.terminal_outcome, `${name}.terminal_outcome`, 32);
    if (!["running", "completed", "failed", "cancelled", "blocked"].includes(traceStatus)
      || !["verified_passed", "verified_failed", "unverified", "not_observed"].includes(terminalOutcome)
      || terminalOutcome === "verified_passed" && traceStatus !== "completed"
      || terminalOutcome === "verified_failed" && traceStatus !== "failed") throw new Error(`${name} terminal evidence does not match the Trace status`);
    const traceRef = reference(source.trace_ref, "trace", `${name}.trace_ref`);
    const trace = store.get("trace", String(traceRef.id), Number(traceRef.version));
    if (trace.identity_digest !== traceRef.digest || trace.task_id !== taskId || trace.status !== traceStatus) {
      throw new Error(`${name} Trace reference does not match its stored identity and status`);
    }
    if (!Array.isArray(source.event_refs) || source.event_refs.length < 1 || source.event_refs.length > 512) {
      throw new Error(`${name}.event_refs must contain one to 512 references`);
    }
    const events = source.event_refs.map((item, eventIndex) => reference(item, "trace_event", `${name}.event_refs[${eventIndex}]`));
    if (events.some((event, eventIndex) => eventIndex > 0 && Number(event.sequence) <= Number(events[eventIndex - 1]!.sequence))
      || new Set(events.map(event => event.id)).size !== events.length) throw new Error(`${name}.event_refs must be unique and ordered`);
    const terminalEvents = events.filter(event => event.event_kind === "task.terminal_verification" || event.event_kind === "task.terminal_verification.unavailable");
    const hasVerifiedOutcome = terminalEvents.some(event => event.event_kind === "task.terminal_verification"
      && event.operation_id === "codex_task_terminal_verification" && event.status === terminalOutcome.slice("verified_".length));
    if (terminalOutcome.startsWith("verified_") && !hasVerifiedOutcome
      || terminalOutcome === "unverified" && !terminalEvents.some(event => event.event_kind === "task.terminal_verification.unavailable")
      || terminalOutcome === "not_observed" && terminalEvents.length > 0) {
      throw new Error(`${name} terminal outcome does not match its Trace event`);
    }
    if (!Array.isArray(source.observation_refs) || !Array.isArray(source.evidence_refs)) throw new Error(`${name} requires Observation and Evidence reference arrays`);
    const observations = source.observation_refs.map((rawObservation, observationIndex) => {
      const observationRef = reference(rawObservation, "workflow_evolution_observation", `${name}.observation_refs[${observationIndex}]`);
      const observation = store.get("workflow_evolution_observation", String(observationRef.id), Number(observationRef.version));
      const observedSource = observation.source as JsonObject | undefined;
      if (stableDigest(observation) !== observationRef.digest || observation.lifecycle !== "accepted"
        || observedSource?.kind !== "host:codex" || observedSource.id !== taskId || observedSource.session_id !== sessionId
        || observedSource.scope !== scope || !Array.isArray(observation.evidence_ids)) {
        throw new Error(`${name} Observation does not match the Host Trace identity`);
      }
      return observationRef;
    });
    const evidence = source.evidence_refs.map((item, evidenceIndex) => evidenceReference(item, store, {
      project_scope_id: scope, task_id: taskId, session_id: sessionId, turn_id: turnId,
    }, `${name}.evidence_refs[${evidenceIndex}]`));
    if (terminalOutcome.startsWith("verified_") && (!observations.length || !evidence.length)
      || !terminalOutcome.startsWith("verified_") && (observations.length > 0 || evidence.length > 0)) {
      throw new Error(`${name} Observation and Evidence refs must match its terminal verification`);
    }
    for (const item of evidence) {
      if (!observations.some(ref => {
        const observation = store.get("workflow_evolution_observation", String(ref.id), Number(ref.version));
        return (observation.evidence_ids as string[]).includes(String(item.id));
      })) throw new Error(`${name} Evidence must be referenced by a selected Observation`);
    }
    for (const ref of observations) {
      const observation = store.get("workflow_evolution_observation", String(ref.id), Number(ref.version));
      if ((observation.evidence_ids as unknown[]).some(id => !evidence.some(item => item.id === id))) {
        throw new Error(`${name} Observation Evidence must be included in the selected source`);
      }
    }
    return {
      host: "codex", project_scope_id: scope, task_id: taskId, session_id: sessionId, turn_id: turnId,
      trace_status: traceStatus, terminal_outcome: terminalOutcome,
      trace_ref: traceRef, event_refs: events, observation_refs: observations, evidence_refs: evidence,
    };
  });
  if (new Set(sources.map(item => String(item.trace_ref && (item.trace_ref as JsonObject).id))).size !== sources.length) {
    throw new Error("sources must contain unique Trace references");
  }
  return sources;
}

function selectedTraceEvents(sources: JsonObject[], store: CraftStore): Map<string, JsonObject> {
  const events = new Map<string, JsonObject>();
  for (const source of sources) {
    const traceRef = source.trace_ref as JsonObject;
    for (const ref of source.event_refs as JsonObject[]) {
      const event = store.get("trace_event", String(ref.id), Number(ref.version));
      const actionContract = event.action_contract && typeof event.action_contract === "object" && !Array.isArray(event.action_contract)
        ? event.action_contract as JsonObject : {};
      if (event.event_digest !== ref.digest || event.trace_id !== traceRef.id || event.sequence !== ref.sequence
        || event.event_kind !== ref.event_kind || event.operation_id !== ref.operation_id || event.status !== ref.status
        || (ref.tool_category !== undefined && (actionContract.tool_category !== ref.tool_category
          || actionContract.tool_name !== ref.tool_name))
        || (ref.verification_digest !== undefined && actionContract.verification_digest !== ref.verification_digest)) {
        throw new Error(`Trace Event reference ${String(ref.id)} does not match the stored Trace Event`);
      }
      events.set(String(ref.id), event);
    }
  }
  return events;
}

function hostObservedText(event: JsonObject): string {
  const actionContract = event.action_contract && typeof event.action_contract === "object" && !Array.isArray(event.action_contract)
    ? event.action_contract as JsonObject : {};
  const fields = [
    `event_kind=${String(event.event_kind)}`,
    `operation_id=${String(event.operation_id)}`,
    `status=${String(event.status)}`,
    `sequence=${String(event.sequence)}`,
    ...(actionContract.tool_category === "api_mcp" && typeof actionContract.tool_name === "string"
      ? [`tool_category=${actionContract.tool_category}`, `tool_name=${actionContract.tool_name}`] : []),
  ];
  return `Observed Host Trace fields: ${fields.join("; ")}.`;
}

function section(value: unknown, name: string, events: Map<string, JsonObject>): JsonObject {
  const input = object(value, name);
  exactKeys(input, SECTION_KEYS, name);
  const provenance = boundedText(input.provenance, `${name}.provenance`, 32);
  if (!PROVENANCE.has(provenance)) throw new Error(`${name}.provenance is unsupported`);
  if (!Array.isArray(input.source_refs)) throw new Error(`${name}.source_refs must be an array`);
  const sourceRefs = [...new Set(input.source_refs.map((item, index) => boundedText(item, `${name}.source_refs[${index}]`, 192)))].sort();
  const text = boundedText(input.text, `${name}.text`);
  if (provenance === "host_observed") {
    if (sourceRefs.length !== 1) throw new Error(`${name} host_observed content requires exactly one selected Trace event`);
    const event = events.get(sourceRefs[0]!);
    if (!event) throw new Error(`${name} host_observed content requires a selected Trace event`);
    if (text !== hostObservedText(event)) {
      throw new Error(`${name} host_observed content must exactly report one selected Trace Event's supported fields`);
    }
  }
  if (provenance !== "host_observed" && sourceRefs.length) throw new Error(`${name} non-Host content cannot cite Host events`);
  return { text, provenance, source_refs: sourceRefs,
    verification_status: provenance === "inferred" ? "unverified" : "provisional" };
}

function stringList(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 16) throw new Error(`${name} must be an array with at most 16 values`);
  return [...new Set(value.map((item, index) => boundedText(item, `${name}[${index}]`, 200)))];
}

function normalizeCandidate(value: unknown, events: Map<string, JsonObject>): JsonObject {
  const input = object(value, "candidate");
  exactKeys(input, CANDIDATE_KEYS, "candidate");
  const steps = input.steps;
  if (!Array.isArray(steps) || steps.length < 1 || steps.length > 32) throw new Error("candidate.steps must contain one to 32 values");
  if (!Array.isArray(input.pitfalls) || input.pitfalls.length > 16) throw new Error("candidate.pitfalls must contain at most 16 values");
  return {
    title: section(input.title, "candidate.title", events),
    applies_when: section(input.applies_when, "candidate.applies_when", events),
    exclude_when: section(input.exclude_when, "candidate.exclude_when", events),
    steps: steps.map((item, index) => section(item, `candidate.steps[${index}]`, events)),
    pitfalls: input.pitfalls.map((raw, index) => {
      const pitfall = object(raw, `candidate.pitfalls[${index}]`);
      exactKeys(pitfall, ["symptom", "cause", "provenance", "source_refs"], `candidate.pitfalls[${index}]`);
      const combined = section({ text: boundedText(pitfall.symptom, `candidate.pitfalls[${index}].symptom`),
        provenance: pitfall.provenance, source_refs: pitfall.source_refs }, `candidate.pitfalls[${index}]`, events);
      return { ...combined, cause: boundedText(pitfall.cause, `candidate.pitfalls[${index}].cause`) };
    }),
    done_criteria: section(input.done_criteria, "candidate.done_criteria", events),
    failure_handling: section(input.failure_handling, "candidate.failure_handling", events),
    focus: stringList(input.focus, "candidate.focus"),
    exclude_topics: stringList(input.exclude_topics, "candidate.exclude_topics"),
  };
}

function scenarioSignature(scope: string, sources: JsonObject[], candidate: JsonObject, store: CraftStore): JsonObject {
  const domains = sources.flatMap(source => source.observation_refs as JsonObject[]).map(ref => {
    const observation = store.get("workflow_evolution_observation", String(ref.id), Number(ref.version));
    const signature = observation.scenario_signature as JsonObject | undefined;
    return typeof signature?.domain === "string" && (EVAL_DOMAINS as readonly string[]).includes(signature.domain)
      ? signature.domain as EvalDomain : null;
  });
  const domain = domains.length > 0 && domains.every(item => item !== null && item === domains[0])
    ? domains[0] as EvalDomain : undefined;
  const projectId = scope.slice("project:".length);
  return {
    schema: "craft.scenario-signature.v1",
    source: "trace_distillation",
    scenario_key: `trace-distilled-${stableDigest({ scope, applies_when: candidate.applies_when }).slice(-20)}`,
    project: { id: projectId },
    ...(domain ? { domain } : {}),
  };
}

function renderSection(title: string, value: JsonObject): string {
  const label = value.provenance === "inferred" ? "inferred（未验证）" : String(value.provenance);
  const refs = (value.source_refs as string[]).length ? `；Trace 事件：${(value.source_refs as string[]).join(", ")}` : "";
  return `## ${title}\n来源标记：${label}${refs}\n${String(value.text)}`;
}

/** Saves a provisional prompt-shaped Procedure Candidate without copying source bodies. */
export function captureTraceDistillationCandidate(store: CraftStore, args: JsonObject,
  evaluationContracts: Pick<CraftStore, "get"> = store): JsonObject {
  return store.transaction(() => {
    const scope = boundedText(args.scope, "scope", 110);
    if (!/^project:[A-Za-z0-9_-]{1,96}$/u.test(scope)) throw new Error("Trace distillation requires a canonical project scope");
    projectExperienceDirectory(store, scope, undefined, true);
    const sources = normalizeSources(args.sources, store, scope);
    const events = selectedTraceEvents(sources, store);
    const candidate = normalizeCandidate(args.candidate, events);
    const signature = scenarioSignature(scope, sources, candidate, store);
    const requestId = args.request_id === undefined ? null : boundedText(args.request_id, "request_id", 128);
    const identity = { scope, request_id: requestId, source_refs: sources, candidate, scenario_signature: signature, raw_source_content_stored: false };
    const identityDigest = stableDigest(identity);
    const id = `experience_procedure_distilled_${stableDigest({ scope, request_id: requestId, source_refs: sources.map(source => source.trace_ref) }).slice(-20)}`;
    const existing = store.find("experience_procedure", id);
    const workItems = new ExperienceLearningWorkItemOwner(store, evaluationContracts);
    const queueCandidate = (procedure: JsonObject) => workItems.enqueueInTransaction({
      candidate_ref: { kind: "experience_procedure", id: String(procedure.id),
        version: Number(procedure.candidate_version ?? procedure.version), digest: String(procedure.definition_digest ?? procedure.content_digest ?? procedure.identity_digest) },
      scope, source_refs: sources, evaluation_contract_ref: args.evaluation_contract_ref ?? null, now: args.now,
    });
    if (existing) {
      if (existing.identity_digest !== identityDigest) throw new Error("Trace distillation idempotency conflict");
      const queued = queueCandidate(existing);
      return { procedure: existing, learning_work_item: queued.work_item, work_item_id: (queued.work_item as JsonObject).id,
        idempotent: true, work_item_idempotent: queued.idempotent, advisory_only: true };
    }
    const title = String((candidate.title as JsonObject).text);
    const body = [
      `# ${title}`,
      "",
      "> 待验证：此项目内候选不可路由；来源事件只证明 Host 操作类别和结果，不证明归纳步骤有效。",
      "",
      renderSection("适用条件", candidate.applies_when as JsonObject),
      "",
      renderSection("排除条件", candidate.exclude_when as JsonObject),
      "",
      "## 可复用步骤",
      ...(candidate.steps as JsonObject[]).map((item, index) => `### ${index + 1}\n${renderSection("步骤", item)}`),
      "",
      "## 观察到的坑点",
      ...(candidate.pitfalls as JsonObject[]).map(item => `${renderSection("现象", item)}\n原因：${String(item.cause)}`),
      "",
      renderSection("完成标准", candidate.done_criteria as JsonObject),
      "",
      renderSection("失败恢复", candidate.failure_handling as JsonObject),
      "",
      "## 用户关注点",
      ...((candidate.focus as string[]).length ? ["来源标记：user_stated", ...(candidate.focus as string[]).map(item => `- ${item}`)] : ["来源标记：user_stated；无"]),
      "## 用户排除项",
      ...((candidate.exclude_topics as string[]).length ? ["来源标记：user_stated", ...(candidate.exclude_topics as string[]).map(item => `- ${item}`)] : ["来源标记：user_stated；无"]),
      "",
      "## 来源引用",
      ...sources.flatMap(source => {
        const trace = source.trace_ref as JsonObject;
        return [`- Trace: ${String(trace.id)}@${String(trace.version)} ${String(trace.digest)}`,
          ...(source.event_refs as JsonObject[]).map(ref => `- Event: ${String(ref.id)}@${String(ref.version)} ${String(ref.digest)}`),
          ...(source.observation_refs as JsonObject[]).map(ref => `- Observation: ${String(ref.id)}@${String(ref.version)} ${String(ref.digest)}`),
          ...(source.evidence_refs as JsonObject[]).map(ref => `- Evidence: ${String(ref.id)}@${String(ref.version)} ${String(ref.digest)}`)];
      }),
      "",
      "## 提炼边界",
      "用户陈述和模型推断只作待审内容；推断内容未验证。当前 Trace 和本候选均不构成独立晋升证据。",
      "",
    ].join("\n");
    const definitionDigest = stableDigest({ body, scenario_signature: signature });
    const contentRef = store.contentStore.writeSync({ kind: "experience", record_id: id, version: 1, scope, status: "candidate",
      sensitivity: "internal", source_id: `host-trace:${String((sources[0]!.trace_ref as JsonObject).id)}`, title, body,
      folder: "prompts", frontmatter: { explicit_trace_distillation: "true", routeable: "false" } });
    const procedure = store.create("experience_procedure", id, {
      scope, title, description: title, procedure_kind: "prompt", provenance: "explicit_trace_distillation", version: 1,
      candidate_version: 1, identity_digest: identityDigest, content_digest: contentRef.digest, content_ref: contentRef,
      definition_digest: definitionDigest, source_refs: sources, scenario_signature: signature,
      source_content_stored: false, raw_source_content_stored: false,
      lifecycle: "candidate", completed_gates: [], routeable: false, publication_allowed: false, execution_visible: false,
      allowed_effects: ["read"], preconditions: [(candidate.exclude_when as JsonObject).text], trigger: (candidate.applies_when as JsonObject).text,
      acceptance_ref: (candidate.done_criteria as JsonObject).text, failure_disposition: (candidate.failure_handling as JsonObject).text,
      evidence_ids: [], runbook_candidate: false, source_provenance: ["host_observed", "user_stated", "inferred"],
    });
    const queued = queueCandidate(procedure);
    return { procedure, learning_work_item: queued.work_item, work_item_id: (queued.work_item as JsonObject).id,
      idempotent: false, work_item_idempotent: queued.idempotent, advisory_only: true };
  });
}
