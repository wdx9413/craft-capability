import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { generateKeyPairSync, sign as signReceipt } from "node:crypto";
import { EvaluationContractKernel, EVALUATION_STAGES, parseTrustedEvaluatorRegistry } from "craft-common-log/evaluation-contract";
import { requiredPairedSampleSize, taskEffectSamplePlanDigest, type TaskEffectSamplePlan } from "../../../node_modules/craft-common-log/dist/task-effect-sample-plan.js";
import { MemoryGovernanceKernel } from "../memory-governance.ts";
import { MemoryLedgerKernel } from "../memory-ledger.ts";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { digestJson, stableDigest } from "craft-common-base/digest";

const stores: CraftStore[] = [];
const directories: string[] = [];
const evaluatorKeys = generateKeyPairSync("ed25519");
async function store(): Promise<CraftStore> {
  const directory = mkdtempSync(join(tmpdir(), "craft-eval-contract-"));
  directories.push(directory);
  const opened = await new CraftStore(craftPaths(directory)).open();
  stores.push(opened);
  return opened;
}
test.after(() => {
  for (const opened of stores) opened.close();
  for (const directory of directories) rmSync(directory, { recursive: true, force: true });
});
const definition = { capability_id: "cap", capability_version: 1, input_contract: "in", output_contract: "out", effect: "read_only" };
const taskEffect = {
  candidate_family: "memory_candidate",
  environment_fingerprint: "sha256:environment", primary_metric: { name: "quality", direction: "higher" as const, minimum_delta: 0.1 },
  tolerated_regressions: { errors: 0.1 }, latency_budget_ms: 100, cost_budget: 2,
  evaluator: { id: "independent-evaluator", version: "1", digest: digestJson("evaluator"), public_key_pem: evaluatorKeys.publicKey.export({ type: "spki", format: "pem" }).toString() }, hard_assertions: ["safety", "privacy"]
};

function pair(refs: { case_ref: { kind: string; id: string; version: number; digest: string }; baseline_session_ref: { kind: string; id: string; version: number; digest: string }; candidate_session_ref: { kind: string; id: string; version: number; digest: string } }, quality = 0.5, errors = 0, latency_ms = 50, cost = 1) {
  return { case_ref: refs.case_ref,
    baseline: { session_ref: refs.baseline_session_ref, metrics: { quality: 0.5, errors: 0.1 }, latency_ms: 40, cost: 0.5, assertions: { safety: true, privacy: true } },
    candidate: { session_ref: refs.candidate_session_ref, metrics: { quality, errors }, latency_ms, cost, assertions: { safety: true, privacy: true } } };
}
function pairAt(heldOutRefs: Array<{ kind: string; id: string; version: number; digest: string }>, sessionRefs: Array<{ kind: string; id: string; version: number; digest: string }>, index: number, quality = 0.5, errors = 0, latency_ms = 50, cost = 1) {
  return pair({ case_ref: heldOutRefs[index]!, baseline_session_ref: sessionRefs[index * 2]!, candidate_session_ref: sessionRefs[index * 2 + 1]! }, quality, errors, latency_ms, cost);
}

function createTask(opened: CraftStore, id: string) {
  return opened.create("task", id, { title: id, goal: `Goal ${id}`, project_id: null, workspace_id: null, model_id: null, permission_mode: "ask", status: "active" });
}

