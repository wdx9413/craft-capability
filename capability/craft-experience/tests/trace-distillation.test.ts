import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { ExperienceLearningEvaluation } from "../learning-evaluation.ts";
import { EXPERIENCE_COMPONENT, EXPERIENCE_OWNS } from "../ownership.ts";
import { ProcedureStore } from "../procedure-projection.ts";
import { ExperienceLearningWorkItemOwner } from "../learning-work-item.ts";
import { ExperienceContribution } from "../contribution.ts";
import { AUTOMATIC_SIGNOFF_POLICY } from "../scenario-evaluation.ts";
import { stableDigest } from "craft-common-base/digest";
import { craftPaths } from "craft-common-store-local/paths";
import { CraftStore } from "craft-common-store-local/store";

const candidate = {
  title: { text: "Recover a failed project check", provenance: "user_stated", source_refs: [] },
  applies_when: { text: "A project check reports a failure", provenance: "inferred", source_refs: [] },
  exclude_when: { text: "The failure belongs to an unrelated project", provenance: "user_stated", source_refs: [] },
  steps: [{ text: "Inspect the reported check category before changing files", provenance: "inferred", source_refs: [] }],
  pitfalls: [{ symptom: "A retry repeats the same failing check", cause: "The underlying change was not applied", provenance: "inferred", source_refs: [] }],
  done_criteria: { text: "The relevant project check reaches a passing result", provenance: "inferred", source_refs: [] },
  failure_handling: { text: "Stop and report the unresolved check category", provenance: "inferred", source_refs: [] },
  focus: ["failure recovery"],
  exclude_topics: ["unrelated projects"],
};

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "craft-experience-trace-distillation-"));
  const projectRoot = join(root, "project");
  const otherRoot = join(root, "other-project");
  mkdirSync(projectRoot);
  mkdirSync(otherRoot);
  let store = await new CraftStore(craftPaths(root)).open();
  store.create("scope_alias", "project-path", { status: "active", alias_kind: "path", alias: projectRoot,
    alias_digest: stableDigest(projectRoot), scope: { kind: "project", id: "project:trace-test" } });
  store.create("scope_alias", "other-project-path", { status: "active", alias_kind: "path", alias: otherRoot,
    alias_digest: stableDigest(otherRoot), scope: { kind: "project", id: "project:other" } });
  const evidenceId = "evidence-1";
  store.create("evidence", evidenceId, { confidence: "bounded", metadata: { provenance: "host_completion_signal",
    verification_outcome: "passed", project_scope_id: "project:trace-test", source_session_id: "session-1",
    task_id: "task-1", turn_id: "turn-1", content_stored: false } });
  store.create("workflow_evolution_observation", "observation-1", { lifecycle: "accepted", outcome: "passed",
    source: { kind: "host:codex", id: "task-1", session_id: "session-1", scope: "project:trace-test" },
    scenario_signature: { domain: "coding" },
    evidence_ids: [evidenceId] });
  const traceIdentity = { host: "codex", project_scope_id: "project:trace-test", task_id: "task-1",
    session_id: "session-1", turn_id: "turn-1", status: "completed" };
  store.create("trace", "trace-1", { ...traceIdentity, identity_digest: stableDigest(traceIdentity) });
  createTraceEvent(store, "event-1", 1, { event_kind: "host.tool.completed", operation_id: "codex_tool_bash",
    status: "failed", source: "codex", trust: "observed",
    action_contract: { kind: "host_tool_operation", tool_category: "script" } });
  createTraceEvent(store, "terminal-1", 2, { event_kind: "task.terminal_verification",
    operation_id: "codex_task_terminal_verification", status: "passed", source: "experience", trust: "verified" });
  let procedures = new ProcedureStore(store);
  return {
    root,
    get store() { return store; },
    get procedures() { return procedures; },
    async restart() {
      await store.close();
      store = await new CraftStore(craftPaths(root)).open();
      procedures = new ProcedureStore(store);
    },
    async close() { await store.close(); rmSync(root, { recursive: true, force: true }); },
  };
}

function createTraceEvent(store: CraftStore, id: string, sequence: number, fields: Record<string, unknown>) {
  const identity = { trace_id: "trace-1", sequence, ...fields };
  return store.create("trace_event", id, { ...identity, event_digest: stableDigest(identity) });
}

function traceEventRef(store: CraftStore, id: string) {
  const event = store.get("trace_event", id);
  const actionContract = event.action_contract as Record<string, unknown> | undefined;
  return {
    kind: "trace_event", id: event.id, version: event.version, digest: event.event_digest,
    sequence: event.sequence, event_kind: event.event_kind, operation_id: event.operation_id, status: event.status,
    ...(actionContract?.tool_category === "api_mcp" ? {
      tool_category: actionContract.tool_category, tool_name: actionContract.tool_name,
    } : {}),
    ...(typeof actionContract?.verification_digest === "string" ? { verification_digest: actionContract.verification_digest } : {}),
  };
}

function sources(store: CraftStore) {
  const evidence = store.get("evidence", "evidence-1");
  const observation = store.get("workflow_evolution_observation", "observation-1");
  return [{
    host: "codex",
    project_scope_id: "project:trace-test",
    task_id: "task-1",
    session_id: "session-1",
    turn_id: "turn-1",
    trace_status: "completed",
    terminal_outcome: "verified_passed",
    trace_ref: { kind: "trace", id: "trace-1", version: 1, digest: store.get("trace", "trace-1").identity_digest },
    event_refs: [traceEventRef(store, "event-1"), traceEventRef(store, "terminal-1")],
    observation_refs: [{ kind: "workflow_evolution_observation", id: "observation-1", version: 1, digest: stableDigest(observation) }],
    evidence_refs: [{ kind: "evidence", id: "evidence-1", version: 1, digest: stableDigest(evidence) }],
  }];
}

