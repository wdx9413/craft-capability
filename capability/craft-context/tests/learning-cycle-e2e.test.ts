import assert from "node:assert/strict";
import test from "node:test";
import { bridgeVerifiedOutcome, isDurableCandidate } from "../learning-cycle-bridge.ts";

test("end-to-end: craft-eval coding held-out run (5/5 passed) bridges to a procedure candidate", () => {
  // Numbers mirror the actual run of examples/craft-context-coding: expected=5,
  // recorded=5, passed=5, failed=0, inconclusive=0, invalid=0, missing=0, status=complete.
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run:8aaf9943591d42339379a24a1e5fa81a:craft-context-coding-heldout",
    statement: "先运行 craft-eval coding held-out，再按 grade.mjs 判据验证，通过后将修复步骤作为 Procedure 候选",
    domain: "coding",
    scope: { kind: "project", id: "project:craft-context" },
  });

  assert.equal(outcome.verdict.verified, true, "craft-eval 5/5 complete run must verify");
  assert.equal(outcome.bridgeable, true, "verified outcome must be bridgeable into learning loop");
  assert.equal(outcome.decision.action, "candidate_procedure", "operating steps with verified evidence must become a procedure candidate");
  assert.ok(isDurableCandidate(outcome.decision));
  assert.deepEqual(outcome.decision.source_refs, [{ id: "run:8aaf9943591d42339379a24a1e5fa81a:craft-context-coding-heldout" }]);
  assert.equal(outcome.decision.scope.domain, "coding");
});

test("end-to-end: a failed held-out run never produces a durable candidate", () => {
  const outcome = bridgeVerifiedOutcome({
    runReport: { passed: 4, failed: 1, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
    evidenceRef: "run:failed:craft-context-coding-heldout",
    statement: "先运行 craft-eval coding held-out，再按 grade.mjs 判据验证，通过后将修复步骤作为 Procedure 候选",
    domain: "coding",
  });

  assert.equal(outcome.verdict.verified, false);
  assert.equal(outcome.bridgeable, false);
  assert.equal(outcome.reason, "outcome not verified");
  assert.equal(isDurableCandidate(outcome.decision), false, "unverified outcome must not become a durable candidate");
});

test("end-to-end: five domain suites each verify and bridge independently", () => {
  const domains = ["coding", "office", "travel", "creation", "research"];
  for (const domain of domains) {
    const outcome = bridgeVerifiedOutcome({
      runReport: { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" },
      evidenceRef: `run:craft-context-${domain}-heldout`,
      statement: "先运行 held-out suite 验证，通过后沉淀为本领域的 Procedure 候选",
      domain,
      scope: { kind: "project", id: `project:${domain}` },
    });
    assert.equal(outcome.verdict.verified, true, `${domain} suite must verify`);
    assert.equal(outcome.bridgeable, true, `${domain} verified outcome must bridge`);
    assert.equal(outcome.decision.scope.domain, domain);
  }
});
