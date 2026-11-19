import assert from "node:assert/strict";
import test from "node:test";
import {
  hybridMemoryScores,
  memoryDecayWeight,
  memoryUsageEvidence,
  planLegacyPromotion,
  rankWithDecay,
  shouldProposeMemory,
} from "../memory-signals.ts";

test("decay weight follows recency, usage, trust and the floor", () => {
  const now = "2026-01-01T00:00:00.000Z";
  const fresh = memoryDecayWeight({ confirmed_at: now, now });
  assert.equal(fresh, 0.85);
  const older = memoryDecayWeight({ confirmed_at: "2025-10-03T00:00:00.000Z", now });
  assert(older < fresh && older > 0.01);
  const used = memoryDecayWeight({ confirmed_at: now, now, accesses: 3 });
  assert(used > fresh);
  const capped = memoryDecayWeight({ confirmed_at: now, now, accesses: 100 });
  assert.equal(capped, Number((0.85 * (1 + 10 * 0.15)).toFixed(6)));
  const verified = memoryDecayWeight({ confirmed_at: now, now, trust: "verified" });
  const bounded = memoryDecayWeight({ confirmed_at: now, now, trust: "bounded" });
  assert(verified > bounded);
  const ancient = memoryDecayWeight({ confirmed_at: "1990-01-01T00:00:00.000Z", now });
  assert.equal(ancient, 0.01);
  const future = memoryDecayWeight({ confirmed_at: "2030-01-01T00:00:00.000Z", now });
  assert.equal(future, 0.85);
  assert.throws(() => memoryDecayWeight({ confirmed_at: "nope", now }), /ISO timestamp/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: now, now: "nope" }), /ISO timestamp/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: now, now, accesses: -1 }), /non-negative integer/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: now, now, accesses: 1.5 }), /non-negative integer/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: now, now, trust: "unknown" }), /verified or bounded/u);
  assert.throws(() => memoryDecayWeight({ confirmed_at: "", now }), /confirmed_at/u);
});

test("rankWithDecay orders by score, demotes superseded facts and stays deterministic", () => {
  const ranked = rankWithDecay([
    { id: "b", base_score: 1, decay: 0.5 },
    { id: "a", base_score: 1, decay: 0.5 },
    { id: "c", base_score: 2, decay: 1, superseded: true },
  ]);
  assert.deepEqual(ranked.map(item => item.id), ["a", "b", "c"]);
  assert.equal(ranked[2]!.score, Number((2 * 1 * 0.05).toFixed(6)));
  assert.equal(ranked[0]!.superseded, undefined);
  assert.equal(rankWithDecay([]).length, 0);
});

test("capture policy proposes only for noteworthy turns", () => {
  assert.deepEqual(shouldProposeMemory({ signals: [], succeeded: true }), { propose: false, reasons: [], policy: "review_by_exception" });
  assert.deepEqual(shouldProposeMemory({ signals: ["durable_value"], succeeded: true }).reasons, ["durable_value"]);
  assert.deepEqual(shouldProposeMemory({ signals: ["user_correction"], succeeded: true }).reasons, ["user_correction"]);
  assert.deepEqual(shouldProposeMemory({ signals: ["decision_made"], succeeded: true }).reasons, ["decision_made"]);
  assert.deepEqual(shouldProposeMemory({ signals: ["needs_execution"], succeeded: true }).reasons, ["needs_execution_automatic"]);
  assert.deepEqual(shouldProposeMemory({ signals: [], succeeded: true, corrections: 2 }).reasons, ["corrections_2"]);
  assert.deepEqual(shouldProposeMemory({ signals: [], succeeded: true, retries: 3 }).reasons, ["retries_3"]);
  assert.deepEqual(shouldProposeMemory({ signals: [], succeeded: true, novel: true }).reasons, ["novel_situation"]);
  assert.deepEqual(shouldProposeMemory({ signals: ["other"], succeeded: true }).reasons, []);
  assert.deepEqual(shouldProposeMemory({ signals: ["durable_value"], succeeded: true, mode: "strict" }), {
    propose: true, reasons: ["durable_value"], policy: "strict",
  });
  assert.deepEqual(shouldProposeMemory({ signals: ["other"], succeeded: true, mode: "strict" }), {
    propose: false, reasons: [], policy: "strict",
  });
  assert.throws(() => shouldProposeMemory({ signals: ["ok"], corrections: -1 }), /non-negative integer/u);
  assert.throws(() => shouldProposeMemory({ signals: ["ok"], retries: 1.5 }), /non-negative integer/u);
  assert.throws(() => shouldProposeMemory({ signals: ["ok"], mode: "unknown" }), /unsupported/u);
  assert.throws(() => shouldProposeMemory({ signals: [5] }), /signal/u);
  assert.deepEqual(shouldProposeMemory({ signals: "not-an-array", succeeded: true }), { propose: false, reasons: [], policy: "review_by_exception" });
});

