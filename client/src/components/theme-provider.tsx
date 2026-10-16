import { ThemeProvider as NextThemesProvider } from "next-themes";
import type { ThemeProviderProps } from "next-themes/dist/types";

/** Where the chosen theme (light / dark / system) is remembered. */
export const THEME_STORAGE_KEY = "terralabs-theme";

/**
 * Puts `class="dark"` on <html> when the dark theme is active. The app opens in
 * the light theme until the user picks another one from the header.
 */
export function ThemeProvider({ children, ...props }: ThemeProviderProps) {
  return (
    <NextThemesProvider
      attribute="class"
      defaultTheme="light"
      enableSystem
      disableTransitionOnChange
      storageKey={THEME_STORAGE_KEY}
      {...props}
    >
      {children}
    </NextThemesProvider>
  );
}
