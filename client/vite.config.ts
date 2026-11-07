import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

/** True for addresses that mean "this machine": localhost, 127.0.0.0/8, ::1, 0.0.0.0 and their IPv6 forms. */
function isLoopbackHost(hostname: string) {
  // URL has already normalised the host (127.1 → 127.0.0.1, [::ffff:127.0.0.1] → [::ffff:7f00:1]).
  const host = hostname.replace(/^\[|\]$/g, "").replace(/\.$/, "").toLowerCase();
  return (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    /^127\.\d+\.\d+\.\d+$/.test(host) ||
    host === "0.0.0.0" ||
    host === "::" ||
    host === "::1" ||
    /^::ffff:7f[0-9a-f]{2}:[0-9a-f]{1,4}$/.test(host) ||
    host === "::ffff:0:0"
  );
}

/**
 * The hosted web app (`vite build`, production mode) must be built against a
 * real API. Missing, it would fall back to http://localhost:4001; on a
 * loopback address it would call the visitor's own machine. Either way every
 * visitor gets a broken app, so the build stops. The dev server, development
 * builds (`build:dev`) and the desktop build (`--mode desktop`, whose API
 * address comes from Electron at runtime) are not checked.
 */
function requireApiUrl(command: string, mode: string) {
  if (command !== "build" || mode !== "production") return;
  const apiUrl = loadEnv(mode, process.cwd(), "VITE_").VITE_API_URL?.trim();
  const fix = "Set VITE_API_URL to the hosted API, e.g. https://api.example.com/api, in the hosting provider's environment variables.";
  if (!apiUrl) {
    throw new Error(`VITE_API_URL is not set. A production build needs the API address. ${fix}`);
  }
  let url: URL;
  try {
    url = new URL(apiUrl);
  } catch {
    throw new Error(`VITE_API_URL (${apiUrl}) is not a full http(s) address. ${fix}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`VITE_API_URL (${apiUrl}) is not a full http(s) address. ${fix}`);
  }
  if (isLoopbackHost(url.hostname)) {
    throw new Error(
      `VITE_API_URL points at ${apiUrl}, which is the visitor's own machine, not a hosted API. ${fix} ` +
        "For a local build against a local backend use `npm run build:dev`."
    );
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
