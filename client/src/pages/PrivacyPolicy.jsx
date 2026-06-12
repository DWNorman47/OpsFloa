import React from 'react';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

export default function PrivacyPolicy() {
  useDocumentMeta({
    title: 'Privacy Policy - OpsFloa',
    description: 'How OpsFloa collects, uses, and protects your data for team time tracking, operations, and payroll.',
  });

  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <a href="/" style={styles.back}>Back to OpsFloa</a>
        <h1 style={styles.h1}>Privacy Policy</h1>
        <p style={styles.updated}>Last updated: March 21, 2025</p>

        <p style={styles.p}>OpsFloa ("we," "our," or "us") operates opsfloa.com and provides workforce management software for mobile teams and service businesses. This Privacy Policy explains how we collect, use, and protect your information.</p>

        <h2 style={styles.h2}>1. Information We Collect</h2>
        <p style={styles.p}><strong>Account information:</strong> When you register, we collect your company name, name, email address, and password (stored as a secure hash).</p>
        <p style={styles.p}><strong>Usage data:</strong> Time entries, work assignments, clock-in/out records, GPS coordinates (when location features are used), and reports submitted through the app.</p>
        <p style={styles.p}><strong>Device and browser data:</strong> IP address, browser type, and device identifiers for security and session management.</p>
        <p style={styles.p}><strong>Payment information:</strong> Billing is processed by Stripe. We do not store your credit card numbers. We receive billing status and subscription metadata from Stripe.</p>
        <p style={styles.p}><strong>QuickBooks data:</strong> If you connect QuickBooks Online, we store OAuth tokens (encrypted) to sync time entries on your behalf. We only access the data necessary to push time activities.</p>

        <h2 style={styles.h2}>2. How We Use Your Information</h2>
        <ul style={styles.ul}>
          <li>Provide, maintain, and improve the OpsFloa service</li>
          <li>Process time entries and generate timesheets and reports</li>
          <li>Send transactional emails such as password resets, invitations, and approvals</li>
          <li>Sync data with connected third-party services you authorize, such as QuickBooks</li>
          <li>Detect and prevent fraud, abuse, and security incidents</li>
          <li>Comply with legal obligations</li>
        </ul>

        <h2 style={styles.h2}>3. Data Sharing</h2>
        <p style={styles.p}>We do not sell your personal data. We share data only with:</p>
        <ul style={styles.ul}>
          <li><strong>Service providers:</strong> Hosting, database, email, payments, and analytics only as necessary to operate the service.</li>
          <li><strong>Intuit/QuickBooks:</strong> When you connect QuickBooks, we exchange data with Intuit's API per your authorization.</li>
          <li><strong>Legal requirements:</strong> If required by law or to protect the rights and safety of users.</li>
        </ul>

        <h2 style={styles.h2}>4. Data Security</h2>
        <p style={styles.p}>We use industry-standard security measures including encryption for sensitive credentials, TLS in transit, hashed passwords, and multi-factor authentication. Access to production systems is restricted and logged.</p>

        <h2 style={styles.h2}>5. Data Retention</h2>
        <p style={styles.p}>We retain your account data for as long as your account is active. You may request deletion of your account and associated data by emailing us. Certain records may be retained as required by law.</p>

        <h2 style={styles.h2}>6. Your Rights</h2>
        <p style={styles.p}>You may access, correct, or request deletion of your personal data by contacting us. If you are in the EU/EEA, you have additional rights under GDPR including portability and the right to object to processing.</p>

        <h2 style={styles.h2}>7. Cookies</h2>
        <p style={styles.p}>We use essential session cookies and local storage tokens for authentication. We do not use advertising or tracking cookies.</p>

        <h2 style={styles.h2}>8. Children's Privacy</h2>
        <p style={styles.p}>OpsFloa is not directed at children under 13. We do not knowingly collect data from children.</p>

        <h2 style={styles.h2}>9. Changes to This Policy</h2>
        <p style={styles.p}>We may update this policy from time to time. We will notify you of material changes by email or by posting a notice in the app.</p>

        <h2 style={styles.h2}>10. Contact Us</h2>
        <p style={styles.p}>For privacy questions or requests, contact us at <a href="mailto:info@opsfloa.com" style={styles.link}>info@opsfloa.com</a>.</p>
      </div>
    </div>
  );
}

const styles = {
  page: { minHeight: '100vh', background: '#f9fafb', padding: '40px 16px' },
  container: { maxWidth: 720, margin: '0 auto', background: '#fff', borderRadius: 12, padding: '40px 48px', boxShadow: '0 1px 8px rgba(0,0,0,0.07)' },
  back: { color: 'var(--ops-page-accent)', textDecoration: 'none', fontSize: 14, display: 'inline-block', marginBottom: 24 },
  h1: { fontSize: 28, fontWeight: 700, color: '#111827', marginBottom: 4 },
  h2: { fontSize: 18, fontWeight: 700, color: '#111827', marginTop: 28, marginBottom: 8 },
  updated: { fontSize: 13, color: '#6b7280', marginBottom: 24 },
  p: { fontSize: 15, color: '#374151', lineHeight: 1.7, marginBottom: 12 },
  ul: { fontSize: 15, color: '#374151', lineHeight: 1.7, marginBottom: 12, paddingLeft: 24 },
  link: { color: 'var(--ops-page-accent)' },
};
