// ── Colour intensity (build 98) ──────────────────────────────────────────────
// Every green and red in the app is a :root CSS var (builds 96–97). This scales
// the lightness of each shade by one factor per family, so all shades keep their
// relative look and brighten/dim together. 100% = the original colours.
// App display pref (localStorage 'colorGreenPct' / 'colorRedPct').
var COLOR_FAMILIES = {
  green: {
    hex: { '--green': '#30c050', '--green-dim': '#1a6b3a', '--green-hi': '#6fe08a', '--green-mid': '#1f8f3c',
           '--green-soft': '#70c070', '--green-olive': '#3a7a3a' },
    rgb: { '--green-rgb': [48, 192, 80], '--green-glow-rgb': [140, 255, 170] }
  },
  red: {
    hex: { '--red': '#d03030', '--red-hot': '#e83828', '--red-deep': '#a8322a', '--red-muted': '#7a3a3a',
           '--red-bg': '#3a1414', '--red-hi': '#ff6a5c', '--red-mid': '#e04a3f', '--red-soft': '#b56a6a',
           '--red-dark': '#5a2020', '--red-hi2': '#ff6a6a', '--red-soft2': '#e46060', '--red-soft3': '#d86a6a',
           '--red-dark2': '#4a2020', '--red-bg2': '#3a1a1a' },
    rgb: { '--red-rgb': [208, 48, 48], '--red-mid-rgb': [224, 74, 63], '--red-glow-rgb': [255, 160, 150] }
  }
};

function colorScaleRgb(rgb, k) {
  var r = rgb[0] / 255, g = rgb[1] / 255, b = rgb[2] / 255;
  var mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2, h = 0, s = 0;
  if (mx !== mn) {
    var d = mx - mn;
    s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
    h = mx === r ? (g - b) / d + (g < b ? 6 : 0) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
    h /= 6;
  }
  l = Math.max(0, Math.min(1, l * k));
  function f(n) {
    var kk = (n + h * 12) % 12, a = s * Math.min(l, 1 - l);
    return Math.round(255 * (l - a * Math.max(-1, Math.min(kk - 3, 9 - kk, 1))));
  }
  return [f(0), f(8), f(4)];
}
function colorHexToRgb(h) { return [1, 3, 5].map(function (i) { return parseInt(h.substr(i, 2), 16); }); }
function colorRgbToHex(c) { return '#' + c.map(function (v) { return ('0' + v.toString(16)).slice(-2); }).join(''); }

function applyColorIntensity(family, pct) {
  var fam = COLOR_FAMILIES[family], k = pct / 100, root = document.documentElement.style;
  if (!fam) return;
  Object.keys(fam.hex).forEach(function (v) {
    if (pct === 100) root.removeProperty(v);
    else root.setProperty(v, colorRgbToHex(colorScaleRgb(colorHexToRgb(fam.hex[v]), k)));
  });
  Object.keys(fam.rgb).forEach(function (v) {
    if (pct === 100) root.removeProperty(v);
    else root.setProperty(v, colorScaleRgb(fam.rgb[v], k).join(','));
  });
}

(function initColors() {
  [['green', 'colorGreenPct'], ['red', 'colorRedPct']].forEach(function (p) {
    var pct = 100;
    try { var v = parseInt(window.localStorage.getItem(p[1]), 10); if (v >= 50 && v <= 130) pct = v; } catch (e) {}
    applyColorIntensity(p[0], pct);
    var rng = document.getElementById('color-' + p[0] + '-range');
    var lbl = document.getElementById('color-' + p[0] + '-val');
    if (!rng) return;
    rng.value = pct;
    if (lbl) lbl.textContent = pct + '%';
    rng.addEventListener('input', function () {
      var n = parseInt(rng.value, 10);
      if (lbl) lbl.textContent = n + '%';
      applyColorIntensity(p[0], n);
      try { window.localStorage.setItem(p[1], String(n)); } catch (e) {}
    });
    rng.addEventListener('dblclick', function () { rng.value = 100; rng.dispatchEvent(new Event('input')); });
  });
})();
