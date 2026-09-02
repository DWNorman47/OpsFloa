import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import { readFileSync } from 'fs';
import { execSync } from 'child_process';

const pkg = JSON.parse(readFileSync('./package.json', 'utf8'));
let gitSha = 'dev';
try {
  // Fixed length so the version string is identical across environments
  // (a bare --short can vary in width between machines/clones).
  gitSha = execSync('git rev-parse --short=7 HEAD', { encoding: 'utf8' }).trim();
} catch { /* not a git checkout or git missing — keep 'dev' */ }
const APP_VERSION = `${pkg.version || '0.0.0'}+${gitSha}`;

// Emit a tiny, never-precached version.json the running app can poll to detect
// a newer deploy (compared against the baked-in __APP_VERSION__). Kept out of
// the service worker precache (see globIgnores) and fetched with no-store so it
// always reflects the live build.
function emitVersionJson() {
  return {
    name: 'emit-version-json',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: 'version.json', source: `${JSON.stringify({ version: APP_VERSION })}\n` });
    },
  };
}

// Source maps to Sentry only when all three env vars are present (prod CI).
// Local dev builds skip the upload and the plugin is a no-op.
const sentryPlugins = (process.env.SENTRY_AUTH_TOKEN && process.env.SENTRY_ORG && process.env.SENTRY_PROJECT)
  ? [sentryVitePlugin({
      org: process.env.SENTRY_ORG,
      project: process.env.SENTRY_PROJECT,
      authToken: process.env.SENTRY_AUTH_TOKEN,
      release: { name: APP_VERSION },
      sourcemaps: { assets: './dist/**' },
    })]
  : [];

export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
  },
  plugins: [
    react(),
    emitVersionJson(),
    ...sentryPlugins,
    VitePWA({
      strategies: 'injectManifest',
      srcDir: 'src',
      filename: 'sw.js',
      injectRegister: null,
      manifest: false,
      injectManifest: {
        injectionPoint: 'self.__WB_MANIFEST',
        maximumFileSizeToCacheInBytes: 5 * 1024 * 1024, // 5 MiB
        globIgnores: [
          '**/*.map',
          'version.json', // polled live; must never be precached/served stale
          '**/version.json',
          // The whole video-converter tool-app is kept OUT of the shared precache — most
          // users never convert, so nothing of it should download on every SW install.
          // Instead sw.js caches its files at RUNTIME (on first fetch), so they only ever
          // enter the cache for someone who actually opens the converter. It still works
          // offline after the first run.
          '**/tool-apps/videoconvert/**',
          'bootwatch.js', // the blank-screen recovery watchdog: never precache it, so the
          '**/bootwatch.js', // newest recovery logic is always fetched fresh (must-revalidate)
          '**/react-pdf.browser-*.js',
          '**/ImportItemsModal-*.js',
          '**/vendor-charts-*.js',
          '**/vendor-leaflet-*.js',
          '**/InventoryPage-*.js',
          // Admin chunks: "admin" is stripped from filenames (see chunkFileNames)
          // so these patterns match the sanitized names.
          '**/mgmtistrationPage-*.js',
          '**/Supermgmt-*.js',
          '**/ProjectsPage-*.js',
          '**/ManageSchedule-*.js',
          '**/ManageWorkers-*.js',
        ],
      },
    }),
  ],
  build: {
    // Required so Sentry can symbolicate — the plugin strips these from the
    // final bundle after upload, so they don't ship to users.
    sourcemap: sentryPlugins.length > 0,
    rollupOptions: {
      output: {
        manualChunks: (id) => {
          // Stable vendor libs — cached long-term separately from app code
          if (!id.includes('node_modules')) return undefined;
          if (/[\\/]node_modules[\\/](react|react-dom|react-router|react-router-dom)[\\/]/.test(id)) {
            return 'vendor-react';
          }
          if (/[\\/]node_modules[\\/](leaflet|react-leaflet)[\\/]/.test(id)) {
            return 'vendor-leaflet';
          }
          if (/[\\/]node_modules[\\/]recharts[\\/]/.test(id)) {
            return 'vendor-charts';
          }
          return undefined;
        },
        // Corporate web filters commonly block any asset URL containing
        // "admin", which silently 404'd the lazily-loaded admin/superadmin
        // route chunks (they're network-fetched, not precached) and broke
        // those pages behind such networks. Strip the keyword from emitted
        // filenames so they load everywhere. Names stay otherwise readable so
        // the precache globIgnores below can still target specific chunks.
        chunkFileNames: (chunkInfo) => {
          const safe = (chunkInfo.name || 'chunk').replace(/admin/gi, 'mgmt');
          return `assets/${safe}-[hash].js`;
        },
        assetFileNames: (assetInfo) => {
          const n = assetInfo.name || '';
          if (!/admin/i.test(n)) return 'assets/[name]-[hash][extname]';
          const dot = n.lastIndexOf('.');
          const ext = dot >= 0 ? n.slice(dot) : '';
          const base = (dot >= 0 ? n.slice(0, dot) : n).replace(/admin/gi, 'mgmt');
          return `assets/${base}-[hash]${ext}`;
        },
      },
    },
  },
  server: {
    host: '0.0.0.0',
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
  test: {
    // jsdom gives the React Testing Library suite a window/document; the
    // older non-DOM tests (utils.test.js, i18n.test.js) don't care either way.
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.js'],
  },
});
