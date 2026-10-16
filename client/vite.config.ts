import { defineConfig } from "vite";
import react from "@vitejs/plugin-react-swc";
import path from "path";
import { componentTagger } from "lovable-tagger";

// https://vitejs.dev/config/
// `--mode desktop` builds the bundle that Electron ships. It writes to its own
// folder so a desktop build can never overwrite the web build in dist/, and the
// web build is byte-for-byte unchanged by any of this.
export default defineConfig(({ mode }) => ({
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
}));
