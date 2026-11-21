import assert from "node:assert/strict";
import test from "node:test";
import type { CraftStore, JsonObject } from "craft-common-store-local/store";
import { CodebaseIndexKernel } from "../codebase-index.ts";

test("owner-record stores reject legacy project graph indexes instead of reading missing root records", () => {
  const store = { ownerRecords: true, get: () => { throw new Error("root record must not be queried"); } } as unknown as CraftStore;
  const kernel = new CodebaseIndexKernel(store) as unknown as { graphRecord(index: JsonObject, kind: string, id: string): JsonObject };
  assert.throws(() => kernel.graphRecord({ graph_storage: "project-sharded-v5" }, "codebase_index_shard", "shard"),
    /persisted in project storage and must be rebuilt/u);
});

test("owner-record stores route current sharded indexes to the owner store", () => {
  const row = { id: "shard", version: 1 };
  const store = { ownerRecords: true, get: (_kind: string, id: string) => id === row.id ? row : null } as unknown as CraftStore;
  const kernel = new CodebaseIndexKernel(store) as unknown as { graphRecord(index: JsonObject, kind: string, id: string): JsonObject };
  assert.equal(kernel.graphRecord({ graph_storage: "sharded-v4" }, "codebase_index_shard", row.id), row);
});