test("Trace distillation reads pinned Trace and events from a separate Runtime owner", async () => {
  const f = await fixture();
  const runtime = await new CraftStore(craftPaths(join(f.root, "runtime-owner"))).open();
  try {
    const input = sources(f.store);
    for (const [kind, id] of [["trace", "trace-1"], ["trace_event", "event-1"], ["trace_event", "terminal-1"]]) {
      const record = f.store.get(kind!, id!);
      const { id: _id, version: _version, created_at: _created, updated_at: _updated, ...payload } = record;
      runtime.create(kind!, id!, payload);
      f.store.remove(kind!, id!);
    }
    f.procedures.setTraceSource(runtime);
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: input, candidate });
    assert.equal((saved.procedure as Record<string, unknown>).lifecycle, "candidate");
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:other", sources: input, candidate }), /scope/u);
  } finally { runtime.close(); await f.close(); }
});

test("explicit Trace distillation stores a scoped, provenance-labeled Candidate and queues the existing Learning Work Item", async () => {
  const f = await fixture();
  try {
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: sources(f.store), candidate });
    const procedure = saved.procedure as Record<string, unknown>;
    assert.equal(saved.advisory_only, true);
    assert.equal(procedure.scope, "project:trace-test");
    assert.equal(procedure.provenance, "explicit_trace_distillation");
    assert.equal(procedure.lifecycle, "candidate");
    assert.equal(procedure.routeable, false);
    assert.equal((procedure.scenario_signature as Record<string, unknown>).domain, "coding");
    assert.deepEqual((procedure.scenario_signature as Record<string, unknown>).project, { id: "trace-test" });
    assert.equal(procedure.publication_allowed, false);
    assert.deepEqual(procedure.source_refs, sources(f.store));

    const rendered = f.procedures.get({ procedure_id: String(procedure.id) });
    assert.equal((rendered.candidate as Record<string, unknown>).executable, false);
    assert.match(String((rendered.candidate as Record<string, unknown>).body), /来源标记：user_stated/u);
    assert.match(String((rendered.candidate as Record<string, unknown>).body), /来源标记：inferred（未验证）/u);
    assert.match(String((rendered.candidate as Record<string, unknown>).body), /failure recovery/u);
    assert.match(String((rendered.candidate as Record<string, unknown>).body), /unrelated projects/u);
    assert.doesNotMatch(JSON.stringify(rendered), /raw prompt|secret value|tool output/u);

    const workItem = saved.learning_work_item as Record<string, unknown>;
    assert.equal(workItem.status, "blocked");
    assert.equal(workItem.stage, "evaluation_contract");
    assert.deepEqual(workItem.candidate_ref, {
      kind: "experience_procedure", id: procedure.id, version: procedure.candidate_version, digest: procedure.definition_digest,
    });
    f.store.save("experience_learning_work_item", String(workItem.id), { ...workItem, blocked_reason: null });
    const waiting = new ExperienceLearningEvaluation(f.store).dispatchNext({
      worker_id: "experience-test-worker", now: "2026-11-26T10:00:00.500Z",
    });
    assert.equal(waiting.status, "blocked");
    assert.equal(waiting.blocked_reason, "learning_work_item_blocked");
    assert.equal((waiting.work_item as Record<string, unknown>).id, workItem.id);
    const contract = f.store.create("evaluation_contract", "trace-distillation-contract", {
      effect: "task_effect", capability_id: `experience-procedure:${procedure.id}`, capability_version: 1,
      contract_digest: `sha256:${"c".repeat(64)}`, task_effect: { candidate_family: "experience_procedure" },
    });
    const workItems = new ExperienceLearningWorkItemOwner(f.store);
    const currentWorkItem = f.store.get("experience_learning_work_item", String(workItem.id));
    const bound = workItems.bindEvaluationContract({ work_item_id: workItem.id, expected_version: currentWorkItem.version,
      evaluation_contract_ref: { kind: "evaluation_contract", id: contract.id, version: 1, digest: contract.contract_digest },
      now: "2026-11-26T10:00:00.000Z" }) as { work_item: Record<string, unknown> };
    const evaluation = new ExperienceLearningEvaluation(f.store);
    evaluation.setEvaluationContractSource(f.store);
    Object.defineProperty(evaluation, "createDispatch", { configurable: true, value: () => { throw new Error("transient dispatch failure"); } });
    assert.throws(() => evaluation.dispatchNext({
      worker_id: "experience-test-worker", lease_ms: 1_000, now: "2026-11-26T10:00:01.000Z",
    }), /transient dispatch failure/u);
    assert.equal(f.store.count("experience_evaluation_dispatch"), 0);
    const failedDispatchItem = workItems.get({ work_item_id: workItem.id }).work_item as Record<string, unknown>;
    assert.equal(failedDispatchItem.status, "queued");
    assert.equal(failedDispatchItem.attempts, 0);

    await f.restart();
    const resumedEvaluation = new ExperienceLearningEvaluation(f.store);
    resumedEvaluation.setEvaluationContractSource(f.store);
    const first = resumedEvaluation.dispatchNext({
      worker_id: "experience-restarted-worker", lease_ms: 1_000, now: "2026-11-26T10:00:03.000Z",
    });
    assert.equal(first.status, "dispatched");
    assert.equal(typeof first.lease_token, "string");
    assert.equal((first.work_item as Record<string, unknown>).id, bound.work_item.id);
    assert.equal((first.dispatch as Record<string, unknown>).status, "awaiting_adapter");
    assert.equal((first.dispatch as Record<string, unknown>).stage, "shadow");
    assert.equal((first.dispatch as Record<string, unknown>).learning_work_item_id, workItem.id);
    assert.equal((first.work_item as Record<string, unknown>).attempts, 1);
    const blocked = resumedEvaluation.blockWorkItem({ work_item_id: workItem.id, worker_id: "experience-restarted-worker",
      lease_token: first.lease_token, reason: "evaluation_adapter_unavailable", now: "2026-11-26T10:00:03.500Z" });
    const blockedItem = blocked.work_item as Record<string, unknown>;
    assert.equal(blockedItem.status, "blocked");
    assert.equal(blockedItem.lease_token, null);
    const firstDispatchId = String((first.dispatch as Record<string, unknown>).id);
    assert.equal((f.store.get("experience_evaluation_dispatch", firstDispatchId)).status, "cancelled");
    assert.equal((resumedEvaluation.listPending().dispatches as Record<string, unknown>[]).some(item => item.id === firstDispatchId), false);
    const explicitlyResumed = resumedEvaluation.resumeWorkItem({ work_item_id: workItem.id,
      expected_version: blockedItem.version, now: "2026-11-26T10:00:04.000Z" });
    assert.equal((explicitlyResumed.work_item as Record<string, unknown>).status, "queued");
    assert.equal((resumedEvaluation.listPending().dispatches as Record<string, unknown>[]).some(item => item.id === firstDispatchId), false);
    const retried = resumedEvaluation.dispatchNext({
      worker_id: "experience-test-worker", lease_ms: 1_000, now: "2026-11-26T10:00:05.000Z",
    });
    assert.equal(retried.status, "dispatched");
    assert.equal(typeof retried.lease_token, "string");
    assert.equal(retried.idempotent, false);
    assert.notEqual((retried.dispatch as Record<string, unknown>).id, (first.dispatch as Record<string, unknown>).id);
    assert.equal((retried.work_item as Record<string, unknown>).attempts, 2);

    const shadowDispatch = retried.dispatch as Record<string, unknown>;
    const shadowEvidenceId = "trace-distillation-shadow-evidence";
    f.store.create("evidence", shadowEvidenceId, { record_origin: "experience_evaluator", source_type: "program", confidence: "confirmed",
      metadata: { experience_evaluation_dispatch_id: shadowDispatch.id, procedure_id: procedure.id,
        procedure_version: shadowDispatch.procedure_version, definition_digest: procedure.definition_digest,
        baseline_version: shadowDispatch.baseline_version, stage: "shadow", status: "passed",
        evaluator_ref: "fixture:experience-evaluator", environment_digest: `sha256:${"d".repeat(64)}` } });
    const gate = (args: Record<string, unknown>) => f.procedures.gate({ ...args, release_channel: "test" });
    assert.throws(() => resumedEvaluation.result({ dispatch_id: shadowDispatch.id, evidence_ids: [shadowEvidenceId], worker_id: "other", lease_token: "invalid", now: "2026-11-26T10:00:05.500Z" }, gate), /active Work Item lease/u);
    assert.throws(() => resumedEvaluation.result({ dispatch_id: shadowDispatch.id, evidence_ids: [shadowEvidenceId], worker_id: "experience-test-worker", lease_token: retried.lease_token, now: "2026-11-26T10:00:06.000Z" }, gate), /active Work Item lease/u);
    assert.equal(f.store.count("experience_procedure_gate"), 0);
    const shadowResult = resumedEvaluation.result({ dispatch_id: shadowDispatch.id, evidence_ids: [shadowEvidenceId], worker_id: "experience-test-worker", lease_token: retried.lease_token, now: "2026-11-26T10:00:05.500Z" }, gate);
    assert.equal((shadowResult.dispatch as Record<string, unknown>).status, "passed");
    assert.equal((shadowResult.learning_work_item as Record<string, unknown>).stage, "held_out");
    assert.equal((shadowResult.learning_work_item as Record<string, unknown>).status, "queued");

    const heldOut = resumedEvaluation.dispatchNext({
      worker_id: "experience-restarted-worker", lease_ms: 1_000, now: "2026-11-27T10:00:05.000Z",
    });
    assert.equal((heldOut.dispatch as Record<string, unknown>).stage, "held_out");
    const heldOutDispatch = heldOut.dispatch as Record<string, unknown>;
    const heldOutEvidenceId = "trace-distillation-held-out-evidence";
    const heldOutEvaluationId = "trusted-held-out-evaluation";
    f.store.create("evidence", heldOutEvidenceId, { record_origin: "experience_evaluator", source_type: "program", confidence: "confirmed",
      metadata: { experience_evaluation_dispatch_id: heldOutDispatch.id, procedure_id: procedure.id,
        procedure_version: heldOutDispatch.procedure_version, definition_digest: procedure.definition_digest,
        baseline_version: heldOutDispatch.baseline_version, stage: "held_out", status: "passed",
        evaluator_ref: "fixture:independent-evaluator", environment_digest: `sha256:${"e".repeat(64)}`,
        held_out_set_ref: "fixture:held-out-set:v1", independent_of_training: true } });
    f.store.save("evaluation_contract", String(contract.id), { ...contract,
      stage_history: [{ stage: "business_eligible", verification: "trusted", evidence: [heldOutEvaluationId] }],
      verified_stage: "business_eligible" });
    f.procedures.setEvaluationVerifier({ verifyTaskEffectEvaluation(input) {
      return { valid: true, eligible: true, contract_id: contract.id, contract_digest: contract.contract_digest,
        evaluation_id: heldOutEvaluationId, evaluation_digest: `sha256:${"f".repeat(64)}`, candidate_ref: input.candidate_ref };
    } });
    assert.throws(() => resumedEvaluation.result({ dispatch_id: heldOutDispatch.id, evidence_ids: [heldOutEvidenceId],
      evaluation_contract_id: "wrong-evaluation-contract", evaluation_id: heldOutEvaluationId, worker_id: "experience-restarted-worker", lease_token: heldOut.lease_token, now: "2026-11-27T10:00:05.500Z" }, gate),
    /pre-bound Evaluation Contract/u);
    const heldOutResult = resumedEvaluation.result({ dispatch_id: heldOutDispatch.id, evidence_ids: [heldOutEvidenceId],
      evaluation_contract_id: contract.id, evaluation_id: heldOutEvaluationId, worker_id: "experience-restarted-worker", lease_token: heldOut.lease_token, now: "2026-11-27T10:00:05.500Z" }, gate);
    assert.equal((heldOutResult.dispatch as Record<string, unknown>).status, "passed");
    assert.equal((heldOutResult.learning_work_item as Record<string, unknown>).stage, "signoff");
    assert.equal((heldOutResult.learning_work_item as Record<string, unknown>).status, "queued");

    const signoff = resumedEvaluation.dispatchNext({
      worker_id: "experience-restarted-worker", lease_ms: 1_000, now: "2026-11-27T10:00:07.000Z",
    });
    const signoffDispatch = signoff.dispatch as Record<string, unknown>;
    const signoffEvidenceId = "trace-distillation-signoff-evidence";
    const signoffEvidence = { record_origin: "experience_evaluator", source_type: "program", confidence: "confirmed",
      metadata: { experience_evaluation_dispatch_id: signoffDispatch.id, procedure_id: procedure.id,
        procedure_version: signoffDispatch.procedure_version, definition_digest: procedure.definition_digest,
        baseline_version: signoffDispatch.baseline_version, stage: "signoff", status: "failed",
        evaluator_ref: "fixture:signoff-evaluator", environment_digest: `sha256:${"a".repeat(64)}`,
        signoff_policy_ref: AUTOMATIC_SIGNOFF_POLICY } };
    f.store.create("evidence", signoffEvidenceId, signoffEvidence);
    const mismatchedConfidenceId = "trace-distillation-signoff-mismatched-confidence";
    f.store.create("evidence", mismatchedConfidenceId, { ...signoffEvidence, confidence: "rejected",
      metadata: { ...signoffEvidence.metadata, status: "passed" } });
    assert.throws(() => resumedEvaluation.result({
      dispatch_id: signoffDispatch.id, evidence_ids: [mismatchedConfidenceId], worker_id: "experience-restarted-worker", lease_token: signoff.lease_token, now: "2026-11-27T10:00:07.500Z",
    }, gate), /Experience evaluation Evidence is not confirmed and bound to this dispatch/u);
    const signoffResult = resumedEvaluation.result({ dispatch_id: signoffDispatch.id, evidence_ids: [signoffEvidenceId], worker_id: "experience-restarted-worker", lease_token: signoff.lease_token, now: "2026-11-27T10:00:07.500Z" }, gate);
    assert.equal((signoffResult.dispatch as Record<string, unknown>).status, "failed");
    assert.equal((signoffResult.learning_work_item as Record<string, unknown>).status, "failed");
    assert.equal((signoffResult.learning_work_item as Record<string, unknown>).failure_reason, "evaluation_gate_failed");

  } finally { await f.close(); }
});

