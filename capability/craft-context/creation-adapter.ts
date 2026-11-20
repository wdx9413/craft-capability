import { randomUUID } from "node:crypto";
import { stableDigest } from "craft-common-base/digest";
import { redact } from "craft-common-base/workflow";
import type { CraftStore, JsonObject } from 'craft-common-store-local/store';
import { matchesEvolutionProjectScope, requireEvolutionProjectScope } from "./evolution-project-scope.ts";

const ARTIFACT_TYPES = ["text", "image", "video", "slides"] as const;
const MODALITIES = ["text", "visual", "video", "mixed"] as const;
const USER_CHOICES = ["accepted", "rejected", "branch"] as const;
const RELIABILITY_FLOOR = 0.4;
const MAX_LINEAGE_RECORDS = 100;

type ArtifactType = (typeof ARTIFACT_TYPES)[number];
type Modality = (typeof MODALITIES)[number];
type UserChoice = (typeof USER_CHOICES)[number];

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function object(value: unknown): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : {};
}

function isArtifactType(value: string): value is ArtifactType {
  return (ARTIFACT_TYPES as readonly string[]).includes(value);
}

function isModality(value: string): value is Modality {
  return (MODALITIES as readonly string[]).includes(value);
}

function isUserChoice(value: string): value is UserChoice {
  return (USER_CHOICES as readonly string[]).includes(value);
}

function containsPrompt(record: JsonObject, prompt: string): boolean {
  if (!prompt) return true;
  return [record.prompt, record.evaluation, ...(Array.isArray(record.source_refs) ? record.source_refs : [])]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(prompt));
}

/** Thin creation-domain adapter: validation, routing and metadata lineage only. */
export class CreationAdapter {
  readonly store: CraftStore;
  constructor(store: CraftStore) { this.store = store; }

  static route(args: JsonObject): JsonObject {
    const modality = text(args.modality);
    if (modality) {
      if (!isModality(modality)) throw new Error("unsupported modality");
      return { route: "modality", modality, artifact_type: text(args.artifact_type) || null };
    }
    const artifactType = text(args.artifact_type);
    if (!artifactType) throw new Error("artifact_type or modality is required");
    if (!isArtifactType(artifactType)) throw new Error("unsupported artifact type");
    return { route: "artifact_type", artifact_type: artifactType, modality: text(args.modality) || null };
  }

  private static defaultModality(artifactType: ArtifactType): Modality {
    if (artifactType === "text") return "text";
    if (artifactType === "video") return "video";
    return "visual";
  }

  private denyOtherDomain(domain: string): boolean {
    return Boolean(domain && domain !== "creation");
  }

  private scopedRecord(args: JsonObject): JsonObject {
    const scope = requireEvolutionProjectScope(args.scope);
    const record = this.store.find("artifact_lineage", this.lineageId(args.id));
    if (!record || !matchesEvolutionProjectScope(record.scope, scope)) throw new Error("artifact lineage is not in scope");
    if (args.expected_version !== undefined && record.version !== args.expected_version) throw new Error("artifact lineage version changed");
    return record;
  }

  private lineageId(value: unknown): string {
    const id = text(value);
    if (!id) throw new Error("id is required");
    return id.startsWith("artifact_lineage_") ? id : `artifact_lineage_${id}`;
  }

