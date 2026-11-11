// Initials sit on a warm paper chip in ink, the same for every name, as on the
// Carbon website.
const AVATAR = "bg-paper-3 text-ink-2";

export const tintFor = (_name: string) => AVATAR;

export const initialsOf = (name = "") =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .map((p) => p[0])
    .slice(0, 2)
    .join("")
    .toUpperCase() || "?";
