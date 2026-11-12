import type { Runtime } from '../core.js';

/** Hourly (worker.ts `7 * * * *`, runner.ts hourly): the daily storage/unpaid/drift work when due, then settlement. */
export async function billingHourly(_runtime: Runtime): Promise<void> {
  // Package A fills this in (settle.ts); the contract only fixes the signature and wiring.
}
