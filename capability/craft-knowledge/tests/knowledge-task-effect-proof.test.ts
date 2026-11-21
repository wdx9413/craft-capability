import assert from "node:assert/strict";
import test from "node:test";
import type { CraftStore, JsonObject } from "craft-common-store-local/store";
import { stableDigest } from "craft-common-base/digest";
import { bindKnowledgeTaskEffectEvaluationReader, KNOWLEDGE_TASK_EFFECT_POLICY, knowledgeTaskEffectAssessmentDigest, knowledgeTaskEffectId, knowledgeTaskEffectProofVerified, WORKBENCH_EVALUATION_DEPENDENCY_KIND } from "../knowledge-task-effect-proof.ts";

function fixture(reader: (id: string) => JsonObject | null) {
  const run = { id: "run-1", version: 1 };
  const evaluation = { id: "evaluation-1", version: 3, status: "completed" };
  const metrics = { completed: 1 };
  const receipt: JsonObject = {
    version: 1, policy: KNOWLEDGE_TASK_EFFECT_POLICY, scope: { kind: "project", id: "project-1" }, claim_id: "claim-1",
    retrieval_run_id: run.id, retrieval_run_digest: stableDigest(run), baseline_id: "baseline-1", candidate_id: "candidate-1",
    dependencies: [{ kind: WORKBENCH_EVALUATION_DEPENDENCY_KIND, id: evaluation.id, version: evaluation.version, digest: stableDigest(evaluation) }],
    comparison_digest: stableDigest(metrics), metrics, observed_model: "fixture", execution_origin: "controlled_paired_host_tasks",
    status: "eligible", reasons: [],
  };
  receipt.assessment_digest = knowledgeTaskEffectAssessmentDigest(receipt);
  const store = {
    find(kind: string, id: string) {
      if (kind === "knowledge_task_effect" && id === knowledgeTaskEffectId(run)) return receipt;
      if (kind === WORKBENCH_EVALUATION_DEPENDENCY_KIND && id === evaluation.id) return evaluation;
      return null;
    },
  } as unknown as CraftStore;
  bindKnowledgeTaskEffectEvaluationReader(store, reader);
  return { store, run };
}

test("evaluation reader null falls back to an exact local dependency projection", () => {
  const f = fixture(() => null);
  assert.equal(knowledgeTaskEffectProofVerified(f.store, f.run), true);
});

test("evaluation reader failures fail closed without escaping proof verification", () => {
  const f = fixture(() => { throw new Error("reader unavailable"); });
  assert.equal(knowledgeTaskEffectProofVerified(f.store, f.run), false);
});
