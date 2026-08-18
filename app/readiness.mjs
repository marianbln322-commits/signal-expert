import { explainCounterfactuals } from "./counterfactual-engine.mjs";

/**
 * Backward-compatible public wrapper. Readiness is explanatory only and never
 * mutates or reevaluates entry quality or gate decisions.
 */
export function explainReadiness({ candidate, snapshot, checks, policy, now = new Date() }) {
  return explainCounterfactuals({ candidate, snapshot, checks, policy, now });
}
