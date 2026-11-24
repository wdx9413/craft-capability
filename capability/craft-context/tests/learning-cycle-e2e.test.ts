import assert from "node:assert/strict";
import test from "node:test";
import { bridgeVerifiedOutcome, isDurableCandidate } from "../learning-cycle-bridge.ts";

const passingReport = { expected: 3, recorded: 3, passed: 3, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };

test("a caller-supplied passing report alone cannot claim durable self-evolution admission", () => {
  const outcome = bridgeVerifiedOutcome({ runReport: passingReport, evidenceRef: "run:caller-supplied",
    statement: "先验证后沉淀修复步骤", domain: "coding", scope: { kind: "project", id: "project:example" } });
  assert.equal(outcome.verdict.report_passed, true, "the pure report predicate only describes report counts");
  assert.equal(outcome.permitted, false, "the runtime must supply an explicit local path policy");
  assert.equal(outcome.candidateEligible, false, "this pure adapter has no persistence port");
  assert.equal(isDurableCandidate(outcome.decision), false, "unpermitted input must not be treated as a durable candidate");
});

test("failed and incomplete reports are diagnostic only", () => {
  for (const runReport of [
    { ...passingReport, failed: 1, passed: 2 },
    { ...passingReport, status: "incomplete" },
    { ...passingReport, recorded: 2 },
    { ...passingReport, not_applicable: 1 },
  ]) {
    const outcome = bridgeVerifiedOutcome({ runReport, evidenceRef: "run:diagnostic", statement: "先验证后沉淀修复步骤" });
    assert.equal(outcome.verdict.report_passed, false);
    assert.equal(outcome.candidateEligible, false);
    assert.equal(isDurableCandidate(outcome.decision), false);
  }
});
