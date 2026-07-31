const axios = require('axios');
const pool = require('../db');
const { encrypt, decrypt } = require('./encryption');
const { sendEmail } = require('../email');

const IS_PRODUCTION = process.env.QBO_ENVIRONMENT === 'production';
const QBO_BASE = IS_PRODUCTION
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';
const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const AUTH_URL = 'https://appcenter.intuit.com/connect/oauth2';

function getAuthUrl(state) {
  const params = new URLSearchParams({
    client_id: process.env.QBO_CLIENT_ID,
    response_type: 'code',
    scope: 'com.intuit.quickbooks.accounting',
    redirect_uri: process.env.QBO_REDIRECT_URI,
    state,
    prompt: 'login',
  });
  return `${AUTH_URL}?${params}`;
}

function basicAuthHeader() {
  return 'Basic ' + Buffer.from(`${process.env.QBO_CLIENT_ID}:${process.env.QBO_CLIENT_SECRET}`).toString('base64');
}

async function notifyDisconnect(companyId) {
  try {
    const setting = await pool.query(
      `SELECT value FROM settings WHERE company_id = $1 AND key = 'notify_qbo_disconnect'`,
      [companyId]
    );
    if (setting.rows[0]?.value !== '1') return;
    const admins = await pool.query(
      `SELECT email, full_name FROM users WHERE company_id = $1 AND role IN ('admin','superadmin') AND active = true AND email IS NOT NULL`,
      [companyId]
    );
    for (const admin of admins.rows) {
      sendEmail(admin.email, 'QuickBooks disconnected — action required',
        `<p>Hi ${admin.full_name},</p><p>Your QuickBooks Online connection for OpsFloa has expired or been revoked. Auto-sync of time entries and expenses has <b>paused</b> until you reconnect.</p><p>To restore the connection, go to <b>Administration → QuickBooks</b> and click Reconnect.</p><p>— OpsFloa</p>`);
    }
  } catch (e) { /* non-fatal */ }
}

async function exchangeCode(code) {
  const r = await axios.post(TOKEN_URL,
    new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: process.env.QBO_REDIRECT_URI }),
    { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
  );
  return r.data;
}

async function refreshAccessToken(companyId) {
  const result = await pool.query('SELECT qbo_refresh_token FROM companies WHERE id = $1', [companyId]);
  const refreshToken = decrypt(result.rows[0]?.qbo_refresh_token);
  if (!refreshToken) throw new Error('QuickBooks not connected');

  try {
    const r = await axios.post(TOKEN_URL,
      new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken }),
      { headers: { Authorization: basicAuthHeader(), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );

    const expiresAt = new Date(Date.now() + r.data.expires_in * 1000);
    await pool.query(
      'UPDATE companies SET qbo_access_token = $1, qbo_refresh_token = $2, qbo_token_expires_at = $3 WHERE id = $4',
      [encrypt(r.data.access_token), encrypt(r.data.refresh_token), expiresAt, companyId]
    );
    return r.data.access_token;
  } catch (err) {
    // Any auth failure from the token endpoint means we can't recover — mark disconnected
    const status = err.response?.status;
    const errorCode = err.response?.data?.error;
    const isAuthFailure = status === 400 && (errorCode === 'invalid_grant' || errorCode === 'Token expired')
      || status === 401
      || status === 403;
    if (isAuthFailure) {
      await pool.query(
        `UPDATE companies
         SET qbo_access_token = NULL, qbo_refresh_token = NULL,
             qbo_token_expires_at = NULL, qbo_disconnected = true
         WHERE id = $1`,
        [companyId]
      );
      notifyDisconnect(companyId);
      const authErr = new Error('QuickBooks authorization expired. Please reconnect your QuickBooks account.');
      authErr.code = 'qbo_auth_expired';
      throw authErr;
    }
    throw err;
  }
}

async function getAccessToken(companyId) {
  const result = await pool.query(
    'SELECT qbo_access_token, qbo_token_expires_at FROM companies WHERE id = $1',
    [companyId]
  );
  const row = result.rows[0];
  if (!row?.qbo_access_token) throw new Error('QuickBooks not connected');
  // Refresh if expiring within 5 minutes
  if (new Date(row.qbo_token_expires_at) < new Date(Date.now() + 5 * 60 * 1000)) {
    return refreshAccessToken(companyId);
  }
  return decrypt(row.qbo_access_token);
}

