import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { stableDigest } from "craft-common-base/digest";
import { craftPaths } from "craft-common-store-local/paths";
import { CraftStore, type JsonObject } from "craft-common-store-local/store";
import { ExperienceLearningWorkItemOwner } from "../learning-work-item.ts";
import { WorkflowEvolutionKernel } from "../workflow-evolution.ts";

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "craft-experience-replay-"));
  const store = await new CraftStore(craftPaths(root)).open();
  for (const id of ["billing", "other"]) {
    const directory = join(await realpath(root), id); await mkdir(directory);
    store.create("scope_alias", `project-${id}`, { status: "active", alias_kind: "path", alias: directory,
      alias_digest: stableDigest(directory), scope: { kind: "project", id: `project:${id}` } });
  }
  store.create("evidence", "history-evidence", { confidence: "unverified", source_type: "historical_session" });
  store.create("evidence", "history-evidence-2", { confidence: "unverified", source_type: "historical_session" });
  store.create("evidence", "live-evidence", { confidence: "bounded", source_type: "host_completion" });
  store.create("evidence", "live-evidence-other", { confidence: "bounded", source_type: "host_completion" });
  const kernel = new WorkflowEvolutionKernel(store);
  return { root, store, kernel, async close() { await store.close(); await rm(root, { recursive: true, force: true }); } };
}

function lineage(runId: string, sessionId = "session-1", evidenceId = "history-evidence") {
  return [{ origin: "historical_replay", replay_run_id: runId, session_id: sessionId,
    project_scope_id: "project:billing", source_ref: { kind: "host_session", id: sessionId, version: 1 },
    evidence_refs: [{ kind: "evidence", id: evidenceId, version: 1 }] }];
}

function liveLineage() {
  return [{ origin: "live_hook", session_id: "live-session", turn_id: "turn-1", task_id: "task-1", project_scope_id: "project:billing",
    source_ref: { kind: "host_task", id: "task-1", version: 1, digest: `sha256:${"c".repeat(64)}` },
    evidence_refs: [{ kind: "evidence", id: "live-evidence", version: 1 }] }];
}

test("Experience replay capture stores a content-free waiting candidate without a verified observation", async () => {
  const f = await fixture();
  try {
    const beforeEvidence = f.store.count("evidence");
    const result = f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-1"),
      blocked_reason: "insufficient_independent_live_evidence" });
    const candidate = result.candidate as Record<string, unknown>;
    assert.equal(candidate.status, "awaiting_evidence");
    assert.equal(candidate.routeable, false);
    assert.equal(candidate.content_stored, false);
    assert.equal(f.store.count("workflow_evolution_observation"), 0);
    assert.equal(f.store.count("experience_procedure"), 0, "historical replay must not synthesize an Experience Procedure");
    assert.equal(f.store.count("experience_learning_work_item"), 0, "historical replay must not enter the asynchronous promotion queue");
    assert.equal(f.store.count("evidence"), beforeEvidence, "replay must not create a Host outcome Evidence");
    assert.deepEqual(candidate.source_lineage, lineage("run-1"));
    assert.equal("summary" in candidate, false);
    assert.equal("transcript" in candidate, false);
  } finally { await f.close(); }
});

test("Experience replay capture rejects incomplete or non-replay lineage", async () => {
  const f = await fixture();
  try {
    for (const bad of [
      [{ ...lineage("run-1")[0], replay_run_id: undefined }],
      [{ ...lineage("run-1")[0], source_ref: "session-1" }],
      [{ ...lineage("run-1")[0], origin: "live_hook" }],
      [{ ...lineage("run-1")[0], evidence_refs: [{ kind: "evidence", id: "missing", version: 1 }] }],
      [{ ...lineage("run-1")[0], source_ref: { kind: "host_session", id: "session-1", digest: "sha256:wrong" } }],
    ]) {
      assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ source_lineage: bad,
        blocked_reason: "insufficient_independent_live_evidence" }));
    }
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ source_lineage: [{ ...liveLineage()[0]!,
      evidence_refs: [{ kind: "evidence", id: "live-evidence", version: 1 }] }], blocked_reason: "insufficient_independent_live_evidence" }), /historical_replay lineage/u);
    assert.equal(f.store.count("experience_replay_candidate"), 0);
  } finally { await f.close(); }
});

