import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import CertifiedPayrollSignature from './CertifiedPayrollSignature';
import api from '../api';

vi.mock('../api', () => ({
  default: { get: vi.fn(), post: vi.fn() },
  errorCodeMessage: (err) => (err?.response?.data?.code === 'report_changed' ? 'apiReportChanged' : null),
}));
vi.mock('../contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 1, language: 'English' } }) }));
vi.mock('../hooks/useT', () => ({ useT: () => new Proxy({}, { get: (_t, k) => String(k) }) }));
vi.mock('./ModalShell', () => ({ default: ({ children }) => <div>{children}</div> }));

const HASH = 'a'.repeat(64);

describe('CertifiedPayrollSignature — signs the report that was reviewed', () => {
  beforeEach(() => {
    api.get.mockReset(); api.post.mockReset();
    api.get.mockResolvedValue({ data: { default_compliance_text: 'text', signature: null } });
  });

  function fillAndSign() {
    fireEvent.change(screen.getByPlaceholderText('cpsTypedSignaturePlaceholder'), { target: { value: 'Ana' } });
    fireEvent.click(screen.getByText('cpsSign'));
  }

  test('sends the viewed report_hash with the signature', async () => {
    api.post.mockResolvedValue({ data: { signature: { signer_name: 'Ana' } } });
    render(<CertifiedPayrollSignature weekEnding="2026-09-20" reportHash={HASH} defaultName="Ana" />);
    fillAndSign();
    await waitFor(() => expect(api.post).toHaveBeenCalled());
    expect(api.post.mock.calls[0][1]).toMatchObject({ week_ending: '2026-09-20', report_hash: HASH });
  });

  test('a 409 report_changed shows the translated message', async () => {
    api.post.mockRejectedValue({ response: { status: 409, data: { code: 'report_changed', error: 'raw' } } });
    render(<CertifiedPayrollSignature weekEnding="2026-09-20" reportHash={HASH} defaultName="Ana" />);
    fillAndSign();
    expect(await screen.findByRole('alert')).toHaveTextContent('apiReportChanged');
  });
});
