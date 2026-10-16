// Soft tints for initials, picked from the name so a person or record keeps
// its colour everywhere it appears.
const TINTS = [
  "bg-primary-soft text-primary-strong",
  "bg-info-soft text-info-strong",
  "bg-success-soft text-success-strong",
  "bg-warning-soft text-warning-strong",
  "bg-secondary text-secondary-foreground"
];

export const tintFor = (name: string) => TINTS[[...(name || "?")].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % TINTS.length];

export const initialsOf = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";
