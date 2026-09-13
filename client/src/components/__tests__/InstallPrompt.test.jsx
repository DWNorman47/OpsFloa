import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { fireEvent } from '@testing-library/react';
import InstallPrompt from '../InstallPrompt';
import { renderWithProviders } from '../../__tests__/test-helpers';

const originalUserAgentDescriptor = Object.getOwnPropertyDescriptor(navigator, 'userAgent');

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
});

afterEach(() => {
  vi.unstubAllGlobals();
  if (originalUserAgentDescriptor) {
    Object.defineProperty(navigator, 'userAgent', originalUserAgentDescriptor);
  } else {
    Reflect.deleteProperty(navigator, 'userAgent');
  }
  localStorage.clear();
});

function dispatchInstallPrompt() {
  const event = new Event('beforeinstallprompt', { cancelable: true });
  fireEvent(window, event);
  return event;
}

describe('InstallPrompt browser banner handling', () => {
  test('leaves the desktop browser install prompt alone', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Desktop Chrome' });
    renderWithProviders(<InstallPrompt />);
    expect(dispatchInstallPrompt().defaultPrevented).toBe(false);
  });

  test('defers Android install prompt for the in-app install button', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android Chrome' });
    renderWithProviders(<InstallPrompt />);
    expect(dispatchInstallPrompt().defaultPrevented).toBe(true);
  });

  test('does not defer the prompt on iOS', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'iPhone Safari' });
    renderWithProviders(<InstallPrompt />);
    expect(dispatchInstallPrompt().defaultPrevented).toBe(false);
  });

  test('does not defer the prompt when already installed', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android Chrome' });
    vi.stubGlobal('matchMedia', () => ({ matches: true }));
    renderWithProviders(<InstallPrompt />);
    expect(dispatchInstallPrompt().defaultPrevented).toBe(false);
  });

  test('leaves the browser prompt alone after the in-app banner was dismissed', () => {
    Object.defineProperty(navigator, 'userAgent', { configurable: true, value: 'Android Chrome' });
    localStorage.setItem('install_prompt_dismissed', '1');
    renderWithProviders(<InstallPrompt />);
    expect(dispatchInstallPrompt().defaultPrevented).toBe(false);
  });
});
