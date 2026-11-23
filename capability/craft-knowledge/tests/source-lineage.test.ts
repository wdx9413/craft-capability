import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "craft-common-store-local/store";
import { historicalReplayProjectionDigest, historicalReplayProjectionId, knowledgeSourceLineageDigest, knowledgeSourceLineageEvidenceIds,
  mergeKnowledgeSourceLineage, normalizeKnowledgeSourceLineage, replayKnowledgeLineageForRun, validateHistoricalReplayProjection } from "../source-lineage.ts";

const evidenceA = { kind: "evidence", id: "evidence-a", version: 1 };
const evidenceB = { kind: "evidence", id: "evidence-b", version: 2 };
const replay: JsonObject = { origin: "historical_replay", replay_run_id: "run-a", session_id: "session-a", project_scope_id: "project:craft",
  source_ref: { kind: "codex_session_task", id: "task-a", version: 1, digest: `sha256:${"a".repeat(64)}` }, evidence_refs: [evidenceA] };

test("Knowledge lineage validates and canonicalizes all origins and optional source fields", () => {
  assert.deepEqual(normalizeKnowledgeSourceLineage(undefined), []);
  assert.deepEqual(normalizeKnowledgeSourceLineage([replay]), [replay]);
  const optional = normalizeKnowledgeSourceLineage([{ ...replay, turn_id: "turn-a", task_id: "task-a" }])[0]!;
  assert.equal(optional.turn_id, "turn-a");
  assert.equal(optional.task_id, "task-a");
  assert.equal(normalizeKnowledgeSourceLineage([{ origin: "live_hook", session_id: "live", project_scope_id: "project:craft",
    source_ref: { kind: "session", id: "live" }, evidence_refs: [evidenceA] }])[0]?.origin, "live_hook");
  assert.equal(normalizeKnowledgeSourceLineage([{ origin: "test_fixture", session_id: "fixture", project_scope_id: "project:craft",
    source_ref: { kind: "fixture", id: "fixture", version: 1 }, evidence_refs: [evidenceB] }])[0]?.origin, "test_fixture");
  assert.throws(() => normalizeKnowledgeSourceLineage(null), /array/u);
  assert.throws(() => normalizeKnowledgeSourceLineage(Array.from({ length: 101 }, () => replay)), /at most 100/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([null]), /object/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, transcript: "private" }]), /unsupported fields/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, origin: "unknown" }]), /origin/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, replay_run_id: undefined }]), /replay_run_id/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, origin: "live_hook" }]), /only historical/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, project_scope_id: "project:other path" }]), /identifier/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, project_scope_id: "user:other" }]), /canonical project/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, source_ref: null }]), /source_ref/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, source_ref: { kind: "session", id: "x", digest: "bad" } }]), /sha256/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, source_ref: { kind: "session", id: "x", body: "private" } }]), /unsupported fields/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, source_ref: { kind: "session", id: "x", version: 0 } }]), /positive integer/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, evidence_refs: [] }]), /one to 64/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, evidence_refs: [null] }]), /object/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, evidence_refs: [{ kind: "other", id: "e", version: 1 }] }]), /kind/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, evidence_refs: [{ kind: "evidence", id: "e", version: 0 }] }]), /positive integer/u);
  assert.throws(() => normalizeKnowledgeSourceLineage([{ ...replay, evidence_refs: [evidenceA, evidenceA] }]), /unique/u);
});

test("Knowledge lineage merges Evidence refs idempotently and rejects occurrence source drift", () => {
  const duplicate = mergeKnowledgeSourceLineage([replay], [replay]);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.source_lineage, [replay]);
  const merged = mergeKnowledgeSourceLineage([replay], [{ ...replay, evidence_refs: [evidenceA, evidenceB] }]);
  assert.equal(merged.changed, true);
  assert.deepEqual((merged.source_lineage[0]!.evidence_refs as JsonObject[]).map(item => item.id), ["evidence-a", "evidence-b"]);
  assert.throws(() => mergeKnowledgeSourceLineage([replay], [{ ...replay, source_ref: { kind: "task", id: "changed" } }]), /conflicts/u);
  const next = { ...replay, replay_run_id: "run-b", session_id: "session-b", source_ref: { kind: "task", id: "task-b" } };
  const added = mergeKnowledgeSourceLineage([replay], [next]);
  assert.equal(added.changed, true);
  assert.equal(added.source_lineage.length, 2);
  const live = { origin: "live_hook", session_id: "live-session", project_scope_id: "project:craft",
    source_ref: { kind: "hook", id: "live-source" }, evidence_refs: [evidenceA] };
  const liveMerged = mergeKnowledgeSourceLineage([], [live]);
  assert.equal(liveMerged.changed, true);
  assert.deepEqual(mergeKnowledgeSourceLineage(liveMerged.source_lineage, [live]).source_lineage, [live]);
  assert.deepEqual(mergeKnowledgeSourceLineage([], []).source_lineage, []);
  assert.deepEqual(knowledgeSourceLineageEvidenceIds(merged.source_lineage), ["evidence-a", "evidence-b"]);
  assert.deepEqual(knowledgeSourceLineageEvidenceIds(undefined), []);
  assert.equal(knowledgeSourceLineageDigest(merged.source_lineage).startsWith("sha256:"), true);
  assert.equal(replayKnowledgeLineageForRun(merged.source_lineage, "run-a").length, 1);
  assert.equal(replayKnowledgeLineageForRun(merged.source_lineage, "run-b").length, 0);
});

test("Knowledge replay projection identity is owner-local, exact and revocable", () => {
  const runId = "run-projection", sourceId = "source-evidence";
  const projection: JsonObject = { id: historicalReplayProjectionId(runId, sourceId), version: 1, source_type: "historical_replay_projection",
    claim: "Historical replay Evidence reference projection.",
    metadata: { replay_run_id: runId, source_owner: "experience", source_evidence_id: sourceId, source_evidence_version: 3,
      semantic_digest: `sha256:${"b".repeat(64)}`, projection_status: "active" } };
  assert.deepEqual(validateHistoricalReplayProjection(projection), projection.metadata);
  assert.match(historicalReplayProjectionDigest(projection), /^sha256:/u);
  assert.throws(() => validateHistoricalReplayProjection({ ...projection, id: "source-evidence" }), /identity is invalid/u);
  assert.throws(() => validateHistoricalReplayProjection({ ...projection, metadata: { ...projection.metadata as JsonObject, private_body: "source" } }), /unsupported fields/u);
  assert.throws(() => validateHistoricalReplayProjection({ ...projection, metadata: { ...projection.metadata as JsonObject, projection_status: "retired" } }), /identity is invalid/u);
});
