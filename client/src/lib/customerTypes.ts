/**
 * The kinds of customer (backend/src/models/Customer.js). A print shop books
 * jobs for walk-in customers and for agencies; the other three are older ways
 * of describing a direct customer and stay selectable for existing records.
 */
export const CUSTOMER_TYPES = [
  { value: "Walk-in", label: "Walk-in customer" },
  { value: "Agency", label: "Agency" },
  { value: "Individual", label: "Individual" },
  { value: "Business", label: "Business" },
  { value: "Corporate", label: "Corporate" }
] as const;

export type CustomerType = (typeof CUSTOMER_TYPES)[number]["value"];

/** The two a new customer is usually added as. */
export const QUICK_CUSTOMER_TYPES = CUSTOMER_TYPES.slice(0, 2);
