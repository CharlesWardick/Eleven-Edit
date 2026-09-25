// ── Chain row view switch (build 86) ─────────────────────────────────────────
// Classic = the original #chainstrip, never modified for Modern's sake.
// Modern  = #chainstrip-modern, its own markup/styles. Presentation only: both
// views drive the same rack handlers. App display pref (localStorage), default
// Classic; unreadable storage falls back to Classic.
var chainView = 'classic';
try {
  if (window.localStorage.getItem('chainView') === 'modern') chainView = 'modern';
} catch (e) {}

function applyChainView() {
  var classic = document.getElementById('chainstrip');
  var modern  = document.getElementById('chainstrip-modern');
  if (classic) classic.style.display = (chainView === 'modern') ? 'none' : '';
  if (modern)  modern.hidden = (chainView !== 'modern');
}

function setChainView(v) {
  chainView = (v === 'modern') ? 'modern' : 'classic';
  try { window.localStorage.setItem('chainView', chainView); } catch (e) {}
  applyChainView();
}

(function initChainView() {
  var sel = document.getElementById('chain-view-select');
  if (sel) {
    sel.value = chainView;
    sel.addEventListener('change', function () { setChainView(sel.value); });
  }
  applyChainView();
})();
