import '@testing-library/jest-dom/vitest';
import { afterEach, vi } from 'vitest';
import { cleanup } from '@testing-library/react';
import { loadLanguage } from './i18n';

// Translations are lazy-loaded per language in the app (main.jsx awaits the
// active one before rendering). Tests render components directly, so load both
// up front to keep getT()/useT() synchronous here too.
await Promise.all([loadLanguage('English'), loadLanguage('Spanish')]);

// RTL doesn't auto-cleanup with vitest — unmount rendered trees between tests
afterEach(() => cleanup());

// jsdom doesn't implement matchMedia; several components use it to detect
// PWA display mode or prefers-reduced-motion. Polyfill as a permissive stub.
if (typeof window !== 'undefined' && !window.matchMedia) {
  window.matchMedia = vi.fn().mockImplementation((query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }));
}

// Silence act() warnings from React 18 async effects in tests — we await
// act() around the renders, but some lazy/Suspense internals flush after.
const originalError = console.error;
console.error = (...args) => {
  if (typeof args[0] === 'string' && args[0].includes('not configured to support act')) return;
  originalError(...args);
};
