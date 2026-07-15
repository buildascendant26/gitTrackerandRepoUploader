// matrix-bg.js — persistent Matrix rain background (no boot/hack sequence)
(function () {
  var CHARS = 'アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ';
  var FONT_SIZE = 16;
  var SPEED = 80;
  var TRAIL = 0.035;
  var DENSITY = 0.35;
  var HEAD_A = 0.65;
  var BODY_A = 0.45;
  var OPACITY = 0.25;

  document.addEventListener('DOMContentLoaded', function () {
    var canvas = document.getElementById('matrix');
    if (!canvas) return;
    var ctx = canvas.getContext('2d');
    canvas.style.opacity = OPACITY;

    var dpr = devicePixelRatio || 1;
    var w = innerWidth;
    var h = innerHeight;
    var cols = Math.ceil(w / FONT_SIZE);
    var drops = Array.from({ length: cols }, function () { return Math.random() * -50; });

    function resize() {
      w = innerWidth;
      h = innerHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      var nc = Math.ceil(w / FONT_SIZE);
      if (nc !== cols) {
        var old = drops;
        drops = Array.from({ length: nc }, function (_, i) { return i < old.length ? old[i] : Math.random() * -50; });
        cols = nc;
      }
    }
    resize();
    addEventListener('resize', resize);

    var lastDraw = 0;
    function tick(now) {
      requestAnimationFrame(tick);
      var dt = now - lastDraw || 16;
      if (dt < SPEED) return;
      lastDraw = now;

      ctx.fillStyle = 'rgba(0,0,0,' + TRAIL + ')';
      ctx.fillRect(0, 0, w, h);

      ctx.font = FONT_SIZE + "px 'JetBrains Mono',monospace";
      for (var i = 0; i < cols; i++) {
        if (drops[i] <= 0 && Math.random() > DENSITY) continue;
        var x = i * FONT_SIZE;
        var y = drops[i] * FONT_SIZE;

        ctx.fillStyle = 'rgba(255,255,255,' + HEAD_A + ')';
        ctx.fillText(CHARS[~~(Math.random() * CHARS.length)], x, y);

        if (y > FONT_SIZE) {
          ctx.fillStyle = 'rgba(255,255,255,' + BODY_A + ')';
          ctx.fillText(CHARS[~~(Math.random() * CHARS.length)], x, y - FONT_SIZE);
        }

        if (y > h && Math.random() > 0.975) drops[i] = 0;
        drops[i]++;
      }
    }
    requestAnimationFrame(tick);
  });
})();
