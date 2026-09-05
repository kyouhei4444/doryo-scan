/* ============================================================
   cases.js  計算部分の検証本体

   実機のカメラが無くても、体積が厳密に分かっている形（円錐・直方体・穴）を
   「仮想カメラ」で撮り、アプリ本体と同じ関数に通して理論値と比べる。

   仮想カメラは WebXR と同じ約束ごとで作る:
     ・投影行列は列優先、視線は -Z、clip.w = -z
     ・深度はカメラ平面からの距離（視線に沿った長さではない）
     ・(u,v) の原点は左上、u は右、v は下

   前提: Geom / HGrid / Volume が読み込み済み、TOUT(文字列) が定義済み。
   結果は window.TRESULT = {rows, fails} に入る。
   ============================================================ */
(function (global) {
  'use strict';
  var G = global.Geom, HGrid = global.HGrid, Volume = global.Volume;
  var TOUT = global.TOUT || function (s) { };

  /* ---------- 小道具 ---------- */
  function sub(a, b) { return [a[0]-b[0], a[1]-b[1], a[2]-b[2]]; }
  function cross(a, b) { return [a[1]*b[2]-a[2]*b[1], a[2]*b[0]-a[0]*b[2], a[0]*b[1]-a[1]*b[0]]; }
  function dot(a, b) { return a[0]*b[0] + a[1]*b[1] + a[2]*b[2]; }
  function norm(a) { var l = Math.sqrt(dot(a, a)); return [a[0]/l, a[1]/l, a[2]/l]; }

  /* 視点→世界 の剛体変換（列優先）。z 軸は後ろ向き、正面は -z */
  function lookAt(P, T) {
    var z = norm(sub(P, T));
    var x = norm(cross([0, 1, 0], z));
    var y = cross(z, x);
    var m = new Float64Array(16);
    m[0]=x[0]; m[1]=x[1]; m[2]=x[2];
    m[4]=y[0]; m[5]=y[1]; m[6]=y[2];
    m[8]=z[0]; m[9]=z[1]; m[10]=z[2];
    m[12]=P[0]; m[13]=P[1]; m[14]=P[2]; m[15]=1;
    m.axes = { x: x, y: y, z: z, P: P };
    return m;
  }

  /* WebXR と同じ形の投影行列。cx,cy を入れると非対称視錐台になる */
  function proj(fovYdeg, aspect, near, far, cx, cy) {
    var f = 1 / Math.tan(fovYdeg * Math.PI / 360);
    var p = new Float64Array(16);
    p[0] = f / aspect; p[5] = f;
    p[8] = cx || 0; p[9] = cy || 0;
    p[10] = (far + near) / (near - far); p[11] = -1;
    p[14] = 2 * far * near / (near - far);
    return p;
  }

  /* 画素(u,v) の視線（世界座標）。視点座標の z 成分を -1 にしてあるので、
     進んだ量 t がそのまま「カメラ平面からの距離」になる */
  function rayDir(M, up, u, v) {
    var ndcX = 2*u - 1, ndcY = 1 - 2*v;
    var dx = (ndcX + up.cx) / up.fx, dy = (ndcY + up.cy) / up.fy, dz = -1;
    var a = M.axes;
    return [a.x[0]*dx + a.y[0]*dy + a.z[0]*dz,
            a.x[1]*dx + a.y[1]*dy + a.z[1]*dz,
            a.x[2]*dx + a.y[2]*dy + a.z[2]*dz];
  }

  /* 高さ関数 S(x,z) の面に視線をぶつける。粗く進んで符号が変わったら二分法 */
  function castRay(P, d, S, tMax, step) {
    tMax = tMax || 14; step = step || 0.03;
    var t, fv;
    var f = function (t) { return (P[1] + t*d[1]) - S(P[0] + t*d[0], P[2] + t*d[2]); };
    if (f(0.05) <= 0) return -1;
    for (t = 0.05 + step; t < tMax; t += step) {
      fv = f(t);
      if (fv <= 0) {
        var lo = t - step, hi = t, mid;
        for (var k = 0; k < 34; k++) { mid = (lo + hi) / 2; if (f(mid) > 0) lo = mid; else hi = mid; }
        return (lo + hi) / 2;
      }
    }
    return -1;
  }

  /* カメラ 1 台ぶん撮って格子に入れる（縁の除去まで本体と同じ） */
  var W3 = new Float64Array(3);
  function shoot(grid, M, Pm, S, o) {
    var up = G.unprojParams(Pm);
    if (!up.ok) throw new Error('投影行列が想定の形ではありません');
    var w = o.sw, h = o.sh, i, j, k, d;
    if (!shoot._b || shoot._b.length < w*h) shoot._b = new Float64Array(w*h);
    var db = shoot._b, hits = 0;
    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        var t = castRay(M.axes.P, rayDir(M, up, (i+0.5)/w, (j+0.5)/h), S);
        if (t < o.dMin || t > o.dMax) { db[j*w+i] = 0; continue; }
        if (o.noise) t += o.noise(t);
        db[j*w+i] = t;
      }
    }
    var eA = o.edgeAbs === undefined ? 0.03 : o.edgeAbs;
    var eR = o.edgeRel === undefined ? 0.06 : o.edgeRel;
    for (j = 0; j < h; j++) {
      for (i = 0; i < w; i++) {
        k = j*w+i; d = db[k];
        if (!d) continue;
        var lim = eA + eR * d;
        if (i+1 < w) { var dr = db[k+1];  if (dr && Math.abs(dr - d) > lim) continue; }
        if (j+1 < h) { var dd = db[k+w];  if (dd && Math.abs(dd - d) > lim) continue; }
        G.unproject(W3, up, M, (i+0.5)/w, (j+0.5)/h, d);
        grid.add(W3[0], W3[1], W3[2]);
        hits++;
      }
    }
    return hits;
  }

  function defaults(o) {
    var d = { cs: 0.03, sw: 56, sh: 74, cams: 20, radius: 3.0, camY: 1.5,
              look: [0, 0.3, 0], dMin: 0.3, dMax: 8, fov: 60, aspect: 0.75, cx: 0, cy: 0, noise: null };
    for (var k in o) if (o.hasOwnProperty(k)) d[k] = o[k];
    return d;
  }

  /* 対象のまわりをぐるっと回って撮る */
  function scanAround(S, opt) {
    var o = defaults(opt);
    var grid = new HGrid(o.cs);
    var Pm = proj(o.fov, o.aspect, 0.1, 100, o.cx, o.cy);
    var hits = 0;
    for (var k = 0; k < o.cams; k++) {
      var a = 2 * Math.PI * k / o.cams;
      var pos = [o.look[0] + o.radius*Math.cos(a), o.camY, o.look[2] + o.radius*Math.sin(a)];
      hits += shoot(grid, lookAt(pos, o.look), Pm, S, o);
    }
    return { grid: grid, hits: hits };
  }

  /* ---------- 判定 ---------- */
  var rows = [], fails = 0;
  function check(name, got, want, tolPct, note) {
    var err = want === 0 ? (got === 0 ? 0 : 100) : (got - want) / Math.abs(want) * 100;
    var ok = Math.abs(err) <= tolPct;
    if (!ok) fails++;
    rows.push([ok, name, want.toFixed(4), got.toFixed(4),
               (err >= 0 ? '+' : '') + err.toFixed(2) + '%', '±' + tolPct + '%', note || '']);
    return ok;
  }
  function checkAbs(name, got, want, tolAbs, unit, note) {
    var d = Math.abs(got - want), ok = d <= tolAbs;
    if (!ok) fails++;
    rows.push([ok, name, fmtE(want), fmtE(got), fmtE(d) + (unit || ''), '≤' + fmtE(tolAbs), note || '']);
    return ok;
  }
  function fmtE(v) { return Math.abs(v) < 1e-4 && v !== 0 ? v.toExponential(2) : (+v).toFixed(5); }
  function rnd0(seed) { var s = seed; return function () { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; }; }

  /* ---------- 形 ---------- */
  function cone(R, H, base) {
    base = base || function () { return 0; };
    return function (x, z) {
      var r = Math.sqrt(x*x + z*z);
      return base(x, z) + (r < R ? H * (1 - r/R) : 0);
    };
  }
  /* 比高がしきい値 thr を超える範囲だけを積分した円錐の体積（理論値） */
  function coneVolAbove(R, H, thr) {
    var Rp = R * (1 - thr / H);
    return 2 * Math.PI * H * (Rp*Rp/2 - Rp*Rp*Rp/(3*R));
  }

  /* ============================================================
     1. 逆投影の往復
     ============================================================ */
  TOUT('【1】逆投影の往復精度（世界座標 → 深度 → 世界座標）');
  [[0, 0, '対称視錐台'], [0.13, -0.07, '非対称視錐台']].forEach(function (t) {
    var Pm = proj(62, 0.75, 0.1, 100, t[0], t[1]);
    var up = G.unprojParams(Pm);
    if (!up.ok) { TOUT('  NG: unprojParams が ' + t[2] + ' を認識できていません'); fails++; return; }
    var M = lookAt([1.3, 1.6, -2.2], [0.2, 0.25, 0.4]);
    var A = M.axes, worst = 0;
    for (var n = 0; n < 20000; n++) {
      var d = 0.4 + Math.random() * 7;
      var dir = rayDir(M, up, Math.random(), Math.random());
      var w = [A.P[0] + d*dir[0], A.P[1] + d*dir[1], A.P[2] + d*dir[2]];
      var rel = sub(w, A.P);
      var pv = [dot(rel, A.x), dot(rel, A.y), dot(rel, A.z)];
      var dd = -pv[2];
      var u2 = ((up.fx * pv[0] / dd - up.cx) + 1) / 2;
      var v2 = (1 - (up.fy * pv[1] / dd - up.cy)) / 2;
      G.unproject(W3, up, M, u2, v2, dd);
      worst = Math.max(worst, Math.sqrt(Math.pow(W3[0]-w[0],2) + Math.pow(W3[1]-w[1],2) + Math.pow(W3[2]-w[2],2)));
    }
    checkAbs('逆投影の往復誤差（' + t[2] + '・2万点）', worst, 0, 1e-9, ' m');
  });

  /* ============================================================
     2. 基準面の当てはめ
     ============================================================ */
  TOUT('【2】基準面の当てはめ');
  (function () {
    var truth = { a: 0.087, b: -0.052, c: 0.31 };
    var rnd = rnd0(12345), pts = [], i, x, z;
    for (i = 0; i < 4000; i++) {
      x = (rnd()-0.5)*10; z = (rnd()-0.5)*10;
      pts.push({ x: x, z: z, y: truth.a*x + truth.b*z + truth.c + (rnd()-0.5)*0.02 });
    }
    var fit = G.fitPlane(pts);
    checkAbs('最小二乗 勾配 a', fit.a, truth.a, 5e-4);
    checkAbs('最小二乗 勾配 b', fit.b, truth.b, 5e-4);
    checkAbs('最小二乗 切片 c', fit.c, truth.c, 5e-4, ' m');

    for (i = 0; i < 2600; i++) {            // 4割ちかくを「土砂の山」に置き換える
      x = (rnd()-0.5)*3; z = (rnd()-0.5)*3;
      pts.push({ x: x, z: z, y: truth.a*x + truth.b*z + truth.c + 0.4 + rnd()*0.8 });
    }
    var r = G.ransacPlane(pts, { thr: 0.04, iter: 900, maxTilt: 25 });
    checkAbs('RANSAC 切片 c（外れ値 39%）', r.c, truth.c, 0.02, ' m');
    checkAbs('RANSAC 勾配 a（外れ値 39%）', r.a, truth.a, 0.01);
  })();

  /* ============================================================
     3. 円錐（土砂の山）
     ============================================================ */
  TOUT('【3】円錐（土砂の山）の体積');
  (function () {
    var R = 1.5, H = 1.0, thr = 0.05;
    var s = scanAround(cone(R, H), { cs: 0.03, cams: 20, radius: 3.2, camY: 1.5 });
    var res = Volume.compute(s.grid, { thr: thr, minCnt: 1, side: 'fill', maxTilt: 20 });
    if (res.error) { TOUT('  NG: ' + res.error); fails++; return; }
    check('円錐 体積（R1.5m H1.0m）', res.main.vol, coneVolAbove(R, H, thr), 3,
          '真の全体積 ' + (Math.PI*R*R*H/3).toFixed(4) + ' m3 / 裾切り後 ' + coneVolAbove(R, H, thr).toFixed(4) + ' m3');
    check('円錐 最大高さ', res.main.hMax, H, 10, '尖端は 1 格子で平均されるので少し低く出る');
    checkAbs('円錐 基準面の高さ', res.plane.c, 0, 0.01, ' m');
    TOUT('  点 ' + s.hits.toLocaleString() + ' / 格子 ' + s.grid.n.toLocaleString()
       + ' / 補間 ' + (res.main.interpRatio*100).toFixed(1) + '% / 基準面の傾き ' + res.tilt.toFixed(2) + '°'
       + ' / ばらつき σ=' + (res.sigma*100).toFixed(2) + 'cm');
  })();

  /* ============================================================
     4. 直方体
     ============================================================ */
  TOUT('【4】直方体の体積');
  (function () {
    var a = 0.5, b = 0.4, H = 0.6;
    var box = function (x, z) { return (Math.abs(x) < a && Math.abs(z) < b) ? H : 0; };
    var s = scanAround(box, { cs: 0.02, cams: 24, radius: 2.2, camY: 1.4 });
    var res = Volume.compute(s.grid, { thr: 0.05, minCnt: 1, side: 'fill', maxTilt: 15 });
    if (res.error) { TOUT('  NG: ' + res.error); fails++; return; }
    check('直方体 体積（1.0×0.8×0.6m）', res.main.vol, 4*a*b*H, 4);
    check('直方体 上面積', res.main.area, 4*a*b, 10, '格子の刻みぶん外周が太る');
    check('直方体 高さ', res.main.hMax, H, 4);
  })();

  /* ============================================================
     5. 掘削した穴
     ============================================================ */
  TOUT('【5】掘削した穴（負の比高）');
  (function () {
    var a = 0.6, b = 0.45, D = 0.5;
    var hole = function (x, z) { return (Math.abs(x) < a && Math.abs(z) < b) ? -D : 0; };
    var s = scanAround(hole, { cs: 0.02, cams: 16, radius: 1.6, camY: 1.8, look: [0, -0.2, 0], dMax: 6 });
    var res = Volume.compute(s.grid, { thr: 0.05, minCnt: 1, side: 'auto', maxTilt: 15 });
    if (res.error) { TOUT('  NG: ' + res.error); fails++; return; }
    check('穴 体積（1.2×0.9×深0.5m）', res.main.vol, 4*a*b*D, 8);
    check('穴 最大深さ', res.main.hMax, D, 4);
    rows.push([res.mainSide === 'cut', '掘削側と判定できたか', 'cut', res.mainSide, '—', '—', 'side=auto で自動判別']);
    if (res.mainSide !== 'cut') fails++;
  })();

  /* ============================================================
     6. 傾いた地面の上の山
     ============================================================ */
  TOUT('【6】傾いた地面（10%勾配）の上の山');
  (function () {
    var R = 1.3, H = 0.8, thr = 0.05;
    var slope = function (x, z) { return 0.10*x - 0.06*z; };
    var s = scanAround(cone(R, H, slope), { cs: 0.03, cams: 20, radius: 3.0, camY: 1.6 });
    var res = Volume.compute(s.grid, { thr: thr, minCnt: 1, side: 'fill', maxTilt: 25 });
    if (res.error) { TOUT('  NG: ' + res.error); fails++; return; }
    check('傾斜地の上の山 体積', res.main.vol, coneVolAbove(R, H, thr), 4);
    checkAbs('推定した勾配 a', res.plane.a, 0.10, 0.01);
    checkAbs('推定した勾配 b', res.plane.b, -0.06, 0.01);
  })();

  /* ============================================================
     7. 深度にノイズを乗せる（実機に近い条件）
     ============================================================ */
  TOUT('【7】深度ノイズを入れたとき（σ＝距離の何％か）');
  (function () {
    var R = 1.5, H = 1.0, thr = 0.05;
    var rnd = rnd0(777);
    function gauss() { return Math.sqrt(-2*Math.log(rnd()+1e-12)) * Math.cos(2*Math.PI*rnd()); }
    [1, 2, 4].forEach(function (pct) {
      var s = scanAround(cone(R, H), {
        cs: 0.03, cams: 20, radius: 3.2, camY: 1.5,
        noise: function (t) { return gauss() * (0.005 + pct/100 * t); }
      });
      var res = Volume.compute(s.grid, { thr: thr, minCnt: 2, side: 'fill', maxTilt: 20 });
      if (res.error) { TOUT('  NG(σ=' + pct + '%): ' + res.error); fails++; return; }
      check('円錐 体積（深度ノイズ σ=' + pct + '%×距離）', res.main.vol, coneVolAbove(R, H, thr), 12,
            '推定ばらつき ' + (res.sigma*100).toFixed(1) + 'cm / 警告 ' + res.warn.length + '件');
    });
  })();

  /* ============================================================
     8. 裏側を撮り忘れたとき
     ============================================================ */
  TOUT('【8】半周しか撮らなかったとき（補間と警告）');
  (function () {
    var R = 1.5, H = 1.0, thr = 0.05;
    var o = defaults({ cs: 0.03 });
    var grid = new HGrid(o.cs);
    var Pm = proj(o.fov, o.aspect, 0.1, 100);
    var S = cone(R, H);
    for (var k = 0; k < 12; k++) {
      var a = Math.PI * k / 12;
      shoot(grid, lookAt([3.2*Math.cos(a), 1.5, 3.2*Math.sin(a)], [0, 0.3, 0]), Pm, S, o);
    }
    var res = Volume.compute(grid, { thr: thr, minCnt: 1, side: 'fill', maxTilt: 20 });
    if (res.error) { TOUT('  NG: ' + res.error); fails++; return; }
    var want = coneVolAbove(R, H, thr);
    // 撮っていない側のデータは作れないので、体積が少なめに出るのは正しい挙動。
    // 大事なのは「少なく出ている」と気づけること。ここでは警告が出るかを見る。
    var openOk = res.main.openEdge > 0.20;
    var warnOk = res.warn.some(function (w) { return w.indexOf('外周') >= 0; });
    rows.push([openOk && warnOk, '裏側の撮り漏れを検知できるか', '外周20%超で警告',
               '外周 ' + (res.main.openEdge*100).toFixed(0) + '% / ' + (warnOk ? '警告あり' : '警告なし'),
               '—', '—', '体積は ' + res.main.vol.toFixed(3) + ' m3（真値 ' + want.toFixed(3) + ' の '
               + (res.main.vol/want*100).toFixed(0) + '%）']);
    if (!(openOk && warnOk)) fails++;
  })();

  /* ============================================================
     9. 手で囲んだ範囲だけを集計できるか
     ============================================================ */
  TOUT('【9】範囲を囲んで、片方の山だけを集計する');
  (function () {
    var R = 1.0, H = 0.8, thr = 0.05;
    // 左右に同じ山を 2 つ置き、右の山だけを囲む
    function two(x, z) {
      var r1 = Math.sqrt((x+2.2)*(x+2.2) + z*z), r2 = Math.sqrt((x-2.2)*(x-2.2) + z*z);
      return (r1 < R ? H*(1-r1/R) : 0) + (r2 < R ? H*(1-r2/R) : 0);
    }
    var o = defaults({ cs: 0.03, cams: 26, radius: 4.6, camY: 1.6, dMax: 9 });
    var grid = new HGrid(o.cs);
    var Pm = proj(o.fov, o.aspect, 0.1, 100);
    for (var k = 0; k < o.cams; k++) {
      var a = 2*Math.PI*k/o.cams;
      shoot(grid, lookAt([o.radius*Math.cos(a), o.camY, o.radius*Math.sin(a)], [0, 0.3, 0]), Pm, two, o);
    }
    var poly = [{x:0.6,z:-1.6},{x:3.9,z:-1.6},{x:3.9,z:1.6},{x:0.6,z:1.6}];
    var res = Volume.compute(grid, { thr: thr, minCnt: 1, side: 'fill', maxTilt: 20, poly: poly });
    if (res.error) { TOUT('  NG: ' + res.error); fails++; return; }
    check('囲んだ右の山だけの体積', res.main.vol, coneVolAbove(R, H, thr), 6, '山は左右に 2 つある');
  })();

  /* ============================================================
     10. 格子の保存・復元
     ============================================================ */
  TOUT('【10】格子の保存・復元（IndexedDB へ入れる形）');
  (function () {
    var g = new HGrid(0.05), rnd = rnd0(99);
    for (var i = 0; i < 50000; i++) g.add((rnd()-0.5)*8, rnd()*2, (rnd()-0.5)*8);
    var g2 = HGrid.unpack(g.pack());
    var same = g.n === g2.n, worst = 0;
    for (var s = 0; s < g.n && same; s++) {
      var s2 = g2.slot(g.ix[s], g.iz[s], false);
      if (s2 < 0 || g.cnt[s] !== g2.cnt[s2]) { same = false; break; }
      worst = Math.max(worst, Math.abs(g.mean[s] - g2.mean[s2]));
    }
    rows.push([same, '格子 ' + g.n.toLocaleString() + ' セルの往復', '完全一致', same ? '一致' : '不一致', '—', '—', '']);
    if (!same) fails++;
    checkAbs('復元後の高さの最大差', worst, 0, 1e-9, ' m');
  })();

  global.TRESULT = { rows: rows, fails: fails };
})(typeof window !== 'undefined' ? window : globalThis);
