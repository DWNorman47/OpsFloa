import { useOffline } from '../contexts/OfflineContext';
import { useT } from '../hooks/useT';
import { useConfirm } from './ConfirmDialog';
import { confirmClearQueue } from '../offlineQueuePolicy';
import { currentOfflineScope } from '../offlineDb';

export default function OfflineBanner() {
  const t = useT();
  const { isOffline, queueCount, sendToSW } = useOffline() || {};
  const { confirm, dialog } = useConfirm();

  if (!isOffline && !queueCount) return dialog;

  const retry = () => sendToSW?.({ type: 'REPLAY_QUEUE' });
  const clear = () => confirmClearQueue({ confirm, t, count: queueCount, sendToSW, scope: currentOfflineScope() });
  const n = queueCount;

  return (
    <>
    {dialog}
    <div
      role="status"
      aria-live="polite"
      aria-atomic="true"
      style={{
        background: '#b45309',
        color: '#fff',
        textAlign: 'center',
        padding: '6px 12px',
        fontSize: '0.85rem',
        fontWeight: 500,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
      }}
    >
      <span>
        {isOffline
          ? n > 0
            ? (n === 1 ? t.offlineBannerQueuedOne : t.offlineBannerQueuedMany.replace('{n}', n))
            : t.offlineNoQueue
          : (n === 1 ? t.offlineBannerPendingOne : t.offlineBannerPendingMany.replace('{n}', n))}
      </span>
      {!isOffline && queueCount > 0 && (
        <>
          <button
            onClick={retry}
            style={{ background: 'rgba(255,255,255,0.25)', border: '1px solid rgba(255,255,255,0.5)', color: '#fff', borderRadius: 5, padding: '2px 10px', fontSize: '0.8rem', fontWeight: 700, cursor: 'pointer' }}
          >
            {t.retry}
          </button>
          <button
            onClick={clear}
            style={{ background: 'none', border: 'none', color: 'rgba(255,255,255,0.7)', fontSize: '0.8rem', cursor: 'pointer', textDecoration: 'underline', padding: 0 }}
          >
            {t.clear}
          </button>
        </>
      )}
    </div>
    </>
  );
}
