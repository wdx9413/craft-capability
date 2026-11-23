import assert from "node:assert/strict";
import test from "node:test";
import { verdictFromRunReport, requireVerified } from "../external-verifier.ts";

test("all-passing complete run yields verified true", () => {
  const report = { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
  const verdict = verdictFromRunReport(report, "run-abc");
  assert.equal(verdict.verified, true);
  assert.equal(verdict.evidence_ref, "run-abc");
  assert.equal(verdict.verifier, "craft-eval");
  assert.ok(verdict.at);
});

test("any failed case yields verified false", () => {
  const report = { passed: 4, failed: 1, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-x").verified, false);
});

test("inconclusive yields verified false", () => {
  const report = { passed: 5, failed: 0, inconclusive: 1, invalid: 0, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-y").verified, false);
});

test("invalid yields verified false", () => {
  const report = { passed: 5, failed: 0, inconclusive: 0, invalid: 1, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-z").verified, false);
});

test("missing yields verified false", () => {
  const report = { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 1, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-w").verified, false);
});

test("non-complete status yields verified false", () => {
  const report = { passed: 5, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "incomplete" };
  assert.equal(verdictFromRunReport(report, "run-v").verified, false);
});

test("zero passed yields verified false", () => {
  const report = { passed: 0, failed: 0, inconclusive: 0, invalid: 0, missing: 0, status: "complete" };
  assert.equal(verdictFromRunReport(report, "run-u").verified, false);
});

test("requireVerified throws on unverified", () => {
  const verdict = { verified: false, evidence_ref: "run-bad", verifier: "craft-eval", at: new Date().toISOString() };
  assert.throws(() => requireVerified(verdict), /external verifier returned unverified outcome/);
});

test("requireVerified passes through verified", () => {
  const verdict = { verified: true, evidence_ref: "run-good", verifier: "craft-eval", at: new Date().toISOString() };
  assert.equal(requireVerified(verdict).verified, true);
});
