import { safeLocal } from './utils/safeStorage';

// Admin company-chat unread is server-side (per-admin read markers, company_chat_reads — see
// server/routes/chat.js): each thread from GET /chat carries `unread` = the worker's messages this
// admin hasn't seen. AdminDashboard's Live-tab dot still compares a thread's `last_at` to the old
// per-worker localStorage key, so whenever the server says a thread is read we move that key up to
// the thread's SERVER `last_at` (no client clock involved) and the dot agrees.
export function syncLegacyAdminReadKey(thread) {
  if (!thread || thread.unread > 0 || !thread.last_at) return;
  const at = new Date(thread.last_at);
  if (Number.isNaN(at.getTime())) return;
  const key = `chatLastRead_admin_${thread.worker_id}`;
  const cur = safeLocal.getItem(key);
  if (!cur || new Date(cur) < at) safeLocal.setItem(key, at.toISOString());
}
