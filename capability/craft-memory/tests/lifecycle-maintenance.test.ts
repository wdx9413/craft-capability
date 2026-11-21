import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";
import { MemoryLedgerKernel } from "../memory-ledger.ts";

test("governance can expire restricted memory after its source is inactive", async () => {
  const root = await mkdtemp(join(tmpdir(), "craft-memory-lifecycle-"));
  const store = await new CraftStore(craftPaths(root)).open();
  try {
    store.create("knowledge_source", "source-inactive", { scope: { kind: "global", id: "global" }, status: "inactive", trust: "untrusted" });
    store.create("memory_ledger", "restricted-memory", {
      source_id: "source-inactive", scope: { kind: "global", id: "global" }, scope_envelope: { kind: "global", id: "global" },
      status: "active", sensitivity: "restricted", kind: "procedural", content: "private", content_digest: "digest", topic: "",
    });
    const ledger = new MemoryLedgerKernel(store);
    assert.throws(() => ledger.transition({ memory_id: "restricted-memory", status: "expired", reason: "expired" }), /scope or audience denied/u);
    const transitioned = ledger.transitionForGovernance({ memory_id: "restricted-memory", status: "expired", reason: "expired" });
    assert.equal((transitioned.memory as { status: string }).status, "expired");
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