test("MCP operation references retain only a validated tool name and reject malformed metadata", async () => {
  const f = await fixture();
  try {
    const originalEvent = f.store.get("trace_event", "event-1");
    const actionContract = { kind: "host_tool_operation", tool_category: "api_mcp", tool_name: "mcp__browser__navigate" };
    f.store.save("trace_event", "event-1", { ...originalEvent, operation_id: "codex_tool_mcp", action_contract: actionContract,
      event_digest: stableDigest({ trace_id: "trace-1", sequence: 1, event_kind: "host.tool.completed",
        operation_id: "codex_tool_mcp", status: "failed", source: "codex", trust: "observed", action_contract: actionContract }) });
    const selectedSources = sources(f.store);
    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: selectedSources, candidate,
    });
    const procedure = saved.procedure as Record<string, unknown>;
    const procedureSources = procedure.source_refs as Array<Record<string, unknown>>;
    const procedureEvents = procedureSources[0]!.event_refs as Array<Record<string, unknown>>;
    assert.equal(procedureEvents[0]!.tool_category, "api_mcp");
    assert.equal(procedureEvents[0]!.tool_name, "mcp__browser__navigate");
    assert.equal(procedureEvents[0]!.data, undefined);
    assert.equal(procedureEvents[0]!.arguments, undefined);

    const malformedSources = sources(f.store);
    const malformedEvents = malformedSources[0]!.event_refs as Record<string, unknown>[];
    malformedEvents[0] = { ...malformedEvents[0], operation_id: "codex_tool_mcp",
      tool_category: "api_mcp", tool_name: "mcp__browser__navigate?url=secret" };
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: malformedSources, candidate,
    }), /MCP tool metadata is invalid/u);
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);

    const observed = { ...candidate, steps: [{
      text: "Observed Host Trace fields: event_kind=host.tool.completed; operation_id=codex_tool_mcp; status=failed; sequence=1; tool_category=api_mcp; tool_name=mcp__browser__navigate.",
      provenance: "host_observed", source_refs: ["event-1"],
    }] };
    const observedSaved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "observed-mcp-tool", sources: selectedSources, candidate: observed,
    });
    const observedProjection = f.procedures.get({
      procedure_id: String((observedSaved.procedure as Record<string, unknown>).id),
    }).candidate as Record<string, unknown>;
    assert.match(String(observedProjection.body), /tool_name=mcp__browser__navigate/u);
  } finally { await f.close(); }
});

