import assert from "node:assert/strict";
import test from "node:test";
import { contextFeedbackEvidenceCurrent, contextFeedbackWeight, contextFeedbackWeights } from "../context-feedback-weight.ts";
import { legacyFieldAbsent } from "../memory-legacy-field.ts";
import { MemorySignalsKernel } from "../memory-signals-kernel.ts";
import { MEMORY_COMPONENT, MEMORY_COMPONENT_SOURCE, MEMORY_CONTEXT_SOURCE, MEMORY_FAMILIES, MEMORY_OWNS } from "../ownership.ts";

type Row = Record<string, unknown>;

function fakeStore(rows: Record<string, Row[]>, records: Record<string, Row> = {}) {
  return {
    list: (kind: string, _limit?: number, predicate?: (row: Row) => boolean) => {
      const all = rows[kind] ?? [];
      return predicate ? all.filter(row => predicate(row)) : all;
    },
    find: (kind: string, id: string) => records[`${kind}:${id}`] ?? null,
    history: () => [],
  };
}

test("legacy field detection requires bounded complete history", () => {
  const store = { history: (_kind: string, _id: string, _before: number, _limit: number) => [{ version: 1 }, { version: 2 }] };
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "x", version: 1 }, "field"), true);
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "x", version: 3 }, "field"), true);
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "x", version: 4 }, "field"), false);
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "x", version: 103 }, "field"), false);
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "", version: 1 }, "field"), false);
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "x" }, "field"), false);
  assert.equal(legacyFieldAbsent(store as never, "k", { id: "x", version: 0 }, "field"), false);
  const withField = { history: () => [{ version: 1, field: "present" }, { version: 2 }] };
  assert.equal(legacyFieldAbsent(withField as never, "k", { id: "x", version: 3 }, "field"), false);
});

test("ownership declares the narrow write surface and the wider projection", () => {
  assert.match(MEMORY_FAMILIES, /ledger_remember/u);
  assert.equal(MEMORY_CONTEXT_SOURCE, "craft_memory");
  assert.equal(MEMORY_OWNS.test("craft_memory_ledger_remember"), true);
  assert.equal(MEMORY_OWNS.test("craft_memory_decay_get"), true);
  assert.equal(MEMORY_OWNS.test("craft_memory_recall"), false);
  assert.equal(MEMORY_OWNS.test("craft_context_resolution"), false);
  assert.equal(MEMORY_COMPONENT.test("craft_memory_ledger_remember"), true);
  assert.equal(MEMORY_COMPONENT.test("craft_knowledge_source_register"), true);
  assert.equal(MEMORY_COMPONENT.test("craft_context_resolution"), true);
  assert.equal(MEMORY_COMPONENT.test("other"), false);
  assert.match(MEMORY_COMPONENT_SOURCE, /knowledge_bootstrap_install/u);
});

test("feedback weight is bounded and symmetric", () => {
  assert.equal(contextFeedbackWeight(0, 0), 1);
  assert.equal(contextFeedbackWeight(5, 0), 2);
  assert.equal(contextFeedbackWeight(100, 0), 2);
  assert.equal(contextFeedbackWeight(0, 5), 0.25);
  assert.equal(contextFeedbackWeight(0, 100), 0.25);
  assert.equal(contextFeedbackWeight(1, 1), 1);
});

test("feedback evidence must be a current, bound program receipt", () => {
  const store = fakeStore({}, {
    "evidence:e1": {
      id: "e1", version: 2, record_origin: "program", source_type: "program", confidence: "confirmed",
      metadata: { context_receipt_id: "r1", verdict: "passed" },
    },
  });
  const base = {
    evidence_verified: true, usage_stage: "used", receipt_id: "r1",
    verified_evidence_refs: [{ id: "e1", version: 2 }],
  };
  assert.equal(contextFeedbackEvidenceCurrent(store as never, base), true);
  assert.equal(contextFeedbackEvidenceCurrent(store as never, { ...base, usage_stage: "verified" }), true);
  for (const bad of [
    { evidence_verified: false }, { usage_stage: "proposed" }, { receipt_id: "" }, { receipt_id: 5 },
    { verified_evidence_refs: [] }, { verified_evidence_refs: "x" },
  ]) {
    assert.equal(contextFeedbackEvidenceCurrent(store as never, { ...base, ...bad }), false);
  }
  assert.equal(contextFeedbackEvidenceCurrent(store as never, { ...base, verified_evidence_refs: [null] }), false);
  assert.equal(contextFeedbackEvidenceCurrent(store as never, { ...base, verified_evidence_refs: [{ id: "e1" }] }), false);
  assert.equal(contextFeedbackEvidenceCurrent(store as never, { ...base, verified_evidence_refs: [{ id: "missing", version: 2 }] }), false);
  assert.equal(contextFeedbackEvidenceCurrent(store as never, { ...base, verified_evidence_refs: [{ id: "e1", version: 1 }] }), false);
});