function createHostSession(opened: CraftStore, taskId: string, sessionId: string) {
  const traceId = `trace-${sessionId}`, hostId = "codex-cli";
  const optionalFingerprints = sessionId.endsWith("candidate");
  const sessionIdentity = { trace_id: traceId, task_id: taskId, host_id: hostId, environment_fingerprint: taskEffect.environment_fingerprint,
    policy_fingerprint: "sha256:policy", capability_fingerprint: "sha256:capability", model_fingerprint: optionalFingerprints ? null : "sha256:model", budget_fingerprint: optionalFingerprints ? null : "sha256:budget" };
  opened.create("trace", traceId, { task_id: taskId, status: "running", next_sequence: 0, event_count: 0 });
  let session = opened.create("host_session", sessionId, { ...sessionIdentity, identity_digest: digestJson(sessionIdentity), status: "running", next_sequence: 0, raw_content_stored: false });
  for (const kind of ["session.started", "session.completed"] as const) {
    const sequence = Number(session.next_sequence) + 1;
    const hostEvent = { session_id: sessionId, sequence, kind, host_id: hostId, action_contract_ref: null, state_before_ref: null, state_after_ref: null, artifact_refs: [], evidence_refs: [], summary_digest: null };
    const eventId = `${sessionId}:${kind === "session.started" ? "started" : sequence}`;
    const eventDigest = digestJson(hostEvent), traceEventId = `host_session_trace:${eventId}`;
    const traceIdentity = { trace_id: traceId, sequence, event_kind: kind, actor: hostId, source: "host_session", trust: "observed", span_id: `${traceId}:span:${sequence}`, parent_span_id: null, operation_id: null,
      action_contract: null, state_before: null, state_after: null, input_refs: [], output_refs: sessionId.includes("bad-output") && kind === "session.completed" ? ["unexpected-output"] : [], capability_revision: null, policy_revision: null, model_fingerprint: null,
      environment_fingerprint: null, workspace_before: null, workspace_after: null, usage: null, cost_usd: null, duration_ms: null, error_class: null, status: null, summary: null,
      data_digest: stableDigest({ session_id: sessionId, session_sequence: sequence, event_digest: eventDigest }), ...(kind === "session.completed" ? { content_stored: false } : {}) };
    const traceEvent = opened.create("trace_event", traceEventId, { ...traceIdentity, event_digest: stableDigest(traceIdentity), trace_id: traceId });
    opened.create("host_session_event", eventId, { ...hostEvent, event_digest: eventDigest, trace_event_id: traceEvent.id, trace_event_version: traceEvent.version, raw_content_stored: false });
    session = opened.save("host_session", sessionId, { ...session, status: kind === "session.completed" ? "terminal" : "running", next_sequence: sequence });
  }
  return session;
}

async function taskEffectKernel(id = "te") {
  const opened = await store();
  const kernel = new EvaluationContractKernel(opened as never, [taskEffect.evaluator]);
  opened.create("knowledge_source", "builtin.evidence-wiki", { scope: { kind: "global", id: "global" }, status: "active", trust: "verified" });
  opened.create("evidence", "memory-evidence", { source_type: "human", confidence: "bounded" });
  const governance = new MemoryGovernanceKernel(opened, new MemoryLedgerKernel(opened));
  const propose = (candidate_id: string, content: string) => governance.propose({ candidate_id, source_id: "builtin.evidence-wiki", kind: "preference",
    scope_kind: "global", scope_id: "global", content, confidence: "bounded", evidence_ids: ["memory-evidence"],
    proposed_by: "agent", proposal_only: true, independent_evaluation_required: true }).candidate as Record<string, unknown>;
  const baseline = propose("baseline-v1", "I prefer concise reports.");
  const candidate = propose("candidate-v2", "I prefer clear written plans.");
  const developmentTask = createTask(opened, "dev-1"), heldOut1 = createTask(opened, "hold-1"), heldOut2 = createTask(opened, "hold-2");
  const heldOut1BaselineSession = createHostSession(opened, String(heldOut1.id), "session-hold-1-baseline"), heldOut1CandidateSession = createHostSession(opened, String(heldOut1.id), "session-hold-1-candidate");
  const heldOut2BaselineSession = createHostSession(opened, String(heldOut2.id), "session-hold-2-baseline"), heldOut2CandidateSession = createHostSession(opened, String(heldOut2.id), "session-hold-2-candidate");
  const devRef = kernel.taskRef(String(developmentTask.id), Number(developmentTask.version));
  const heldOutRefs = [kernel.taskRef(String(heldOut1.id), Number(heldOut1.version)), kernel.taskRef(String(heldOut2.id), Number(heldOut2.version))];
  const baselineRef = kernel.artifactRef("memory_candidate", String(baseline.id), Number(baseline.version));
  const candidateRef = kernel.artifactRef("memory_candidate", String(candidate.id), Number(candidate.version));
  const sessionRefs = [kernel.hostSessionRef(String(heldOut1BaselineSession.id), Number(heldOut1BaselineSession.version)), kernel.hostSessionRef(String(heldOut1CandidateSession.id), Number(heldOut1CandidateSession.version)),
    kernel.hostSessionRef(String(heldOut2BaselineSession.id), Number(heldOut2BaselineSession.version)), kernel.hostSessionRef(String(heldOut2CandidateSession.id), Number(heldOut2CandidateSession.version))];
  const samplePlanUnsigned: TaskEffectSamplePlan = { method: "chebyshev-mean-precision-v1", pilot_pair_count: 5, pilot_paired_difference_variance: 0.0001,
    pilot_report_digest: digestJson({ pilot: id }), minimum_meaningful_effect: 0.1, confidence_level: 0.95, planned_task_pairs: heldOutRefs.length,
    repeats_per_task: 1, required_pair_count: requiredPairedSampleSize({ pilotVariance: 0.0001, minimumMeaningfulEffect: 0.1, confidenceLevel: 0.95 }), pilot_signature: "pending" };
  const samplePlanBinding = { candidate_family: taskEffect.candidate_family, environment_fingerprint: taskEffect.environment_fingerprint, primary_metric: taskEffect.primary_metric };
  const samplePlan = { ...samplePlanUnsigned, pilot_signature: signReceipt(null, Buffer.from(taskEffectSamplePlanDigest(samplePlanBinding, samplePlanUnsigned)), evaluatorKeys.privateKey).toString("base64") };
  const spec = { ...taskEffect, baseline_ref: baselineRef, candidate_ref: candidateRef, task_set: { id: "tasks", development_task_refs: [devRef], held_out_task_refs: heldOutRefs,
    digest: digestJson({ id: "tasks", development_task_refs: [devRef], held_out_task_refs: heldOutRefs }) }, sample_plan: samplePlan };
  const pairs = [pair({ case_ref: heldOutRefs[0]!, baseline_session_ref: sessionRefs[0]!, candidate_session_ref: sessionRefs[1]! }),
    pair({ case_ref: heldOutRefs[1]!, baseline_session_ref: sessionRefs[2]!, candidate_session_ref: sessionRefs[3]! })];
  kernel.define({ capability_id: "cap", capability_version: 1, input_contract: "in", output_contract: "out", effect: "task_effect", task_effect: spec, contract_id: id });
  return { opened, kernel, governance, spec, candidateRef, devRef, heldOutRefs, sessionRefs, pairs };
}

