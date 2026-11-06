import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

/**
 * The hosted web app must be built against a real API. Without VITE_API_URL
 * the client would fall back to http://localhost:4001 — the visitor's own
 * machine — so a production build stops instead. The dev server, development
 * builds and the desktop build (whose API address comes from Electron at
 * runtime) keep working without it.
 */
function requireApiUrl(command: string, mode: string) {
  if (command !== "build" || mode !== "production") return;
  const apiUrl = loadEnv(mode, process.cwd(), "VITE_").VITE_API_URL?.trim();
  if (!apiUrl) {
    throw new Error(
      "VITE_API_URL is not set. A production build needs the API address, e.g. VITE_API_URL=https://api.example.com/api (set it in the hosting provider's environment variables)."
    );
  }
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(apiUrl)) {
    console.warn(`\n⚠ VITE_API_URL points at ${apiUrl}. This production build will only work on the machine running that API.\n`);
  }
}

// https://vitejs.dev/config/
// `--mode desktop` builds the bundle that Electron ships. It writes to its own
// folder so a desktop build can never overwrite the web build in dist/, and the
// web build is byte-for-byte unchanged by any of this.
export default defineConfig(({ command, mode }) => {
  requireApiUrl(command, mode);
  return {
    server: {
      host: "::",
      port: 8080,
    },
    plugins: [
      react(),
      mode === 'development' &&
      componentTagger(),
    ].filter(Boolean),
    resolve: {
      alias: {
        "@": path.resolve(__dirname, "./src"),
      },
    },
    // Release builds drop debug logging (console.log/debug/info); warnings and
    // errors stay so real problems still reach the browser console.
    esbuild: mode === 'development' ? {} : { pure: ['console.log', 'console.debug', 'console.info'] },
    build: {
      outDir: mode === 'desktop' ? 'dist-desktop' : 'dist',
      assetsDir: 'assets',
      rollupOptions: {
        output: {
          assetFileNames: (assetInfo) => {
            const info = assetInfo.name?.split('.') || [];
            const ext = info[info.length - 1] || '';
            if (/\.(png|jpe?g|gif|svg|webp|ico)$/i.test(assetInfo.name || '')) {
              return `assets/images/[name]-[hash][extname]`;
            }
            return `assets/[name]-[hash][extname]`;
          },
        },
      },
    },
  };
});