test("Trace distillation tolerates non-object tool contracts and rejects empty Host event citations", async () => {
  const f = await fixture();
  try {
    const event = f.store.get("trace_event", "event-1");
    const actionContract: unknown[] = [];
    f.store.save("trace_event", "event-1", { ...event, action_contract: actionContract,
      event_digest: stableDigest({ trace_id: "trace-1", sequence: 1, event_kind: "host.tool.completed",
        operation_id: "codex_tool_bash", status: "failed", source: "codex", trust: "observed", action_contract: actionContract }) });
    const invalidCitation = { ...candidate, steps: [{ text: "Observed Host Trace fields: event_kind=host.tool.completed; operation_id=codex_tool_bash; status=failed; sequence=1.",
      provenance: "host_observed", source_refs: [] }] };
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "empty-host-citation", sources: sources(f.store), candidate: invalidCitation,
    }), /exactly one selected Trace event/u);

    const fallbackObserved = { ...candidate, steps: [{
      text: "Observed Host Trace fields: event_kind=host.tool.completed; operation_id=codex_tool_bash; status=failed; sequence=1.",
      provenance: "host_observed", source_refs: ["event-1"],
    }] };
    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: sources(f.store), candidate: fallbackObserved,
    });
    assert.equal((saved.procedure as Record<string, unknown>).routeable, false);
    const projection = f.procedures.get({ procedure_id: String((saved.procedure as Record<string, unknown>).id) }).candidate as Record<string, unknown>;
    assert.match(String(projection.body), /operation_id=codex_tool_bash/u);
    assert.equal(f.store.count("experience_procedure"), 1);
  } finally { await f.close(); }
});

