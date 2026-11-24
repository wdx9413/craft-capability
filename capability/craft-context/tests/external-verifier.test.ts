import assert from "node:assert/strict";
import test from "node:test";
import { verdictFromRunReport, requirePassingReport, requireVerified } from "../external-verifier.ts";

test("count-valid complete report passes the report criteria", () => {
  const report = { expected: 5, recorded: 5, passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
  const verdict = verdictFromRunReport(report, "run-abc");
  assert.equal(verdict.report_passed, true);
  assert.equal(verdict.verified, true, "the previous verified field remains available as an alias");
  assert.equal(verdict.evidence_ref, "run-abc");
  assert.equal(verdict.verifier, "craft-eval");
  assert.ok(verdict.at);
});

test("any failed case makes the report ineligible", () => {
  const report = { expected: 5, recorded: 5, passed: 4, failed: 1, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-x").report_passed, false);
});

test("inconclusive cases make the report ineligible", () => {
  const report = { expected: 5, recorded: 5, passed: 5, failed: 0, inconclusive: 1, invalid: 0, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-y").report_passed, false);
});

test("invalid cases make the report ineligible", () => {
  const report = { expected: 5, recorded: 5, passed: 5, failed: 0, inconclusive: 0, invalid: 1, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-z").report_passed, false);
});

test("missing cases make the report ineligible", () => {
  const report = { expected: 5, recorded: 4, passed: 4, failed: 0, inconclusive: 0, invalid: 0, missing: 1, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-w").report_passed, false);
});

test("non-complete status makes the report ineligible", () => {
  const report = { expected: 5, recorded: 5, passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "incomplete" };
  assert.equal(verdictFromRunReport(report, "run-v").report_passed, false);
});

test("a zero-case report is ineligible", () => {
  const report = { expected: 0, recorded: 0, passed: 0, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-u").report_passed, false);
});

test("requirePassingReport throws on a report that does not pass", () => {
  const verdict = { verified: false, report_passed: false, evidence_ref: "run-bad", verifier: "craft-eval", at: new Date().toISOString() };
  assert.throws(() => requirePassingReport(verdict), /evaluation report did not pass/);
});

test("malformed or legacy reports are rejected distinctly from a completed failing run", () => {
  assert.throws(() => verdictFromRunReport({ passed: 3, failed: 0, status: "complete" } as never, "run-old"), /report is malformed/u);
  assert.throws(() => verdictFromRunReport({ expected: 2, recorded: "2", passed: 2, failed: 0, inconclusive: 0,
    invalid: 0, missing: 0, status: "complete" } as never, "run-invalid"), /report is malformed/u);
  assert.throws(() => verdictFromRunReport(null as never, "run-null"), /report is malformed/u);
  assert.throws(() => verdictFromRunReport([] as never, "run-array"), /report is malformed/u);
  assert.throws(() => verdictFromRunReport({ expected: 2, recorded: 2, passed: 2, failed: 0, inconclusive: 0,
    invalid: 0, missing: 0, not_applicable: -1, status: "complete" } as never, "run-invalid-na"), /report is malformed/u);
  assert.throws(() => verdictFromRunReport({ expected: 2, recorded: 2, passed: 2, failed: 0, inconclusive: 0,
    invalid: 0, missing: 0, status: 42 } as never, "run-invalid-status"), /report is malformed/u);
});

test("requirePassingReport passes through a count-valid report", () => {
  const verdict = { verified: true, report_passed: true, evidence_ref: "run-good", verifier: "craft-eval", at: new Date().toISOString() };
  assert.equal(requirePassingReport(verdict).report_passed, true);
  assert.equal(requireVerified(verdict).verified, true, "the previous requireVerified export remains available");
});

test("deprecated requireVerified keeps rejecting an unverified legacy verdict", () => {
  assert.throws(() => requireVerified({ verified: false, evidence_ref: "run-bad", verifier: "craft-eval", at: "now" }), /unverified outcome/u);
});
