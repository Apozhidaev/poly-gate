/** Native Temporal (Node.js >= 26). Single import point for deadline logic. */
const temporal = globalThis.Temporal;

if (!temporal) {
  throw new Error("Temporal API requires Node.js >= 26");
}

export const Temporal = temporal;
export type Instant = Temporal.Instant;
