import React from 'react';
import { useDocumentMeta } from '../hooks/useDocumentMeta';

export default function EULA() {
  useDocumentMeta({
    title: 'End-User License Agreement — OpsFloa',
    description: 'OpsFloa End-User License Agreement. Terms for using the OpsFloa operations and time tracking platform.',
  });
  return (
    <div style={styles.page}>
      <div style={styles.container}>
        <a href="/" style={styles.back}>← Back to OpsFloa</a>
        <h1 style={styles.h1}>End-User License Agreement</h1>
        <p style={styles.updated}>Last updated: July 22, 2026</p>

        <p style={styles.p}>This End-User License Agreement ("Agreement") is a legal agreement between you and OpsFloa ("Company," "we," "us") governing your use of the OpsFloa software and services available at opsfloa.com ("Service"). By accessing or using the Service, you agree to be bound by this Agreement.</p>

        <h2 style={styles.h2}>1. License Grant</h2>
        <p style={styles.p}>Subject to the terms of this Agreement and payment of applicable fees, we grant you a limited, non-exclusive, non-transferable, revocable license to access and use the Service for your internal business operations during the subscription period.</p>

        <h2 style={styles.h2}>2. Restrictions</h2>
        <p style={styles.p}>You may not:</p>
        <ul style={styles.ul}>
          <li>Copy, modify, or create derivative works of the Service</li>
          <li>Reverse engineer, disassemble, or decompile any part of the Service</li>
          <li>Sublicense, sell, resell, transfer, or otherwise exploit the Service commercially without our written consent</li>
          <li>Use the Service to store or transmit unlawful, harmful, or fraudulent content</li>
          <li>Attempt to gain unauthorized access to any part of the Service or its related systems</li>
          <li>Use the Service in any way that violates applicable laws or regulations</li>
        </ul>

        <h2 style={styles.h2}>3. Accounts and Access</h2>
        <p style={styles.p}>You are responsible for maintaining the confidentiality of your account credentials and for all activity that occurs under your account. You must notify us immediately of any unauthorized use. Each account is for a single company; sharing accounts across unrelated organizations is not permitted.</p>

        <h2 style={styles.h2}>4. Subscription and Payment</h2>
        <p style={styles.p}>Access to the Service requires a paid subscription (after any applicable trial period). Fees are billed in advance on a monthly or annual basis. All fees are non-refundable except as required by law. We reserve the right to change pricing with 30 days' notice.</p>

        <h2 style={styles.h2}>5. Third-Party Integrations</h2>
        <p style={styles.p}>The Service may integrate with third-party platforms such as QuickBooks Online (Intuit Inc.). Your use of those integrations is governed by those platforms' own terms and privacy policies. We are not responsible for third-party services and their availability.</p>

        <h2 style={styles.h2}>6. Data Ownership</h2>
        <p style={styles.p}>You retain ownership of all data you submit to the Service ("Customer Data"). You grant us a limited license to process Customer Data solely to provide the Service. We do not claim ownership of your data.</p>

        <h2 style={styles.h2}>7. Intellectual Property</h2>
        <p style={styles.p}>The Service, including its software, design, and content, is owned by OpsFloa and protected by intellectual property laws. This Agreement does not grant you any rights to our trademarks, logos, or brand features.</p>

        <h2 style={styles.h2}>8. Termination</h2>
        <p style={styles.p}>Either party may terminate this Agreement at any time. We may suspend or terminate your access immediately if you breach this Agreement. Upon termination, your license ends and we may delete your data after a reasonable retention period.</p>

        <h2 style={styles.h2}>9. Disclaimer of Warranties</h2>
        <p style={styles.p}>The Service is provided "as is" and "as available" without warranties of any kind, express or implied, including fitness for a particular purpose or uninterrupted availability. We do not warrant that the Service will be error-free.</p>

        <h2 style={styles.h2}>10. Customer Responsibilities; No Payroll, Tax, or Legal Advice</h2>
        <p style={styles.p}>OpsFloa is a software tool. It is not a payroll provider, professional employer organization, accountant, tax preparer, or legal advisor, and it does not provide payroll, tax, accounting, or legal advice. Features that calculate hours, overtime, pay, deductions, or taxes, or that generate invoices, estimates, or compliance documents (including certified payroll), are provided to assist you, and their outputs are estimates you must review and verify.</p>
        <p style={styles.p}>You are solely responsible for the data you enter and the settings you choose, and for ensuring that the amounts you pay, withhold, or report comply with all applicable wage-and-hour, tax, labor, and other laws in every jurisdiction where you operate. You should confirm figures with a qualified accountant, payroll professional, or attorney before relying on them. To the fullest extent permitted by law, we are not responsible or liable for pay, tax, or compliance decisions you make using the Service.</p>

        <h2 style={styles.h2}>11. Limitation of Liability</h2>
        <p style={styles.p}>To the fullest extent permitted by law, OpsFloa's total liability for any claims arising under this Agreement shall not exceed the fees you paid in the three months preceding the claim. We are not liable for indirect, incidental, consequential, or punitive damages.</p>

        <h2 style={styles.h2}>12. Governing Law</h2>
        <p style={styles.p}>This Agreement is governed by the laws of the State of Texas, without regard to conflict of law principles. Any disputes shall be resolved in the courts of Texas.</p>

        <h2 style={styles.h2}>13. Changes to This Agreement</h2>
        <p style={styles.p}>We may update this Agreement from time to time. Continued use of the Service after notice of changes constitutes acceptance. We will provide at least 14 days' notice of material changes.</p>

        <h2 style={styles.h2}>14. Contact</h2>
        <p style={styles.p}>Questions about this Agreement? Contact us at <a href="mailto:info@opsfloa.com" style={styles.link}>info@opsfloa.com</a>.</p>
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