  write(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation" };
    const artifactType = text(args.artifact_type);
    if (!isArtifactType(artifactType)) throw new Error("unsupported artifact type");
    const route = CreationAdapter.route(args);
    const id = this.lineageId(args.id || randomUUID());
    const userChoice = text(args.user_choice);
    if (userChoice && !isUserChoice(userChoice)) throw new Error("unsupported user choice");
    const reliability = Number(args.reliability ?? 0.5);
    if (!Number.isFinite(reliability) || reliability < 0 || reliability > 1) throw new Error("reliability must be between 0 and 1");
    const scope = requireEvolutionProjectScope(args.scope);
    const modality = text(args.modality) || CreationAdapter.defaultModality(artifactType);
    const requestedVersion = Number(args.version ?? 1);
    if (!Number.isSafeInteger(requestedVersion) || requestedVersion < 1) throw new Error("version must be a positive integer");
    const sourceRefs = Array.isArray(args.source_refs)
      ? args.source_refs.filter((item): item is string => typeof item === "string" && Boolean(item.trim())).slice(0, 50).map(ref => redact(ref.trim().slice(0, 500)))
      : [];
    const parameters = Object.fromEntries(Object.entries(object(args.parameters)).slice(0, 30)
      .filter(([key]) => !/(?:token|secret|cookie|password|api.?key|authorization)/iu.test(key))
      .flatMap<[string, string | number | boolean | null]>(([key, value]) => typeof value === "string" ? [[key, redact(value).slice(0, 200)]]
        : typeof value === "number" || typeof value === "boolean" || value === null ? [[key, value]] : []));
    const tool = redact(text(args.tool)).slice(0, 100) || null;
    const evaluation = redact(text(args.evaluation)).slice(0, 500) || null;
    const signature = { artifact_type: artifactType, source_refs: sourceRefs, parameters, tool, user_choice: userChoice || null, evaluation };
    const record: JsonObject = {
      ...signature, id, modality, prompt: redact(text(args.prompt)).slice(0, 500) || null,
      reliability, scope, requested_version: requestedVersion, signature_digest: stableDigest(signature),
    };
    return this.store.transaction(() => {
      const current = this.store.find("artifact_lineage", id);
      if (current && !matchesEvolutionProjectScope(current.scope, scope)) throw new Error("artifact lineage is not in scope");
      if (current?.status === "forgotten") throw new Error("artifact lineage is unavailable");
      const saved = this.store.save("artifact_lineage", id, record);
      return { ...saved, route: route.route };
    });
  }

  recall(args: JsonObject, abstainOnConflicts = true): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation", items: [] };
    const route = args.artifact_type === undefined && args.modality === undefined ? { route: "all" } : CreationAdapter.route(args);
    const scope = requireEvolutionProjectScope(args.scope);
    const prompt = text(args.prompt).toLowerCase();
    const targetType = text(args.artifact_type);
    const records = this.store.list("artifact_lineage", MAX_LINEAGE_RECORDS, (item) => {
      if (!matchesEvolutionProjectScope(item.scope, scope) || item.status === "forgotten") return false;
      if (route.route === "artifact_type" && item.artifact_type !== targetType) return false;
      if (route.route === "modality" && item.modality !== route.modality) return false;
      return containsPrompt(item, prompt);
    }, false);
    const weak = records.filter((item) => Number(item.reliability) < RELIABILITY_FLOOR);
    const candidates = records.filter((item) => Number(item.reliability) >= RELIABILITY_FLOOR);
    const signatures = new Set(candidates.map((item) => String(item.signature_digest)));
    if (abstainOnConflicts && candidates.length > 1 && signatures.size > 1 && !signatures.has("")) {
      return { route: route.route, abstain: true, reason: "conflicting_lineage", downweighted: candidates.map((item) => String(item.id)), items: [] };
    }
    if (!candidates.length && weak.length) {
      return { route: route.route, abstain: true, reason: "low_reliability", downweighted: weak.map((item) => String(item.id)), items: [] };
    }
    const items = candidates.sort((left, right) => Number(right.reliability) - Number(left.reliability));
    return { route: route.route, abstain: false, scope, items };
  }

  apply(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation" };
    const record = this.scopedRecord(args);
    if (record.status === "forgotten" || Number(record.reliability) < RELIABILITY_FLOOR)
      throw new Error("artifact lineage is unavailable");
    return { ...record, status: "applied", domain: "creation" };
  }

  forget(args: JsonObject): JsonObject {
    if (this.denyOtherDomain(text(args.domain))) return { status: "denied", reason: "domain isolation" };
    return this.store.transaction(() => {
      const record = this.scopedRecord(args);
      const id = String(record.id);
      if (record.status !== "forgotten") {
        this.store.save("artifact_lineage", id, { artifact_type: record.artifact_type, modality: record.modality,
          scope: record.scope, status: "forgotten", reliability: 0, forgotten_at: new Date().toISOString() });
      }
      return { status: "forgotten", domain: "creation", id };
    });
  }
}