test("bash Trace references preserve a validated verification digest and reject mismatches", async () => {
  const f = await fixture();
  try {
    const originalEvent = f.store.get("trace_event", "event-1");
    const verificationDigest = `sha256:${"a".repeat(64)}`;
    const actionContract = { kind: "host_tool_operation", tool_category: "script", verification_digest: verificationDigest };
    f.store.save("trace_event", "event-1", { ...originalEvent, action_contract: actionContract,
      event_digest: stableDigest({ trace_id: "trace-1", sequence: 1, event_kind: "host.tool.completed",
        operation_id: "codex_tool_bash", status: "failed", source: "codex", trust: "observed", action_contract: actionContract }) });

    const selectedSources = sources(f.store);
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: selectedSources, candidate });
    const procedure = saved.procedure as Record<string, unknown>;
    const procedureSources = procedure.source_refs as Array<Record<string, unknown>>;
    const procedureEvents = procedureSources[0]!.event_refs as Array<Record<string, unknown>>;
    assert.equal(procedureEvents[0]!.verification_digest, verificationDigest);

    const mismatched = sources(f.store);
    (mismatched[0]!.event_refs[0] as Record<string, unknown>).verification_digest = `sha256:${"b".repeat(64)}`;
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "mismatched-verification-digest", sources: mismatched, candidate,
    }), /does not match the stored Trace Event/u);

    const invalid = sources(f.store);
    (invalid[0]!.event_refs[0] as Record<string, unknown>).verification_digest = "not-a-digest";
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "invalid-verification-digest", sources: invalid, candidate,
    }), /verification digest is invalid/u);
    assert.equal(f.store.count("experience_procedure"), 1);
  } finally { await f.close(); }
});

test("Trace Candidate projection reports unavailable lifecycle and Workflow Context guidance", async () => {
  const f = await fixture();
  try {
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: sources(f.store), candidate });
    const procedure = saved.procedure as Record<string, unknown>;
    f.store.save("experience_procedure", String(procedure.id), { ...procedure, lifecycle: "rejected" });
    const projection = f.procedures.get({ procedure_id: String(procedure.id) }).candidate as Record<string, unknown>;
    assert.equal(projection.status, "不可用");
    assert.equal(projection.executable, false);
    assert.equal(projection.routeable, false);

    const describe = (new ExperienceContribution(f.store) as unknown as {
      describe(value: Record<string, unknown>): Record<string, unknown>;
    }).describe;
    const guidance = describe.call(new ExperienceContribution(f.store), {
      id: "workflow-guidance", scope: "project:trace-test", procedure_kind: "workflow", title: "Repair a check",
      trigger: "A project check fails", acceptance_ref: "acceptance-1", scenario_signature: { domain: "coding" },
      version: 1, definition_digest: "sha256:workflow-guidance", routeable: true,
    });
    assert.equal(guidance.host_next_step, "select_entry_exit_then_plan_and_bind");
    assert.equal(guidance.execution_started, false);
    assert.equal(Object.hasOwn(guidance, "usage_mode"), false);

    const graphGuidance = describe.call(new ExperienceContribution(f.store), {
      id: "graph-guidance", scope: "project:trace-test", procedure_kind: "graph", title: "Route a check",
      trigger: "A project check fails", acceptance_ref: "acceptance-2", scenario_signature: { domain: "coding" },
      version: 1, definition_digest: "sha256:graph-guidance", routeable: true,
    });
    assert.equal(graphGuidance.host_next_step, "match_graph_then_plan_and_bind");
    assert.equal(graphGuidance.execution_started, false);
  } finally { await f.close(); }
});

test("Trace distillation falls back to the legacy Candidate version and identity digest", async () => {
  const f = await fixture();
  try {
    const store = f.store as unknown as {
      create(kind: string, id: string, value: Record<string, unknown>): Record<string, unknown>;
    };
    const create = store.create.bind(f.store);
    store.create = (kind, id, value) => {
      if (kind !== "experience_procedure") return create(kind, id, value);
      const legacy = { ...value };
      delete legacy.candidate_version;
      delete legacy.definition_digest;
      delete legacy.content_digest;
      return create(kind, id, legacy);
    };
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: sources(f.store), candidate });
    const procedure = saved.procedure as Record<string, unknown>;
    const workItem = saved.learning_work_item as Record<string, unknown>;
    assert.equal(procedure.candidate_version, undefined);
    assert.equal(procedure.definition_digest, undefined);
    assert.equal(procedure.content_digest, undefined);
    assert.equal((workItem.candidate_ref as Record<string, unknown>).version, procedure.version);
    assert.equal((workItem.candidate_ref as Record<string, unknown>).digest, procedure.identity_digest);
    assert.equal(workItem.status, "blocked");
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
  } finally { await f.close(); }
});

test("Experience owner claims the explicit distillation tool and keeps ordinary Procedures on the standard projection", async () => {
  const f = await fixture();
  try {
    assert.equal(EXPERIENCE_OWNS.test("craft_experience_trace_distill"), true);
    assert.equal(EXPERIENCE_OWNS.test("craft_experience_learning_evaluation_dispatch_next"), true);
  assert.equal(EXPERIENCE_OWNS.test("craft_experience_learning_work_item_block"), true);
  assert.equal(EXPERIENCE_OWNS.test("craft_experience_learning_work_item_resume"), true);
    assert.equal(EXPERIENCE_OWNS.test("craft_experience_learning_work_item_get"), true);
    assert.equal(EXPERIENCE_OWNS.test("craft_experience_learning_work_item_evaluation_contract_bind"), true);
    assert.equal(EXPERIENCE_COMPONENT.test("craft_experience_trace_distill"), true);
    assert.equal(EXPERIENCE_OWNS.test("craft_evolution_program_memory_capture"), false);

    f.store.create("experience_procedure", "ordinary-procedure", { scope: "project:trace-test", provenance: "procedure_draft",
      lifecycle: "candidate", version: 1, routeable: false });
    assert.deepEqual(f.procedures.get({ procedure_id: "ordinary-procedure" }), {
      procedure: f.store.get("experience_procedure", "ordinary-procedure"),
    });
    const standardEvaluation = new ExperienceLearningEvaluation(f.store);
    const standardDispatch = standardEvaluation.dispatch({ procedure_id: "ordinary-procedure" });
    const dispatch = standardDispatch.dispatch as Record<string, unknown>;
    assert.equal(dispatch.learning_work_item_id, undefined);
    const evidenceId = "ordinary-shadow-evidence";
    f.store.create("evidence", evidenceId, { record_origin: "experience_evaluator", source_type: "program", confidence: "confirmed",
      metadata: { experience_evaluation_dispatch_id: dispatch.id, procedure_id: "ordinary-procedure",
        procedure_version: dispatch.procedure_version, definition_digest: dispatch.definition_digest,
        baseline_version: dispatch.baseline_version, stage: "shadow", status: "passed",
        evaluator_ref: "fixture:experience-evaluator", environment_digest: `sha256:${"d".repeat(64)}` } });
    const result = standardEvaluation.result({ dispatch_id: dispatch.id, evidence_ids: [evidenceId] },
      args => f.procedures.gate({ ...args, release_channel: "test" }));
    assert.equal((result.next_dispatch as Record<string, unknown>).stage, "held_out");
    assert.equal(result.learning_work_item, undefined);
    f.store.create("experience_procedure", "candidate-without-content", { scope: "project:trace-test",
      provenance: "explicit_trace_distillation", lifecycle: "candidate", version: 1, routeable: false });
    assert.throws(() => f.procedures.get({ procedure_id: "candidate-without-content" }), /Candidate content is unavailable/u);
  } finally { await f.close(); }
});

