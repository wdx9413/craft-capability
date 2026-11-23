import assert from "node:assert/strict";
import test from "node:test";
import { bridgeVerifiedOutcome, isDurableCandidate } from "../learning-cycle-bridge.ts";

function fullPassReport(): ReturnType<typeof bridgeVerifiedOutcome>["verdict"] {
  return { verified: true, evidence_ref: "run-ok", verifier: "craft-eval", at: new Date().toISOString() };
}

test("verified run bridges to self-evolution candidate", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-ok",
    statement: "retry on timeout with backoff",
    domain: "coding",
    explicit: true,
  });
  assert.equal(outcome.verdict.verified, true);
  assert.equal(outcome.permitted, true);
  assert.equal(outcome.bridgeable, true);
  assert.equal(outcome.reason, "verified outcome bridged to self-evolution");
});

test("failed run does not bridge", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 4, failed: 1, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-bad",
    statement: "retry on timeout with backoff",
    domain: "coding",
  });
  assert.equal(outcome.verdict.verified, false);
  assert.equal(outcome.bridgeable, false);
  assert.equal(outcome.reason, "outcome not verified");
});

test("incomplete run does not bridge", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "incomplete" },
    evidenceRef: "run-inc",
    statement: "retry on timeout with backoff",
  });
  assert.equal(outcome.bridgeable, false);
});

test("zero passed run does not bridge", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 0, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-zero",
    statement: "retry on timeout with backoff",
  });
  assert.equal(outcome.bridgeable, false);
});

test("operating steps with verification become candidate_procedure", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-steps",
    statement: "先安装依赖再运行测试",
    domain: "coding",
  });
  assert.equal(outcome.decision.action, "candidate_procedure");
  assert.ok(isDurableCandidate(outcome.decision));
});

test("rule statement becomes store_as_fact", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-rule",
    statement: "本项目约定：使用 pnpm",
    domain: "coding",
  });
  assert.equal(outcome.decision.action, "store_as_fact");
  assert.equal(isDurableCandidate(outcome.decision), false);
});

test("ordinary task text is ignored even when verified", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-ordinary",
    statement: "hello world",
  });
  assert.equal(outcome.decision.action, "ignore");
  assert.equal(outcome.bridgeable, true);
});

test("secret statement is rejected even when verified", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-secret",
    statement: "api_key = {{SECRET_ab12cd34}}",
  });
  assert.equal(outcome.decision.action, "ignore");
  assert.equal(outcome.decision.reason, "credential or placeholder rejected");
});

test("scope is carried into the gate decision", () => {
  const scope = { kind: "project", id: "repo-1" };
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run-scoped",
    statement: "use pnpm",
    domain: "coding",
    scope,
  });
  assert.equal(outcome.decision.scope.domain, "coding");
  assert.deepEqual(outcome.decision.scope, { kind: "project", id: "repo-1", domain: "coding" });
});

test("isDurableCandidate returns true only for procedure/mod candidates", () => {
  assert.equal(isDurableCandidate({ action: "candidate_procedure", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), true);
  assert.equal(isDurableCandidate({ action: "candidate_mod", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), true);
  assert.equal(isDurableCandidate({ action: "store_as_fact", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), false);
  assert.equal(isDurableCandidate({ action: "ignore", reason: "x", digest: "d", scope: {}, note_refs: [], source_refs: [], gate_version: "v" }), false);
});
