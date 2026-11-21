import type { JsonObject } from 'craft-common-store-local/store';
import { randomUUID } from 'node:crypto';
import { digestJson } from 'craft-common-base/digest';
import { text } from 'craft-common-base/validation';
import { sessionStorageScopeId } from 'craft-common-store-local/paths';
import { mapLegacyKind, validateConcept } from 'craft-common-ontology/validation';
import type { MemoryGovernanceKernel } from "./memory-governance.ts";
import { SharedPromotionEvidenceError } from "./memory-ledger.ts";
import { legacyFieldAbsent } from "./memory-legacy-field.ts";
import { globalPromotionContentDecision } from "./global-promotion-gate.ts";

/** The host supplies Evidence/source ports; this package never imports a harness. */
export class MemoryCapture {
  readonly memory: MemoryGovernanceKernel;
  readonly bootstrap: () => unknown;
  readonly evidenceRecord: (args: JsonObject) => JsonObject;
  constructor(memory: MemoryGovernanceKernel, bootstrap: () => unknown, evidenceRecord: (args: JsonObject) => JsonObject) { this.memory = memory; this.bootstrap = bootstrap; this.evidenceRecord = evidenceRecord; }
  private proposePromotion(args: JsonObject): JsonObject {
    try { return this.memory.propose(args); }
    catch (error) {
      if (error instanceof SharedPromotionEvidenceError) return { status: "insufficient_independence", auto_committed: false, reason: "shared_evidence" };
      throw error;
    }
  }
  captureUserStatement(args: JsonObject): JsonObject { return this.capture(args, "explicit-user-statement"); }

  /** Host-classified facts enter the session tier and promote through the governed repeat thresholds. */
  captureObservedFact(args: JsonObject): JsonObject {
    const sessionId = text(args.session_id, "session_id");
    const projectScopeId = text(args.project_scope_id, "project_scope_id");
    if (args.scope_kind !== undefined && args.scope_kind !== "session") throw new Error("observed Memory facts must start in session scope");
    if (args.scope_id !== undefined && text(args.scope_id, "scope_id") !== sessionId) throw new Error("scope_id must match session_id");
    return this.capture({ ...args, scope_kind: "session", scope_id: sessionId, project_scope_id: projectScopeId }, "host-observed-stable-fact");
  }

