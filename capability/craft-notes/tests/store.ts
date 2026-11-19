import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CraftStore } from "craft-common-store-local/store";
import { craftPaths } from "craft-common-store-local/paths";

export async function openStore(prefix = "craft-notes-test-"): Promise<{ root: string; store: CraftStore; close(): Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const store = await new CraftStore(craftPaths(root)).open();
  return {
    root,
    store,
    async close() {
      await store.close();
      const { rm } = await import("node:fs/promises");
      await rm(root, { recursive: true, force: true, maxRetries: 5 });
    },
  };
}