test("Experience replay rejects unsupported reasons, mixed scopes, and malformed projection metadata", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-reason"), blocked_reason: "guess" }), /blocked_reason/u);
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ source_lineage: [
      ...lineage("run-scope"), { ...lineage("run-scope", "session-2")[0]!, project_scope_id: "project:other" },
    ], blocked_reason: "insufficient_independent_live_evidence" }), /one project scope/u);
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ candidate_id: "bad id", source_lineage: lineage("run-id"),
      blocked_reason: "insufficient_independent_live_evidence" }), /candidate_id/u);
    f.store.create("evidence", "bad-projection", { source_type: "historical_replay_projection", claim: "wrong", metadata: {} });
    assert.throws(() => f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-any" }), /projection is malformed/u);
    assert.equal(f.store.count("experience_replay_candidate"), 0);
  } finally { await f.close(); }
});

test("Experience rejects non-live observations and malformed projection metadata fields", async () => {
  const f = await fixture();
  try {
    assert.throws(() => f.kernel.observe({ scenario_key: "scenario:x", source_kind: "host:codex", source_id: "task-x",
      source_digest: "digest-x", outcome: "passed", evidence_ids: ["live-evidence"],
      source_lineage: [{ ...liveLineage()[0]!, origin: "test_fixture" }], sanitized: true, content_stored: false }), /explicit live_hook/u);
    f.store.create("evidence", "bad-projection-fields", { source_type: "historical_replay_projection",
      claim: "Historical replay Evidence reference projection.", metadata: { replay_run_id: "run", source_owner: "context",
        source_evidence_id: "e", source_evidence_version: 1, semantic_digest: `sha256:${"a".repeat(64)}`, projection_status: "active", extra: true } });
    assert.throws(() => f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run" }), /metadata is malformed/u);
  } finally { await f.close(); }
});

test("Experience lineage rejects malformed field types, bounds, and dangling Evidence refs", async () => {
  const f = await fixture();
  try {
    const base = lineage("run-invalid")[0]!;
    const badValues: unknown[] = [
      null,
      [],
      { ...base, origin: "unknown" },
      { ...base, session_id: "s".repeat(257) },
      { ...base, project_scope_id: "billing" },
      { ...base, source_ref: null },
      { ...base, source_ref: { kind: "Bad Kind", id: "id" } },
      { ...base, source_ref: { kind: "host", id: "i".repeat(257) } },
      { ...base, source_ref: { kind: "host", id: "id", version: 0 } },
      { ...base, evidence_refs: [] },
      { ...base, evidence_refs: Array(65).fill({ kind: "evidence", id: "history-evidence", version: 1 }) },
      { ...base, evidence_refs: [null] },
      { ...base, evidence_refs: [{ kind: "task", id: "history-evidence", version: 1 }] },
      { ...base, evidence_refs: [{ kind: "evidence", id: "history-evidence", version: 0 }] },
      { ...base, evidence_refs: [{ kind: "evidence", id: "missing-evidence", version: 1 }] },
      { ...base, origin: "live_hook", replay_run_id: "run-invalid" },
      { ...base, turn_id: "t".repeat(257) },
      { ...base, task_id: "t\n1" },
    ];
    for (const bad of badValues) assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ source_lineage: [bad],
      blocked_reason: "insufficient_independent_live_evidence" }));
    assert.equal(f.store.count("experience_replay_candidate"), 0);
  } finally { await f.close(); }
});