function signedEvaluation(kernel: EvaluationContractKernel, input: Parameters<EvaluationContractKernel["recordTaskEffectEvaluation"]>[0]) {
  const contract = kernel.get(String(input.contract_id)).contract as { contract_digest: string };
  const receiptDigest = digestJson({ contract_digest: contract.contract_digest, ...input });
  return { ...input, evaluator_signature: signReceipt(null, Buffer.from(receiptDigest), evaluatorKeys.privateKey).toString("base64") };
}

test("signed task-effect contract gates Memory approval and commit", async () => {
  const { opened, kernel, governance, spec, candidateRef, devRef, heldOutRefs, sessionRefs } = await taskEffectKernel("memory-eval");
  governance.setEvaluationVerifier(kernel);
  const binding = { contract_id: "memory-eval", evaluation_id: "eval-passing", candidate_ref: candidateRef };
  const review = () => governance.review({ candidate_id: candidateRef.id, decision: "approve", reviewer: "operator",
    reason: "Independent evaluation verified.", evaluation_binding: binding });
  for (const stage of ["mechanism_passed", "fixture_passed", "conformance_passed", "integration_passed", "host_verified"] as const) {
    const plan = `plan-${stage}`, assessment = `assessment-${stage}`;
    opened.create("verification_plan", plan, { change_ref: `memory-eval:${stage}`, requires_real_host: stage === "host_verified", candidate_change: false });
    opened.create("verification_assessment", assessment, { verdict: "eligible", verification_id: plan });
    kernel.record({ contract_id: "memory-eval", stage, evidence: [assessment] });
  }
  const input = { contract_id: "memory-eval", evaluation_id: "eval-passing", candidate_ref: candidateRef, candidate_source_task_refs: [devRef], evaluator: spec.evaluator,
    pairs: [pairAt(heldOutRefs, sessionRefs, 0, 0.8), pairAt(heldOutRefs, sessionRefs, 1, 0.8)] };
  kernel.recordTaskEffectEvaluation(signedEvaluation(kernel, input));
  assert.throws(review, /did not pass/u);
  kernel.record({ contract_id: "memory-eval", stage: "business_eligible", evidence: ["eval-passing"] });
  kernel.record({ contract_id: "memory-eval", stage: "routeable", evidence: ["eval-passing"] });
  assert.throws(() => governance.review({ candidate_id: candidateRef.id, decision: "approve", reviewer: "operator",
    reason: "Wrong evidence.", evaluation_binding: { ...binding, candidate_ref: { ...candidateRef, digest: digestJson("other") } } }), /exact candidate/u);
  assert.equal((review().candidate as Record<string, unknown>).status, "approved");
  assert.equal((governance.remember({ candidate_id: candidateRef.id }).memory as Record<string, unknown>).status, "active");
});
