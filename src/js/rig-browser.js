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
  if (rbOrigin === null) {   // build 154: bar is permanent (no layout jump) — idle hint
    bar.innerHTML = '<span class="rb-idle">Hover a slot: 🎧 hear it (browser stays open) · ➜ or click to go to it</span>';
    bar.style.display = 'block'; return;
  }
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
  // build 154: 🎧 only ever means "hear this" — no toggle-back, and hearing the
  // start slot stays in hearing mode. Only Back / CLOSE / Esc / ➜ end it.
  if (slot !== currentSlot) goToSlot(slot);
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

// build 155: a LIST, one row per slot (Slot | Name | Amp | Cab | Mic). No search =
// every used slot (scroll, hear, go); any search/filter = only the matches;
// CLEAR brings them all back. Every slot listed (build 156).
// build 156: every slot is listed — any name could be a real patch ("Empty Nest").
function rbIsEmpty(e) { return !e; }
function rbRender() {
  var ov = document.getElementById('rig-browser');
  if (!ov || !ov.classList.contains('open')) return;
  var q  = document.getElementById('rb-q').value.trim().toLowerCase();
  var fa = document.getElementById('rb-amp').value, fc = document.getElementById('rb-cab').value,
      fm = document.getElementById('rb-mic').value;
  var active = !!(q || fa || fc || fm), shown = 0;
  var html = '<div class="rb-row rb-head"><span>Slot</span><span>Patch</span><span>Amp</span><span>Cab</span><span>Mic</span><span></span></div>';
  for (var slot = 0; slot <= MAX_SLOT; slot++) {
    var e = rackCatalog.slots[slot];
    if (rbIsEmpty(e)) continue;
    var amp = rbAmpLabel(e.amp);
    if (active) {
      var hay = (e.n + ' ' + amp + ' ' + (e.cab || '') + ' ' + (e.mic || '')).toLowerCase();
      if (!((!q || hay.indexOf(q) >= 0) && (!fa || e.amp === fa) && (!fc || e.cab === fc) && (!fm || e.mic === fm))) continue;
    }
    shown++;
    var cls = 'rb-row rb-c' + (slot === currentSlot ? ' cur' : '') + (slot === rbOrigin ? ' org' : '')
      + (rbOrigin !== null && slot === currentSlot ? ' aud' : '');
    html += '<div class="' + cls + '" data-slot="' + slot + '">'
      + '<span class="rb-sl">' + slotLabel(slot) + '</span>'
      + '<span class="rb-n">' + rbEsc(e.n) + '</span>'
      + '<span class="rb-a">' + rbEsc(amp) + '</span>'
      + '<span class="rb-x">' + rbEsc(e.cab || '') + '</span>'
      + '<span class="rb-x">' + rbEsc(e.mic || '') + '</span>'
      + '<span class="rb-ic"><span class="rb-ear" title="Hear it — browser stays open">🎧</span>'
      + '<span class="rb-go" title="Go to it — closes the browser">➜</span></span></div>';
  }
  if (!shown) html += '<div class="rb-none">' + (active ? 'No patches match.' : 'No patches in the catalog yet.') + '</div>';
  document.getElementById('rb-grid').innerHTML = html;
  document.getElementById('rb-count').textContent = active ? (shown + ' match' + (shown === 1 ? '' : 'es')) : (shown + ' patches');
  document.getElementById('rb-status').textContent = 'All ' + (MAX_SLOT + 1) + ' user slots checked this session.';
  var cur = document.querySelector('#rb-grid .rb-c.cur');
  if (cur && !active && !rbScrolled) { cur.scrollIntoView({ block: 'center' }); rbScrolled = true; }
}
var rbScrolled = false;
function rbEsc(s) { return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;'); }

function openRigBrowser() {
  if (!rigBrowserReady()) return;
  if (typeof pauseRollerForNameEdit === 'function') pauseRollerForNameEdit();
  if (typeof closeSlotMatrix === 'function') closeSlotMatrix();
  document.getElementById('rig-browser').classList.add('open');
  rbScrolled = false;
  rbBuildFilters();
  rbBar();
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
// build 154: the open buttons stay dimmed until every user slot has been
// checked this session (catalog Off = always usable, last saved catalog).
function rigBrowserReady() {
  return (typeof rackCatalogCount === 'function') && rackCatalogCount() > MAX_SLOT;
}
function rbUpdateButtons() {
  var ready = rigBrowserReady(), n = (typeof rackCatalogCount === 'function') ? rackCatalogCount() : 0;
  ['btn-rig-browser-top', 'btn-rig-browser'].forEach(function(id) {
    var b = document.getElementById(id); if (!b) return;
    b.classList.toggle('rb-wait', !ready);
    b.title = ready ? 'Rig Browser — find a patch by name, amp, cab or mic'
                    : 'Rig Browser — checking the rack… ' + n + ' of ' + (MAX_SLOT + 1) + ' slots';
  });
}
function rigBrowserRefresh() {
  rbUpdateButtons();
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
  rbUpdateButtons();
  ['btn-rig-browser-top', 'btn-rig-browser'].forEach(function(id) {
    var b = document.getElementById(id); if (b) b.addEventListener('click', function(e) { e.stopPropagation(); openRigBrowser(); });
  });
})();
