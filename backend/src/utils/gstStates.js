/**
 * GST state / union-territory codes (the first two digits of a GSTIN and the
 * "place of supply" code in GST returns). 25 (Daman & Diu) merged into 26 in
 * 2020; 28 is pre-2014 Andhra Pradesh and is not used for new registrations.
 */
const STATES = {
  '01': 'Jammu and Kashmir', '02': 'Himachal Pradesh', '03': 'Punjab', '04': 'Chandigarh', '05': 'Uttarakhand',
  '06': 'Haryana', '07': 'Delhi', '08': 'Rajasthan', '09': 'Uttar Pradesh', '10': 'Bihar', '11': 'Sikkim',
  '12': 'Arunachal Pradesh', '13': 'Nagaland', '14': 'Manipur', '15': 'Mizoram', '16': 'Tripura', '17': 'Meghalaya',
  '18': 'Assam', '19': 'West Bengal', '20': 'Jharkhand', '21': 'Odisha', '22': 'Chhattisgarh', '23': 'Madhya Pradesh',
  '24': 'Gujarat', '26': 'Dadra and Nagar Haveli and Daman and Diu', '27': 'Maharashtra', '29': 'Karnataka', '30': 'Goa',
  '31': 'Lakshadweep', '32': 'Kerala', '33': 'Tamil Nadu', '34': 'Puducherry', '35': 'Andaman and Nicobar Islands',
  '36': 'Telangana', '37': 'Andhra Pradesh', '38': 'Ladakh', '97': 'Other Territory'
};

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');
const BY_NAME = new Map(Object.entries(STATES).map(([code, name]) => [norm(name), code]));
BY_NAME.set(norm('Orissa'), '21');
BY_NAME.set(norm('Pondicherry'), '34');
BY_NAME.set(norm('Daman and Diu'), '26');
BY_NAME.set(norm('Dadra and Nagar Haveli'), '26');
BY_NAME.set(norm('New Delhi'), '07');

/** "32" from "32", "Kerala", "KERALA" or a GSTIN starting 32; null when unknown. */
function stateCodeOf(value) {
  const v = String(value || '').trim();
  if (!v) return null;
  if (/^\d{2}$/.test(v)) return STATES[v] ? v : null;
  if (/^\d{2}[A-Z0-9]{13}$/i.test(v)) return STATES[v.slice(0, 2)] ? v.slice(0, 2) : null;
  return BY_NAME.get(norm(v)) || null;
}

const stateName = (code) => STATES[code] || null;
const placeOfSupplyLabel = (code) => (code && STATES[code] ? `${code}-${STATES[code]}` : null);

module.exports = { STATES, stateCodeOf, stateName, placeOfSupplyLabel };
