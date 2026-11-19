import assert from "node:assert/strict";
import test from "node:test";
import { procedureEvaluationBinding, type VerifiedTaskEffectEvaluation } from "../procedure-evaluation-binding.ts";
import { ProcedureStore } from "../procedure-projection.ts";
import type { JsonObject } from "craft-common-store-local/store";

const procedure: JsonObject = { id: "procedure-1", version: 4, candidate_version: 2, definition_digest: "sha256:procedure", procedure_kind: "workflow" };
const candidateRef = { kind: "experience_procedure", id: "procedure-1", version: 2, digest: "sha256:procedure" };
const evaluation: VerifiedTaskEffectEvaluation = { valid: true, eligible: true, contract_id: "contract-1", contract_digest: "sha256:contract",
  evaluation_id: "evaluation-1", evaluation_digest: "sha256:evaluation", candidate_ref: candidateRef };
const contract: JsonObject = { id: "contract-1", effect: "task_effect", capability_id: "experience-procedure:procedure-1", capability_version: 2,
  contract_digest: "sha256:contract", task_effect: { candidate_family: "experience_procedure" }, verified_stage: "business_eligible",
  stage_history: [{ stage: "business_eligible", verification: "trusted", evidence: ["evaluation-1"] }] };

test("Procedure evaluation binding returns stable exact candidate and evidence references", () => {
  assert.deepEqual(procedureEvaluationBinding({ procedure, contract, evaluation, evaluationId: "evaluation-1" }), {
    evaluation_contract_id: "contract-1", evaluation_contract_digest: "sha256:contract", evaluation_id: "evaluation-1", candidate_ref: candidateRef,
  });
});

test("Procedure evaluation binding reads legacy digest and candidate-version fields", () => {
  const legacy = { ...procedure, definition_digest: null, content_digest: "sha256:procedure", candidate_version: null };
  const legacyContract = { ...contract, capability_version: 4 };
  const legacyEvaluation = { ...evaluation, candidate_ref: { ...candidateRef, version: 4 } };
  assert.deepEqual(procedureEvaluationBinding({ procedure: legacy, contract: legacyContract, evaluation: legacyEvaluation, evaluationId: "evaluation-1" }).candidate_ref, legacyEvaluation.candidate_ref);
  const identityDigest = { ...procedure, definition_digest: null, content_digest: null, identity_digest: "sha256:procedure", candidate_version: null };
  assert.deepEqual(procedureEvaluationBinding({ procedure: identityDigest, contract: legacyContract, evaluation: legacyEvaluation, evaluationId: "evaluation-1" }).candidate_ref, legacyEvaluation.candidate_ref);
  const emptyDigest = { ...procedure, definition_digest: null, content_digest: null, identity_digest: null, candidate_version: null };
  assert.throws(() => procedureEvaluationBinding({ procedure: emptyDigest, contract: legacyContract, evaluation: legacyEvaluation, evaluationId: "evaluation-1" }), /candidate/u);
});

test("Procedure evaluation binding fails closed for unsupported contract family or version", () => {
  for (const [patch, message] of [
    [{ effect: "capability" }, /task-effect/u],
    [{ task_effect: null }, /task-effect/u],
    [{ task_effect: { candidate_family: "other" } }, /task-effect/u],
    [{ capability_id: "other" }, /task-effect/u],
    [{ capability_version: 3 }, /task-effect/u],
  ] as const) assert.throws(() => procedureEvaluationBinding({ procedure, contract: { ...contract, ...patch }, evaluation, evaluationId: "evaluation-1" }), message);
});

test("Procedure evaluation binding fails closed for unsigned, ineligible, mismatched or untrusted evidence", () => {
  for (const patch of [
    { valid: false }, { eligible: false }, { contract_id: "other" }, { contract_digest: "other" },
    { evaluation_id: "other" }, { candidate_ref: { ...candidateRef, version: 3 } },
  ]) assert.throws(() => procedureEvaluationBinding({ procedure, contract, evaluation: { ...evaluation, ...patch }, evaluationId: "evaluation-1" }), /Evaluation/u);
  assert.throws(() => procedureEvaluationBinding({ procedure, contract: { ...contract, stage_history: [] }, evaluation, evaluationId: "evaluation-1" }), /trusted held-out/u);
  assert.throws(() => procedureEvaluationBinding({ procedure, contract: { ...contract, stage_history: null }, evaluation, evaluationId: "evaluation-1" }), /trusted held-out/u);
  assert.throws(() => procedureEvaluationBinding({ procedure, contract: { ...contract, verified_stage: "host_verified" }, evaluation, evaluationId: "evaluation-1" }), /trusted held-out/u);
});

test("Procedure evaluation binding preserves the exact held-out pin across later gates", () => {
  const pinned = procedureEvaluationBinding({ procedure, contract, evaluation, evaluationId: "evaluation-1" });
  assert.deepEqual(procedureEvaluationBinding({ procedure, contract, evaluation, evaluationId: "evaluation-1", prior: pinned }), pinned);
  for (const patch of [
    { evaluation_contract_id: "other" }, { evaluation_contract_digest: "other" }, { evaluation_id: "other" },
    { candidate_ref: { ...candidateRef, digest: "sha256:other" } },
  ]) assert.throws(() => procedureEvaluationBinding({ procedure, contract, evaluation, evaluationId: "evaluation-1", prior: { ...pinned, ...patch } }), /cannot change/u);
});

test("Runbook candidates cannot be Procedure-qualified", () => {
  assert.throws(() => procedureEvaluationBinding({ procedure: { ...procedure, runbook_candidate: true }, contract, evaluation, evaluationId: "evaluation-1" }), /Runbook candidates/u);
});

test("ProcedureStore requires and accepts the Runtime task-effect evaluator verifier", () => {
  const procedures = new ProcedureStore({} as never);
  assert.throws(() => procedures.setEvaluationVerifier(null as never), /verified task-effect Evaluation Contract service/u);
  const verifier = { verifyTaskEffectEvaluation: () => ({ valid: true }) };
  assert.doesNotThrow(() => procedures.setEvaluationVerifier(verifier));
});
