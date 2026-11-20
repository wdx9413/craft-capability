import { stableDigest } from "craft-common-base/digest";
import type { CraftStore, JsonObject } from "craft-common-store-local/store";

const candidateKind = "program_memory_candidate";

function strings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0))].sort() : [];
}

export function captureGovernedProgramMemory(store: CraftStore, args: JsonObject): JsonObject {
  const { statement, scenario_key, domain, scope } = args;
  const steps = Array.isArray(args.steps) ? args.steps : [];
  const contentDigest = stableDigest({ statement, scenario_key, domain, scope, steps });
  const contractId = typeof args.evaluation_contract_id === "string" ? args.evaluation_contract_id : null;
  const contract = contractId ? store.find("evaluation_contract", contractId) : null;
  if (contractId && (!contract || contract.effect !== "program_memory_design" || stableDigest(contract.scope) !== stableDigest(scope)
    || typeof contract.contract_digest !== "string" || (contract.budget as JsonObject | undefined)?.task_effect_design == null)) {
    throw new Error("Program Memory requires a frozen evaluation design contract in the same project");
  }
  const candidateDigest = stableDigest({ content_digest: contentDigest, contract_digest: contract?.contract_digest ?? null });
  const id = `program_memory_${candidateDigest.slice(-24)}`;
  return store.transaction(() => {
    const current = store.find(candidateKind, id);
    const evidenceIds = strings([...strings(current?.evidence_ids), ...strings(args.evidence_ids)]).slice(0, 50);
    const evidence = independentProgramMemoryObservations(store, evidenceIds, scope, scenario_key);
    const sources = [current?.source_refs, args.source_refs].flatMap(value => Array.isArray(value) ? value as JsonObject[] : []);
    const sourceRefs = [...new Map(sources.map(value => [stableDigest(value), value])).values()].slice(0, 50);
    if (current && stableDigest(current.evidence_ids) === stableDigest(evidenceIds)
      && stableDigest(current.source_refs ?? []) === stableDigest(sourceRefs)
      && current.independent_evidence_count === evidence.length) return current;
    return store.save(candidateKind, id, {
      ...current, id, statement, scenario_key, domain, scope, steps,
      content_digest: contentDigest, digest: candidateDigest,
      evaluation_design_id: contractId, evaluation_design_digest: contract?.contract_digest ?? null,
      source_refs: sourceRefs, scope_provenance: sourceRefs.length ? "project_binding" : current?.scope_provenance ?? null,
      evidence_ids: evidenceIds, repetitions: Math.max(1, sourceRefs.length, evidenceIds.length), independent_evidence_count: evidence.length,
      status: current?.status ?? "diagnostic",
    });
  });
}

export function independentProgramMemoryObservations(
  store: CraftStore, evidenceIds: string[], scope: unknown, scenarioKey: unknown,
): JsonObject[] {
  const scopeId = (scope as JsonObject | undefined)?.id;
  if (typeof scopeId !== "string" || !scopeId.startsWith("project:")) return [];
  const sessions = new Set<string>(), tasks = new Set<string>();
  const independent: JsonObject[] = [];
  for (const id of evidenceIds) {
    const observation = store.find("workflow_evolution_observation", id);
    const source = observation?.source as JsonObject | undefined;
    const proof = store.find("program_memory_verified_observation", id);
    if (observation?.lifecycle !== "accepted" || observation.outcome !== "passed"
      || observation.sanitized !== true || observation.content_stored !== false
      || (observation.scenario_key !== scenarioKey && (observation.scenario_signature as JsonObject | undefined)?.scenario_key !== scenarioKey)
      || source?.scope !== scopeId || typeof source.session_id !== "string" || !source.session_id
      || typeof source.id !== "string" || !source.id || sessions.has(source.session_id) || tasks.has(source.id)
      || !proof || stableDigest(proof.scope) !== stableDigest(scope) || proof.task_id !== source.id
      || proof.source_session_id !== source.session_id || proof.source_digest !== source.digest) continue;
    const verified = strings(observation.evidence_ids).some(evidenceId => {
      if (evidenceId !== proof.evidence_id) return false;
      const item = store.find("evidence", evidenceId), metadata = item?.metadata as JsonObject | undefined;
      return item?.record_origin !== "caller_asserted" && item?.source_type === "host_completion_signal"
        && (item.confidence === "bounded" || item.confidence === "confirmed")
        && metadata?.provenance === "host_completion_signal" && metadata.content_stored === false
        && metadata.verification_outcome === "passed" && metadata.project_scope_id === scopeId
        && metadata.source_session_id === source.session_id && metadata.task_id === source.id
        && metadata.turn_id === proof.turn_id && metadata.context_receipt_id === proof.context_receipt_id;
    });
    if (!verified) continue;
    sessions.add(source.session_id);
    tasks.add(source.id);
    independent.push(observation);
  }
  return independent;
}

export function programMemorySubmission(store: CraftStore, candidate: JsonObject): { design: JsonObject; observations: JsonObject[] } {
  const design = typeof candidate.evaluation_design_id === "string" ? store.find("evaluation_contract", candidate.evaluation_design_id) : null;
  if (design?.effect !== "program_memory_design" || design.contract_digest !== candidate.evaluation_design_digest
    || stableDigest(design.scope) !== stableDigest(candidate.scope)) throw new Error("Program Memory requires a bound evaluation design contract");
  const adapter = store.find("domain_adapter", `domain_adapter_${candidate.domain}`);
  const observations = independentProgramMemoryObservations(store, strings(candidate.evidence_ids), candidate.scope, candidate.scenario_key);
  if (observations.length < Math.max(2, Number(adapter?.value_threshold ?? 2))) {
    throw new Error("Program Memory requires independent verified project observations");
  }
  return { design, observations };
}
