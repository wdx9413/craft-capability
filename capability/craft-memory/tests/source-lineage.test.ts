import assert from "node:assert/strict";
import test from "node:test";
import type { JsonObject } from "craft-common-store-local/store";
import { historicalReplayProjectionDigest, historicalReplayProjectionId, mergeSourceLineage, normalizeSourceLineage, replayLineageForRun,
  sourceLineageDigest, sourceLineageEvidenceIds, validateHistoricalReplayProjection } from "../source-lineage.ts";

const evidenceA = { kind: "evidence", id: "evidence-a", version: 1 };
const evidenceB = { kind: "evidence", id: "evidence-b", version: 2 };
const replay: JsonObject = { origin: "historical_replay", replay_run_id: "run-a", session_id: "session-a", project_scope_id: "project:craft",
  source_ref: { kind: "codex_session_task", id: "task-a", version: 1, digest: `sha256:${"a".repeat(64)}` }, evidence_refs: [evidenceA] };

test("source lineage normalizes replay, live, fixture and optional source references", () => {
  assert.deepEqual(normalizeSourceLineage(undefined), []);
  assert.deepEqual(normalizeSourceLineage([replay]), [replay]);
  const taskBound = normalizeSourceLineage([{ ...replay, turn_id: "turn-a", task_id: "task-a" }])[0]!;
  assert.equal(taskBound.turn_id, "turn-a");
  assert.equal(taskBound.task_id, "task-a");
  assert.deepEqual(normalizeSourceLineage([{ origin: "live_hook", session_id: "live", project_scope_id: "project:craft",
    source_ref: { kind: "session", id: "live" }, evidence_refs: [evidenceA] }])[0]?.origin, "live_hook");
  assert.deepEqual(normalizeSourceLineage([{ origin: "test_fixture", session_id: "fixture", project_scope_id: "project:craft",
    source_ref: { kind: "fixture", id: "fixture", version: 1 }, evidence_refs: [evidenceB] }])[0]?.origin, "test_fixture");
  assert.throws(() => normalizeSourceLineage(null), /array/u);
  assert.throws(() => normalizeSourceLineage(Array.from({ length: 101 }, () => replay)), /at most 100/u);
  assert.throws(() => normalizeSourceLineage([null]), /object/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, private_body: "transcript" }]), /unsupported fields/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, origin: "unknown" }]), /origin/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, replay_run_id: undefined }]), /replay_run_id/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, origin: "live_hook" }]), /only historical/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, project_scope_id: "project:other path" }]), /identifier/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, project_scope_id: "user:other" }]), /canonical project/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, source_ref: null }]), /source_ref/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, source_ref: { kind: "session", id: "x", digest: "bad" } }]), /sha256/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, source_ref: { kind: "session", id: "x", private_body: "x" } }]), /unsupported fields/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, source_ref: { kind: "session", id: "x", version: 0 } }]), /positive integer/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, evidence_refs: [] }]), /one to 64/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, evidence_refs: [null] }]), /object/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, evidence_refs: [{ kind: "other", id: "e", version: 1 }] }]), /kind/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, evidence_refs: [{ kind: "evidence", id: "e", version: 0 }] }]), /positive integer/u);
  assert.throws(() => normalizeSourceLineage([{ ...replay, evidence_refs: [evidenceA, evidenceA] }]), /unique/u);
});

test("lineage merge unions exact-source Evidence refs and rejects source drift", () => {
  const duplicate = mergeSourceLineage([replay], [replay]);
  assert.equal(duplicate.changed, false);
  assert.deepEqual(duplicate.source_lineage, [replay]);
  const moreEvidence = { ...replay, evidence_refs: [evidenceA, evidenceB] };
  const merged = mergeSourceLineage([replay], [moreEvidence]);
  assert.equal(merged.changed, true);
  assert.deepEqual((merged.source_lineage[0]!.evidence_refs as JsonObject[]).map(item => item.id), ["evidence-a", "evidence-b"]);
  assert.throws(() => mergeSourceLineage([replay], [{ ...replay, source_ref: { kind: "codex_session_task", id: "changed" } }]), /conflicts/u);
  const added = mergeSourceLineage([replay], [{ ...replay, replay_run_id: "run-b", session_id: "session-b", source_ref: { kind: "codex_session_task", id: "task-b" } }]);
  assert.equal(added.changed, true);
  assert.equal(added.source_lineage.length, 2);
  const live = { origin: "live_hook", session_id: "live-session", project_scope_id: "project:craft",
    source_ref: { kind: "hook", id: "live-source" }, evidence_refs: [evidenceA] };
  const liveMerged = mergeSourceLineage([], [live]);
  assert.equal(liveMerged.changed, true);
  assert.deepEqual(mergeSourceLineage(liveMerged.source_lineage, [live]).source_lineage, [live]);
  assert.deepEqual(mergeSourceLineage([], []).source_lineage, []);
  assert.deepEqual(sourceLineageEvidenceIds(merged.source_lineage), ["evidence-a", "evidence-b"]);
  assert.equal(sourceLineageEvidenceIds(undefined).length, 0);
  assert.equal(sourceLineageDigest(merged.source_lineage).startsWith("sha256:"), true);
  assert.equal(replayLineageForRun(merged.source_lineage, "run-a").length, 1);
  assert.equal(replayLineageForRun(merged.source_lineage, "run-b").length, 0);
});

test("Memory replay projection identity is owner-local, exact and revocable", () => {
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
