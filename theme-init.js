/* Apply the saved theme BEFORE first paint so the splash + first frame never flash
   the default dark theme on restart. External file (not inline) to satisfy the
   page CSP `script-src 'self'`. Loaded synchronously in <head> before styles. */
(function () {
  try {
    var raw = localStorage.getItem('aqua.state.v1');
    var theme = raw && (JSON.parse(raw).settings || {}).theme;
    var BG = { dark: '#0e0f1c', light: '#f3f4fb', evening: '#160f26', morning: '#eef3fb', cream: '#f4ecdf', ocean: '#0a1a24', forest: '#0e1a12' };
    if (theme && BG[theme]) {
      document.documentElement.setAttribute('data-theme', theme);
      var m = document.querySelector('meta[name=theme-color]');
      if (m) m.setAttribute('content', BG[theme]);
    }
  } catch (e) {}
})();
