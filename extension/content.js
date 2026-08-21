// Injects a small OpsFloa key icon beside a focused password field. Clicking it tries to
// open the popup (via the service worker); if the browser blocks that, it falls back to
// generating a strong password and filling the field in-page. Browsers don't let an
// extension auto-open its toolbar popup from a page event, so this is the workaround.
(function () {
  let btn = null;
  let field = null; // the password field the button is currently attached to

  function ensureBtn() {
    if (btn) return btn;
    btn = document.createElement('button');
    btn.textContent = '🔑';
    btn.type = 'button';
    btn.setAttribute('aria-label', 'OpsFloa Passwords');
    btn.title = 'OpsFloa — open, or generate & fill a strong password';
    Object.assign(btn.style, {
      position: 'absolute', zIndex: '2147483647', width: '24px', height: '24px',
      padding: '0', margin: '0', border: '1px solid rgba(0,0,0,.18)', borderRadius: '6px',
      background: '#ffffff', color: '#111', cursor: 'pointer', fontSize: '13px',
      lineHeight: '22px', textAlign: 'center', boxShadow: '0 1px 4px rgba(0,0,0,.25)',
      display: 'none',
    });
    btn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the field focused
    btn.addEventListener('click', (e) => {
      e.preventDefault(); e.stopPropagation();
      const target = field;
      try {
        chrome.runtime.sendMessage({ type: 'openPopup' }, (resp) => {
          if (chrome.runtime.lastError || !resp || !resp.opened) quickFill(target);
        });
      } catch { quickFill(target); }
    });
    document.documentElement.appendChild(btn);
    return btn;
  }

  const isPw = (el) => el && el.tagName === 'INPUT' && el.type === 'password';

  function place(f) {
    const b = ensureBtn();
    const r = f.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) { b.style.display = 'none'; return; }
    b.style.top = (window.scrollY + r.top + (r.height - 24) / 2) + 'px';
    b.style.left = (window.scrollX + r.right - 28) + 'px';
    b.style.display = 'block';
  }
  function hide() { if (btn) btn.style.display = 'none'; }

  // In-page fallback: strong random password, fill the field (+ any confirm field), copy it.
  function genPassword(len) {
    const cs = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*()-_=+';
    const out = new Uint32Array(len); crypto.getRandomValues(out);
    let s = ''; for (let i = 0; i < len; i++) s += cs[out[i] % cs.length];
    return s;
  }
  function setVal(input, v) {
    input.focus(); input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  }
  function deepFindPassword() {
    const all = [];
    const walk = (root) => {
      root.querySelectorAll('input').forEach((el) => all.push(el));
      root.querySelectorAll('*').forEach((el) => { if (el.shadowRoot) walk(el.shadowRoot); });
    };
    walk(document);
    const vis = (el) => !!el && (el.offsetParent !== null || el.getClientRects().length > 0);
    return all.find((el) => el.type === 'password' && vis(el)) || all.find((el) => el.type === 'password') || null;
  }
  function quickFill(f) {
    if (!isPw(f)) f = deepFindPassword();
    if (!f) { flash('No password field found'); return; }
    const pw = genPassword(20);
    setVal(f, pw);
    if (f.form) f.form.querySelectorAll('input[type="password"]').forEach((p) => { if (p !== f) setVal(p, pw); });
    if (navigator.clipboard) navigator.clipboard.writeText(pw).catch(() => {});
    flash('Strong password filled & copied');
  }

  let flashEl = null;
  function flash(msg) {
    if (!flashEl) {
      flashEl = document.createElement('div');
      Object.assign(flashEl.style, {
        position: 'fixed', zIndex: '2147483647', bottom: '18px', left: '50%',
        transform: 'translateX(-50%)', background: '#171a21', color: '#fff',
        font: '600 12.5px system-ui, sans-serif', padding: '8px 14px', borderRadius: '20px',
        boxShadow: '0 4px 14px rgba(0,0,0,.35)', pointerEvents: 'none', opacity: '0',
        transition: 'opacity .2s',
      });
      document.documentElement.appendChild(flashEl);
    }
    flashEl.textContent = msg;
    flashEl.style.opacity = '1';
    clearTimeout(flashEl._t);
    flashEl._t = setTimeout(() => { flashEl.style.opacity = '0'; }, 1600);
  }

  document.addEventListener('focusin', (e) => { if (isPw(e.target)) { field = e.target; place(field); } });
  document.addEventListener('focusout', (e) => { if (isPw(e.target)) setTimeout(hide, 150); });
  const reposition = () => { if (isPw(field) && document.activeElement === field) place(field); };
  window.addEventListener('scroll', reposition, true);
  window.addEventListener('resize', reposition);
})();