test("WorkflowEvolution observe persists live learning-cycle source_lineage and rejects replay provenance", async () => {
  const f = await fixture();
  try {
    const result = f.kernel.observe({ observation_id: "live-observation", scenario_key: "scenario:billing", source_kind: "host:codex",
      source_id: "task-1", source_session_id: "live-session", source_digest: "digest-1", outcome: "passed", scope: "project:billing",
      scenario_signature: { schema: "craft.scenario-signature.v1", source: "host" }, evidence_ids: ["live-evidence"],
      source_lineage: liveLineage(), sanitized: true, content_stored: false });
    assert.deepEqual((result.observation as Record<string, unknown>).source_lineage, liveLineage());
    assert.throws(() => f.kernel.observe({ observation_id: "replay-observation", scenario_key: "scenario:billing", source_kind: "host:codex",
      source_id: "task-2", source_session_id: "session-1", source_digest: "digest-2", outcome: "passed", scope: "project:billing",
      evidence_ids: ["live-evidence"], source_lineage: lineage("run-1"), sanitized: true, content_stored: false }), /origin is unsupported/u);
    assert.equal(f.store.find("workflow_evolution_observation", "replay-observation"), null);
    assert.throws(() => f.kernel.observe({ observation_id: "session-mismatch", scenario_key: "scenario:billing", source_kind: "host:codex",
      source_id: "task-1", source_session_id: "another-session", source_digest: "digest-3", outcome: "passed", scope: "project:billing",
      evidence_ids: ["live-evidence"], source_lineage: liveLineage(), sanitized: true, content_stored: false }), /source session/u);
    const mismatchedLineage = liveLineage();
    (mismatchedLineage[0]!.evidence_refs[0] as Record<string, unknown>).id = "live-evidence-other";
    assert.throws(() => f.kernel.observe({ observation_id: "evidence-mismatch", scenario_key: "scenario:billing", source_kind: "host:codex",
      source_id: "task-1", source_session_id: "live-session", source_digest: "digest-4", outcome: "passed", scope: "project:billing",
      evidence_ids: ["live-evidence"], source_lineage: mismatchedLineage, sanitized: true, content_stored: false }), /observation Evidence/u);
  } finally { await f.close(); }
});

test("WorkflowEvolution observe accepts optional replay-free lineage fields and Host verification receipts", async () => {
  const f = await fixture();
  try {
    const base = liveLineage()[0]!;
    const optionalFreeLineage = [{ ...base, source_ref: { kind: "host_task", id: "task-optional" }, turn_id: undefined, task_id: undefined }];
    const observation = f.kernel.observe({ observation_id: "live-observation-with-receipt", scenario_key: "scenario:billing",
      source_kind: "host:codex", source_id: "task-optional", source_session_id: "live-session", source_digest: "digest-receipt",
      outcome: "passed", failure_type: "none", verification: { contract_ref: "contract:1", workspace_revision: "rev-1",
        evidence_digest: "evidence-digest", producer: "host", started_at: "2026-11-23T00:00:00Z", completed_at: "2026-11-23T00:01:00Z", exit_code: 0 },
      evidence_ids: ["live-evidence"], source_lineage: optionalFreeLineage, sanitized: true, content_stored: false });
    assert.equal((observation.observation as Record<string, unknown>).failure_type, "none");
    assert.equal((observation.observation as Record<string, unknown>).verification !== null, true);
    assert.equal(((observation.observation as Record<string, unknown>).source_lineage as Array<Record<string, unknown>>)[0]!.source_ref !== undefined, true);
  } finally { await f.close(); }
});

test("Experience replay cleanup revokes replay-only candidates and preserves a content-free receipt", async () => {
  const f = await fixture();
  try {
    const captured = f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-1"),
      blocked_reason: "insufficient_independent_live_evidence" }) as { candidate: Record<string, unknown> };
    const candidate = captured.candidate;
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-1" }) as Record<string, unknown>;
    assert.deepEqual(preview.items, [{ kind: "experience_replay_candidate", id: candidate.id, version: candidate.version,
      lineage_digest: previewLineageDigest(candidate.source_lineage), action: "revoke" }]);
    assert.equal(JSON.stringify(preview).includes("transcript"), false);
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-1", expected_manifest_digest: preview.manifest_digest });
    assert.equal(f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-1", expected_manifest_digest: preview.manifest_digest }).idempotent, true);
    const cleaned = f.store.get("experience_replay_candidate", String(candidate.id));
    assert.equal(cleaned.status, "revoked");
    assert.equal(cleaned.candidate_content, undefined);
    assert.equal(cleaned.cleanup_receipt !== undefined, true);
  } finally { await f.close(); }
});

test("Experience replay cleanup removes only the selected run from mixed lineage", async () => {
  const f = await fixture();
  try {
    const first = f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-1"),
      blocked_reason: "insufficient_independent_live_evidence" }) as { candidate: Record<string, unknown> };
    const second = f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-2"),
      blocked_reason: "insufficient_independent_live_evidence" }) as { candidate: Record<string, unknown> };
    assert.equal(first.candidate.id, second.candidate.id, "the same candidate source deduplicates across replay runs");
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-1" }) as Record<string, unknown>;
    assert.equal((preview.items as Array<Record<string, unknown>>)[0]?.action, "remove_replay_lineage");
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-1", expected_manifest_digest: preview.manifest_digest });
    const candidate = f.store.get("experience_replay_candidate", String(first.candidate.id));
    assert.equal(candidate.status, "awaiting_evidence");
    assert.deepEqual((candidate.source_lineage as Array<Record<string, unknown>>).map(item => item.replay_run_id), ["run-2"]);
  } finally { await f.close(); }
});

