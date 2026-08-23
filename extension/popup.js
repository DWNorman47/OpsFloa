(function () {
  const $ = id => document.getElementById(id);
  const form = $('form'), popup = $('popup');
  const lenEl = $('length'), lenVal = $('lenval');
  const SYMBOLS = '!@#$%^&*()-_=+[]{};:,.?';
  const SAFE_SYMBOLS = '!@*-_.'; // widely accepted; avoids + % & # $ ^ ; = and URL/shell hazards
  const ambiguous = 'IOl0O1|';

  lenEl.addEventListener('input', () => lenVal.textContent = lenEl.value);

  /* ---- Categories: base + saved customs; "Other…" reveals a textbox that adds a
     permanent option. Persisted in localStorage here; per-user in the DB later. ---- */
  const BASE_CATS = ['Personal', 'Work'];
  const CAT_KEY = 'opsfloa_categories';
  const loadCustom = () => { try { return JSON.parse(localStorage.getItem(CAT_KEY)) || []; } catch { return []; } };
  const saveCustom = arr => { try { localStorage.setItem(CAT_KEY, JSON.stringify(arr)); } catch {} };

  function renderCats(selected) {
    const cats = [...BASE_CATS, ...loadCustom()];
    const sel = $('category');
    sel.innerHTML = '';
    for (const c of cats) { const o = document.createElement('option'); o.value = o.textContent = c; sel.appendChild(o); }
    const other = document.createElement('option'); other.value = '__other'; other.textContent = 'Other…'; sel.appendChild(other);
    if (selected && cats.includes(selected)) sel.value = selected;
  }
  renderCats('Personal');

  $('category').addEventListener('change', e => {
    const isOther = e.target.value === '__other';
    $('cat-other-wrap').classList.toggle('hidden', !isOther);
    if (isOther) $('cat-other').focus();
  });
  function addCategory() {
    const v = $('cat-other').value.trim();
    if (!v) return;
    const customs = loadCustom();
    if (!BASE_CATS.includes(v) && !customs.includes(v)) { customs.push(v); saveCustom(customs); }
    renderCats(v);
    $('cat-other').value = '';
    $('cat-other-wrap').classList.add('hidden');
  }
  $('cat-add').addEventListener('click', addCategory);
  $('cat-other').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addCategory(); } });
  const curCategory = () => { const v = $('category').value; return v === '__other' ? '' : v; };

  /* ---- Encryption: WebCrypto PBKDF2-SHA256 → AES-256-GCM. Self-describing blob so the
     offline decryptor (decryptor.html) needs only the password. Same code will move into
     a shared crypto.js in Phase 1. ---- */
  const KDF_ITERS = 600000;
  const enc = new TextEncoder();
  const b64 = u8 => btoa(String.fromCharCode(...u8));
  const packJSON = obj => 'OPSFLOA1:' + b64(enc.encode(JSON.stringify(obj))); // UTF-8-safe envelope

  async function deriveKey(password, salt, iters) {
    const base = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt, iterations: iters, hash: 'SHA-256' },
      base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
  }
  // The hint rides in the envelope (plaintext, by design) so it is ALWAYS saved with the
  // encrypted value — wherever the value goes (vault entry, email), the hint goes too.
  async function encryptText(password, plaintext, hint) {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await deriveKey(password, salt, KDF_ITERS);
    const ct = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(plaintext)));
    return packJSON({ v: 1, kdf: 'PBKDF2', hash: 'SHA-256', it: KDF_ITERS, salt: b64(salt), iv: b64(iv), ct: b64(ct), hint: hint || '' });
  }

  let encBlob = null; // current encrypted bundle, or null
  let onGenerated = null; // optional hook the extension sets (fills the page password field)

  // Remember the hint in the browser + prefill it next time.
  const HINT_KEY = 'opsfloa_enc_hint';
  const saveHint = h => { try { localStorage.setItem(HINT_KEY, h || ''); } catch {} };
  try { $('enc-hint').value = localStorage.getItem(HINT_KEY) || ''; } catch {}
  $('enc-hint').addEventListener('input', e => saveHint(e.target.value));

  // Persist the encryption ON state (the hint above is saved on every keystroke, so it
  // sticks even when encryption is turned off / closed). Restored on open below.
  const ENC_ON_KEY = 'opsfloa_enc_on';
  const saveEncOn = on => { try { localStorage.setItem(ENC_ON_KEY, on ? '1' : '0'); } catch {} };

  // Remember the last-used share email address(es) + prefill next time.
  const EMAIL_KEY = 'opsfloa_share_to';
  try { $('share-to').value = localStorage.getItem(EMAIL_KEY) || ''; } catch {}
  $('share-to').addEventListener('input', e => { try { localStorage.setItem(EMAIL_KEY, e.target.value || ''); } catch {} });

  // Decryption (mirror of the offline decryptor); deriveKey above already grants 'decrypt'.
  const dec = new TextDecoder();
  const fromb64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const unpack = blob => JSON.parse(dec.decode(fromb64(blob.trim().replace(/^OPSFLOA1:/, ''))));
  async function decryptBlob(blob, password) {
    const o = unpack(blob);
    const key = await deriveKey(password, fromb64(o.salt), o.it);
    const pt = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromb64(o.iv) }, key, fromb64(o.ct));
    return JSON.parse(dec.decode(pt));
  }

  // chip visual state
  document.querySelectorAll('.chip input').forEach(cb => {
    const sync = () => cb.closest('.chip').classList.toggle('on', cb.checked);
    cb.addEventListener('change', sync); sync();
  });

  const randInt = (n) => { const a = new Uint32Array(1); crypto.getRandomValues(a); return a[0] % n; };
  const pick = (s) => s[randInt(s.length)];

  // One string per enabled character class (lowercase always). Honors exclude-ambiguous
  // and the safe-symbols toggle. Used to guarantee coverage of every enabled class.
  function pools() {
    const strip = (s) => $('c-amb').checked ? [...s].filter(c => !ambiguous.includes(c)).join('') : s;
    const list = [strip('abcdefghijklmnopqrstuvwxyz')];
    if ($('c-upper').checked) list.push(strip('ABCDEFGHIJKLMNOPQRSTUVWXYZ'));
    if ($('c-num').checked)   list.push(strip('0123456789'));
    if ($('c-sym').checked)   { const sym = strip($('c-safe').checked ? SAFE_SYMBOLS : SYMBOLS); if (sym) list.push(sym); }
    return list.filter(p => p.length);
  }

  function generate() {
    const len = +lenEl.value;
    const ps = pools();
    const all = [...new Set(ps.join(''))].join('');
    const chars = [];
    // At least one char from each enabled class (as far as the length allows)…
    for (const p of ps) if (chars.length < len) chars.push(pick(p));
    // …then fill the rest from the full pool, and shuffle so the guaranteed ones aren't first.
    while (chars.length < len) chars.push(pick(all));
    for (let i = chars.length - 1; i > 0; i--) { const j = randInt(i + 1); [chars[i], chars[j]] = [chars[j], chars[i]]; }
    const pw = chars.join('');
    $('pw').textContent = pw;
    $('pw').dataset.value = pw;
    strength(pw, all.length);
    popup.classList.add('locked');
    // Collapse the Generate section; a fresh password invalidates any prior encryption.
    setOpen('gen-collapse', 'gen-head', false);
    clearEncrypted();
    autoEnableEncryption();
    $('t-save').checked = true; $('p-save').classList.remove('hidden'); // open Save to vault after generating
    setOpen('share-collapse', 'share-head', true); // open Share after generating
    if (onGenerated) onGenerated(pw);
  }

  function clearEncrypted() {
    encBlob = null;
    $('enc-value').classList.remove('show');
    $('enc-badge').style.display = 'none';
    setCopyAllLabel();
  }

  // If encryption was used before (saved on-state), turn it on once a password is generated —
  // enabled, expanded, and ready with the remembered hint (until you change/turn it off).
  function autoEnableEncryption() {
    let on = false; try { on = localStorage.getItem(ENC_ON_KEY) === '1'; } catch {}
    if (on && !$('t-enc').checked) {
      $('t-enc').checked = true;
      $('p-enc').classList.remove('hidden');
      $('enc-state').textContent = 'On'; $('enc-state').classList.add('on');
      setOpen('enc-collapse', 'enc-head', true);
    }
    // Auto-fill the saved encryption password (only if the user opted into saving it).
    let savedPw = null; try { savedPw = localStorage.getItem(ENC_PW_KEY); } catch {}
    if (savedPw != null && $('t-enc').checked) $('enc-pw').value = savedPw;
  }

  // Explicit, post-generate step. Encrypts the entry, reveals the sealed value, and
  // collapses the encryption section. The current hint is bundled into the value.
  async function encryptNow() {
    const pw = $('pw').dataset.value;
    if (!pw) { toast('Generate a password first'); return; }
    const encPw = $('enc-pw').value;
    if (!encPw) { toast('Enter an encryption password'); $('enc-pw').focus(); return; }
    const hint = $('enc-hint').value;
    const badge = $('enc-badge');
    badge.style.display = 'block'; badge.style.color = 'var(--muted)'; badge.textContent = '🔒 Encrypting…';
    try {
      const bundle = JSON.stringify({ site: $('site').value, username: $('username').value, password: pw, category: curCategory() });
      encBlob = await encryptText(encPw, bundle, hint);
      saveHint(hint);
      $('blob-text').textContent = encBlob;
      $('enc-value').classList.add('show');
      badge.style.display = 'none';
      setOpen('enc-collapse', 'enc-head', false); // collapse encryption
      setCopyAllLabel();
      toast($('t-save').checked ? 'Encrypted & saved (hint included)' : 'Encrypted');
    } catch { badge.style.color = 'var(--bad)'; badge.textContent = 'Encryption failed.'; }
  }
  function setCopyAllLabel() {
    const b = document.querySelector('[data-copy="all"]');
    if (b) b.textContent = encBlob ? 'Copy encrypted' : 'Copy all';
  }

  function strength(pw, poolSize) {
    const bits = pw.length * Math.log2(poolSize);
    const segs = document.querySelectorAll('#meter i');
    let level, label, color;
    if (bits < 50)      { level=1; label='Weak';      color='var(--bad)'; }
    else if (bits < 80) { level=2; label='Fair';      color='var(--warn)'; }
    else if (bits < 110){ level=3; label='Strong';    color='var(--good)'; }
    else                { level=4; label='Very strong'; color='var(--good)'; }
    segs.forEach((s,i)=> s.style.background = i < level ? color : 'var(--field-border)');
    $('meterlabel').textContent = `${label} · ${Math.round(bits)} bits of entropy`;
    $('meterlabel').style.color = color;
  }

  function reset() {
    popup.classList.remove('locked');
    $('pw').innerHTML = '<span class="placeholder">Press generate…</span>';
    delete $('pw').dataset.value;
    document.querySelectorAll('#meter i').forEach(s=>s.style.background='var(--field-border)');
    $('meterlabel').textContent='—'; $('meterlabel').style.color='var(--muted)';
    clearEncrypted();
    setOpen('gen-collapse', 'gen-head', true);
    $('t-save').checked = false; $('p-save').classList.add('hidden'); // back to pre-generate state
    setOpen('share-collapse', 'share-head', false);
  }

  // sub-panel toggles
  const bind = (t, p) => $(t).addEventListener('change', e => $(p).classList.toggle('hidden', !e.target.checked));
  bind('t-enc','p-enc'); bind('t-save','p-save');

  // Save the encryption password to the browser — dangerous, so warn first. Once saved it
  // auto-fills after future generates. Click again (when saved) to remove it.
  const ENC_PW_KEY = 'opsfloa_enc_pw';
  const hasSavedPw = () => { try { return localStorage.getItem(ENC_PW_KEY) != null; } catch { return false; } };
  function refreshSavePwState() {
    const on = hasSavedPw();
    $('save-enc-pw').classList.toggle('saved', on);
    $('save-enc-pw').title = on ? 'Encryption password is saved in this browser — click to remove'
                                : 'Save this password to the browser (risky)';
  }
  $('save-enc-pw').addEventListener('click', async () => {
    if (hasSavedPw()) {
      const { result } = await confirmModal({ title: 'Remove saved password?', msg: 'Remove the saved encryption password from this browser?', okText: 'Remove', cancelText: 'Keep' });
      if (result !== 'ok') return;
      try { localStorage.removeItem(ENC_PW_KEY); } catch {}
      toast('Saved password removed'); refreshSavePwState(); return;
    }
    const v = $('enc-pw').value;
    if (!v) { toast('Enter a password first'); return; }
    const { result } = await confirmModal({
      title: 'Save password to this browser?',
      msg: 'Saving your encryption password in this browser is less safe — anyone who can use this device could read it and decrypt everything you sealed. Save it anyway?',
      okText: 'Save', cancelText: 'Cancel',
    });
    if (result !== 'ok') return;
    try { localStorage.setItem(ENC_PW_KEY, v); toast('Encryption password saved to this browser'); } catch { toast('Save failed'); }
    refreshSavePwState();
  });
  refreshSavePwState();

  // Share: encrypted email opens the mail app with the sealed payload; one-time link is Phase 3.
  $('share-go').addEventListener('click', () => {
    const mode = (document.querySelector('input[name="share"]:checked') || {}).value;
    if (mode === 'link') { toast('One-time links are set up server-side (Phase 3)'); return; }
    if (!encBlob) { toast('Encrypt the entry first to share it by email'); return; }
    const to = $('share-to').value.trim();
    if (!to) { toast('Enter at least one email'); $('share-to').focus(); return; }
    const site = $('site').value || 'a login';
    const subject = `Encrypted credentials for ${site}`;
    const body =
`Someone shared encrypted credentials with you.

--- Encrypted payload ---
${encBlob}
-------------------------

To read it: open the OpsFloa decryptor (decryptor.html), paste the payload above, and enter the password you were given separately. It decrypts on your device — nothing is uploaded.`;
    window.location.href = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  });

  // Custom in-popup confirm modal → { result: 'ok'|'cancel', dontAsk: bool }.
  function confirmModal({ title, msg, okText = 'OK', cancelText = 'Cancel', showDontAsk = false }) {
    return new Promise(resolve => {
      $('modal-title').textContent = title;
      $('modal-msg').textContent = msg;
      $('modal-ok').textContent = okText;
      $('modal-cancel').textContent = cancelText;
      $('modal-dontask').checked = false;
      $('modal-dontask-row').style.display = showDontAsk ? 'flex' : 'none';
      $('modal').hidden = false;
      const finish = result => {
        $('modal').hidden = true;
        $('modal-ok').removeEventListener('click', onOk);
        $('modal-cancel').removeEventListener('click', onCancel);
        $('modal').removeEventListener('click', onBackdrop);
        document.removeEventListener('keydown', onKey);
        resolve({ result, dontAsk: $('modal-dontask').checked });
      };
      const onOk = () => finish('ok');
      const onCancel = () => finish('cancel');
      const onBackdrop = e => { if (e.target === $('modal')) finish('cancel'); };
      const onKey = e => { if (e.key === 'Escape') finish('cancel'); };
      $('modal-ok').addEventListener('click', onOk);
      $('modal-cancel').addEventListener('click', onCancel);
      $('modal').addEventListener('click', onBackdrop);
      document.addEventListener('keydown', onKey);
    });
  }

  // Save to Browser: append this entry to a local vault (Save to Database is Phase 2).
  const VAULT_KEY = 'opsfloa_vault';
  const SKIP_ENC_PROMPT_KEY = 'opsfloa_skip_encrypt_prompt';
  const skipEncryptPrompt = () => { try { return localStorage.getItem(SKIP_ENC_PROMPT_KEY) === '1'; } catch { return false; } };
  $('save-browser').addEventListener('click', async () => {
    const pw = $('pw').dataset.value;
    if (!pw) { toast('Generate a password first'); return; }
    // If unencrypted, offer to encrypt first — unless they’ve ticked "Don't ask again".
    if (!encBlob && !skipEncryptPrompt()) {
      const { result, dontAsk } = await confirmModal({
        title: 'Encrypt before saving?',
        msg: 'This entry isn’t encrypted. Encrypt it so only your password can open it later.',
        okText: 'Encrypt first',
        cancelText: 'Save unencrypted',
        showDontAsk: true,
      });
      if (result === 'ok') {
        $('t-enc').checked = true; $('p-enc').classList.remove('hidden');
        $('enc-state').textContent = 'On'; $('enc-state').classList.add('on'); saveEncOn(true);
        setOpen('enc-collapse', 'enc-head', true);
        $('enc-pw').focus();
        toast('Set a password, press Encrypt, then Save');
        return;
      }
      if (dontAsk) { try { localStorage.setItem(SKIP_ENC_PROMPT_KEY, '1'); } catch {} }
    }
    const entry = {
      id: (crypto.randomUUID ? crypto.randomUUID() : 's' + Math.random().toString(36).slice(2)),
      site: $('site').value, username: $('username').value, category: curCategory(),
      encrypted: !!encBlob,
      value: encBlob || pw,           // sealed blob (hint embedded) if encrypted, else plaintext
      hint: encBlob ? $('enc-hint').value : ''
    };
    let vault;
    try { vault = JSON.parse(localStorage.getItem(VAULT_KEY) || '[]'); } catch { vault = []; }
    // Same site + username already saved? Offer to overwrite or cancel.
    const norm = s => (s || '').trim().toLowerCase();
    const idx = vault.findIndex(x => norm(x.site) === norm(entry.site) && norm(x.username) === norm(entry.username));
    if (idx >= 0) {
      const { result } = await confirmModal({
        title: 'Already saved',
        msg: `An entry for “${entry.site || '—'}” / “${entry.username || '(no username)'}” is already in this browser. Overwrite it?`,
        okText: 'Overwrite', cancelText: 'Cancel',
      });
      if (result !== 'ok') { toast('Save cancelled'); return; }
      entry.id = vault[idx].id;   // keep the existing entry's id
      vault[idx] = entry;
    } else {
      vault.push(entry);
    }
    try {
      localStorage.setItem(VAULT_KEY, JSON.stringify(vault));
      toast(idx >= 0 ? 'Entry overwritten' : `Saved to browser (${vault.length} in vault)`);
    } catch { toast('Save failed'); }
  });

  // Collapsible sections
  const setOpen = (boxId, headId, open) => { $(boxId).classList.toggle('open', open); $(headId).setAttribute('aria-expanded', String(open)); };
  const collapse = (headId, boxId) => $(headId).addEventListener('click', () => setOpen(boxId, headId, !$(boxId).classList.contains('open')));
  collapse('gen-head', 'gen-collapse');
  collapse('enc-head', 'enc-collapse');
  collapse('share-head', 'share-collapse');
  collapse('dec-head', 'dec-collapse');

  $('encrypt').addEventListener('click', encryptNow);
  $('copy-blob').addEventListener('click', () => { if (encBlob) copy(encBlob, 'Encrypted value'); });

  // Decryption utility: show the embedded hint on paste, decrypt on click.
  $('dec-blob').addEventListener('input', () => {
    const el = $('dec-hint'), b = $('dec-blob').value.trim();
    try { const o = unpack(b); if (b && o.hint) { el.textContent = '💡 Hint: ' + o.hint; el.style.display = 'block'; return; } } catch {}
    el.style.display = 'none';
  });
  $('decrypt').addEventListener('click', async () => {
    const err = $('dec-err'), out = $('dec-out');
    err.style.display = 'none'; out.innerHTML = '';
    const blob = $('dec-blob').value, pw = $('dec-pw').value;
    if (!blob.trim() || !pw) { err.textContent = 'Paste the payload and the password.'; err.style.display = 'block'; return; }
    try {
      const d = await decryptBlob(blob, pw);
      const esc = s => (s || '—').replace(/[<&]/g, c => ({ '<': '&lt;', '&': '&amp;' }[c]));
      const row = (k, v) => v ? `<div class="drow"><span class="dk">${k}</span><span class="dv">${esc(v)}</span><button class="mini" data-v="${encodeURIComponent(v)}">Copy</button></div>` : '';
      out.innerHTML = row('Site', d.site) + row('Username', d.username) + row('Password', d.password) + (d.category ? row('Category', d.category) : '');
      out.querySelectorAll('.mini').forEach(b => b.addEventListener('click', () => copy(decodeURIComponent(b.dataset.v), 'Value')));
    } catch { err.textContent = 'Could not decrypt — wrong password or corrupted payload.'; err.style.display = 'block'; }
  });
  $('t-enc').addEventListener('change', e => {
    $('enc-state').textContent = e.target.checked ? 'On' : 'Off';
    $('enc-state').classList.toggle('on', e.target.checked);
    saveEncOn(e.target.checked);
  });

  $('generate').addEventListener('click', generate);
  $('reset').addEventListener('click', reset);

  // copy handlers
  function toast(m){ const t=$('toast'); t.textContent=m; t.classList.add('show'); clearTimeout(t._h); t._h=setTimeout(()=>t.classList.remove('show'),1400); }
  async function copy(text, what){ try{ await navigator.clipboard.writeText(text); toast(what+' copied'); }catch{ toast('Copy blocked in preview'); } }
  function val(k){
    if (k==='site') return $('site').value;
    if (k==='username') return $('username').value;
    if (k==='password') return $('pw').dataset.value || '';
    if (k==='all') return encBlob || `Site: ${$('site').value}\nUsername: ${$('username').value}\nPassword: ${$('pw').dataset.value||''}\nCategory: ${curCategory()||'—'}`;
  }
  document.querySelectorAll('[data-copy]').forEach(b =>
    b.addEventListener('click', () => {
      const k=b.dataset.copy; const v=val(k);
      if(!v){toast('Nothing to copy yet');return;}
      const label = k==='all' ? (encBlob?'Encrypted payload':'Site, username & password') : k[0].toUpperCase()+k.slice(1);
      copy(v, label);
    }));
  $('copy-inline').addEventListener('click', () => { const v=val('password'); if(!v){toast('Generate first');return;} copy(v,'Password'); });

  /* ---- Extension integration (Chrome/Edge MV3) ---- */
  const hasChrome = typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting;
  async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
  if (hasChrome) {
    activeTab().then(async t => {
      // Prefill Site from the active tab's hostname.
      try { if (t && t.url) { const u = new URL(t.url); if (u.hostname) $('site').value = u.hostname; } } catch {}
      // Pull the entered username/email from the page (if any) into the Username field.
      try {
        const results = await chrome.scripting.executeScript({
          target: { tabId: t.id, allFrames: true },
          func: () => {
            const sels = ['input[autocomplete="username"]', 'input[type="email"]',
              'input[name*="user" i]', 'input[name*="email" i]', 'input[id*="user" i]', 'input[id*="email" i]'];
            for (const s of sels) { const el = document.querySelector(s); if (el && el.value.trim()) return el.value.trim(); }
            const pw = document.querySelector('input[type="password"]');
            if (pw && pw.form) {
              const ins = [...pw.form.querySelectorAll('input')]; const i = ins.indexOf(pw);
              for (let j = i - 1; j >= 0; j--) { const tp = ins[j].type; if ((tp === 'text' || tp === 'email') && ins[j].value.trim()) return ins[j].value.trim(); }
            }
            return '';
          },
        });
        const found = results.map((r) => r && r.result).find(Boolean);
        if (found && !$('username').value) $('username').value = found;
      } catch {}
    }).catch(() => {});
  }
  async function fillPageWith(value) {
    if (!hasChrome || !value) return false;
    try {
      const t = await activeTab();
      const results = await chrome.scripting.executeScript({
        target: { tabId: t.id, allFrames: true }, args: [value],
        func: (v) => {
          const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
          const setVal = (input) => {
            input.focus(); input.value = v;
            input.dispatchEvent(new Event('input', { bubbles: true }));
            input.dispatchEvent(new Event('change', { bubbles: true }));
          };
          // Collect every input, piercing shadow roots (many sign-up forms wrap fields in
          // web components that querySelector can't see through).
          const all = [];
          const walk = (root) => {
            root.querySelectorAll('input').forEach((el) => all.push(el));
            root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
          };
          walk(document);
          const a = document.activeElement;
          if (a && a.tagName === 'INPUT' && a.type === 'password') { setVal(a); return true; }
          const passish = (el) => /pass(word|wd|phrase)?/i.test(el.name || '') || /pass(word|wd|phrase)?/i.test(el.id || '') || /password/i.test(el.autocomplete || '');
          const input = all.find((el) => el.type === 'password' && vis(el))
            || all.find((el) => el.type === 'password')
            || all.find((el) => vis(el) && passish(el));
          if (!input) return false;
          setVal(input);
          return true;
        },
      });
      return results.some((r) => r && r.result); // true if any frame filled
    } catch { return false; }
  }
  // Clicking Generate fills the page's password field with the plaintext password.
  // (The sealed value is never put in a login field — it's for the vault/share only.)
  onGenerated = (pw) => { fillPageWith(pw); };
  const fillBtn = $('fill');
  if (fillBtn) fillBtn.addEventListener('click', async () => {
    const val = $('pw').dataset.value;
    if (!val) { toast('Generate a password first'); return; }
    if (!hasChrome) { toast('Fill works inside the extension'); return; }
    const ok = await fillPageWith(val);
    toast(ok ? 'Filled the page' : 'No password field found on the page');
  });

})();
