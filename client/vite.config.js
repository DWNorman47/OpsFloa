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
          '**/react-pdf.browser-*.js',
          '**/ImportItemsModal-*.js',
          '**/vendor-charts-*.js',
          '**/vendor-leaflet-*.js',
          '**/InventoryPage-*.js',
          '**/AdministrationPage-*.js',
          '**/AnalyticsPage-*.js',
          '**/SuperAdmin-*.js',
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
        manualChunks: {
          // Stable vendor libs — cached long-term separately from app code
          'vendor-react': ['react', 'react-dom', 'react-router-dom'],
          'vendor-leaflet': ['leaflet', 'react-leaflet'],
          'vendor-charts': ['recharts'],
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