test("Experience replay cleanup revokes pure replay Work Items and strips one run from mixed lineage", async () => {
  const f = await fixture();
  try {
    const owner = new ExperienceLearningWorkItemOwner(f.store);
    const createWorkItem = (id: string, sourceLineage?: JsonObject[], sourceRefs: JsonObject[] = []) => {
      const procedure = f.store.create("experience_procedure", id, {
        scope: "project:billing", provenance: "explicit_trace_distillation", lifecycle: "candidate",
        version: 1, candidate_version: 1, definition_digest: `sha256:${"a".repeat(64)}`,
        source_refs: sourceRefs, ...(sourceLineage ? { source_lineage: sourceLineage } : {}),
        completed_gates: [], routeable: false, publication_allowed: false,
      });
      return owner.enqueue({
        candidate_ref: { kind: "experience_procedure", id: String(procedure.id), version: 1, digest: String(procedure.definition_digest) },
        scope: "project:billing", source_refs: sourceRefs, evaluation_contract_ref: null,
      }).work_item as Record<string, unknown>;
    };

    const replayOnly = createWorkItem("procedure-work-item-replay-only", lineage("run-work-item-pure"));
    const mixedLineage = [...lineage("run-work-item-mixed"), ...liveLineage()];
    const nestedProjection = { origin: "live_hook", session_id: "live-session", source_ref: { kind: "host_task", id: "task-2" },
      trace_ref: { kind: "evidence", id: "history-evidence", version: 1 },
      event_refs: [
        { kind: "evidence", id: "history-evidence", version: 1 },
        { kind: "evidence", id: "live-evidence-other", version: 1 },
        { kind: "evidence", id: 12, version: 1 },
      ] };
    const mixedSources: JsonObject[] = [
      { origin: "historical_replay", replay_run_id: "run-work-item-mixed", session_id: "session-1",
        source_ref: { kind: "host_session", id: "session-1", version: 1 },
        evidence_refs: [{ kind: "evidence", id: "history-evidence", version: 1 }] },
      { origin: "live_hook", session_id: "live-session", source_ref: { kind: "host_task", id: "task-1", version: 1 },
        evidence_refs: [{ kind: "evidence", id: "live-evidence", version: 1 }] },
      nestedProjection,
      { origin: "historical_replay", replay_run_id: "run-work-item-retained", session_id: "session-retained",
        source_ref: { kind: "host_task", id: 17, version: 1 } },
      ...([null, "unstructured-source-ref", []] as unknown as JsonObject[]),
    ];
    const mixed = createWorkItem("procedure-work-item-mixed", mixedLineage, mixedSources);
    const sharedReplay = createWorkItem("procedure-work-item-shared-replay", [
      ...lineage("run-work-item-shared", "session-shared-1", "history-evidence"),
      ...lineage("run-work-item-retained", "session-shared-2", "history-evidence-2"),
    ]);
    const liveOnly = createWorkItem("procedure-work-item-live-only");
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-work-item-pure" });
    assert.deepEqual((preview.items as Array<Record<string, unknown>>).filter(item => item.kind === "experience_learning_work_item")
      .map(item => ({ id: item.id, action: item.action })),
    [{ id: replayOnly.id, action: "revoke" }]);

    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-work-item-pure", expected_manifest_digest: preview.manifest_digest });
    const revoked = f.store.get("experience_learning_work_item", String(replayOnly.id));
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.failure_reason, "source_unavailable");
    const lateGate = f.store.create("experience_procedure_gate", "late-replay-work-item-gate", {
      procedure_id: "procedure-work-item-replay-only", stage: "shadow", passed: true, evidence_ids: ["late-evidence"],
    });
    assert.throws(() => owner.advance({ work_item_id: replayOnly.id, gate_id: lateGate.id }),
      /Revoked Learning Work Item cannot advance/u);
    assert.throws(() => owner.failFromGate({ work_item_id: replayOnly.id, gate_id: lateGate.id }),
      /Revoked Learning Work Item cannot accept a Gate result/u);

    const mixedPreview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-work-item-mixed" });
    const mixedItem = (mixedPreview.items as Array<Record<string, unknown>>)
      .find(item => item.kind === "experience_learning_work_item" && item.id === mixed.id);
    assert.equal(mixedItem?.action, "remove_replay_lineage");
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-work-item-mixed", expected_manifest_digest: mixedPreview.manifest_digest });
    const retained = f.store.get("experience_learning_work_item", String(mixed.id));
    assert.deepEqual(retained.source_lineage, liveLineage());
    assert.equal(retained.replay_run_id, undefined);
    assert.equal(retained.status, "blocked", "removing replay provenance preserves the remaining Work Item state");
    const { trace_ref: _removedTraceRef, ...cleanedNestedProjection } = nestedProjection;
    assert.deepEqual(retained.source_refs, [mixedSources[1], {
      ...cleanedNestedProjection,
      event_refs: [
        { kind: "evidence", id: "live-evidence-other", version: 1 },
        { kind: "evidence", id: 12, version: 1 },
      ],
    }, mixedSources[3], null, "unstructured-source-ref", []]);
    assert.equal(JSON.stringify(retained.source_refs).includes("run-work-item-mixed"), false,
      "removed replay run identifiers are not left in searchable Work Item source refs");
    assert.equal(owner.findForCandidate(mixed.candidate_ref)?.id, mixed.id,
      "lookup resolves the preserved Work Item even though cleanup changed its mutable lineage projection");
    const retry = owner.enqueue({
      candidate_ref: mixed.candidate_ref, scope: "project:billing", source_refs: mixedSources, evaluation_contract_ref: null,
    }) as { work_item: Record<string, unknown>; idempotent: boolean };
    assert.equal(retry.idempotent, true, "retry after cleanup does not recreate a second Work Item");
    assert.equal(retry.work_item.id, mixed.id);

    const livePreview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-work-item-pure" });
    assert.equal((livePreview.items as Array<Record<string, unknown>>)
      .some(item => item.kind === "experience_learning_work_item" && item.id === liveOnly.id), false);

    const sharedPreview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-work-item-shared" });
    const sharedItem = (sharedPreview.items as Array<Record<string, unknown>>)
      .find(item => item.kind === "experience_learning_work_item" && item.id === sharedReplay.id);
    assert.equal(sharedItem?.action, "remove_replay_lineage");
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-work-item-shared", expected_manifest_digest: sharedPreview.manifest_digest });
    const sharedRetained = f.store.get("experience_learning_work_item", String(sharedReplay.id));
    assert.deepEqual(sharedRetained.source_lineage, lineage("run-work-item-retained", "session-shared-2", "history-evidence-2"));
    assert.equal(sharedRetained.replay_run_id, "run-work-item-retained");
    assert.equal(sharedRetained.status, "blocked");
  } finally { await f.close(); }
});

