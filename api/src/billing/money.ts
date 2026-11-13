import { z } from '@hono/zod-openapi';

// Billing money is integer micro-cents (µ¢): 1¢ = 1,000,000 µ¢, $1 = 100,000,000 µ¢. A bigint brand, never a JS
// number except through Number() for display. API JSON carries it as an integer string; API inputs are whole cents;
// Stripe amounts are cents.
export type MicroCents = bigint & { readonly __brand: 'MicroCents' };
export const UC_PER_CENT = 1_000_000n, UC_PER_USD = 100_000_000n;
export const RATES = { version: 1, emailUc: 20_000n, omenUc: 10_000n, storageUcPerGbMonth: 25_000_000n, freeEmails: 3000, freeStorageBytes: 1_000_000_000n } as const;

/** Parses an integer µ¢ value (bigint or integer string). Throws on anything else. */
export const microCents = (v: bigint | string): MicroCents => {
  if (typeof v === 'bigint') return v as MicroCents;
  if (!/^-?\d{1,19}$/.test(v)) throw new RangeError(`Not an integer micro-cent amount: ${JSON.stringify(v)}`);
  return BigInt(v) as MicroCents;
};
export const fromCents = (cents: number): MicroCents => {
  if (!Number.isSafeInteger(cents)) throw new RangeError(`Not a whole number of cents: ${cents}`);
  return (BigInt(cents) * UC_PER_CENT) as MicroCents;
};
/** Whole cents, rounded towards negative infinity. */
export const toCentsFloor = (v: MicroCents): number => {
  const q = v / UC_PER_CENT, r = v % UC_PER_CENT;
  return Number(r < 0n ? q - 1n : q);
};
/** "$12.34", "−$0.50"; four decimals when 0 < |v| < 1¢ ("$0.0002"). */
export const formatUsd = (v: MicroCents): string => {
  const neg = v < 0n, abs = neg ? -v : v;
  const digits = abs > 0n && abs < UC_PER_CENT ? 4 : 2;
  const scale = 10n ** BigInt(8 - digits), units = (abs + scale / 2n) / scale; // round half up at the shown precision
  const whole = units / 10n ** BigInt(digits), frac = (units % 10n ** BigInt(digits)).toString().padStart(digits, '0');
  return `${neg ? '−' : ''}$${whole.toLocaleString('en-US')}.${frac}`;
};
export const MicroCentsJson = z.string().regex(/^-?\d{1,19}$/).openapi('MicroCents', { description: 'Integer micro-cents (1¢ = 1,000,000) as a string.', example: '2500000000' });