async function qboGet(companyId, path) {
  const token = await getAccessToken(companyId);
  const realmResult = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
  const realmId = decrypt(realmResult.rows[0].qbo_realm_id);
  try {
    const r = await axios.get(`${QBO_BASE}/v3/company/${realmId}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
    });
    const tid = r.headers['intuit_tid'];
    if (tid) console.log(`[QBO] intuit_tid=${tid} path=${path}`);
    return r.data;
  } catch (err) {
    if (err.response?.status === 401 || err.response?.status === 403) {
      await pool.query(
        `UPDATE companies SET qbo_access_token = NULL, qbo_refresh_token = NULL,
         qbo_token_expires_at = NULL, qbo_disconnected = true WHERE id = $1`,
        [companyId]
      );
      notifyDisconnect(companyId);
      const authErr = new Error('QuickBooks authorization expired. Please reconnect your QuickBooks account.');
      authErr.code = 'qbo_auth_expired';
      throw authErr;
    }
    throw err;
  }
}

async function qboPost(companyId, path, body) {
  const token = await getAccessToken(companyId);
  const realmResult = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
  const realmId = decrypt(realmResult.rows[0].qbo_realm_id);

  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const r = await axios.post(`${QBO_BASE}/v3/company/${realmId}${path}`, body, {
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
      });
      const tid = r.headers['intuit_tid'];
      if (tid) console.log(`[QBO] intuit_tid=${tid} path=${path}`);
      return r.data;
    } catch (err) {
      lastErr = err;
      if (err.response?.status === 429) {
        // Respect Retry-After header if present, otherwise exponential backoff
        const retryAfter = parseInt(err.response.headers['retry-after'] || '0', 10);
        const delay = retryAfter > 0 ? retryAfter * 1000 : (attempt + 1) * 2000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function getCompanyInfo(companyId) {
  const realmResult = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
  const realmId = decrypt(realmResult.rows[0].qbo_realm_id);
  const data = await qboGet(companyId, `/companyinfo/${realmId}?minorversion=65`);
  return data.CompanyInfo || null;
}

async function listEmployees(companyId) {
  const data = await qboGet(companyId, '/query?query=SELECT * FROM Employee WHERE Active = true MAXRESULTS 1000&minorversion=65');
  return data.QueryResponse?.Employee || [];
}

async function listCustomers(companyId) {
  const data = await qboGet(companyId, '/query?query=SELECT * FROM Customer WHERE Active = true MAXRESULTS 1000&minorversion=65');
  return data.QueryResponse?.Customer || [];
}

async function listVendors(companyId) {
  const data = await qboGet(companyId, '/query?query=SELECT * FROM Vendor WHERE Active = true MAXRESULTS 1000&minorversion=65');
  return data.QueryResponse?.Vendor || [];
}

async function listItems(companyId) {
  const data = await qboGet(companyId, "/query?query=SELECT * FROM Item WHERE Active = true AND Type IN ('Service', 'NonInventory') MAXRESULTS 1000&minorversion=65");
  return data.QueryResponse?.Item || [];
}

async function createInvoice(companyId, { customerId, itemId, amount, description, docNumber, txnDate }) {
  const body = {
    CustomerRef: { value: String(customerId) },
    TxnDate: txnDate || new Date().toLocaleDateString('en-CA'),
    ...(docNumber ? { DocNumber: String(docNumber) } : {}),
    Line: [
      {
        Amount: parseFloat(amount.toFixed(2)),
        DetailType: 'SalesItemLineDetail',
        Description: description || '',
        SalesItemLineDetail: {
          ItemRef: { value: String(itemId) },
          Qty: 1,
          UnitPrice: parseFloat(amount.toFixed(2)),
        },
      },
    ],
  };
  const data = await qboPost(companyId, '/invoice?minorversion=65', body);
  return data.Invoice;
}

async function listAccounts(companyId) {
  const data = await qboGet(companyId, '/query?query=SELECT * FROM Account WHERE Active = true MAXRESULTS 1000&minorversion=65');
  return data.QueryResponse?.Account || [];
}

async function createPurchase(companyId, { bankAccountId, expenseAccountId, vendorId, amount, description, txnDate }) {
  const body = {
    PaymentType: 'Cash',
    AccountRef: { value: String(bankAccountId) },
    TxnDate: txnDate || new Date().toLocaleDateString('en-CA'),
    Line: [
      {
        Amount: parseFloat(amount.toFixed(2)),
        DetailType: 'AccountBasedExpenseLineDetail',
        Description: description || '',
        AccountBasedExpenseLineDetail: {
          AccountRef: { value: String(expenseAccountId) },
        },
      },
    ],
  };
  if (vendorId) body.EntityRef = { value: String(vendorId), type: 'Vendor' };
  const data = await qboPost(companyId, '/purchase?minorversion=65', body);
  return data.Purchase;
}

/**
 * Create a QBO Bill for a vendor with a mix of item-based (labor) and
 * account-based (reimbursement) line items.
 *
 * lines: Array<
 *   | { type: 'item',    itemId, qty, unitPrice, description, customerId?, classId? }
 *   | { type: 'account', accountId, amount,                 description, customerId?, classId? }
 * >
 */
async function createBill(companyId, { vendorId, txnDate, dueDate, memo, lines }) {
  const qboLines = lines.map(l => {
    if (l.type === 'item') {
      const amount = parseFloat((l.qty * l.unitPrice).toFixed(2));
      return {
        DetailType: 'ItemBasedExpenseLineDetail',
        Amount: amount,
        Description: l.description || '',
        ItemBasedExpenseLineDetail: {
          ItemRef: { value: String(l.itemId) },
          UnitPrice: parseFloat(l.unitPrice.toFixed(2)),
          Qty: parseFloat(l.qty.toFixed(2)),
          ...(l.classId ? { ClassRef: { value: String(l.classId) } } : {}),
          ...(l.customerId ? { CustomerRef: { value: String(l.customerId) }, BillableStatus: 'NotBillable' } : {}),
        },
      };
    }
    return {
      DetailType: 'AccountBasedExpenseLineDetail',
      Amount: parseFloat(l.amount.toFixed(2)),
      Description: l.description || '',
      AccountBasedExpenseLineDetail: {
        AccountRef: { value: String(l.accountId) },
        ...(l.classId ? { ClassRef: { value: String(l.classId) } } : {}),
        ...(l.customerId ? { CustomerRef: { value: String(l.customerId) }, BillableStatus: 'NotBillable' } : {}),
      },
    };
  });
  const body = {
    VendorRef: { value: String(vendorId) },
    TxnDate: txnDate || new Date().toLocaleDateString('en-CA'),
    ...(dueDate ? { DueDate: dueDate } : {}),
    ...(memo ? { PrivateNote: memo } : {}),
    Line: qboLines,
  };
  const data = await qboPost(companyId, '/bill?minorversion=65', body);
  return data.Bill;
}

async function pushTimeActivity(companyId, { employeeId, vendorId, customerId, classId, workDate, hours, description }) {
  const useVendor = !!vendorId;
  const body = {
    NameOf: useVendor ? 'Vendor' : 'Employee',
    ...(useVendor
      ? { VendorRef: { value: String(vendorId) } }
      : { EmployeeRef: { value: String(employeeId) } }),
    CustomerRef: { value: String(customerId) },
    ...(classId ? { ClassRef: { value: String(classId) } } : {}),
    TxnDate: workDate,
    Hours: Math.floor(hours),
    Minutes: Math.round((hours % 1) * 60),
    Description: description || '',
  };
  const data = await qboPost(companyId, '/timeactivity?minorversion=65', body);
  return data.TimeActivity;
}

async function deleteTimeActivity(companyId, activityId) {
  // QBO delete via POST with operation=delete (soft delete)
  const token = await getAccessToken(companyId);
  const realmResult = await pool.query('SELECT qbo_realm_id FROM companies WHERE id = $1', [companyId]);
  const realmId = decrypt(realmResult.rows[0].qbo_realm_id);
  const current = await axios.get(`${QBO_BASE}/v3/company/${realmId}/timeactivity/${activityId}?minorversion=65`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
  });
  const activity = current.data.TimeActivity;
  const body = { ...activity, SyncToken: activity.SyncToken, sparse: true };
  await axios.post(`${QBO_BASE}/v3/company/${realmId}/timeactivity?operation=delete&minorversion=65`, body, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/json', 'Content-Type': 'application/json' },
  });
}

async function listClasses(companyId) {
  const data = await qboGet(companyId, '/query?query=SELECT * FROM Class WHERE Active = true MAXRESULTS 1000&minorversion=65');
  return data.QueryResponse?.Class || [];
}

async function getInvoice(companyId, invoiceId) {
  const data = await qboGet(companyId, `/invoice/${invoiceId}?minorversion=65`);
  return data.Invoice || null;
}

async function createVendor(companyId, { displayName }) {
  const body = { DisplayName: displayName };
  const data = await qboPost(companyId, '/vendor?minorversion=65', body);
  return data.Vendor;
}

async function createCustomer(companyId, { displayName }) {
  const body = { DisplayName: displayName };
  const data = await qboPost(companyId, '/customer?minorversion=65', body);
  return data.Customer;
}

async function createJournalEntry(companyId, { txnDate, description, debitAccountId, creditAccountId, amount, requestId }) {
  const body = {
    TxnDate: txnDate || new Date().toLocaleDateString('en-CA'),
    PrivateNote: description || '',
    Line: [
      {
        JournalEntryLineDetail: { PostingType: 'Debit', AccountRef: { value: String(debitAccountId) } },
        DetailType: 'JournalEntryLineDetail',
        Amount: parseFloat(amount.toFixed(2)),
        Description: description || '',
      },
      {
        JournalEntryLineDetail: { PostingType: 'Credit', AccountRef: { value: String(creditAccountId) } },
        DetailType: 'JournalEntryLineDetail',
        Amount: parseFloat(amount.toFixed(2)),
        Description: description || '',
      },
    ],
  };
  const params = new URLSearchParams({ minorversion: '65' });
  if (requestId) params.set('requestid', String(requestId).slice(0, 50));
  const data = await qboPost(companyId, `/journalentry?${params.toString()}`, body);
  return data.JournalEntry;
}

module.exports = { getAuthUrl, exchangeCode, refreshAccessToken, getCompanyInfo, listEmployees, listCustomers, listVendors, listItems, listAccounts, listClasses, createInvoice, getInvoice, createPurchase, createCustomer, createVendor, createJournalEntry, createBill, deleteTimeActivity, pushTimeActivity };