test("Experience replay cleanup fails closed on malformed Learning Work Item source refs", async () => {
  const f = await fixture();
  try {
    const item = f.store.create("experience_learning_work_item", "work-item-malformed-source-refs", {
      scope: "project:billing",
      status: "blocked",
      source_lineage: lineage("run-work-item-malformed"),
      source_refs: "not-an-array",
    });
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-work-item-malformed" });
    assert.ok((preview.items as Array<Record<string, unknown>>)
      .some(entry => entry.kind === "experience_learning_work_item" && entry.id === item.id));

    assert.throws(() => f.kernel.historicalReplayCleanupApply({
      replay_run_id: "run-work-item-malformed", expected_manifest_digest: preview.manifest_digest,
    }), /source_refs is malformed; cleanup requires reconciliation/u);
    const unchanged = f.store.get("experience_learning_work_item", String(item.id));
    assert.equal(unchanged.version, item.version);
    assert.equal(unchanged.source_refs, "not-an-array");
    assert.deepEqual(unchanged.source_lineage, item.source_lineage);
    assert.equal(f.store.count("experience_replay_cleanup_receipt"), 0);
  } finally { await f.close(); }
});

test("Experience merges Evidence refs for a repeated lineage occurrence", async () => {
  const f = await fixture();
  try {
    const first = f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-merge"),
      blocked_reason: "insufficient_independent_live_evidence" }) as { candidate: Record<string, unknown> };
    const repeated = lineage("run-merge");
    repeated[0]!.evidence_refs.push({ kind: "evidence", id: "history-evidence-2", version: 1 });
    const next = f.kernel.captureHistoricalReplayCandidate({ source_lineage: repeated,
      blocked_reason: "insufficient_independent_live_evidence" }) as { candidate: Record<string, unknown> };
    assert.equal(next.candidate.id, first.candidate.id);
    const entries = next.candidate.source_lineage as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1);
    assert.equal((entries[0]!.evidence_refs as unknown[]).length, 2);
  } finally { await f.close(); }
});

