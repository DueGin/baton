import type { DriverRegistry } from "./types.js";
/** Replaced by the providers worker's adapter when the lead merges worktrees. */
export function createPaseoDriverRegistry(_options: { home: string }): DriverRegistry {
  throw new Error("providers not merged yet");
}
