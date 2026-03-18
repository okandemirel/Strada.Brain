(function () {
  try {
    var proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
    var ws = new WebSocket(proto + location.host + '/ws');
    ws.onopen = function () {
      var el = document.getElementById('status-text');
      var dot = document.querySelector('.dot');
      if (el) el.textContent = 'Server running \u2014 see terminal for next steps';
      if (dot) dot.style.background = '#22c55e';
    };
    ws.onerror = function () {};
  } catch (_) {}

  var nv = document.querySelector('meta[name="x-node-version"]');
  var nodeEl = document.getElementById('node-ver');
  if (nodeEl) {
    nodeEl.textContent = nv ? nv.content : 'run node -v to check';
  }
}());
