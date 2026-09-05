/* ============================================================
   render.js  結果を絵にする
   - MapView : 真上から見た平面図。格子を比高で色分けし、対象範囲の外周を描く
               指で拡大縮小・移動、範囲の囲み込み、断面線の指定ができる
   - section : 断面図（地表と基準面のあいだを塗る）
   ============================================================ */
(function (global) {
  'use strict';

  var G = global.Geom;

  /* シェーダと同じ色の並び。青→水→緑→黄→赤 */
  function ramp(t) {
    t = Math.max(0, Math.min(1, t));
    var c;
    if (t < 0.25)      c = mix([41,102,217],  [26,189,219],  t / 0.25);
    else if (t < 0.50) c = mix([26,189,219],  [61,194,77],  (t - 0.25) / 0.25);
    else if (t < 0.75) c = mix([61,194,77],   [250,214,41], (t - 0.50) / 0.25);
    else               c = mix([250,214,41],  [235,51,36],  (t - 0.75) / 0.25);
    return c;
  }
  function rampCut(t) {                   // 掘削側は紫系
    t = Math.max(0, Math.min(1, t));
    return mix([214,220,232], [104,45,145], t);
  }
  function mix(a, b, t) {
    return [Math.round(a[0]+(b[0]-a[0])*t), Math.round(a[1]+(b[1]-a[1])*t), Math.round(a[2]+(b[2]-a[2])*t)];
  }
  function rgb(c, a) { return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a === undefined ? 1 : a) + ')'; }

  /* ============================================================
     MapView
     ============================================================ */
  function MapView(canvas) {
    this.cv = canvas;
    this.ctx = canvas.getContext('2d');
    this.res = null;
    this.mode = 'pan';          // pan / poly / section
    this.poly = [];             // 手で囲んだ範囲（世界座標 x,z）
    this.section = null;        // {a:{x,z}, b:{x,z}}
    this.scale = 1; this.ox = 0; this.oy = 0;
    this.onChange = null;
    this._bind();
  }

  MapView.prototype.setResult = function (res, keepView) {
    this.res = res;
    this.tile = null;
    if (!keepView) this.fit();
    this.draw();
  };

  /* --- 座標変換（世界 XZ ↔ 画面） 画面右 = +X、画面下 = +Z --- */
  MapView.prototype.w2s = function (x, z) {
    return { x: (x - this.cx) * this.scale + this.cv.width / 2 + this.ox,
             y: (z - this.cz) * this.scale + this.cv.height / 2 + this.oy };
  };
  MapView.prototype.s2w = function (sx, sy) {
    return { x: (sx - this.cv.width / 2 - this.ox) / this.scale + this.cx,
             z: (sy - this.cv.height / 2 - this.oy) / this.scale + this.cz };
  };

  MapView.prototype.fit = function () {
    var d = this.res && this.res.dense;
    if (!d) { this.scale = 40; this.cx = 0; this.cz = 0; this.ox = 0; this.oy = 0; return; }
    var w = d.nx * d.cs, h = d.nz * d.cs;
    this.cx = (d.ix0 + d.nx / 2) * d.cs;
    this.cz = (d.iz0 + d.nz / 2) * d.cs;
    var m = 46;                                     // 目盛や凡例のぶんの余白
    this.scale = Math.min((this.cv.width - m * 2) / w, (this.cv.height - m * 2) / h);
    if (!isFinite(this.scale) || this.scale <= 0) this.scale = 40;
    this.ox = 0; this.oy = 0;
  };

  /* --- 格子を 1 セル 1 画素の画像にしてから拡大して描く（速い） --- */
  MapView.prototype._tile = function () {
    if (this.tile) return this.tile;
    var res = this.res, d = res.dense;
    var main = res.main;
    var img = this.ctx.createImageData(d.nx, d.nz);
    var px = img.data;
    var hArr = main ? main.denseH : d.h;
    var sel  = main ? main.sel : null;
    var interp = main ? main.interp : null;
    var hMax = main ? Math.max(0.2, main.hMax) : 1;
    var sign = main ? main.sign : 1;

    for (var i = 0; i < d.nx * d.nz; i++) {
      var o = i * 4, c, a;
      var measured = d.cnt[i] > 0;
      var inSel = sel ? !!sel[i] : false;
      if (inSel) {
        var t = Math.abs(hArr[i]) / hMax;
        c = sign > 0 ? ramp(t) : rampCut(t);
        a = (interp && interp[i]) ? 150 : 255;      // 補間したセルは薄く
      } else if (measured) {
        c = [176, 184, 192]; a = 190;               // 計測済みだが対象外＝地面
      } else {
        c = [0, 0, 0]; a = 0;
      }
      px[o] = c[0]; px[o+1] = c[1]; px[o+2] = c[2]; px[o+3] = a;
    }
    var cv = document.createElement('canvas');
    cv.width = d.nx; cv.height = d.nz;
    cv.getContext('2d').putImageData(img, 0, 0);
    this.tile = cv;
    return cv;
  };

  MapView.prototype.draw = function () {
    var cv = this.cv, ctx = this.ctx;
    var dpr = global.devicePixelRatio || 1;
    var W = cv.clientWidth * dpr, H = cv.clientHeight * dpr;
    if (cv.width !== Math.round(W) || cv.height !== Math.round(H)) {
      cv.width = Math.round(W); cv.height = Math.round(H);
      this.tile = null;
      if (this.res) this.fit();
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#eef1f4';
    ctx.fillRect(0, 0, cv.width, cv.height);
    if (!this.res || !this.res.dense) {
      ctx.fillStyle = '#8a95a0'; ctx.font = (14 * dpr) + 'px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('結果がありません', cv.width / 2, cv.height / 2);
      return;
    }
    var d = this.res.dense;
    var tl = this.w2s(d.ix0 * d.cs, d.iz0 * d.cs);
    var w = d.nx * d.cs * this.scale, h = d.nz * d.cs * this.scale;

    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this._tile(), tl.x, tl.y, w, h);
    ctx.imageSmoothingEnabled = true;

    this._outline(ctx);
    this._poly(ctx, dpr);
    this._sectionLine(ctx, dpr);
    this._scaleBar(ctx, dpr);
    this._legend(ctx, dpr);
  };

  /* 対象範囲の外周（隣が範囲外のセルの辺だけを引く） */
  MapView.prototype._outline = function (ctx) {
    var res = this.res, main = res.main;
    if (!main) return;
    var d = res.dense, sel = main.sel, nx = d.nx, nz = d.nz, cs = d.cs;
    ctx.beginPath();
    for (var i = 0; i < nx * nz; i++) {
      if (!sel[i]) continue;
      var x = i % nx, z = (i / nx) | 0;
      var wx = (d.ix0 + x) * cs, wz = (d.iz0 + z) * cs;
      var p0 = this.w2s(wx, wz), p1 = this.w2s(wx + cs, wz + cs);
      if (x === 0      || !sel[i-1])  { ctx.moveTo(p0.x, p0.y); ctx.lineTo(p0.x, p1.y); }
      if (x === nx - 1 || !sel[i+1])  { ctx.moveTo(p1.x, p0.y); ctx.lineTo(p1.x, p1.y); }
      if (z === 0      || !sel[i-nx]) { ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p0.y); }
      if (z === nz - 1 || !sel[i+nx]) { ctx.moveTo(p0.x, p1.y); ctx.lineTo(p1.x, p1.y); }
    }
    ctx.strokeStyle = 'rgba(20,32,43,.85)';
    ctx.lineWidth = Math.max(1, (global.devicePixelRatio || 1));
    ctx.stroke();
  };

  MapView.prototype._poly = function (ctx, dpr) {
    if (!this.poly.length) return;
    var self = this;
    ctx.beginPath();
    this.poly.forEach(function (p, i) {
      var s = self.w2s(p.x, p.z);
      if (i === 0) ctx.moveTo(s.x, s.y); else ctx.lineTo(s.x, s.y);
    });
    if (this.poly.length > 2) ctx.closePath();
    ctx.strokeStyle = '#e8590c'; ctx.lineWidth = 2.5 * dpr; ctx.setLineDash([7 * dpr, 5 * dpr]);
    ctx.stroke(); ctx.setLineDash([]);
    this.poly.forEach(function (p, i) {
      var s = self.w2s(p.x, p.z);
      ctx.beginPath(); ctx.arc(s.x, s.y, 6 * dpr, 0, 6.284);
      ctx.fillStyle = '#e8590c'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold ' + (10 * dpr) + 'px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), s.x, s.y);
    });
  };

  MapView.prototype._sectionLine = function (ctx, dpr) {
    if (!this.section) return;
    var a = this.w2s(this.section.a.x, this.section.a.z);
    var b = this.w2s(this.section.b.x, this.section.b.z);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    ctx.strokeStyle = '#fff'; ctx.lineWidth = 5 * dpr; ctx.stroke();
    ctx.strokeStyle = '#12395c'; ctx.lineWidth = 2.5 * dpr; ctx.stroke();
    [[a, 'A'], [b, 'B']].forEach(function (t) {
      ctx.beginPath(); ctx.arc(t[0].x, t[0].y, 8 * dpr, 0, 6.284);
      ctx.fillStyle = '#12395c'; ctx.fill();
      ctx.fillStyle = '#fff'; ctx.font = 'bold ' + (11 * dpr) + 'px system-ui';
      ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
      ctx.fillText(t[1], t[0].x, t[0].y);
    });
  };

  MapView.prototype._scaleBar = function (ctx, dpr) {
    var target = 90 * dpr;                       // だいたいこの長さになる切りのいい寸法を選ぶ
    var m = target / this.scale;
    var nice = [0.1,0.2,0.5,1,2,5,10,20,50,100], L = nice[0];
    for (var i = 0; i < nice.length; i++) if (nice[i] <= m) L = nice[i];
    var px = L * this.scale;
    var x0 = 12 * dpr, y0 = this.cv.height - 16 * dpr;
    ctx.strokeStyle = '#14202b'; ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    ctx.moveTo(x0, y0 - 6 * dpr); ctx.lineTo(x0, y0); ctx.lineTo(x0 + px, y0); ctx.lineTo(x0 + px, y0 - 6 * dpr);
    ctx.stroke();
    ctx.fillStyle = '#14202b'; ctx.font = 'bold ' + (12 * dpr) + 'px system-ui';
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillText(L >= 1 ? L + ' m' : (L * 100) + ' cm', x0, y0 - 8 * dpr);
  };

  MapView.prototype._legend = function (ctx, dpr) {
    var main = this.res.main;
    if (!main) return;
    var w = 14 * dpr, h = 110 * dpr;
    var x = this.cv.width - 52 * dpr, y = 16 * dpr;
    var g = ctx.createLinearGradient(0, y + h, 0, y);
    for (var i = 0; i <= 10; i++) {
      var c = main.sign > 0 ? ramp(i / 10) : rampCut(i / 10);
      g.addColorStop(i / 10, rgb(c));
    }
    ctx.fillStyle = g; ctx.fillRect(x, y, w, h);
    ctx.strokeStyle = '#14202b'; ctx.lineWidth = 1 * dpr; ctx.strokeRect(x, y, w, h);
    ctx.fillStyle = '#14202b'; ctx.font = 'bold ' + (11 * dpr) + 'px system-ui';
    ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(main.hMax.toFixed(2) + 'm', x + w + 4 * dpr, y);
    ctx.fillText('0', x + w + 4 * dpr, y + h);
    ctx.textBaseline = 'bottom';
    ctx.fillText(main.sign > 0 ? '高さ' : '深さ', x - 2 * dpr, y - 3 * dpr);
  };

  /* --- 指の操作 --- */
  MapView.prototype._bind = function () {
    var self = this, pts = {}, last = null, moved = 0;

    function xy(e) {
      var r = self.cv.getBoundingClientRect(), dpr = global.devicePixelRatio || 1;
      return { x: (e.clientX - r.left) * dpr, y: (e.clientY - r.top) * dpr };
    }
    function count() { return Object.keys(pts).length; }

    this.cv.addEventListener('pointerdown', function (e) {
      self.cv.setPointerCapture(e.pointerId);
      pts[e.pointerId] = xy(e); moved = 0;
      if (count() === 1) last = { one: pts[e.pointerId] };
      if (count() === 2) {
        var k = Object.keys(pts);
        last = { two: [pts[k[0]], pts[k[1]]] };
      }
      if (self.mode === 'section' && count() === 1) {
        var w = self.s2w(pts[e.pointerId].x, pts[e.pointerId].y);
        self.section = { a: w, b: w };
      }
      e.preventDefault();
    });

    this.cv.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return;
      var p = xy(e);
      var prev = pts[e.pointerId];
      moved += Math.abs(p.x - prev.x) + Math.abs(p.y - prev.y);
      pts[e.pointerId] = p;

      if (count() === 2 && last && last.two) {
        var k = Object.keys(pts), a = pts[k[0]], b = pts[k[1]];
        var d0 = dist(last.two[0], last.two[1]), d1 = dist(a, b);
        if (d0 > 4) {
          var f = d1 / d0;
          var mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          var wBefore = self.s2w(mid.x, mid.y);
          self.scale *= f;
          var sAfter = self.w2s(wBefore.x, wBefore.z);
          self.ox += mid.x - sAfter.x; self.oy += mid.y - sAfter.y;
        }
        last.two = [a, b];
        self.draw();
      } else if (count() === 1) {
        if (self.mode === 'section' && self.section) {
          self.section.b = self.s2w(p.x, p.y);
          self.draw();
          if (self.onChange) self.onChange('section');
        } else if (self.mode === 'pan') {
          self.ox += p.x - prev.x; self.oy += p.y - prev.y;
          self.draw();
        }
      }
      e.preventDefault();
    });

    function up(e) {
      var p = pts[e.pointerId];
      delete pts[e.pointerId];
      if (!p) return;
      if (self.mode === 'poly' && moved < 12 && count() === 0) {
        var w = self.s2w(p.x, p.y);
        self.poly.push(w);
        self.draw();
        if (self.onChange) self.onChange('poly');
      }
      if (count() === 0) last = null;
    }
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);

    this.cv.addEventListener('wheel', function (e) {
      var p = xy(e);
      var wBefore = self.s2w(p.x, p.y);
      self.scale *= (e.deltaY < 0 ? 1.15 : 1 / 1.15);
      var sAfter = self.w2s(wBefore.x, wBefore.z);
      self.ox += p.x - sAfter.x; self.oy += p.y - sAfter.y;
      self.draw();
      e.preventDefault();
    }, { passive: false });

    function dist(a, b) { return Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y)); }
  };

  /* ============================================================
     断面図
     ============================================================ */
  function drawSection(canvas, prof, opt) {
    opt = opt || {};
    var ctx = canvas.getContext('2d');
    var dpr = global.devicePixelRatio || 1;
    var W = Math.round(canvas.clientWidth * dpr), H = Math.round(canvas.clientHeight * dpr);
    if (canvas.width !== W || canvas.height !== H) { canvas.width = W; canvas.height = H; }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, W, H);
    if (!prof || !prof.length) {
      ctx.fillStyle = '#8a95a0'; ctx.font = (13 * dpr) + 'px system-ui'; ctx.textAlign = 'center';
      ctx.fillText('平面図で断面線を引いてください', W / 2, H / 2);
      return;
    }
    var mL = 44 * dpr, mR = 12 * dpr, mT = 14 * dpr, mB = 30 * dpr;
    var pw = W - mL - mR, ph = H - mT - mB;
    var hmin = 0, hmax = 0, i;
    for (i = 0; i < prof.length; i++) if (prof[i].h !== null) {
      if (prof[i].h < hmin) hmin = prof[i].h;
      if (prof[i].h > hmax) hmax = prof[i].h;
    }
    var pad = Math.max(0.1, (hmax - hmin) * 0.15);
    hmin -= pad; hmax += pad;
    var L = prof.len || prof[prof.length - 1].s;

    function X(s) { return mL + (s / L) * pw; }
    function Y(h) { return mT + ph - ((h - hmin) / (hmax - hmin)) * ph; }

    // 目盛
    ctx.strokeStyle = '#dde3e9'; ctx.lineWidth = 1 * dpr;
    ctx.fillStyle = '#5b6b7a'; ctx.font = (10 * dpr) + 'px system-ui';
    ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    var stepH = niceStep((hmax - hmin) / 5);
    for (var hv = Math.ceil(hmin / stepH) * stepH; hv <= hmax; hv += stepH) {
      var y = Y(hv);
      ctx.beginPath(); ctx.moveTo(mL, y); ctx.lineTo(W - mR, y); ctx.stroke();
      ctx.fillText(hv.toFixed(hv === 0 ? 0 : 2), mL - 5 * dpr, y);
    }
    ctx.textAlign = 'center'; ctx.textBaseline = 'top';
    var stepS = niceStep(L / 5);
    for (var sv = 0; sv <= L + 1e-6; sv += stepS) {
      var x = X(sv);
      ctx.beginPath(); ctx.moveTo(x, mT); ctx.lineTo(x, mT + ph); ctx.stroke();
      ctx.fillText(sv.toFixed(sv === 0 ? 0 : 1), x, mT + ph + 4 * dpr);
    }

    // 地表と基準面のあいだを塗る（欠測で途切れたらいったん閉じる）
    function closeBand(endI) { ctx.lineTo(X(prof[endI].s), Y(0)); ctx.closePath(); }
    ctx.beginPath();
    var open = false, lastI = 0;
    for (i = 0; i < prof.length; i++) {
      if (prof[i].h === null) { if (open) { closeBand(lastI); open = false; } continue; }
      if (!open) { ctx.moveTo(X(prof[i].s), Y(0)); open = true; }
      ctx.lineTo(X(prof[i].s), Y(prof[i].h));
      lastI = i;
    }
    if (open) closeBand(lastI);
    ctx.fillStyle = 'rgba(232,89,12,.28)'; ctx.fill();

    // 基準面
    ctx.beginPath(); ctx.moveTo(mL, Y(0)); ctx.lineTo(W - mR, Y(0));
    ctx.strokeStyle = '#12395c'; ctx.lineWidth = 2 * dpr; ctx.setLineDash([6 * dpr, 4 * dpr]);
    ctx.stroke(); ctx.setLineDash([]);

    // 地表
    ctx.beginPath(); var pen = false;
    for (i = 0; i < prof.length; i++) {
      if (prof[i].h === null) { pen = false; continue; }
      var px = X(prof[i].s), py = Y(prof[i].h);
      if (!pen) { ctx.moveTo(px, py); pen = true; } else ctx.lineTo(px, py);
    }
    ctx.strokeStyle = '#b02020'; ctx.lineWidth = 2.5 * dpr; ctx.stroke();

    ctx.fillStyle = '#14202b'; ctx.font = 'bold ' + (11 * dpr) + 'px system-ui';
    ctx.textAlign = 'left'; ctx.textBaseline = 'top';
    ctx.fillText('A', mL + 2 * dpr, mT + 2 * dpr);
    ctx.textAlign = 'right';
    ctx.fillText('B', W - mR - 2 * dpr, mT + 2 * dpr);
    ctx.textAlign = 'left'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = '#5b6b7a'; ctx.font = (10 * dpr) + 'px system-ui';
    ctx.fillText('横 ' + L.toFixed(2) + ' m / 縦 基準面からの比高(m)', mL, H - 2 * dpr);
  }

  function niceStep(v) {
    if (!(v > 0)) return 1;
    var e = Math.pow(10, Math.floor(Math.log(v) / Math.LN10));
    var f = v / e;
    return (f < 1.5 ? 1 : f < 3 ? 2 : f < 7 ? 5 : 10) * e;
  }

  global.Render = { MapView: MapView, drawSection: drawSection, ramp: ramp, rampCut: rampCut, rgb: rgb };
})(window);