test("Experience replay capture rejects candidate identity collisions and conflicting source refs", async () => {
  const f = await fixture();
  try {
    f.store.create("experience_replay_candidate", "experience_replay_legacy", { status: "awaiting_evidence" });
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ candidate_id: "experience_replay_legacy", source_lineage: lineage("run-collision"),
      blocked_reason: "insufficient_independent_live_evidence" }), /identity is unknown/u);
    const first = f.kernel.captureHistoricalReplayCandidate({ candidate_id: "experience_replay_conflict", source_lineage: lineage("run-conflict"),
      blocked_reason: "insufficient_independent_live_evidence" });
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ candidate_id: "experience_replay_conflict",
      source_lineage: [{ ...lineage("run-conflict")[0]!, source_ref: { kind: "host_session", id: "other-session", version: 1 } }],
      blocked_reason: "insufficient_independent_live_evidence" }), /identity conflict/u);
    const conflictingOccurrences = [lineage("run-source-conflict")[0]!,
      { ...lineage("run-source-conflict")[0]!, source_ref: { kind: "host_session", id: "different-source", version: 1 } }];
    assert.throws(() => f.kernel.captureHistoricalReplayCandidate({ source_lineage: conflictingOccurrences,
      blocked_reason: "insufficient_independent_live_evidence" }), /source_ref conflicts/u);
    assert.equal((first as Record<string, unknown>).status, "awaiting_evidence");
  } finally { await f.close(); }
});

test("Experience propose accepts live and legacy observations but rejects a replay observation", async () => {
  const f = await fixture();
  try {
    const signature = { schema: "craft.scenario-signature.v1", project: "project:billing", target_class: "host_task_completion" };
    const common = { scenario_key: "scenario:billing", scenario_signature: signature, outcome: "passed", scope: "project:billing",
      execution_shape: [], sanitized: true, content_stored: false };
    const live = f.kernel.observe({ ...common, observation_id: "proposal-live", source_kind: "host:codex", source_id: "task-live",
      source_session_id: "live-session", source_digest: "proposal-live-digest", evidence_ids: ["live-evidence"], source_lineage: liveLineage() });
    const legacy = f.kernel.observe({ ...common, observation_id: "proposal-legacy", source_kind: "host:codex", source_id: "task-legacy",
      source_session_id: "session-legacy", source_digest: "proposal-legacy-digest", evidence_ids: ["live-evidence"] });
    const request = f.kernel.propose({ scenario_key: "scenario:billing", observation_ids: ["proposal-live", "proposal-legacy"],
      hypothesis: "Use the verified completion sequence", design_axes: ["tools"], output_contract_ref: "contract:billing" });
    assert.equal((request.request as Record<string, unknown>).lifecycle, "awaiting_model");
    assert.equal((live.observation as Record<string, unknown>).source_lineage !== undefined, true);
    const replayObservation = f.store.create("workflow_evolution_observation", "proposal-replay", { ...common, source_kind: "host:codex",
      source_id: "task-replay", source: { kind: "host:codex", id: "task-replay", digest: "proposal-replay-digest", session_id: "session-replay", scope: "project:billing" },
      source_lineage: lineage("proposal-run"), lifecycle: "accepted" });
    assert.equal((legacy.observation as Record<string, unknown>).source_lineage, undefined);
    assert.throws(() => f.kernel.propose({ scenario_key: "scenario:billing", observation_ids: ["proposal-live", String(replayObservation.id)],
      hypothesis: "Should fail", design_axes: ["tools"], output_contract_ref: "contract:billing" }), /explicit live_hook lineage/u);
  } finally { await f.close(); }
});

