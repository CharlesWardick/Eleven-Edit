// ════════════════════════════════════════════════════════════════════
// TIMING-PANEL.JS — live tuning of the post-nav pull timings.
//
// The four timing values are plain `var` globals, so they can be changed at
// runtime; nothing needs rebuilding to try a different number. This panel
// edits them in place and reports what the last pull actually cost, so the
// lowest workable values can be found by experiment rather than by guessing.
//
// TUNE THESE TWO:
//   NAV_QUERY_GAP      gap between ordinary queries. The main lever.
//   NAV_RECALL_SETTLE  pause after the recall before querying starts.
//
// THESE TWO ARE NOT SPEED CONTROLS:
//   NAV_CHAIN_TIMEOUT / NAV_AMP_TIMEOUT only bound a LOST reply. The pull
//   already continues the instant the real reply arrives, so lowering them
//   cannot make anything faster — it can only cause a false give-up on a slow
//   reply. Raise them if "did not arrive" ever appears in the log; otherwise
//   leave them alone. They are shown greyed for that reason.
//
// HOW TO DIAL IN: reduce NAV_QUERY_GAP a few ms at a time, navigating several
// patches after each change, including across DIFFERENT amps and with auto
// advance running. Watch the log for "unhandled paramLo" or a readout that
// lags a patch behind — either means the gap is now too small. Then go back
// up one step. Avid's measured mean is 14.3 ms, so treat roughly 10 ms as the
// floor worth chasing.
//
// This panel is a development tool. Setting SHOW_TIMING_PANEL to false hides
// it completely without touching anything else.
// ════════════════════════════════════════════════════════════════════

var SHOW_TIMING_PANEL = true;

var TIMING_FIELDS = [
  { key: 'NAV_QUERY_GAP',     label: 'Query gap',     tune: true,
    hint: 'Between ordinary queries. Main lever. Avid mean 14.3 ms.' },
  { key: 'NAV_RECALL_SETTLE', label: 'Recall settle', tune: true,
    hint: 'Pause after recall before querying starts.' },
  { key: 'NAV_CHAIN_TIMEOUT', label: 'Chain timeout', tune: false,
    hint: 'Lost-reply bound only. Not a speed control.' },
  { key: 'NAV_AMP_TIMEOUT',   label: 'Amp timeout',   tune: false,
    hint: 'Lost-reply bound only. Not a speed control.' },
];

