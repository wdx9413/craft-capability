import type { JsonObject } from 'craft-common-store-local/store';
import { evaluateEvolutionValue, type EvolutionValueDecision } from 'craft-common-ontology';
import type { CraftEvalRunReport, ExternalVerdict } from './external-verifier.ts';
import { verdictFromRunReport } from './external-verifier.ts';
import { decidePermission, DEFAULT_PERMISSION_MODEL } from './permission-boundary.ts';

/** Bridge from external verification verdicts to craft-context self-evolution state.
 *
 * craft-context itself stays read-only; this bridge converts an external verifier's
 * verified verdict into the statement/evidence/verification inputs that the
 * Evolution Value Gate and Experience lifecycle consume, so a verified outcome
 * can flow back into the learning loop without the plugin executing code itself.
 */

export interface BridgeInput {
  readonly runReport: CraftEvalRunReport;
  readonly evidenceRef: string;
  readonly statement: string;
  readonly domain?: string;
  readonly scope?: JsonObject;
  readonly sourceKind?: string;
  readonly explicit?: boolean;
}

export interface BridgeOutcome {
  readonly verdict: ExternalVerdict;
  readonly decision: EvolutionValueDecision;
  readonly permitted: boolean;
  readonly bridgeable: boolean;
  readonly reason: string;
}

/** Convert a craft-eval run report into a self-evolution candidate input.
 *
 * Only a verified verdict is bridgeable; unverified verdicts are recorded as
 * diagnostic-only and never become durable facts or procedure candidates.
 */
export function bridgeVerifiedOutcome(input: BridgeInput): BridgeOutcome {
  const { runReport, evidenceRef, statement, domain, scope, sourceKind, explicit } = input;

  const verdict = verdictFromRunReport(runReport, evidenceRef);
  const permitted = decidePermission(DEFAULT_PERMISSION_MODEL, 'experience', 'self-evolution', 'write')
    .allowed;

  if (!verdict.verified || !permitted) {
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
      reason: verdict.verified ? 'permission denied' : 'outcome not verified',
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

  return {
    verdict,
    decision,
    permitted: true,
    bridgeable: true,
    reason: 'verified outcome bridged to self-evolution',
  };
}

/** Whether a value gate decision should become a durable Experience candidate. */
export function isDurableCandidate(decision: EvolutionValueDecision): boolean {
  return decision.action === 'candidate_procedure' || decision.action === 'candidate_mod';
}
