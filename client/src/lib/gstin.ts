/**
 * GSTIN validation (format + GSTN mod-36 check digit). Mirrors
 * backend/src/utils/gstin.js. A blank GSTIN is valid (unregistered party).
 */
const CHARSET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
const FORMAT = /^(0[1-9]|[1-2][0-9]|3[0-9])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

export const normalizeGstin = (value: string | null | undefined): string =>
  String(value ?? "").replace(/\s+/g, "").toUpperCase();

export function gstinCheckChar(first14: string): string {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARSET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** null when valid or blank; otherwise a message to show the user. */
export function gstinError(value: string | null | undefined): string | null {
  const gstin = normalizeGstin(value);
  if (!gstin) return null;
  if (gstin.length !== 15) return "GSTIN must be exactly 15 characters";
  if (!FORMAT.test(gstin)) return "GSTIN format is invalid (e.g. 22AAAAA0000A1Z5)";
  if (gstinCheckChar(gstin.slice(0, 14)) !== gstin[14]) return "GSTIN check digit is incorrect — please re-check the number";
  return null;
}