function buildTimingPanel() {
  if (!SHOW_TIMING_PANEL) return;
  if (document.getElementById('timing-panel')) return;

  var p = document.createElement('div');
  p.id = 'timing-panel';
  // Positioned bottom-LEFT by default and draggable by its header, because
  // bottom-right sits on top of the About and Settings buttons. Position is
  // remembered for the session only.
  p.style.cssText =
    'position:fixed;left:12px;bottom:12px;z-index:9999;' +
    'background:#1b1b1e;color:#ddd;border:1px solid #444;border-radius:6px;' +
    'font:11px/1.45 system-ui,sans-serif;padding:8px 10px;min-width:210px;' +
    'box-shadow:0 4px 14px rgba(0,0,0,.5);';

  var html = '<div id="timing-head" style="display:flex;align-items:center;gap:6px;' +
             'margin-bottom:6px;cursor:move;user-select:none">' +
             '<strong style="font-size:11px;letter-spacing:.04em">NAV TIMING</strong>' +
             '<span id="timing-collapse" style="margin-left:auto;cursor:pointer;' +
             'opacity:.6;padding:0 4px">–</span></div><div id="timing-body">';

  for (var i = 0; i < TIMING_FIELDS.length; i++) {
    var f = TIMING_FIELDS[i];
    var dim = f.tune ? '' : 'opacity:.45;';
    html += '<div title="' + f.hint + '" style="display:flex;align-items:center;' +
            'gap:6px;margin:3px 0;' + dim + '">' +
            '<span style="flex:1">' + f.label + '</span>' +
            '<input id="tp-' + f.key + '" type="number" min="0" step="1" ' +
            'style="width:58px;background:#111;color:#eee;border:1px solid #555;' +
            'border-radius:3px;padding:2px 4px;font:11px system-ui">' +
            '<span style="opacity:.5">ms</span></div>';
  }

  html += '<div style="display:flex;gap:6px;margin-top:7px">' +
          '<button id="tp-apply" style="flex:1;background:#2d4f2d;color:#dfe;' +
          'border:1px solid #4a7a4a;border-radius:3px;padding:3px;cursor:pointer;' +
          'font:11px system-ui">Apply</button>' +
          '<button id="tp-reset" style="flex:1;background:#333;color:#ccc;' +
          'border:1px solid #555;border-radius:3px;padding:3px;cursor:pointer;' +
          'font:11px system-ui">Defaults</button></div>' +
          '<div id="tp-last" style="margin-top:7px;padding-top:6px;' +
          'border-top:1px solid #333;opacity:.75">last pull: —</div>' +
          '</div>';

  p.innerHTML = html;
  document.body.appendChild(p);

  // Remember the values present at load so "Defaults" is meaningful.
  window.__timingDefaults = {};
  for (var j = 0; j < TIMING_FIELDS.length; j++) {
    window.__timingDefaults[TIMING_FIELDS[j].key] = window[TIMING_FIELDS[j].key];
  }

  document.getElementById('tp-apply').addEventListener('click', applyTimingPanel);
  document.getElementById('tp-reset').addEventListener('click', function () {
    for (var k in window.__timingDefaults) window[k] = window.__timingDefaults[k];
    loadTimingPanel();
    appLog('Nav timing reset to load-time defaults');
  });
  document.getElementById('timing-collapse').addEventListener('click', function () {
    var b = document.getElementById('timing-body');
    var open = b.style.display !== 'none';
    b.style.display = open ? 'none' : '';
    this.textContent = open ? '+' : '–';
    // Shrink right down when collapsed so it cannot sit over other controls.
    p.style.minWidth = open ? '0' : '210px';
    p.style.padding  = open ? '4px 8px' : '8px 10px';
    p.style.opacity  = open ? '0.55' : '1';
  });

  // Drag by the header.
  (function () {
    var head = document.getElementById('timing-head');
    var dx = 0, dy = 0, dragging = false;
    head.addEventListener('mousedown', function (e) {
      if (e.target.id === 'timing-collapse') return;
      dragging = true;
      var r = p.getBoundingClientRect();
      dx = e.clientX - r.left; dy = e.clientY - r.top;
      p.style.right = 'auto'; p.style.bottom = 'auto';
      e.preventDefault();
    });
    document.addEventListener('mousemove', function (e) {
      if (!dragging) return;
      p.style.left = Math.max(0, e.clientX - dx) + 'px';
      p.style.top  = Math.max(0, e.clientY - dy) + 'px';
    });
    document.addEventListener('mouseup', function () { dragging = false; });
  })();

  loadTimingPanel();
}

function loadTimingPanel() {
  for (var i = 0; i < TIMING_FIELDS.length; i++) {
    var k = TIMING_FIELDS[i].key;
    var el = document.getElementById('tp-' + k);
    if (el) el.value = window[k];
  }
  refreshTimingPanel();
}

function applyTimingPanel() {
  var changed = [];
  for (var i = 0; i < TIMING_FIELDS.length; i++) {
    var k = TIMING_FIELDS[i].key;
    var el = document.getElementById('tp-' + k);
    if (!el) continue;
    var v = parseInt(el.value, 10);
    if (isNaN(v) || v < 0) { el.value = window[k]; continue; }
    if (v !== window[k]) { changed.push(k + ' ' + window[k] + '->' + v); window[k] = v; }
  }
  appLog(changed.length
    ? 'Nav timing applied: ' + changed.join(', ')
    : 'Nav timing unchanged');
}

function refreshTimingPanel() {
  var el = document.getElementById('tp-last');
  if (!el) return;
  el.textContent = lastNavPullMs
    ? 'last pull: ' + lastNavPullQueries + ' queries, ' + lastNavPullMs + ' ms'
    : 'last pull: —';
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', buildTimingPanel);
} else {
  buildTimingPanel();
}
