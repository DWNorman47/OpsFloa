import api from '../api';
import { safeLocal } from './safeStorage';

// Web-push subscription helpers shared by the Account page toggle
// (components/NotificationSetup.jsx) and the app-level re-subscribe
// (hooks/usePushResubscribe.js).
//
// Why an app-level re-subscribe: logout removes this browser's subscription
// (AuthContext.logout — a shared phone must not keep getting the previous user's
// pushes). Only NotificationSetup subscribed again, and it's mounted on the
// Account page — so after any logout → login, pushes silently stopped until the
// user happened to open Account. Now every session start re-subscribes when the
// browser permission is already granted (never prompts).

// Set when the user turns notifications off on this device, so the automatic
// re-subscribe respects that choice. Cleared when they turn them back on.
export const PUSH_OPT_OUT_KEY = 'tc_push_opt_out';

export function pushSupported() {
  return typeof window !== 'undefined'
    && typeof navigator !== 'undefined'
    && 'serviceWorker' in navigator
    && 'PushManager' in window
    && typeof Notification !== 'undefined';
}

export function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  return Uint8Array.from([...raw].map(c => c.charCodeAt(0)));
}

export function pushOptedOut() {
  return safeLocal.getItem(PUSH_OPT_OUT_KEY) === '1';
}
export function setPushOptOut(optedOut) {
  if (optedOut) safeLocal.setItem(PUSH_OPT_OUT_KEY, '1');
  else safeLocal.removeItem(PUSH_OPT_OUT_KEY);
}

// Subscribe this browser (reusing an existing subscription) and register it with
// the server for the signed-in user. May show the permission prompt if it hasn't
// been answered — callers that must never prompt check Notification.permission first.
export async function subscribePush(reg) {
  const registration = reg || await navigator.serviceWorker.ready;
  let sub = await registration.pushManager.getSubscription();
  if (!sub) {
    const keyRes = await api.get('/push/vapid-public-key', { suppressToast: true });
    if (!keyRes.data?.publicKey) {
      const err = new Error('push_not_configured');
      err.code = 'push_not_configured';
      throw err;
    }
    sub = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: urlBase64ToUint8Array(keyRes.data.publicKey),
    });
  }
  const { endpoint, keys } = sub.toJSON();
  // Upsert on the server: also moves an endpoint left over from another user of this
  // browser onto the current one (server/routes/push.js).
  await api.post('/push/subscribe', { endpoint, p256dh: keys.p256dh, auth: keys.auth }, { suppressToast: true });
  return sub;
}

// Silent re-subscribe for a freshly started session. Only when the browser has
// ALREADY granted permission and the user hasn't turned pushes off on this device;
// never prompts, never throws. Resolves true when a subscription was registered.
export async function ensurePushSubscription() {
  try {
    if (!pushSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    if (pushOptedOut()) return false;
    // getRegistration (not .ready): .ready never settles when no service worker is
    // registered (e.g. local dev with the SW off).
    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg || !reg.pushManager) return false;
    await subscribePush(reg);
    return true;
  } catch {
    return false;
  }
}