test("Experience replay cleanup rejects stale previews and is idempotent", async () => {
  const f = await fixture();
  try {
    const captured = f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-1"),
      blocked_reason: "insufficient_independent_live_evidence" }) as { candidate: Record<string, unknown> };
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-1" }) as Record<string, unknown>;
    f.store.save("experience_replay_candidate", String(captured.candidate.id), {
      ...f.store.get("experience_replay_candidate", String(captured.candidate.id)), blocked_reason: "changed_after_preview",
    });
    assert.throws(() => f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-1", expected_manifest_digest: preview.manifest_digest }), /manifest.*changed|stale/u);
    const current = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-1" }) as Record<string, unknown>;
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-1", expected_manifest_digest: current.manifest_digest });
    const empty = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-1" }) as Record<string, unknown>;
    assert.deepEqual(empty.items, []);
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-1", expected_manifest_digest: empty.manifest_digest });
  } finally { await f.close(); }
});

test("Experience cleanup fails closed when lineage identity is malformed", async () => {
  const f = await fixture();
  try {
    f.store.create("experience_replay_candidate", "malformed-lineage", { status: "awaiting_evidence", source_lineage: "unknown" });
    assert.throws(() => f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-malformed" }), /reconciliation/u);
  } finally { await f.close(); }
});

test("Experience replay cleanup revokes only its projection Evidence and preserves the original Evidence", async () => {
  const f = await fixture();
  try {
    f.store.create("evidence", "original-evidence", { confidence: "confirmed", source_type: "host_completion", claim: "original" });
    const projection = f.store.create("evidence", "evidence_historical_replay_projection_test", { confidence: "unverified",
      source_type: "historical_replay_projection", claim: "Historical replay Evidence reference projection.", metadata: {
        replay_run_id: "run-evidence", source_owner: "context", source_evidence_id: "original-evidence", source_evidence_version: 1,
        semantic_digest: `sha256:${"d".repeat(64)}`, projection_status: "active" } });
    f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-evidence", "session-evidence", String(projection.id)),
      blocked_reason: "insufficient_independent_live_evidence" });
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-evidence" });
    const evidenceItem = (preview.items as Array<Record<string, unknown>>).find(item => item.kind === "evidence_projection");
    assert.deepEqual({ id: evidenceItem?.id, version: evidenceItem?.version, action: evidenceItem?.action },
      { id: projection.id, version: projection.version, action: "revoke" });
    assert.equal(JSON.stringify(preview).includes("original"), false);
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-evidence", expected_manifest_digest: preview.manifest_digest });
    const cleanedProjection = f.store.get("evidence", String(projection.id));
    const original = f.store.get("evidence", "original-evidence");
    assert.equal(cleanedProjection.confidence, "rejected");
    assert.equal((cleanedProjection.metadata as Record<string, unknown>).projection_status, "revoked");
    assert.equal(original.confidence, "confirmed");
    assert.equal(original.claim, "original");
  } finally { await f.close(); }
});

