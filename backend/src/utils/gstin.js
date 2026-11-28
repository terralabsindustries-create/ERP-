'use strict';

/**
 * GSTIN (India GST identification number) validation.
 * Format: 2-digit state code, 10-char PAN, entity number (1-9/A-Z), 'Z',
 * and a check character computed with the GSTN mod-36 algorithm.
 * A blank GSTIN is valid (unregistered customers/suppliers).
 */
const CHARSET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
const FORMAT = /^(0[1-9]|[1-2][0-9]|3[0-9])[A-Z]{5}[0-9]{4}[A-Z][1-9A-Z]Z[0-9A-Z]$/;

const normalizeGstin = (value) => String(value ?? '').replace(/\s+/g, '').toUpperCase();

function checkChar(first14) {
  let sum = 0;
  for (let i = 0; i < 14; i += 1) {
    const product = CHARSET.indexOf(first14[i]) * (i % 2 === 0 ? 1 : 2);
    sum += Math.floor(product / 36) + (product % 36);
  }
  return CHARSET[(36 - (sum % 36)) % 36];
}

/** Returns null when valid (or blank), otherwise a user-facing message. */
function gstinError(value) {
  const gstin = normalizeGstin(value);
  if (!gstin) return null;
  if (gstin.length !== 15) return 'GSTIN must be exactly 15 characters';
  if (!FORMAT.test(gstin)) return 'GSTIN format is invalid (e.g. 22AAAAA0000A1Z5)';
  if (checkChar(gstin.slice(0, 14)) !== gstin[14]) return 'GSTIN check digit is incorrect — please re-check the number';
  return null;
}

const isValidGstin = (value) => gstinError(value) === null;

module.exports = { normalizeGstin, gstinError, isValidGstin, checkChar };
