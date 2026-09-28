/*
 * Eleven Edit
 * Copyright (c) 2026 Charles Wardick
 * SPDX-License-Identifier: MIT
 * See LICENSE in the project root for full license text.
 */
// ════════════════════════════════════════════════════════════════════
// RIG-BROWSER.JS — "safari mode" patch finder (build 152, feature/rig-browser).
// The Jump List is for knowing what you want; this is for fishing: every
// USER slot with its amp under the name, a search box (name / amp / cab /
// mic) and amp / cab / mic filters. Matches light green, the rest fade.
// Click a slot = go to it (browser closes). Data = rack-catalog.js; a slot
// the catalog hasn't read yet shows the Jump List name + "reading…".
// Hear (🎧, build 153) = recall that slot but KEEP the browser open; the slot
// you came from is remembered. Go (➜ or click) = go there and close. CLOSE /
// Esc while hearing = back to where you came from. Hearing recalls the SAVED
// patch, so unsaved edits on the origin patch are lost — asked first.
// ════════════════════════════════════════════════════════════════════

var rbOrigin = null;        // slot we came from while hearing, else null
var rbPendingHear = null;   // slot awaiting the unsaved-edits answer

function rbIsDirty() { var b = document.getElementById('btn-save-menu'); return !!(b && b.classList.contains('green')); }
function rbSlotText(slot) {
  var e = rackCatalog.slots[slot];
  return slotLabel(slot) + ' — ' + ((e && e.n) || (typeof patchNameCache !== 'undefined' && patchNameCache[slot]) || '');
}
function rbBar() {
  var bar = document.getElementById('rb-bar');
  if (rbPendingHear !== null) {
    bar.innerHTML = '<b>' + rbEsc(rbSlotText(currentSlot)) + '</b> has unsaved changes — hearing another patch loses them.'
      + ' <button class="matrix-close-btn" id="rb-hear-anyway">Hear anyway</button>'
      + ' <button class="matrix-close-btn" id="rb-hear-cancel">Cancel</button>';
    bar.style.display = 'block'; return;
  }
  if (rbOrigin === null) { bar.style.display = 'none'; return; }
  var e = rackCatalog.slots[currentSlot];
  bar.innerHTML = '🎧 Hearing <b>' + rbEsc(rbSlotText(currentSlot)) + '</b>' + (e ? ' (' + rbEsc(rbAmpLabel(e.amp)) + ')' : '')
    + ' — play away, nothing is saved. <span class="rb-keys">➜ keep it · 🎧 another · '
    + '<button class="matrix-close-btn" id="rb-back">Back to ' + rbEsc(rbSlotText(rbOrigin)) + '</button></span>';
  bar.style.display = 'block';
}
function rbHear(slot, confirmed) {
  if (rbOrigin === null && !confirmed && rbIsDirty()) { rbPendingHear = slot; rbBar(); return; }
  rbPendingHear = null;
  if (rbOrigin === null) rbOrigin = currentSlot;
  if (slot === currentSlot && slot !== rbOrigin) { rbBack(); return; }   // 🎧 again on the one playing = stop
  if (slot !== currentSlot) goToSlot(slot);
  if (slot === rbOrigin) rbOrigin = null;
  rbBar(); rbRender();
}
function rbBack() {
  var o = rbOrigin; rbOrigin = null; rbPendingHear = null;
  if (o !== null && o !== currentSlot) goToSlot(o);
  rbBar(); rbRender();
}
function rbGo(slot) {
  rbOrigin = null; rbPendingHear = null;
  document.getElementById('rig-browser').classList.remove('open');
  rbBar();
  if (slot !== currentSlot) goToSlot(slot);
  // Land on the Amp view: close whatever effect panel is open.
  var open = document.querySelector('.chain-open.panel-open'); if (open) open.click();
}

function rbAmpLabel(key) {
  var a = key && AMP_SELECT_BY_KEY[key];
  return a ? a.label : (key || '');
}

function rbFillSelect(sel, items, allLabel) {
  var keep = sel.value;
  sel.innerHTML = '<option value="">' + allLabel + '</option>';
  items.forEach(function(it) {
    var o = document.createElement('option'); o.value = it[0]; o.textContent = it[1]; sel.appendChild(o);
  });
  sel.value = keep;
}

function rbBuildFilters() {
  var used = {}, cabs = {}, mics = {};
  for (var s = 0; s <= MAX_SLOT; s++) {
    var e = rackCatalog.slots[s]; if (!e) continue;
    if (e.amp) used[e.amp] = true; if (e.cab) cabs[e.cab] = true; if (e.mic) mics[e.mic] = true;
  }
  // Amps in the rack's own list order; only ones actually used in the bank.
  rbFillSelect(document.getElementById('rb-amp'),
    AMP_SELECT_LIST.filter(function(a) { return used[a.key]; }).map(function(a) { return [a.key, a.label]; }), 'All amps');
  rbFillSelect(document.getElementById('rb-cab'),
    CAB_TYPE_LIST.filter(function(c) { return cabs[c.name]; }).map(function(c) { return [c.name, c.name]; }), 'All cabs');
  rbFillSelect(document.getElementById('rb-mic'),
    MIC_TYPE_NAMES.filter(function(m) { return mics[m]; }).map(function(m) { return [m, m]; }), 'All mics');
}

