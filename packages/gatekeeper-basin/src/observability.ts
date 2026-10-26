import { createObservabilityContext } from "@gadgets/observability/observability-context";

/** Observability fields emitted by the Basin gatekeeper. */
export type BasinObservabilityFields = { vendorId: string };

/** Ambient observability fields for one Basin gatekeeper operation. */
export const obsContext = createObservabilityContext<BasinObservabilityFields>();
