const paths = {
  arrow: '<path d="M5 12h14m-5-5 5 5-5 5"/>',
  external: '<path d="M14 4h6v6m0-6L10 14M10 4H5a1 1 0 0 0-1 1v14a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5"/>',
  monitor: '<rect x="3" y="4" width="18" height="12" rx="2"/><path d="M8 21h8m-4-5v5"/>',
  phone: '<rect x="7" y="2" width="10" height="20" rx="2"/><path d="M10 5h4m-3 14h2"/>',
  chevron: '<path d="m8 10 4 4 4-4"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  shield: '<path d="m12 3 8 3v6c0 5-8 9-8 9s-8-4-8-9V6Z"/><path d="m8 12 3 3 5-6"/>',
  users: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2m2-15a3 3 0 0 1 0 6m2 4a5 5 0 0 1 2 4v1"/>',
  invite: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="m3 6 9 7 9-7"/>',
  budget: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3 10h18m-5 5h2"/>',
  audit: '<path d="M7 3h10v18H4V6h3V3Zm0 0v4h5m-4 5h8m-8 4h8"/>',
  key: '<circle cx="8" cy="8" r="4"/><path d="m11 11 9 9m-4-4 3-3m-6 0 3-3"/>',
  clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
};
export const icon = name => `<svg viewBox="0 0 24 24" aria-hidden="true">${paths[name] || paths.shield}</svg>`;
export const logo = () => '<svg class="logo" viewBox="0 0 1024 1024" aria-hidden="true"><path d="M462 236V420H624M276 732L424 644L356 512M540 676L622 546L786 640"/></svg>';
export const status = (label, kind = '') => `<span class="status ${kind}"><i></i>${label}</span>`;
export const escape = text => String(text).replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[char]));
export function toast(text) { const node = document.querySelector('#toast'); node.textContent = text; node.classList.add('show'); clearTimeout(toast.timer); toast.timer = setTimeout(() => node.classList.remove('show'), 2700); }
export function confirm(title, detail, label, callback) {
  const dialog = document.createElement('dialog');
  const prior = document.activeElement;
  let pending = false;
  const id = `confirmation-${confirm.sequence = (confirm.sequence || 0) + 1}`;
  dialog.setAttribute('aria-labelledby', `${id}-title`);
  dialog.setAttribute('aria-describedby', `${id}-detail`);
  dialog.innerHTML = `<h2 id="${id}-title">${escape(title)}</h2><p id="${id}-detail">${escape(detail)}</p><div class="dialog-actions"><button class="button" data-cancel autofocus>取消</button><button class="button danger" data-confirm>${escape(label)}</button></div>`;
  document.body.append(dialog);
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (prior?.isConnected && !prior.disabled) prior.focus();
    else {
      const heading = document.querySelector('main h1');
      if (heading) { heading.setAttribute('tabindex', '-1'); heading.focus(); }
    }
  });
  dialog.addEventListener('cancel', event => { if (pending) event.preventDefault(); });
  dialog.addEventListener('click', async event => {
    if (pending) return;
    if (event.target.closest('[data-cancel]')) dialog.close();
    if (event.target.closest('[data-confirm]')) {
      pending = true; dialog.setAttribute('aria-busy', 'true');
      for (const control of dialog.querySelectorAll('button')) control.disabled = true;
      try { await callback(); } finally { dialog.close(); }
    }
  });
  dialog.showModal();
}