function rbRender() {
  var ov = document.getElementById('rig-browser');
  if (!ov || !ov.classList.contains('open')) return;
  var q  = document.getElementById('rb-q').value.trim().toLowerCase();
  var fa = document.getElementById('rb-amp').value, fc = document.getElementById('rb-cab').value,
      fm = document.getElementById('rb-mic').value;
  var active = !!(q || fa || fc || fm), hits = 0;
  var grid = document.getElementById('rb-grid');
  var html = '<div></div><div class="rb-colh">1</div><div class="rb-colh">2</div><div class="rb-colh">3</div><div class="rb-colh">4</div>';
  for (var b = 0; b < 26; b++) {
    html += '<div class="rb-bk">' + BANKS[b] + '</div>';
    for (var p = 0; p < 4; p++) {
      var slot = b * 4 + p, e = rackCatalog.slots[slot];
      var name = e ? e.n : ((typeof patchNameCache !== 'undefined' && patchNameCache[slot]) || '');
      var amp  = e ? rbAmpLabel(e.amp) : '';
      var fresh = (typeof rcFresh !== 'undefined') && rcFresh[slot];
      var cls = 'rb-c' + (slot === currentSlot ? ' cur' : '') + (slot === rbOrigin ? ' org' : '') + (rbOrigin !== null && slot === currentSlot ? ' aud' : '');
      if (active) {
        var hay = (name + ' ' + amp + ' ' + (e ? (e.cab || '') + ' ' + (e.mic || '') : '')).toLowerCase();
        var hit = !!e && (!q || hay.indexOf(q) >= 0) && (!fa || e.amp === fa) && (!fc || e.cab === fc) && (!fm || e.mic === fm);
        cls += hit ? ' hit' : ' miss'; if (hit) hits++;
      }
      var tip = e ? (name + '\nAmp: ' + amp + '\nCab: ' + (e.cab || '?') + '\nMic: ' + (e.mic || '?')) : name;
      html += '<div class="' + cls + '" data-slot="' + slot + '" title="' + tip.replace(/"/g, '&quot;') + '">'
        + '<div class="rb-n">' + rbEsc(name || '—') + '</div>'
        + '<div class="rb-a">' + (e ? rbEsc(amp) + (fresh ? '' : ' <i>·</i>') : '<i>reading…</i>') + '</div>'
        + '<div class="rb-ic"><span class="rb-ear" title="Hear it — browser stays open">🎧</span>'
        + '<span class="rb-go" title="Go to it — closes the browser">➜</span></div></div>';
    }
  }
  grid.innerHTML = html;
  document.getElementById('rb-count').textContent = active ? (hits + ' match' + (hits === 1 ? '' : 'es')) : '';
  var n = (typeof rackCatalogCount === 'function') ? rackCatalogCount() : 0;
  document.getElementById('rb-status').textContent = (rackCatalogMode() === 'off')
    ? 'Rack catalog is off — showing the last saved catalog.'
    : (n > MAX_SLOT ? 'Catalog up to date — all ' + (MAX_SLOT + 1) + ' user slots checked this session.'
                    : 'Checking the rack in the background: ' + n + ' of ' + (MAX_SLOT + 1) + ' (· = not re-checked yet this session).');
}
function rbEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function openRigBrowser() {
  if (typeof pauseRollerForNameEdit === 'function') pauseRollerForNameEdit();
  if (typeof closeSlotMatrix === 'function') closeSlotMatrix();
  document.getElementById('rig-browser').classList.add('open');
  rbBuildFilters();
  rbRender();
  var q = document.getElementById('rb-q'); q.focus(); q.select();
}
// CLOSE / Esc: while hearing, go back to where you came from.
function closeRigBrowser() {
  if (rbOrigin !== null) rbBack();
  rbPendingHear = null; rbBar();
  document.getElementById('rig-browser').classList.remove('open');
}
// Called by rack-catalog.js whenever a slot updates.
function rigBrowserRefresh() {
  var ov = document.getElementById('rig-browser');
  if (ov && ov.classList.contains('open')) { rbBuildFilters(); rbRender(); }
}

(function rigBrowserInit() {
  ['rb-q', 'rb-amp', 'rb-cab', 'rb-mic'].forEach(function(id) {
    document.getElementById(id).addEventListener('input', rbRender);
  });
  document.getElementById('rb-close').addEventListener('click', closeRigBrowser);
  document.getElementById('rb-clear').addEventListener('click', function() {
    ['rb-q', 'rb-amp', 'rb-cab', 'rb-mic'].forEach(function(id) { document.getElementById(id).value = ''; });
    rbRender(); document.getElementById('rb-q').focus();
  });
  document.getElementById('rb-grid').addEventListener('click', function(e) {
    var c = e.target.closest('.rb-c'); if (!c) return;
    var slot = parseInt(c.dataset.slot, 10); if (isNaN(slot)) return;
    if (e.target.closest('.rb-ear')) rbHear(slot, false);
    else rbGo(slot);
  });
  document.getElementById('rb-bar').addEventListener('click', function(e) {
    var id = e.target && e.target.id;
    if (id === 'rb-back') rbBack();
    else if (id === 'rb-hear-cancel') { rbPendingHear = null; rbBar(); }
    else if (id === 'rb-hear-anyway') { var s = rbPendingHear; rbPendingHear = null; rbHear(s, true); }
  });
  document.addEventListener('keydown', function(e) {
    var ov = document.getElementById('rig-browser');
    if (e.key === 'Escape' && ov.classList.contains('open')) { e.preventDefault(); e.stopPropagation(); closeRigBrowser(); }
  }, true);
  ['btn-rig-browser-top', 'btn-rig-browser'].forEach(function(id) {
    var b = document.getElementById(id); if (b) b.addEventListener('click', function(e) { e.stopPropagation(); openRigBrowser(); });
  });
})();
