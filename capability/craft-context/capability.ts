import { observedKernel } from 'craft-common-log/index';
import type { CraftCapability } from 'craft-common-base/capability-protocol';
import { CORE_KERNELS } from 'craft-common-base/capability-protocol';
import type { CraftStore } from 'craft-common-store-local/store';
import { SelfEvolutionKernel } from "./self-evolution.ts";
import { CONTEXT_OWNS } from "./ownership.ts";

export const CONTEXT_KERNELS = { selfEvolution: "context.self_evolution" } as const;

export { CONTEXT_OWNS };

/**
 * The Context capability.
 *
 * It owns self-evolution state and orchestration, and composes Knowledge,
 * Memory, Experience and Notes rather than duplicating their stores. Scenario
 * adapters are hints; `general` is always available as the fallback path.
 */
export const contextCapability: CraftCapability = {
  name: "context",
  product: "craft-context",
  evaluation: { input_contract: "statement-or-verified-trajectory", output_contract: "governed-evolution-candidate", fixture_id: "context-evolution-fixture-v1", host_compatibility: ["fixture", "codex", "claude"] },
  owns: CONTEXT_OWNS,
  register(registry): void {
    const store = registry.require<CraftStore>(CORE_KERNELS.store);
    registry.provide(CONTEXT_KERNELS.selfEvolution, observedKernel(store, "context", new SelfEvolutionKernel(store)));
  },
};
