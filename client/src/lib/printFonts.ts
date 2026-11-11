/*
  Carbon's fonts for documents printed from their own window (the delivery
  challan). Such a window has none of the app's CSS, so it gets @font-face
  rules pointing at the same bundled font files, and waits for them before it
  prints. Colours come from the --print-* tokens in src/index.css.
*/
import interLatin400 from "@fontsource/inter/files/inter-latin-400-normal.woff2?url";
import interLatinExt400 from "@fontsource/inter/files/inter-latin-ext-400-normal.woff2?url";
import interLatin600 from "@fontsource/inter/files/inter-latin-600-normal.woff2?url";
import interLatinExt600 from "@fontsource/inter/files/inter-latin-ext-600-normal.woff2?url";
import sora600 from "@fontsource/sora/files/sora-latin-600-normal.woff2?url";
import sora700 from "@fontsource/sora/files/sora-latin-700-normal.woff2?url";
import mono500 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-500-normal.woff2?url";
import mono600 from "@fontsource/jetbrains-mono/files/jetbrains-mono-latin-600-normal.woff2?url";

// The same subsets as @fontsource's latin / latin-ext files; ₹ is in latin-ext.
const LATIN =
  "U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD";
const LATIN_EXT =
  "U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF";

const FACES: { family: string; weight: number; url: string; range: string }[] = [
  { family: "Inter", weight: 400, url: interLatin400, range: LATIN },
  { family: "Inter", weight: 400, url: interLatinExt400, range: LATIN_EXT },
  { family: "Inter", weight: 600, url: interLatin600, range: LATIN },
  { family: "Inter", weight: 600, url: interLatinExt600, range: LATIN_EXT },
  { family: "Sora", weight: 600, url: sora600, range: LATIN },
  { family: "Sora", weight: 700, url: sora700, range: LATIN },
  { family: "JetBrains Mono", weight: 500, url: mono500, range: LATIN },
  { family: "JetBrains Mono", weight: 600, url: mono600, range: LATIN },
];

/** @font-face rules for a print document, with absolute URLs (it may be about:blank). */
export function printFontFaces(): string {
  return FACES.map(
    (f) =>
      `@font-face{font-family:'${f.family}';font-style:normal;font-weight:${f.weight};font-display:block;src:url(${new URL(f.url, document.baseURI).href}) format('woff2');unicode-range:${f.range};}`
  ).join("\n");
}

/** The print colours from the tokens, as `--name: value;` declarations. */
export function printColorVars(): string {
  const css = getComputedStyle(document.documentElement);
  return ["--print-ink", "--print-ink-2", "--print-brand", "--print-brand-fg", "--print-line", "--print-hair", "--print-paper"]
    .map((name) => `${name}: ${css.getPropertyValue(name).trim()};`)
    .join(" ");
}

/** Resolves once the print fonts have loaded, or after `timeoutMs` at the latest. */
export function whenPrintFontsReady(doc: Document, timeoutMs = 2000): Promise<void> {
  const fonts = (doc as Document & { fonts?: FontFaceSet }).fonts;
  if (!fonts) return Promise.resolve();
  // The rupee sign is in the latin-ext files, which load only when asked for.
  const loads = [
    ["400 13px Inter", "A₹"],
    ["600 13px Inter", "A₹"],
    ["700 20px Sora", "A"],
    ["600 16px Sora", "A"],
    ["500 13px 'JetBrains Mono'", "A"],
    ["600 13px 'JetBrains Mono'", "A"],
  ].map(([font, text]) => fonts.load(font, text).catch(() => []));
  return Promise.race([
    Promise.all(loads).then(() => undefined),
    new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
  ]);
}