  private capture(args: JsonObject, proposedBy: string): JsonObject {
    if (typeof args.content !== "string" || !args.content.trim()) throw new Error("content must not be empty");
    const content = args.content;
    if (/(?:api[_-]?key|authorization|cookie|password|secret|token)["']?\s*[:=]\s*[^\s]+/iu.test(content)) throw new Error("content must not contain sensitive assignments");
    const kind = String(args.kind ?? "preference");
    if (!new Set(["working", "episodic", "preference", "procedural"]).has(kind)) throw new Error("Memory capture kind is unsupported");
    // Memory records share the ontology's readability contract: one clean
    // sentence per record, no filler phrases, no 300-character prose dumps.
    // The shared taxonomy names concepts (fact/rule/...), while Memory still
    // names its own tiers (working/episodic/preference/procedural), so the
    // legacy table owns the translation — the same way Knowledge does it.
    validateConcept(mapLegacyKind("memory", kind), content);
    const scopeKind = text(args.scope_kind ?? (args.session_id ? "session" : "user"), "scope_kind");
    const rawScopeId = text(args.scope_id ?? (scopeKind === "session" ? args.session_id : scopeKind === "global" ? "global" : "local"), "scope_id");
    const sessionHost = scopeKind === "session" && args.session_host !== undefined ? text(args.session_host, "session_host") : undefined;
    if (sessionHost) {
      const sessionId = text(args.session_id, "session_id");
      this.memory.store.bindSessionStorageHost(sessionId, sessionHost);
    }
    const scopeId = sessionHost ? sessionStorageScopeId(sessionHost, rawScopeId) : rawScopeId;
    if (scopeKind === "session" && this.memory.ledger.files.isSessionArchived(scopeId)) {
      return { candidate: null, conflicts: [], auto_committed: false, status: "archived", next_action: "session_archive_is_terminal" };
    }
    const topic = args.topic === undefined ? undefined : text(args.topic, "topic");
    const policy = this.memory.policyGet().policy as JsonObject;
    // Disabled capture is a read-only decision, not a partial source/Evidence write.
    if (policy.mode === "off") return { candidate: null, conflicts: [], auto_committed: false, status: "disabled", policy, next_action: "memory_disabled" };
    const hints = topic === undefined && kind === "preference" ? (this.memory.topicSuggestions({ ...args, content, scope_kind: scopeKind, scope_id: scopeId }).suggestions as JsonObject[]).filter(hint => hint.content_digest !== digestJson(content)) : [];
    this.bootstrap();
    const captureIdentity = { kind, scope_kind: scopeKind, scope_id: scopeId, project_scope_id: args.project_scope_id ?? null, topic: topic ?? null, content_digest: digestJson(content) };
    const suffix = digestJson(captureIdentity).slice(-20);
    const explicit = proposedBy === "explicit-user-statement";
    const evidenceInput = { evidence_id: String(args.evidence_id ?? `evidence_memory_statement_${suffix}`), source_type: explicit ? "human" : "host_observed_fact", confidence: "bounded",
      claim: explicit ? "User-authored statement captured for governed Memory." : "Host-classified stable fact captured for governed Memory.",
      locator: `memory-capture:${scopeKind}:${scopeId}`, metadata: { capture_digest: digestJson(captureIdentity), user_authored: explicit, capture_mode: proposedBy } };
    const evidence = this.memory.store.transaction(() => {
      const existingEvidence = this.memory.store.find("evidence", evidenceInput.evidence_id);
      if (existingEvidence && (existingEvidence.source_type !== evidenceInput.source_type || existingEvidence.confidence !== evidenceInput.confidence
        || existingEvidence.claim !== evidenceInput.claim || existingEvidence.locator !== evidenceInput.locator
        || digestJson(existingEvidence.metadata) !== digestJson(evidenceInput.metadata))) throw new Error("Memory capture evidence idempotency conflict");
      return existingEvidence ?? this.evidenceRecord(evidenceInput);
    });
    const proposed = this.memory.propose({ candidate_id: String(args.candidate_id ?? `memory_candidate_statement_${suffix}`), source_id: "builtin.evidence-wiki", kind,
      scope_kind: scopeKind, scope_id: scopeId, ...(args.scope_envelope === undefined ? {} : { scope_envelope: args.scope_envelope }), ...(topic === undefined ? {} : { topic }), content, sensitivity: args.sensitivity ?? "internal", confidence: "bounded",
      proposal_only: hints.length > 0, evidence_ids: [evidence.id], proposed_by: proposedBy, valid_until: args.valid_until,
      ...(args.memory_id === undefined ? {} : { memory_id: args.memory_id }) });
    if (scopeKind === "session" && args.project_scope_id) {
      const intentId = `memory_observation_intent_${suffix}`;
      const intent = {
        scope: { kind: "session", id: scopeId }, project_id: text(args.project_scope_id, "project_scope_id"), capture_digest: digestJson(captureIdentity),
        candidate_id: String(args.candidate_id ?? `memory_candidate_statement_${suffix}`), content_digest: digestJson(content), kind, topic: topic ?? "", capture_topic: topic ?? null, evidence_id: evidence.id, evidence_version: evidence.version, content_free: true,
        promotion_status: "pending",
      };
      const existing = this.memory.store.find("memory_observation_intent", intentId);
      if (existing && existing.evidence_version === undefined && !legacyFieldAbsent(this.memory.store, "memory_observation_intent", existing, "evidence_version")) throw new Error("Memory observation intent evidence version was removed");
      if (existing && Object.entries(intent).some(([key, value]) => key !== "promotion_status" && !(key === "evidence_version" && existing[key] === undefined) && digestJson(existing[key]) !== digestJson(value))) throw new Error("Memory observation intent idempotency conflict");
      if (!existing) this.memory.store.create("memory_observation_intent", intentId, intent);
      const jobId = this.observationPromotionJobId(intentId);
      const jobIdentity = { intent_id: intentId, candidate_id: intent.candidate_id, project_id: intent.project_id,
        session_scope_id: scopeId, capture_digest: intent.capture_digest, status: "pending", content_free: true };
      const existingJob = this.memory.store.find("memory_observation_promotion", jobId);
      if (existingJob && Object.entries(jobIdentity).some(([key, value]) => key !== "status" && digestJson(existingJob[key]) !== digestJson(value))) throw new Error("Memory promotion job idempotency conflict");
      if (!existingJob) this.memory.store.create("memory_observation_promotion", jobId, jobIdentity);
    }
    const retainedCandidate = proposed.candidate as JsonObject;
    if (proposed.idempotent === true && retainedCandidate.ledger_memory_id) {
      const retained = this.memory.ledger.get({ ...args, scope_kind: scopeKind, scope_id: scopeId, memory_id: retainedCandidate.ledger_memory_id }).memory as JsonObject;
      if (retained.status === "active") {
        return { ...proposed, memory: retained, evidence, promotions: [], already_retained: true, auto_committed: false,
          next_action: scopeKind === "session" && Boolean(args.project_scope_id) ? "memory_promotion_queued" : "available_for_scoped_context" };
      }
    }
    if (hints.length > 0) return { ...proposed, evidence, topic_suggestions: hints, auto_committed: false, next_action: "confirm_topic_or_explicit_replacement" };
    // Governed policy can already approve and commit; neither deny that fact nor commit twice.
    if (proposed.auto_committed === true) {
      const memoryFile = this.memory.ledger.files.sync({ kind: scopeKind, id: scopeId }, typeof args.project_root === "string" ? args.project_root : undefined);
      return { ...proposed, evidence, memory_file: memoryFile, promotions: [],
        next_action: scopeKind === "session" && Boolean(args.project_scope_id) ? "memory_promotion_queued" : "available_for_scoped_context" };
    }
    const candidate = proposed.candidate as JsonObject;
    return { ...proposed, evidence, auto_committed: false,
      next_action: candidate.status === "conflict_pending" ? "resolve_conflict" : "review_or_accept" };
  }

  /** Process durable Host-observation intents using Memory's own evidence and tier gates. */
  processObservedPromotions(args: JsonObject = {}): JsonObject {
    this.bootstrap();
    const limit = args.limit === undefined ? 50 : Number(args.limit);
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) throw new Error("limit must be an integer between 1 and 500");
    const projectId = args.project_scope_id === undefined ? undefined : text(args.project_scope_id, "project_scope_id");
    for (const archive of this.memory.store.list("memory_session_archive", 10_000, row => row.status === "archived" && row.promotion_content_retained === true).slice(0, limit)) {
      if (typeof archive.session_scope_id === "string") this.memory.ledger.files.releaseArchivedPromotionContent(archive.session_scope_id);
    }
    const eligibleJobs = this.memory.store.list("memory_observation_promotion", 10_000, job =>
      (job.status === "pending" || job.status === "processing" && Date.parse(String(job.lease_expires_at ?? "")) <= Date.now())
      && (!projectId || job.project_id === projectId));
    const jobs = eligibleJobs.slice(0, limit);
    const items: JsonObject[] = [];
    for (const candidateJob of jobs) {
      const claimId = randomUUID();
      const job = this.memory.store.transaction(() => {
        const current = this.memory.store.find("memory_observation_promotion", String(candidateJob.id));
        if (!current || (current.status !== "pending" && !(current.status === "processing" && Date.parse(String(current.lease_expires_at ?? "")) <= Date.now()))) return null;
        return this.memory.store.save("memory_observation_promotion", String(current.id), { ...current, status: "processing", claim_id: claimId,
          claimed_at: new Date().toISOString(), lease_expires_at: new Date(Date.now() + 5 * 60_000).toISOString(), attempts: Number(current.attempts ?? 0) + 1 });
      });
      if (!job) continue;
      const intent = this.memory.store.find("memory_observation_intent", String(job.intent_id), undefined, false);
      const candidateId = text(job.candidate_id, "candidate_id");
      const finish = (status: string, reason?: string, promotions: JsonObject[] = []) => {
        const savedJob = this.memory.store.transaction(() => {
          const current = this.memory.store.find("memory_observation_promotion", String(job.id));
          if (!current || current.status !== "processing" || current.claim_id !== claimId) throw new Error("Memory promotion claim was superseded");
          const saved = this.memory.store.save("memory_observation_promotion", String(job.id), { ...current, status, claim_id: null, lease_expires_at: null,
            ...(reason ? { reason } : {}), ...(promotions.length ? { promotion_tiers: promotions.map(row => row.tier) } : {}), completed_at: new Date().toISOString() });
          const currentIntent = this.memory.ledger.files.isSessionArchived(String(job.session_scope_id)) ? null
            : this.memory.store.find("memory_observation_intent", String(job.intent_id));
          if (currentIntent) this.memory.store.save("memory_observation_intent", String(job.intent_id), { ...currentIntent, promotion_status: status,
            promotion_reason: reason ?? null, promoted_at: new Date().toISOString() });
          return saved;
        });
        this.releaseArchivedCandidate(job);
        items.push({ work_id: savedJob.id, candidate_id: candidateId, status,
          ...(reason ? { reason } : {}), promotions: promotions.map(row => ({ tier: row.tier, status: row.status, auto_committed: row.auto_committed === true,
            ...(typeof row.reason_code === "string" ? { reason_code: row.reason_code } : {}),
            ...(Number.isSafeInteger(row.repetition_count) ? { repetition_count: row.repetition_count } : {}) })) });
      };
      const defer = (reason: string, errorType?: string) => {
        this.memory.store.transaction(() => {
          const current = this.memory.store.find("memory_observation_promotion", String(job.id));
          if (!current || current.status !== "processing" || current.claim_id !== claimId) return;
          this.memory.store.save("memory_observation_promotion", String(job.id), { ...current, status: "pending", claim_id: null, lease_expires_at: null,
            reason, ...(errorType ? { last_error_type: errorType } : {}), last_attempted_at: new Date().toISOString() });
        });
        items.push({ work_id: job.id, candidate_id: candidateId, status: "waiting", reason, ...(errorType ? { error_type: errorType } : {}) });
      };
      if (!intent) { finish("rejected", "intent_unavailable"); continue; }
      const candidate = this.memory.store.find("memory_candidate", candidateId, undefined, false);
      if (!candidate || candidate.status !== "approved") {
        if (!candidate || ["rejected", "expired", "superseded"].includes(String(candidate.status))) {
          finish("rejected", candidate ? `candidate_${candidate.status}` : "candidate_unavailable");
          continue;
        }
        defer(candidate?.status === "conflict_pending" ? "conflict_pending" : "awaiting_session_commit");
        continue;
      }
      if (typeof candidate.valid_until === "string" && Date.parse(candidate.valid_until) < Date.now()) {
        finish("rejected", "candidate_expired");
        continue;
      }
      const scope = candidate.scope as JsonObject | undefined;
      if (scope?.kind !== "session" || scope.id !== job.session_scope_id || scope.id !== (intent.scope as JsonObject | undefined)?.id
        || candidate.content_digest !== intent.content_digest || candidate.kind !== intent.kind
        || (candidate.topic ?? "") !== intent.topic || !Array.isArray(candidate.evidence_ids) || !candidate.evidence_ids.includes(intent.evidence_id as string)) {
        finish("rejected", "candidate_identity_changed");
        continue;
      }
      const evidence = this.memory.store.find("evidence", String(intent.evidence_id));
      const captureIdentity = { kind: intent.kind, scope_kind: "session", scope_id: scope.id, project_scope_id: intent.project_id, topic: intent.capture_topic, content_digest: intent.content_digest };
      if (!evidence || digestJson(captureIdentity) !== intent.capture_digest
        || (intent.evidence_version !== undefined && evidence.version !== intent.evidence_version)
        || (evidence.metadata as JsonObject | undefined)?.capture_digest !== intent.capture_digest) {
        finish("rejected", "evidence_changed_or_unavailable");
        continue;
      }
      const policy = this.memory.policyGet().policy as JsonObject;
      if (policy.mode !== "governed") {
        defer(policy.mode === "off" ? "memory_disabled" : "governed_policy_required");
        continue;
      }
      let promotions: JsonObject[];
      try {
        promotions = this.promoteRepeatedFact({ sessionId: String(scope.id), projectId: String(intent.project_id),
          projectRoot: projectId && projectId === intent.project_id && typeof args.project_root === "string" ? args.project_root : undefined, candidate, evidence });
      } catch (error) {
        defer("promotion_gate_unavailable", error instanceof Error ? error.name : "unknown");
        continue;
      }
      finish(promotions.some(row => row.auto_committed === true) ? "promoted" : "observed", undefined, promotions);
    }
    const promoted = items.reduce((count, item) => count + (Array.isArray(item.promotions)
      ? (item.promotions as JsonObject[]).filter(row => row.auto_committed === true).length : 0), 0);
    return { processed: items.filter(item => item.status === "promoted" || item.status === "observed" || item.status === "rejected").length,
      promoted,
      pending: this.memory.store.list("memory_observation_promotion", 10_000, job => job.status === "pending" && (!projectId || job.project_id === projectId)).length,
      has_more: eligibleJobs.length > jobs.length, items };
  }

  private releaseArchivedCandidate(job: JsonObject): void {
    const scopeId = String(job.session_scope_id ?? "");
    if (!scopeId) return;
    this.memory.ledger.files.releaseArchivedPromotionContent(scopeId);
  }

  private observationPromotionJobId(intentId: string): string { return `memory_observation_promotion_${digestJson(intentId).slice(-32)}`; }


  private promoteRepeatedFact(input: { sessionId: string; projectId: string; projectRoot?: string; candidate: JsonObject; evidence?: JsonObject }): JsonObject[] {
    const candidate = input.candidate;
    const contentDigest = String(candidate.content_digest ?? "");
    if (!contentDigest || candidate.scope && (candidate.scope as JsonObject).kind !== "session") return [];
    const projectId = input.projectId;
    const observationIdentity = { content_digest: contentDigest, project_id: projectId, session_digest: digestJson(input.sessionId), kind: candidate.kind, topic: candidate.topic ?? "" };
    const observationId = `memory_observation_${digestJson(observationIdentity).slice(-32)}`;
    const existingObservation = this.memory.store.find("memory_observation", observationId);
    if (existingObservation && input.evidence && (digestJson(existingObservation.evidence_refs ?? null) !== digestJson([{ id: input.evidence.id, version: input.evidence.version }])
      || digestJson(existingObservation.evidence_ids ?? null) !== digestJson(candidate.evidence_ids ?? []))) throw new Error("Memory observation evidence binding changed");
    if (!existingObservation) this.memory.store.create("memory_observation", observationId, {
      ...observationIdentity, scope: { kind: "project", id: projectId }, evidence_ids: candidate.evidence_ids ?? [], observed_at: candidate.observed_at,
      ...(input.evidence ? { evidence_refs: [{ id: input.evidence.id, version: input.evidence.version }] } : {}),
      ...(typeof candidate.valid_until === "string" ? { valid_until: candidate.valid_until } : {}), content_free: true, status: "active",
    });
    const observations = this.memory.store.list("memory_observation", 10_000, row => row.status === "active"
      && (!row.valid_until || Date.parse(String(row.valid_until)) >= Date.now())
      && row.content_digest === contentDigest && row.project_id === projectId
      && (row.scope as JsonObject | undefined)?.kind === "project" && (row.scope as JsonObject | undefined)?.id === projectId
      && row.kind === candidate.kind && row.topic === (candidate.topic ?? "") && this.memory.ledger.observationEvidenceCurrent(row));
    const sessions = new Set(observations.map(row => String(row.session_digest)));
    if (sessions.size < 2) return [];

    const results: JsonObject[] = [];
    const evidenceIds = [...new Set(observations.flatMap(row => Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : []))];
    // A promotion cannot outlive the shortest-lived supporting observation.
    const validUntil = observations.map(row => typeof row.valid_until === "string" ? row.valid_until : null)
      .filter((value): value is string => value !== null).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
    const now = Date.now();
    const projectExisting = this.memory.store.list("memory_ledger", 10_000, row => row.status === "active" && (!row.valid_until || Date.parse(String(row.valid_until)) >= now) && row.content_digest === contentDigest
      && row.kind === candidate.kind && (row.topic ?? "") === (candidate.topic ?? "")
      && (row.scope as JsonObject | undefined)?.kind === "project" && (row.scope as JsonObject | undefined)?.id === projectId
      && this.memory.ledger.promotionSupported(row));
    if (!projectExisting.length) {
      const supportRefs = observations.map(row => ({ kind: "memory_observation", id: String(row.id), version: Number(row.version) }))
        .sort((left, right) => left.id.localeCompare(right.id));
      const projectCandidateId = `memory_candidate_project_${digestJson({ contentDigest, projectId, kind: candidate.kind, topic: candidate.topic ?? "", supportRefs }).slice(-32)}`;
      const promoted = this.proposePromotion({ candidate_id: projectCandidateId, source_id: candidate.source_id, kind: candidate.kind,
        scope_kind: "project", scope_id: projectId, content: candidate.content, topic: candidate.topic || undefined,
        sensitivity: candidate.sensitivity, confidence: "bounded", evidence_ids: evidenceIds, proposed_by: "automatic-memory-promotion", valid_until: validUntil,
        promotion_support_refs: supportRefs });
      const governedPromotion = this.resolveRepeatedConflict(promoted, evidenceIds);
      results.push({ tier: "project", repetition_count: sessions.size, ...governedPromotion,
        ...(governedPromotion.auto_committed === true ? { memory_file: this.memory.ledger.files.sync({ kind: "project", id: projectId }, input.projectRoot) } : {}) });
    }

    const projectMemories = this.memory.store.list("memory_ledger", 10_000, row => row.status === "active" && row.content_digest === contentDigest
      && (!row.valid_until || Date.parse(String(row.valid_until)) >= now)
      && (row.scope as JsonObject | undefined)?.kind === "project" && row.kind === candidate.kind && (row.topic ?? "") === (candidate.topic ?? "")
      && this.memory.ledger.promotionSupported(row));
    const projects = new Set(projectMemories.map(row => String((row.scope as JsonObject).id)));
    if (projects.size >= 3) {
      const globalExisting = this.memory.store.list("memory_ledger", 10_000, row => row.status === "active" && row.content_digest === contentDigest
        && row.kind === candidate.kind && (row.topic ?? "") === (candidate.topic ?? "")
        && (row.scope as JsonObject | undefined)?.kind === "global" && this.memory.ledger.promotionSupported(row));
      if (!globalExisting.length) {
        const globalEvidenceIds = [...new Set(projectMemories.flatMap(row => Array.isArray(row.evidence_ids) ? row.evidence_ids.map(String) : []))];
        const supportRefs = projectMemories.map(row => ({ kind: "memory_ledger", id: String(row.id), version: Number(row.version) }))
          .sort((left, right) => left.id.localeCompare(right.id));
        const globalCandidateId = `memory_candidate_global_${digestJson({ contentDigest, kind: candidate.kind, topic: candidate.topic ?? "", supportRefs }).slice(-32)}`;
        const globalValidUntil = projectMemories.map(row => typeof row.valid_until === "string" ? row.valid_until : null)
          .filter((value): value is string => value !== null).sort((left, right) => Date.parse(left) - Date.parse(right))[0] ?? null;
        const contentDecision = globalPromotionContentDecision(String(candidate.content ?? ""), candidate.sensitivity);
        if (!contentDecision.eligible) {
          results.push({ tier: "global", repetition_count: projects.size, status: "rejected", auto_committed: false,
            reason_code: contentDecision.reason_code, reason: contentDecision.reason_code === "deidentification_required"
              ? "Rewrite identifiable details before cross-project promotion."
              : "Memory sensitivity is not eligible for cross-project promotion." });
          return results;
        }
        const globalArgs = { candidate_id: globalCandidateId, source_id: candidate.source_id, kind: candidate.kind,
          scope_kind: "global", scope_id: "global", content: candidate.content, topic: candidate.topic || undefined,
          sensitivity: candidate.sensitivity, confidence: "bounded", evidence_ids: globalEvidenceIds, proposed_by: "automatic-memory-promotion",
          valid_until: globalValidUntil, promotion_support_refs: supportRefs };
        try { this.memory.ledger.validatePromotionSupport(globalArgs); }
        catch (error) {
          const sharedEvidence = error instanceof SharedPromotionEvidenceError;
          results.push({ tier: "global", repetition_count: projects.size, status: "rejected", auto_committed: false,
            reason_code: sharedEvidence ? "shared_evidence" : "independent_project_evidence_unverified",
            reason: sharedEvidence ? "Project evidence is shared; independent evidence is required." : "Current independent project evidence could not be verified." });
          return results;
        }
        const promoted = this.proposePromotion(globalArgs);
        const governedPromotion = this.resolveRepeatedConflict(promoted, globalEvidenceIds);
        results.push({ tier: "global", repetition_count: projects.size, ...governedPromotion,
          ...(governedPromotion.auto_committed === true ? { memory_file: this.memory.ledger.files.sync({ kind: "global", id: "global" }) } : {}) });
      }
    }
    return results;
  }

  /** Repeated independent observations may resolve only a policy-qualified same-topic conflict. */
  private resolveRepeatedConflict(promoted: JsonObject, evidenceIds: string[]): JsonObject {
    const candidate = promoted.candidate as JsonObject | undefined;
    if (candidate?.status !== "conflict_pending") return promoted;
    const policy = this.memory.policyGet().policy as JsonObject;
    if (policy.mode !== "governed" || evidenceIds.length === 0) return promoted;
    const evidenceIsQualified = evidenceIds.every(evidenceId => {
      const evidence = this.memory.store.find("evidence", evidenceId);
      if (!evidence) return false;
      const confidence = String(evidence.confidence);
      return policy.min_confidence === "bounded" ? ["bounded", "confirmed"].includes(confidence) : confidence === "confirmed";
    });
    if (!evidenceIsQualified) return promoted;
    const resolved = this.memory.resolveConflict({ candidate_id: candidate.id, actor: "automatic-repeat-evidence", resolution: "supersede",
      reason: "Independent repeated observations met the configured Memory promotion threshold and Evidence policy." });
    return { ...promoted, ...resolved };
  }

}