test("a promoted Trace Prompt enters matching Context as read-only guidance and resolves its current body", async () => {
  const f = await fixture();
  try {
    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: sources(f.store), candidate,
    });
    const procedure = saved.procedure as Record<string, unknown>;
    f.store.save("experience_procedure", String(procedure.id), {
      ...procedure,
      lifecycle: "routeable",
      completed_gates: ["shadow", "held_out", "signoff", "canary"],
      routeable: true,
    });

    const projection = f.procedures.get({
      procedure_id: String(procedure.id), release_channel: "current",
    });
    const promoted = projection.candidate as Record<string, unknown>;
    assert.equal(promoted.status, "已晋级");
    assert.equal(promoted.executable, false);
    assert.equal(promoted.routeable, true);
    assert.equal(promoted.usage_mode, "read_only_guidance");
    assert.match(String(promoted.body), /可复用步骤/u);

    const context = await new ExperienceContribution(f.store).contribute({
      scope_kind: "project",
      scope_id: "trace-test",
      query: "project check failure recovery",
      domain: "coding",
      max_items: 5,
      max_chars: 1_200,
    });
    const items = context.items as Record<string, unknown>[];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.kind, "experience_procedure");
    assert.equal(items[0]?.procedure_id, procedure.id);
    assert.equal(items[0]?.usage_mode, "read_only_guidance");
    assert.equal(items[0]?.host_next_step, "read_promoted_prompt_content");
    assert.equal(items[0]?.materialization_tool, "craft_experience_procedure_projection_get");
    assert.equal(items[0]?.materialization_release_channel, "current");
    assert.equal(items[0]?.execution_started, false);
    const wrongDomain = await new ExperienceContribution(f.store).contribute({
      scope_kind: "project",
      scope_id: "trace-test",
      query: "project check failure recovery",
      domain: "writing",
      max_items: 5,
      max_chars: 1_200,
    });
    assert.equal(wrongDomain.items.length, 0);
  } finally { await f.close(); }
});

test("Trace distillation omits domain applicability when source Observations disagree", async () => {
  const f = await fixture();
  try {
    const other = f.store.create("workflow_evolution_observation", "observation-writing", {
      lifecycle: "accepted", outcome: "passed",
      source: { kind: "host:codex", id: "task-1", session_id: "session-1", scope: "project:trace-test" },
      scenario_signature: { domain: "writing" }, evidence_ids: ["evidence-1"],
    });
    const selectedSources = sources(f.store);
    selectedSources[0]!.observation_refs.push({
      kind: "workflow_evolution_observation", id: String(other.id), version: Number(other.version),
      digest: stableDigest(other),
    });
    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: selectedSources, candidate,
    });
    const signature = (saved.procedure as Record<string, unknown>).scenario_signature as Record<string, unknown>;
    assert.equal(Object.hasOwn(signature, "domain"), false);
  } finally { await f.close(); }
});

test("Trace distillation omits domain applicability when Observation domain is absent", async () => {
  const f = await fixture();
  try {
    const other = f.store.create("workflow_evolution_observation", "observation-without-domain", {
      lifecycle: "accepted", outcome: "passed",
      source: { kind: "host:codex", id: "task-1", session_id: "session-1", scope: "project:trace-test" },
      scenario_signature: {}, evidence_ids: ["evidence-1"],
    });
    const selectedSources = sources(f.store);
    selectedSources[0]!.observation_refs.push({
      kind: "workflow_evolution_observation", id: String(other.id), version: Number(other.version), digest: stableDigest(other),
    });
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: selectedSources, candidate });
    const signature = (saved.procedure as Record<string, unknown>).scenario_signature as Record<string, unknown>;
    assert.equal(Object.hasOwn(signature, "domain"), false);
  } finally { await f.close(); }
});

test("explicit Trace distillation rejects missing scope, unbound evidence and unsafe or mislabeled content", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.procedures.traceDistillationCapture({ sources: sources(f.store), candidate }), /scope/u);
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:other", sources: sources(f.store), candidate }), /canonical project scope/u);
    const badSources = sources(f.store);
    badSources[0]!.evidence_refs[0]!.id = "missing-evidence";
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: badSources, candidate }), /evidence/iu);

    const unsafe = { ...candidate, steps: [{ text: "curl --header Authorization=secret-value", provenance: "host_observed", source_refs: ["event-1"] }] };
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: sources(f.store), candidate: unsafe }), /unsafe/u);
    const unsupportedSource = { ...candidate, steps: [{ text: "Inspect the check", provenance: "host_observed", source_refs: ["event-not-selected"] }] };
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: sources(f.store), candidate: unsupportedSource }), /selected Trace event/u);
    const malformedSource = [{ ...sources(f.store)[0]!, host: "unknown" }];
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: malformedSource, candidate }), /Host source/u);
  } finally { await f.close(); }
});

