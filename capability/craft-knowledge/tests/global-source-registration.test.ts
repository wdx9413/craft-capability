import assert from "node:assert/strict";
import test from "node:test";
import type { CraftStore, JsonObject } from "craft-common-store-local/store";
import { stableDigest } from "craft-common-base/digest";
import { scopeEnvelope } from "craft-common-base/scope-policy";
import { KnowledgeSourceRegistry } from "../knowledge-source-registry.ts";

function fixture() {
  const records = new Map<string, JsonObject>();
  const store = {
    find(kind: string, id: string) { return records.get(`${kind}:${id}`) ?? null; },
    create(kind: string, id: string, data: JsonObject) { const record = { id, version: 1, ...data }; records.set(`${kind}:${id}`, record); return record; },
    save(kind: string, id: string, data: JsonObject) { const record = { ...data, id, version: Number(records.get(`${kind}:${id}`)?.version ?? 0) + 1 }; records.set(`${kind}:${id}`, record); return record; },
  } as unknown as CraftStore;
  return new KnowledgeSourceRegistry(store);
}

test("global verified Knowledge Sources require an exact Runtime-pinned descriptor", () => {
  const previous = process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
  try {
    const registry = fixture();
    const descriptor = { kind: "custom", label: "Organization standard", scope: { kind: "global", id: "global" },
      scope_envelope: scopeEnvelope(undefined, { kind: "global", id: "global" }), locator: "org://engineering/standard",
      content_digest: "org-standard-v1", trust: "verified", access: "read_only" };
    const request = { source_id: "organization-standard", kind: descriptor.kind, label: descriptor.label, scope_kind: "global",
      scope_id: "global", locator: descriptor.locator, content_digest: descriptor.content_digest, trust: "verified" };
    delete process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
    assert.throws(() => registry.sourceRegister(request), /Runtime-pinned source identity allowlist/u);
    const identityDigest = stableDigest(descriptor);
    process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = JSON.stringify([{ id: request.source_id, identity_digest: identityDigest }]);
    const registered = registry.sourceRegister(request);
    assert.equal((registered.source as JsonObject).identity_digest, identityDigest);
    assert.throws(() => registry.sourceRegister({ ...request, label: "Changed organization standard" }), /allowlist/u);
  } finally {
    if (previous === undefined) delete process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES;
    else process.env.CRAFT_TRUSTED_KNOWLEDGE_SOURCES = previous;
  }
});