test("Experience cleanup handles nonmatching projections, stale records, procedure rollback, and in-transaction receipts", async () => {
  const f = await fixture();
  try {
    const other = f.store.create("evidence", "other-run-projection", { source_type: "historical_replay_projection",
      claim: "Historical replay Evidence reference projection.", confidence: "unverified", metadata: { replay_run_id: "other-run",
        source_owner: "context", source_evidence_id: "original", source_evidence_version: 1,
        semantic_digest: `sha256:${"b".repeat(64)}`, projection_status: "active" } });
    f.kernel.captureHistoricalReplayCandidate({ source_lineage: lineage("run-stale"), blocked_reason: "insufficient_independent_live_evidence" });
    const preview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-stale" });
    const item = (preview.items as Array<Record<string, unknown>>).find(entry => entry.kind === "experience_replay_candidate")!;
    const originalGet = f.store.get.bind(f.store);
    f.store.get = ((kind: string, id: string, version?: number) => {
      if (kind === "experience_replay_candidate" && id === item.id) {
        const row = originalGet(kind, id);
        f.store.save(kind, id, { ...row, source_lineage: undefined, blocked_reason: "changed during cleanup" });
      }
      return originalGet(kind, id, version);
    }) as typeof f.store.get;
    assert.throws(() => f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-stale", expected_manifest_digest: preview.manifest_digest }), /changed after cleanup preview/u);
    f.store.get = originalGet;

    const staleProjection = f.store.create("evidence", "stale-projection", { source_type: "historical_replay_projection",
      claim: "Historical replay Evidence reference projection.", confidence: "unverified", metadata: { replay_run_id: "run-projection-stale",
        source_owner: "context", source_evidence_id: "source", source_evidence_version: 1,
        semantic_digest: `sha256:${"c".repeat(64)}`, projection_status: "active" } });
    const projectionPreview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-projection-stale" });
    f.store.get = ((kind: string, id: string, version?: number) => {
      if (kind === "evidence" && id === staleProjection.id) {
        const row = originalGet(kind, id);
        f.store.save(kind, id, { ...row, metadata: { ...(row.metadata as Record<string, unknown>), projection_status: "revoked" } });
      }
      return originalGet(kind, id, version);
    }) as typeof f.store.get;
    assert.throws(() => f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-projection-stale",
      expected_manifest_digest: projectionPreview.manifest_digest }), /projection changed after cleanup preview/u);
    f.store.get = originalGet;

    const receiptPreview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-empty-race" });
    const receiptId = `experience_replay_cleanup_${stableDigest({ replay_run_id: "run-empty-race", manifest_digest: receiptPreview.manifest_digest }).slice(-32)}`;
    f.store.create("experience_replay_cleanup_receipt", receiptId, { owner: "experience", replay_run_id: "run-empty-race",
      manifest_digest: receiptPreview.manifest_digest, content_free: true, status: "cleaned" });
    const originalFind = f.store.find.bind(f.store);
    let hideFirstReceiptRead = true;
    f.store.find = ((kind: string, id: string) => {
      if (hideFirstReceiptRead && kind === "experience_replay_cleanup_receipt" && id === receiptId) {
        hideFirstReceiptRead = false;
        return null;
      }
      return originalFind(kind, id);
    }) as typeof f.store.find;
    const raceRetry = f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-empty-race", expected_manifest_digest: receiptPreview.manifest_digest });
    assert.equal(raceRetry.idempotent, true);
    f.store.find = originalFind;

    f.store.create("experience_procedure", "procedure-replay", { lifecycle: "active", source_lineage: lineage("run-rollback") });
    const signature = { schema: "craft.scenario-signature.v1", source: "host" };
    for (const [id, session] of [["cleanup-observation-1", "cleanup-session-1"], ["cleanup-observation-2", "cleanup-session-2"]]) {
      f.kernel.observe({ observation_id: id, scenario_key: "scenario:cleanup", scenario_signature: signature, source_kind: "host:codex",
        source_id: id, source_session_id: session, source_digest: id, outcome: "passed", evidence_ids: ["live-evidence"],
        sanitized: true, content_stored: false });
    }
    f.kernel.propose({ request_id: "cleanup-request", scenario_key: "scenario:cleanup",
      observation_ids: ["cleanup-observation-1", "cleanup-observation-2"], hypothesis: "cleanup proposal", design_axes: ["tools"],
      output_contract_ref: "contract:cleanup" });
    f.kernel.submit({ request_id: "cleanup-request", proposal_id: "cleanup-proposal", workflow_id: "workflow-cleanup",
      name: "Cleanup workflow", description: "cleanup", inputs: [], steps: ["step"] });
    f.store.save("workflow_evolution_proposal", "cleanup-proposal", {
      ...f.store.get("workflow_evolution_proposal", "cleanup-proposal"), publication_allowed: true, source_lineage: lineage("run-rollback"),
    });
    const rollbackPreview = f.kernel.historicalReplayCleanupPreview({ replay_run_id: "run-rollback" });
    f.kernel.historicalReplayCleanupApply({ replay_run_id: "run-rollback", expected_manifest_digest: rollbackPreview.manifest_digest });
    assert.equal(f.store.get("experience_procedure", "procedure-replay").lifecycle, "rolled_back");
    assert.equal(f.store.get("workflow_evolution_proposal", "cleanup-proposal").publication_allowed, false);
    assert.equal(f.store.get("evidence", String(other.id)).confidence, "unverified");
  } finally { await f.close(); }
});

function previewLineageDigest(lineageValue: unknown): string {
  return stableDigest(lineageValue);
}
