import { observedKernel } from 'craft-common-log/index';
/**
 * The Memory capability.
 *
 * Memory is the accumulated context member gated by **evidence quality and conflict policy**. Where knowledge is
 * gated by Evidence — a claim carries the Evidence that backs it — a memory entry additionally
 * answers "whose memory is this, and may it be recalled here": it carries a scope, a
 * sensitivity, a validity window and the Knowledge Source version it came from. `MemoryContribution`
 * enforces that scope, refuses `restricted` entries unless the caller asks for them, drops an
 * expired entry, and refuses a Source that is not active or is `untrusted`.
 *
 * That gate is why the member exists separately from knowledge, and it is why the tools this
 * package implements are the Ledger's writes plus the signals derived from recall history.
 * Candidate reading belongs here; cross-member selection belongs to Context.
 *
 * | kernel | what it holds |
 * |---|---|
 * | `memory-ledger` | `remember`, `transition`, `compatBind`, `get` — content-addressed, Source-pinned, Evidence-checked entries |
 * | `memory-governance` | automatic quality-gated commit, conflict selection, candidate review, topic suggestions and confirmations |
 * | `memory-signals` | `memoryDecayWeight`, `rankWithDecay`, `shouldProposeMemory`, `planLegacyPromotion`, `hybridMemoryScores`, `memoryUsageEvidence` — pure functions over recall history |
 * | `memory-consolidation` | episodic entries into a versioned semantic one, with resolution and scoped search |
 *
 * `MemoryContribution` owns candidate eligibility and read snapshots. Context combines
 * those candidates with other members using its shared retrieval, budget and receipt.
 */
import type { CraftCapability } from 'craft-common-base/capability-protocol';
import { CORE_KERNELS } from 'craft-common-base/capability-protocol';
import type { CraftStore } from 'craft-common-store-local/store';
import { MemoryContribution } from "./contribution.ts";
import { MemoryGovernanceKernel } from "./memory-governance.ts";
import { MemoryLedgerKernel } from "./memory-ledger.ts";
import { MemorySignalsKernel } from "./memory-signals-kernel.ts";
import { MemoryConsolidationKernel } from "./memory-consolidation.ts";
import { MEMORY_OWNS } from "./ownership.ts";

/** Kernel names this capability registers, and the core requires back. */
export const MEMORY_KERNELS = { ledger: "memory.ledger", signals: "memory.signals", governance: "memory.governance",
  consolidation: "memory.consolidation" } as const;

/** Tool families this capability implements. Declared in `ownership.ts` beside the projection. */
export { MEMORY_OWNS };

export const memoryCapability: CraftCapability = {
  name: "memory",
  product: "craft-memory",
  evaluation: { input_contract: "scoped-memory-request", output_contract: "bounded-memory-ledger-result", fixture_id: "memory-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
  owns: MEMORY_OWNS,
  contributes: registry => new MemoryContribution(registry.require<CraftStore>(CORE_KERNELS.store)),
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    const ledger = observedKernel(store, "memory", new MemoryLedgerKernel(store));
    registry.provide(MEMORY_KERNELS.ledger, ledger);
    registry.provide(MEMORY_KERNELS.governance, observedKernel(store, "memory", new MemoryGovernanceKernel(store, ledger)));
    registry.provide(MEMORY_KERNELS.signals, observedKernel(store, "memory", new MemorySignalsKernel(store)));
    // Episodic-to-semantic consolidation is a Memory operation on the same
    // member, so it belongs here rather than in the core facade.
    registry.provide(MEMORY_KERNELS.consolidation, observedKernel(store, "memory", new MemoryConsolidationKernel(store)));
  },
};