test("feedback evidence rejects unbound or caller-asserted provenance", () => {
  const base = { evidence_verified: true, usage_stage: "used", receipt_id: "r1", verified_evidence_refs: [{ id: "e1", version: 1 }] };
  for (const evidence of [
    { id: "e1", version: 1, record_origin: "caller_asserted", source_type: "program", confidence: "confirmed", metadata: { context_receipt_id: "r1", verdict: "passed" } },
    { id: "e1", version: 1, record_origin: "program", source_type: "human", confidence: "confirmed", metadata: { context_receipt_id: "r1", verdict: "passed" } },
    { id: "e1", version: 1, record_origin: "program", source_type: "program", confidence: "bounded", metadata: { context_receipt_id: "r1", verdict: "passed" } },
    { id: "e1", version: 1, record_origin: "program", source_type: "program", confidence: "confirmed", metadata: { context_receipt_id: "r2", verdict: "passed" } },
    { id: "e1", version: 1, record_origin: "program", source_type: "program", confidence: "confirmed", metadata: { context_receipt_id: "r1", verdict: "failed" } },
    { id: "e1", version: 1, record_origin: "program", source_type: "program", confidence: "confirmed" },
  ]) {
    const store = fakeStore({}, { "evidence:e1": evidence });
    assert.equal(contextFeedbackEvidenceCurrent(store as never, base), false);
  }
});

test("context feedback weights count unique helpful receipts and pending corrections", () => {
  const receipts: Row[] = [
    { receipt_id: "r1", outcome: "helpful", evidence_verified: true, usage_stage: "used", asset_refs: [{ member: "m", id: "a" }, { member: "m", id: "b" }] },
    { receipt_id: "r1", outcome: "helpful", evidence_verified: true, usage_stage: "used", asset_refs: [{ member: "m", id: "a" }] },
    { receipt_id: "r2", outcome: "helpful", evidence_verified: true, usage_stage: "used", asset_refs: [{ member: "m", id: "a" }, { member: "other", id: "a" }, null, { member: "m", id: 5 }] },
  ];
  const corrections: Row[] = [
    { status: "pending_review", outcome: "incorrect", asset_ref: { member: "m", id: "a" } },
    { status: "confirmed", outcome: "stale", asset_ref: { member: "m", id: "b" } },
    { status: "dismissed", outcome: "stale", asset_ref: { member: "m", id: "a" } },
    { status: "pending_review", outcome: "incorrect", asset_ref: null },
    { status: "pending_review", outcome: "incorrect", asset_ref: { member: "m", id: 5 } },
  ];
  const bound = fakeStore({ context_correction_task: corrections }, {});
  bound.list = (kind: string, _limit?: number, predicate?: (row: Row) => boolean) => {
    const rows = kind === "context_feedback" ? receipts.map(row => ({
      ...row,
      verified_evidence_refs: [{ id: row.receipt_id === "r1" ? "e1" : "e2", version: 1 }],
    })) : corrections;
    return predicate ? rows.filter(row => predicate(row)) : rows;
  };
  bound.find = (kind: string, id: string): Row => kind === "evidence"
    ? { id, version: 1, record_origin: "program", source_type: "program", confidence: "confirmed", metadata: { context_receipt_id: id === "e1" ? "r1" : "r2", verdict: "passed" } }
    : {};
  const weights = contextFeedbackWeights(bound as never, "m", ["a", "b", "c"]);
  assert.equal(weights.size, 3);
  assert.equal(weights.get("a")!.positive, 2);
  assert.equal(weights.get("b")!.positive, 1);
  assert.equal(weights.get("c")!.positive, 0);
  assert.equal(weights.get("a")!.negative, 1);
  assert.equal(weights.get("b")!.negative, 1);
  assert.equal(weights.get("c")!.negative, 0);
  assert.equal(weights.get("a")!.penalty, 0.8);
  assert.equal(weights.get("c")!.penalty, 1);
  assert.equal(contextFeedbackWeights(bound as never, "m", []).size, 0);
});

test("MemorySignalsKernel delegates to the pure signals", () => {
  const kernel = new MemorySignalsKernel({} as never);
  assert.equal(kernel.store, kernel.store);
  assert.equal(kernel.decayWeight({ confirmed_at: "2026-01-01T00:00:00.000Z", now: "2026-01-01T00:00:00.000Z" }), 0.85);
  assert.deepEqual(kernel.rankWithDecay([{ id: "a", base_score: 1, decay: 1 }]).map(item => item.id), ["a"]);
  assert.equal(kernel.shouldPropose({ signals: ["durable_value"] }).propose, true);
  assert.equal(kernel.planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m", content: "x" }).kind, "fact");
  assert.equal(kernel.hybridScores([{ id: "a", similarity: null, keyword_score: 1 }], { vectorEligible: false }).length, 1);
  assert.equal(kernel.usageEvidence({ memory_ids: ["m"], outcome: "succeeded", turn_id: "t" }).counted_as_use, true);
});
