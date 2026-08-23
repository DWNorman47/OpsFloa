// Shared "unread company chat" signal. The header MessagesBell is the single poller of
// /chat; the Dashboard's Messages-tab dot subscribes here instead of polling /chat a
// second time. Plain module-level pub/sub — no provider wiring needed, works regardless
// of where in the tree the reader/writer sit.
let value = false;
const subscribers = new Set();

export function setChatUnread(next) {
  const v = !!next;
  if (v === value) return;
  value = v;
  subscribers.forEach(fn => { try { fn(value); } catch { /* ignore */ } });
}

export function getChatUnread() {
  return value;
}

export function subscribeChatUnread(fn) {
  subscribers.add(fn);
  return () => subscribers.delete(fn);
}