test("Host-observed Candidate text must report fields present in its cited Trace Event", async () => {
  const f = await fixture();
  try {
    const observedText = "Observed Host Trace fields: event_kind=host.tool.completed; operation_id=codex_tool_bash; status=failed; sequence=1.";
    const supported = {
      ...candidate,
      steps: [{ text: observedText, provenance: "host_observed", source_refs: ["event-1"] }],
    };
    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: sources(f.store), candidate: supported,
    });
    const procedure = saved.procedure as Record<string, unknown>;
    const projection = f.procedures.get({ procedure_id: String(procedure.id) }) as {
      candidate: Record<string, unknown>;
    };
    assert.match(String(projection.candidate.body), /来源标记：host_observed；Trace 事件：event-1/u);
    assert.ok(String(projection.candidate.body).includes(observedText));

    const unsupported = {
      ...candidate,
      steps: [{ text: "Inspect the reported check category before changing files", provenance: "host_observed", source_refs: ["event-1"] }],
    };
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "unsupported-host-claim",
      sources: sources(f.store), candidate: unsupported,
    }), /must exactly report one selected Trace Event's supported fields/u);
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);

    const forgedRef = sources(f.store);
    (forgedRef[0]!.event_refs[0] as Record<string, unknown>).operation_id = "codex_tool_edit";
    const forgedText = "Observed Host Trace fields: event_kind=host.tool.completed; operation_id=codex_tool_edit; status=failed; sequence=1.";
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "forged-event-fields",
      sources: forgedRef, candidate: { ...candidate,
        steps: [{ text: forgedText, provenance: "host_observed", source_refs: ["event-1"] }] },
    }), /does not match the stored Trace Event/u);
    assert.equal(f.store.count("experience_procedure"), 1);
    assert.equal(f.store.count("experience_learning_work_item"), 1);
  } finally { await f.close(); }
});

test("explicit Trace distillation retries are idempotent and changed content conflicts under the same request", async () => {
  const f = await fixture();
  try {
    const requestId = "distillation-request-1";
    const args = { scope: "project:trace-test", request_id: requestId, sources: sources(f.store), candidate };
    const first = f.procedures.traceDistillationCapture(args);
    const retry = f.procedures.traceDistillationCapture(args);
    assert.equal(retry.idempotent, true);
    assert.equal((retry.procedure as Record<string, unknown>).id, (first.procedure as Record<string, unknown>).id);
    const changed = { ...candidate, title: { text: "Different method", provenance: "user_stated", source_refs: [] } };
    assert.throws(() => f.procedures.traceDistillationCapture({ ...args, candidate: changed }), /idempotency conflict/u);
  } finally { await f.close(); }
});

test("explicit Trace distillation rejects inconsistent terminal, Observation, Evidence and source references", async () => {
  const f = await fixture();
  try {
    const original = sources(f.store)[0]!;
    const candidateInput = candidate;

    const terminal = f.store.get("trace_event", "terminal-1");
    f.store.save("trace_event", "terminal-1", { ...terminal, status: "failed",
      event_digest: stableDigest({ trace_id: "trace-1", sequence: 2, event_kind: "task.terminal_verification",
        operation_id: "codex_task_terminal_verification", status: "failed", source: "experience", trust: "verified" }) });
    const terminalMismatch = sources(f.store)[0]!;
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [terminalMismatch], candidate: candidateInput,
    }), /terminal outcome does not match its Trace event/u);

    const observationMismatch = structuredClone(original);
    observationMismatch.task_id = "different-task";
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [observationMismatch], candidate: candidateInput,
    }), /Trace reference does not match/u);

    const forgedDigest = structuredClone(original);
    forgedDigest.trace_ref.digest = `sha256:${"a".repeat(64)}`;
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: [forgedDigest], candidate: candidateInput }), /Trace reference does not match/u);

    for (const field of ["session_id", "turn_id"] as const) {
      const wrongSource = structuredClone(original);
      wrongSource[field] = "other";
      assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: [wrongSource], candidate: candidateInput }), /does not match/u);
    }
    const missingEvidence = structuredClone(original);
    missingEvidence.evidence_refs = [];
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: [missingEvidence], candidate: candidateInput }), /Observation and Evidence refs must match/u);

    const observation = f.store.get("workflow_evolution_observation", "observation-1");
    const mixedObservation = f.store.save("workflow_evolution_observation", "observation-1", { ...observation, evidence_ids: ["evidence-1", "unselected"] });
    const mixedSource = structuredClone(original);
    mixedSource.observation_refs[0]!.version = Number(mixedObservation.version);
    mixedSource.observation_refs[0]!.digest = stableDigest(mixedObservation);
    assert.throws(() => f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: [mixedSource], candidate: candidateInput }), /Observation Evidence must be included/u);

    const evidenceMismatch = structuredClone(original);
    evidenceMismatch.terminal_outcome = "not_observed";
    evidenceMismatch.event_refs = [evidenceMismatch.event_refs[0]!];
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [evidenceMismatch], candidate: candidateInput,
    }), /Observation and Evidence refs must match/u);

    const duplicateSource = structuredClone(original);
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [duplicateSource, structuredClone(duplicateSource)], candidate: candidateInput,
    }), /unique Trace references/u);

    const unexpectedContent = { ...structuredClone(original), raw_body: "discard this input" };
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [unexpectedContent], candidate: candidateInput,
    }), /unsupported fields/u);
  } finally { await f.close(); }
});

test("explicit Trace distillation preserves an unverified source as a non-routeable Candidate", async () => {
  const f = await fixture();
  try {
    const source = sources(f.store)[0]!;
    source.trace_status = "running";
    const trace = f.store.get("trace", "trace-1");
    const runningTrace = f.store.save("trace", "trace-1", { ...trace, status: "running" });
    source.trace_ref.version = Number(runningTrace.version);
    source.terminal_outcome = "unverified";
    createTraceEvent(f.store, "terminal-unavailable", 3, {
      event_kind: "task.terminal_verification.unavailable", operation_id: "codex_task_terminal_verification",
      status: "unknown", source: "codex", trust: "observed",
    });
    source.event_refs = [source.event_refs[0]!, traceEventRef(f.store, "terminal-unavailable")];
    source.observation_refs = [];
    source.evidence_refs = [];

    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [source], candidate,
    });
    const procedure = saved.procedure as Record<string, unknown>;
    assert.equal(procedure.routeable, false);
    assert.equal(procedure.publication_allowed, false);
    assert.equal(((procedure.source_refs as Record<string, unknown>[])[0]!).terminal_outcome, "unverified");

    const invalidUnverified = structuredClone(source);
    invalidUnverified.event_refs = [source.event_refs[0]!];
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [invalidUnverified], candidate: {
        ...candidate,
        title: { text: "Different candidate", provenance: "user_stated", source_refs: [] },
      },
    }), /terminal outcome does not match/u);
  } finally { await f.close(); }
});