test("legacy promotion plans a governed candidate without migrating", () => {
  const plan = planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m1", content: "prefers dark mode" });
  assert.equal(plan.kind, "fact");
  assert.equal(plan.sensitivity, "internal");
  assert.equal(plan.migration_performed, false);
  assert.equal(plan.requires_approval, true);
  assert.equal(plan.requires_source, true);
  assert.equal(plan.downgrade_policy, "reference_only_until_approved");
  assert.match(String(plan.promotion_id), /^promotion_/u);
  assert.match(String(plan.content_digest), /^sha256:/u);
  assert.equal(planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m1", content: "x", kind: "preference" }).kind, "preference");
  assert.equal(planLegacyPromotion({ legacy_kind: "episodic_memory", legacy_id: "m1", content: "x" }).kind, "experience");
  assert.equal(planLegacyPromotion({ legacy_kind: "episodic_memory", legacy_id: "m1", content: "x" }).sensitivity, "restricted");
  assert.equal(planLegacyPromotion({ legacy_kind: "semantic_memory", legacy_id: "m1", content: "x" }).kind, "fact");
  assert.equal(planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m1", content: "x", scope: "project" }).scope, "project");
  assert.equal(planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m1", content: "x", legacy_version: 3 }).legacy_version, 3);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "other", legacy_id: "m", content: "c" }), /unsupported/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "", content: "c" }), /legacy_id/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m", content: "" }), /content/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m", content: "c", scope: "galaxy" }), /unsupported/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m", content: "c", legacy_version: 0 }), /positive integer/u);
  assert.throws(() => planLegacyPromotion({ legacy_kind: "memory_item", legacy_id: "m", content: "c", kind: "mystery" }), /unsupported/u);
});

test("hybrid scoring fuses keyword and vector rankings", () => {
  const keywordOnly = hybridMemoryScores([
    { id: "a", similarity: null, keyword_score: 2 },
    { id: "b", similarity: null, keyword_score: 0 },
  ], { vectorEligible: false });
  assert.deepEqual(keywordOnly, [{ id: "a", score: 2, retrieval_mode: "keyword" }]);
  const fused = hybridMemoryScores([
    { id: "a", similarity: 0.9, keyword_score: 1 },
    { id: "b", similarity: null, keyword_score: 1 },
  ], { vectorEligible: true, k: 1 });
  assert.equal(fused.length, 2);
  assert(fused.every(item => item.retrieval_mode === "vector+keyword"));
  assert.equal(fused[0]!.id, "a");
  assert.throws(() => hybridMemoryScores([], { vectorEligible: true, k: 0 }), /positive number/u);
  assert.throws(() => hybridMemoryScores([], { vectorEligible: true, k: Number.NaN }), /positive number/u);
  const tie = hybridMemoryScores([
    { id: "b", similarity: 0.5, keyword_score: 0 },
    { id: "a", similarity: 0.5, keyword_score: 0 },
  ], { vectorEligible: true });
  assert.deepEqual(tie.map(item => item.id), ["a", "b"]);
  const keywordTie = hybridMemoryScores([
    { id: "b", similarity: null, keyword_score: 1 },
    { id: "a", similarity: null, keyword_score: 1 },
  ], { vectorEligible: false });
  assert.deepEqual(keywordTie.map(item => item.id), ["a", "b"]);
  const vectorTie = hybridMemoryScores([
    { id: "b", similarity: 0.5, keyword_score: 1 },
    { id: "a", similarity: 0.5, keyword_score: 1 },
  ], { vectorEligible: true });
  assert.deepEqual(vectorTie.map(item => item.id), ["a", "b"]);
  const equalScore = hybridMemoryScores([
    { id: "b", similarity: 0.5, keyword_score: 0 },
    { id: "a", similarity: null, keyword_score: 1 },
  ], { vectorEligible: true });
  assert.deepEqual(equalScore.map(item => item.id), ["a", "b"]);
});

test("usage evidence counts only successful turns", () => {
  const success = memoryUsageEvidence({ memory_ids: ["m1"], outcome: "succeeded", turn_id: "t1" });
  assert.equal(success.counted_as_use, true);
  assert.deepEqual(success.access_deltas, [{ memory_id: "m1", delta: 1 }]);
  assert.equal(success.receipt_id, null);
  assert.equal(success.content_free, true);
  const failure = memoryUsageEvidence({ memory_ids: ["m1", "m2"], outcome: "failed", turn_id: "t1", receipt_id: "r1" });
  assert.equal(failure.counted_as_use, false);
  assert.deepEqual(failure.access_deltas, [{ memory_id: "m1", delta: 0 }, { memory_id: "m2", delta: 0 }]);
  assert.equal(failure.receipt_id, "r1");
  assert.throws(() => memoryUsageEvidence({ memory_ids: [], outcome: "succeeded", turn_id: "t" }), /must not be empty/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: ["m1", "m1"], outcome: "succeeded", turn_id: "t" }), /unique/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: ["m1"], outcome: "unknown", turn_id: "t" }), /unsupported/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: ["m1"], outcome: "succeeded", turn_id: "" }), /turn_id/u);
  assert.throws(() => memoryUsageEvidence({ memory_ids: "nope", outcome: "succeeded", turn_id: "t" }), /must not be empty/u);
});
