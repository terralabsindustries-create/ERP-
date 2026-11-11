/*
  Carbon's three typefaces, bundled with the app so they also work offline in
  the desktop builds (no Google Fonts request):

    Inter           400 / 500 / 600   body and UI text (the default)
    Sora            500 / 600 / 700   headings, page and card titles, KPI numbers
    JetBrains Mono  500 / 600         job and invoice numbers, money, codes, small labels

  Only the Latin and Latin Extended sets are loaded; Latin Extended holds the
  rupee sign. The browser fetches a file only when the page uses it.
*/
import "@fontsource/inter/latin-400.css";
import "@fontsource/inter/latin-ext-400.css";
import "@fontsource/inter/latin-500.css";
import "@fontsource/inter/latin-ext-500.css";
import "@fontsource/inter/latin-600.css";
import "@fontsource/inter/latin-ext-600.css";

import "@fontsource/sora/latin-500.css";
import "@fontsource/sora/latin-ext-500.css";
import "@fontsource/sora/latin-600.css";
import "@fontsource/sora/latin-ext-600.css";
import "@fontsource/sora/latin-700.css";
import "@fontsource/sora/latin-ext-700.css";

import "@fontsource/jetbrains-mono/latin-500.css";
import "@fontsource/jetbrains-mono/latin-ext-500.css";
import "@fontsource/jetbrains-mono/latin-600.css";
import "@fontsource/jetbrains-mono/latin-ext-600.css";
