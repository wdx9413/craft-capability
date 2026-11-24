import type { JsonObject } from 'craft-common-store-local/store';
import { evaluateEvolutionValue, type EvolutionValueDecision } from 'craft-common-ontology';
import type { CraftEvalRunReport, CountBoundedExternalVerdict } from './external-verifier.ts';
import { verdictFromRunReport } from './external-verifier.ts';
import { decidePermission, DEFAULT_PERMISSION_MODEL, type PermissionModel } from './permission-boundary.ts';

/** Pure Value Gate adapter for a report already obtained by an owning runtime.
 * It does not authenticate a caller-supplied report or persist an Experience candidate.
 */

export interface BridgeInput {
  readonly runReport: CraftEvalRunReport;
  readonly evidenceRef: string;
  readonly statement: string;
  readonly domain?: string;
  readonly scope?: JsonObject;
  readonly sourceKind?: string;
  readonly explicit?: boolean;
  /** A canonical local persistence target, supplied by the owning runtime. */
  readonly permissionTarget?: string;
  /** Runtime-resolved roots. The static default intentionally grants no path access. */
  readonly permissionModel?: PermissionModel;
}

export interface BridgeOutcome {
  readonly verdict: CountBoundedExternalVerdict;
  readonly decision: EvolutionValueDecision;
  readonly permitted: boolean;
  /** @deprecated Use candidateEligible to distinguish a durable candidate from a passing report. */
  readonly bridgeable: boolean;
  readonly candidateEligible: boolean;
  readonly reason: string;
}

/** Convert report counts into a Value Gate decision; persistence is an owner responsibility. */
export function bridgeVerifiedOutcome(input: BridgeInput): BridgeOutcome {
  const { runReport, evidenceRef, statement, domain, scope, sourceKind, explicit } = input;

  const verdict = verdictFromRunReport(runReport, evidenceRef);
  const permissionModel = input.permissionModel ?? DEFAULT_PERMISSION_MODEL;
  const permissionTarget = input.permissionTarget ?? '';
  const permitted = permissionTarget.length > 0
    && decidePermission(permissionModel, 'experience', permissionTarget, 'write').allowed;

  if (!verdict.report_passed || !permitted) {
    return {
      verdict,
      decision: evaluateEvolutionValue({
        statement,
        source_kind: sourceKind ?? 'external-verifier',
        verification: 'failed',
        evidence_ids: [{ id: evidenceRef }],
        explicit: explicit ?? false,
        domain,
        scope,
      }),
      permitted,
      bridgeable: false,
      candidateEligible: false,
      reason: !verdict.report_passed ? 'report did not pass' : !permissionTarget ? 'no permission target supplied' : 'permission denied',
    };
  }

  const decision = evaluateEvolutionValue({
    statement,
    source_kind: sourceKind ?? 'external-verifier',
    verification: 'passed',
    evidence_ids: [{ id: evidenceRef }],
    explicit: explicit ?? false,
    domain,
    scope,
  });

  const durable = isDurableCandidate(decision);
  return {
    verdict,
    decision,
    permitted: true,
    bridgeable: true,
    candidateEligible: durable,
    reason: durable ? 'verified candidate is eligible for the owning persistence path' : 'value gate did not produce a durable candidate',
  };
}

/** Whether a value gate decision should become a durable Experience candidate. */
export function isDurableCandidate(decision: EvolutionValueDecision): boolean {
  return decision.action === 'candidate_procedure' || decision.action === 'candidate_mod';
}
