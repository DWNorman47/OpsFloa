// Generate popup.html + popup.js (the MV3 extension) from popup-prototype.html.
// The prototype is the single source of truth for the UI/logic; run `node build.js`
// after editing it. MV3 forbids inline scripts, so the popup's script is externalized
// and a bit of Chrome/Edge glue (Site prefill + Fill) is injected into the IIFE.
const fs = require('fs');
const path = require('path');
const dir = __dirname + path.sep;
let html = fs.readFileSync(dir + 'popup-prototype.html', 'utf8');

// 1. Extract the inline script.
const m = html.match(/<script>([\s\S]*?)<\/script>/);
if (!m) throw new Error('no <script> block found in popup-prototype.html');
let script = m[1];

// 2. Extension glue, injected INSIDE the IIFE (needs $/toast/etc.), before the final })();
const extCode = `
  /* ---- Extension integration (Chrome/Edge MV3) ---- */
  const hasChrome = typeof chrome !== 'undefined' && chrome.tabs && chrome.scripting;
  async function activeTab() { const [t] = await chrome.tabs.query({ active: true, currentWindow: true }); return t; }
  if (hasChrome) {
    activeTab().then(async t => {
      // Prefill Site from the active tab's hostname.
      try { if (t && t.url) { const u = new URL(t.url); if (u.hostname) $('site').value = u.hostname; } } catch {}
      // Pull the entered username/email from the page (if any) into the Username field.
      try {
        const [r] = await chrome.scripting.executeScript({
          target: { tabId: t.id },
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
        if (r && r.result && !$('username').value) $('username').value = r.result;
      } catch {}
    }).catch(() => {});
  }
  async function fillPageWith(value) {
    if (!hasChrome || !value) return false;
    try {
      const t = await activeTab();
      const [res] = await chrome.scripting.executeScript({
        target: { tabId: t.id }, args: [value],
        func: (v) => {
          const a = document.activeElement;
          const input = (a && a.tagName === 'INPUT' && a.type === 'password') ? a
            : document.querySelector('input[type="password"]');
          if (!input) return false;
          input.focus(); input.value = v;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
          return true;
        },
      });
      return !!(res && res.result);
    } catch { return false; }
  }
  // Clicking Generate fills the page's password field; Encrypt overwrites it with the sealed value.
  onGenerated = (pw) => { fillPageWith(pw); };
  onEncrypted = (blob) => { fillPageWith(blob); };
  const fillBtn = $('fill');
  if (fillBtn) fillBtn.addEventListener('click', async () => {
    const val = encBlob || $('pw').dataset.value;
    if (!val) { toast('Generate a password first'); return; }
    if (!hasChrome) { toast('Fill works inside the extension'); return; }
    const ok = await fillPageWith(val);
    toast(ok ? 'Filled the page' : 'No password field found on the page');
  });
`;
const marker = '})();';
const idx = script.lastIndexOf(marker);
script = script.slice(0, idx) + extCode + '\n' + marker + script.slice(idx + marker.length);
fs.writeFileSync(dir + 'popup.js', script.trim() + '\n');

// 3. popup.html: external script, Fill button, popup-window sizing override.
html = html.replace(/<script>[\s\S]*?<\/script>/, '<script src="popup.js" defer></script>');
html = html.replace(
  '          <button class="copy" id="copy-inline" style="padding:5px 8px" title="Copy password">',
  '          <button class="copy go" id="fill" style="padding:5px 11px" title="Fill the password field on the page">Fill</button>\n          <button class="copy" id="copy-inline" style="padding:5px 8px" title="Copy password">'
);
html = html.replace('</style>\n</head>',
  '  /* Extension popup sizing (overrides the standalone-preview backdrop) */\n' +
  '  body { display:block; min-height:0; padding:0; width:380px; background:var(--card); }\n' +
  '  .popup { border:0; border-radius:0; box-shadow:none; }\n' +
  '</style>\n</head>');
fs.writeFileSync(dir + 'popup.html', html);
console.log('Built popup.js + popup.html from popup-prototype.html');