test("explicit Trace distillation rejects malformed contract branches and renders empty user boundaries", async () => {
  const f = await fixture();
  try {
    const reject = (source: Record<string, unknown>, nextCandidate: unknown = candidate) => {
      assert.throws(() => f.procedures.traceDistillationCapture({
        scope: "project:trace-test", sources: [source], candidate: nextCandidate,
      }));
    };
    const original = sources(f.store)[0]!;

    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:trace-test", sources: [], candidate,
    }), /one to eight Trace references/u);
    reject(structuredClone(original), []);
    const badDigest = structuredClone(original);
    (badDigest.trace_ref as Record<string, unknown>).digest = "invalid";
    reject(badDigest);
    const badVersion = structuredClone(original);
    (badVersion.trace_ref as Record<string, unknown>).version = 0;
    reject(badVersion);
    const badEvidenceDigest = structuredClone(original);
    (badEvidenceDigest.evidence_refs[0] as Record<string, unknown>).digest = `sha256:${"c".repeat(64)}`;
    reject(badEvidenceDigest);
    const badEvent = structuredClone(original);
    (badEvent.event_refs[0] as Record<string, unknown>).sequence = 0;
    reject(badEvent);
    const badStatus = structuredClone(original);
    badStatus.trace_status = "unknown";
    reject(badStatus);
    const wrongTerminalStatus = structuredClone(original);
    wrongTerminalStatus.trace_status = "running";
    reject(wrongTerminalStatus);
    const failedTerminalStatusMismatch = structuredClone(original);
    failedTerminalStatusMismatch.terminal_outcome = "verified_failed";
    failedTerminalStatusMismatch.trace_status = "completed";
    reject(failedTerminalStatusMismatch);
    const noEvents = structuredClone(original);
    noEvents.event_refs = [];
    reject(noEvents);
    const noReferenceArrays: Record<string, unknown> = structuredClone(original);
    delete noReferenceArrays.observation_refs;
    reject(noReferenceArrays);
    const unsortedEvents = structuredClone(original);
    unsortedEvents.event_refs.reverse();
    reject(unsortedEvents);

    const unrelatedEvidenceId = "evidence-not-in-observation";
    const unrelatedEvidence = f.store.create("evidence", unrelatedEvidenceId, { confidence: "bounded",
      metadata: { provenance: "host_completion_signal", verification_outcome: "passed", project_scope_id: "project:trace-test",
        source_session_id: "session-1", task_id: "task-1", turn_id: "turn-1", content_stored: false } });
    const unrelatedEvidenceSource = structuredClone(original);
    unrelatedEvidenceSource.evidence_refs = [{ kind: "evidence", id: unrelatedEvidenceId, version: 1, digest: stableDigest(unrelatedEvidence) }];
    reject(unrelatedEvidenceSource);

    const unsupportedProvenance = structuredClone(candidate) as Record<string, unknown>;
    unsupportedProvenance.title = { text: "A bounded procedure", provenance: "unknown_origin", source_refs: [] };
    reject(structuredClone(original), unsupportedProvenance);
    const malformedSourceRefs = structuredClone(candidate) as Record<string, unknown>;
    malformedSourceRefs.title = { text: "A bounded procedure", provenance: "user_stated", source_refs: "not-an-array" };
    reject(structuredClone(original), malformedSourceRefs);
    const unsupportedUserRefs = structuredClone(candidate) as Record<string, unknown>;
    unsupportedUserRefs.title = { text: "A bounded procedure", provenance: "user_stated", source_refs: ["event-1"] };
    reject(structuredClone(original), unsupportedUserRefs);
    const missingSteps = structuredClone(candidate) as Record<string, unknown>;
    missingSteps.steps = [];
    reject(structuredClone(original), missingSteps);
    const missingPitfalls = structuredClone(candidate) as Record<string, unknown>;
    missingPitfalls.pitfalls = null;
    reject(structuredClone(original), missingPitfalls);
    const tooManyFocusItems = structuredClone(candidate) as Record<string, unknown>;
    tooManyFocusItems.focus = Array.from({ length: 17 }, (_, index) => `focus ${index}`);
    reject(structuredClone(original), tooManyFocusItems);
    assert.throws(() => f.procedures.traceDistillationCapture({
      scope: "project:bad/path", sources: [structuredClone(original)], candidate,
    }), /canonical project scope/u);

    const noUserBoundaries = structuredClone(candidate) as Record<string, unknown>;
    noUserBoundaries.focus = [];
    noUserBoundaries.exclude_topics = [];
    const saved = f.procedures.traceDistillationCapture({
      scope: "project:trace-test", request_id: "empty-user-boundaries", sources: [structuredClone(original)],
      candidate: noUserBoundaries,
    });
    const procedure = saved.procedure as Record<string, unknown>;
    const projection = f.procedures.get({ procedure_id: String(procedure.id) }).candidate as Record<string, unknown>;
    assert.match(String(projection.body), /用户关注点\n来源标记：user_stated；无/u);
    assert.match(String(projection.body), /用户排除项\n来源标记：user_stated；无/u);
  } finally { await f.close(); }
});

test("trace candidate refuses content reference whose digest differs from the Procedure", async () => {
  const f = await fixture();
  try {
    const saved = f.procedures.traceDistillationCapture({ scope: "project:trace-test", sources: sources(f.store), candidate });
    const procedure = saved.procedure as Record<string, unknown>;
    f.store.save("experience_procedure", String(procedure.id), { ...procedure, content_digest: `sha256:${"0".repeat(64)}` });
    assert.throws(() => f.procedures.get({ procedure_id: String(procedure.id) }), /content digest mismatch/u);
  } finally { await f.close(); }
});
