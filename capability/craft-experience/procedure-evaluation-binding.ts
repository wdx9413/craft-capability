import type { JsonObject } from 'craft-common-store-local/store';

export interface VerifiedTaskEffectEvaluation extends JsonObject {
  valid: boolean;
  eligible: boolean;
  contract_id: string;
  contract_digest: string;
  evaluation_id: string;
  evaluation_digest: string;
  candidate_ref: { kind: string; id: string; version: number; digest: string };
}

/** Bind a routeability gate to the exact procedure and a trusted held-out report. */
export function procedureEvaluationBinding(input: {
  procedure: JsonObject;
  contract: JsonObject;
  evaluation: VerifiedTaskEffectEvaluation;
  evaluationId: string;
  prior?: JsonObject;
}): JsonObject {
  const { procedure, contract, evaluation, evaluationId, prior } = input;
  const capabilityId = `experience-procedure:${String(procedure.id)}`;
  const family = "experience_procedure";
  const digest = String(procedure.definition_digest ?? procedure.content_digest ?? procedure.identity_digest ?? "");
  const candidateVersion = Number(procedure.candidate_version ?? procedure.version);
  const candidateRef = { kind: family, id: String(procedure.id), version: candidateVersion, digest };
  if (procedure.runbook_candidate === true) throw new Error("Runbook candidates cannot use Procedure Evaluation Contracts");
  if (contract.effect !== "task_effect" || !contract.task_effect || (contract.task_effect as JsonObject).candidate_family !== family
    || contract.capability_id !== capabilityId || contract.capability_version !== candidateVersion) {
    throw new Error("Procedure Evaluation Contract must be task-effect and bound to this exact Procedure version");
  }
  if (typeof contract.contract_digest !== "string" || !contract.contract_digest.trim()
    || evaluation.valid !== true || evaluation.eligible !== true || evaluation.contract_id !== contract.id
    || evaluation.contract_digest !== contract.contract_digest || evaluation.evaluation_id !== evaluationId
    || JSON.stringify(evaluation.candidate_ref) !== JSON.stringify(candidateRef)) {
    throw new Error("Procedure held-out Evaluation is not verified and bound to this exact candidate");
  }
  const history = Array.isArray(contract.stage_history) ? contract.stage_history as JsonObject[] : [];
  const trusted = history.some(item => item.stage === "business_eligible" && item.verification === "trusted"
    && Array.isArray(item.evidence) && item.evidence.includes(evaluationId));
  if (!trusted || !["business_eligible", "routeable"].includes(String(contract.verified_stage))) {
    throw new Error("Procedure requires a trusted held-out Evaluation Contract result");
  }
  if (prior && (prior.evaluation_contract_id !== contract.id || prior.evaluation_contract_digest !== contract.contract_digest
    || prior.evaluation_id !== evaluationId || JSON.stringify(prior.candidate_ref) !== JSON.stringify(candidateRef))) {
    throw new Error("Procedure qualification cannot change its held-out Evaluation after qualification");
  }
  return { evaluation_contract_id: contract.id, evaluation_contract_digest: contract.contract_digest,
    evaluation_id: evaluationId, candidate_ref: candidateRef };
}
