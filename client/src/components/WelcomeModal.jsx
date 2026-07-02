import React from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useT } from '../hooks/useT';
import { useModalA11y } from '../hooks/useModalA11y';

function WelcomeModalInner({ isAdmin, firstName, handleStart, t }) {
  const modalRef = useModalA11y(handleStart);
  const adminSteps = [t.wmAdminStep1, t.wmAdminStep2, t.wmAdminStep3];
  const workerSteps = [t.wmWorkerStep1, t.wmWorkerStep2, t.wmWorkerStep3];
  const steps = isAdmin ? adminSteps : workerSteps;

  return (
    <div style={styles.overlay} onClick={e => { if (e.target === e.currentTarget) handleStart(); }}>
      <div ref={modalRef} role="dialog" aria-modal="true" aria-labelledby="welcome-modal-title" style={styles.modal}>
        <div style={styles.markRow}>
          <img src="/icon-96x96.png" alt="" style={styles.mark} />
          <span style={styles.brand}>OpsFloa</span>
        </div>
        <h2 id="welcome-modal-title" style={styles.title}>
          {isAdmin ? t.wmAdminTitle.replace('{name}', firstName) : t.wmWorkerTitle.replace('{name}', firstName)}
        </h2>
        <p style={styles.body}>
          {isAdmin ? t.wmAdminBody : t.wmWorkerBody}
        </p>
        <div style={styles.steps}>
          {steps.map((step, index) => (
            <div key={step} style={styles.step}>
              <span style={styles.stepNum}>{index + 1}</span>
              <span>{step}</span>
            </div>
          ))}
        </div>
        <button style={styles.btn} onClick={handleStart}>
          {isAdmin ? t.wmSetUpCompany : t.welcomeGotIt}
        </button>
      </div>
    </div>
  );
}

export default function WelcomeModal() {
  const { user, firstLogin, clearFirstLogin } = useAuth();
  const navigate = useNavigate();
  const t = useT();
  if (!firstLogin || !user) return null;

  const firstName = user.first_name || user.full_name?.split(' ')[0] || user.username;
  const isAdmin = user.role === 'admin' || user.role === 'super_admin';

  const handleStart = () => {
    clearFirstLogin();
    if (isAdmin) navigate('/administration');
  };

  return (
    <WelcomeModalInner
      isAdmin={isAdmin}
      firstName={firstName}
      handleStart={handleStart}
      t={t}
    />
  );
}

const styles = {
  overlay: { position: 'fixed', inset: 0, background: 'rgba(15,23,42,0.72)', zIndex: 1000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 24 },
  modal: { background: '#f8fafc', borderRadius: 14, padding: '30px', maxWidth: 460, width: '100%', boxShadow: '0 26px 80px rgba(0,0,0,0.32)', display: 'flex', flexDirection: 'column', gap: 16, border: '1px solid rgba(148,163,184,0.35)' },
  markRow: { display: 'flex', alignItems: 'center', gap: 10 },
  mark: { width: 36, height: 36, objectFit: 'contain', flexShrink: 0 },
  brand: { fontSize: 12, fontWeight: 800, color: '#475569', textTransform: 'uppercase', letterSpacing: '0.12em' },
  title: { fontSize: 25, fontWeight: 850, color: '#0f172a', margin: 0, lineHeight: 1.15 },
  body: { fontSize: 14, color: '#475569', lineHeight: 1.7, margin: 0 },
  steps: { display: 'grid', gap: 8 },
  step: { display: 'flex', alignItems: 'center', gap: 10, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 9, padding: '10px 12px', fontSize: 14, color: '#1e293b', fontWeight: 650 },
  stepNum: { width: 24, height: 24, borderRadius: 6, background: '#d9f99d', color: '#365314', display: 'inline-flex', alignItems: 'center', justifyContent: 'center', fontSize: 12, fontWeight: 850, flexShrink: 0 },
  btn: { marginTop: 2, padding: '12px 18px', background: '#14532d', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 800, fontSize: 15, cursor: 'pointer', alignSelf: 'flex-start' },
};
