(function () {
  'use strict';

  var phone = document.querySelector('.phone');
  if (!phone) return;

  var tabs = phone.querySelectorAll('.tab');
  var panes = phone.querySelectorAll('.pane');

  function show(id) {
    tabs.forEach(function (tab) {
      var isActive = tab.getAttribute('data-tab') === id;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', isActive ? 'true' : 'false');
    });
    panes.forEach(function (pane) {
      pane.classList.toggle('is-active', pane.getAttribute('data-pane') === id);
    });
  }

  tabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      show(tab.getAttribute('data-tab'));
    });
  });

  // The phone mockup is illustrative; these buttons never call a real API.
  phone.querySelectorAll('.ap').forEach(function (button) {
    button.addEventListener('click', function () {
      var card = button.closest('.ap-card');
      if (!card) return;
      var allowed = button.classList.contains('allow');
      const box=document.createElement('div');
      box.className='ap-result';
      const icon=document.createElement('div');
      icon.className='ap-result-icon '+(allowed?'is-allowed':'is-denied');
      icon.textContent = allowed ? '\u2713' : '\u00d7';
      const label=document.createElement('div');
      label.className='ap-result-label';
      label.textContent = allowed ? '已授权，任务继续执行' : '已拒绝本次操作';
      const note=document.createElement('div');
      note.className='ap-result-note';
      note.textContent='记录仅保存在电脑端';
      box.appendChild(icon); box.appendChild(label); box.appendChild(note);
      card.replaceChildren(box);
    });
  });

  var stopButton = phone.querySelector('.stop-btn');
  if (stopButton) {
    stopButton.addEventListener('click', function () {
      stopButton.textContent = '已发送停止指令';
      stopButton.style.color = 'var(--muted)';
      stopButton.style.borderColor = 'var(--line)';
      stopButton.disabled = true;
    });
  }
})();
