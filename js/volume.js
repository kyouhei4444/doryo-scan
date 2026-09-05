/* ============================================================
   volume.js  体積の計算（点高法＝メッシュ法）

   考え方は土木の点高法そのもの。
     ① 土砂の周りの地面から「基準面」を決める
     ② 対象を格子（既定 5cm）に切り、各格子の代表高さを出す
     ③ 体積 = Σ（基準面からの比高 × 格子面積）

   比高が正なら土量（盛土）、負なら掘削量。穴も山も同じ式で出る。
   基準面が傾いていても、比高を「水平投影面あたりの高さの差」として
   足し合わせているので体積は正しい（2つの高さ関数の間の体積の定義そのもの）。
   ============================================================ */
(function (global) {
  'use strict';

  var G = global.Geom;

  /* ---------- 計測のばらつき（1セルあたりの高さのノイズ）を見積もる ----------
     隣り合う 3 セルの「2階差分」 |2h - h左 - h右| / 2 を使う。
     平面や一定勾配では 0 になるので、地形の傾きに引きずられずノイズだけが残る。
     ノイズが σ の白色雑音なら 2階差分の標準偏差は σ·√1.5 なので、そこから戻す。
     中央値を使うので、山の稜線のような一部の急変には強い。 */
  function gridSigma(grid, minCnt) {
    minCnt = minCnt || 1;
    var v = [], s, sl, sr;
    for (s = 0; s < grid.n; s++) {
      if (grid.cnt[s] < minCnt) continue;
      sl = grid.slot(grid.ix[s] - 1, grid.iz[s], false);
      sr = grid.slot(grid.ix[s] + 1, grid.iz[s], false);
      if (sl < 0 || sr < 0) continue;
      if (grid.cnt[sl] < minCnt || grid.cnt[sr] < minCnt) continue;
      v.push(Math.abs(2 * grid.mean[s] - grid.mean[sl] - grid.mean[sr]) / 2);
      if (v.length > 40000) break;
    }
    if (v.length < 30) return 0.01;
    v.sort(function (a, b) { return a - b; });
    var mad = v[v.length >> 1];
    return Math.max(0.002, 1.4826 * mad / Math.sqrt(1.5));
  }

  /* ---------- 基準面の自動推定 ----------
     地面はふつう視界の中でいちばん広い平らな面なので、RANSAC で
     「内点がいちばん多い、ほぼ水平な面」を探せば地面が採れる。
     内外判定のしきい値は、上で見積もったノイズに合わせて自動で広げる。
     （固定 5cm のままだと、荒れた計測で地面の内点が集まらず平面が暴れる）
     山の天端が広くて誤検出したときは、結果画面のスライダーで上下できる。 */
  function autoPlane(grid, opt) {
    opt = opt || {};
    var pts = grid.toPoints(opt.minCnt || 2, 20000);
    if (pts.length < 10) return null;
    var sigma = opt.sigma === undefined ? gridSigma(grid, opt.minCnt) : opt.sigma;
    var thr = opt.planeThr || Math.max(0.03, Math.min(0.25, 3 * sigma));
    var pl = G.ransacPlane(pts, {
      thr: thr,
      iter: opt.iter || 500,
      maxTilt: opt.maxTilt === undefined ? 25 : opt.maxTilt,
      minSpan: 0.3
    });
    if (pl) { pl.sigma = sigma; pl.thrUsed = thr; }
    return pl;
  }

  /* ---------- 3×3 メディアンで高さをならす ----------
     深度のノイズはセルごとに独立なので、中央値を取るだけでかなり落ちる。
     平均と違って、隣に飛び値が 1 個あっても引きずられない。
     未計測セル（観測回数 0）は計算に入れないし、埋めもしない。 */
  function medianSmooth(dense) {
    var nx = dense.nx, nz = dense.nz, N = nx * nz;
    var src = { h: dense.h, hmn: dense.hmn, hmx: dense.hmx };
    var out = { h: new Float32Array(N), hmn: new Float32Array(N), hmx: new Float32Array(N) };
    var buf = new Float32Array(9);
    var keys = ['h', 'hmn', 'hmx'];
    for (var i = 0; i < N; i++) {
      if (!dense.cnt[i]) continue;
      var x = i % nx, z = (i / nx) | 0;
      for (var k = 0; k < 3; k++) {
        var n = 0;
        for (var dz = -1; dz <= 1; dz++) {
          var zz = z + dz; if (zz < 0 || zz >= nz) continue;
          for (var dx = -1; dx <= 1; dx++) {
            var xx = x + dx; if (xx < 0 || xx >= nx) continue;
            var j = zz * nx + xx;
            if (dense.cnt[j]) buf[n++] = src[keys[k]][j];
          }
        }
        if (n < 5) { out[keys[k]][i] = src[keys[k]][i]; continue; }
        var a = Array.prototype.slice.call(buf.subarray(0, n));
        a.sort(function (p, q) { return p - q; });
        out[keys[k]][i] = a[n >> 1];
      }
    }
    dense.h = out.h; dense.hmn = out.hmn; dense.hmx = out.hmx;
    dense.smoothed = true;
  }

  /* ---------- 形態処理（8近傍の膨張・収縮） ----------
     クロージング（膨張→収縮）で、ノイズによる 1 セルの切れ目や穴を埋める。
     面積を太らせずに「砕けた塊」をつなぎ直せるので、
     荒れた計測でも山が細切れにならない。 */
  function dilate(m, nx, nz) {
    var o = new Uint8Array(m.length);
    for (var i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      var x = i % nx, z = (i / nx) | 0;
      for (var dz = -1; dz <= 1; dz++) {
        var zz = z + dz; if (zz < 0 || zz >= nz) continue;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx; if (xx < 0 || xx >= nx) continue;
          o[zz * nx + xx] = 1;
        }
      }
    }
    return o;
  }
  function erode(m, nx, nz) {
    var o = new Uint8Array(m.length);
    for (var i = 0; i < m.length; i++) {
      if (!m[i]) continue;
      var x = i % nx, z = (i / nx) | 0, ok = 1;
      for (var dz = -1; dz <= 1 && ok; dz++) {
        var zz = z + dz;
        for (var dx = -1; dx <= 1; dx++) {
          var xx = x + dx;
          if (xx < 0 || xx >= nx || zz < 0 || zz >= nz || !m[zz * nx + xx]) { ok = 0; break; }
        }
      }
      o[i] = ok;
    }
    return o;
  }
  function closing(m, nx, nz) { return erode(dilate(m, nx, nz), nx, nz); }

  /* ---------- 格子を「密な 2 次元配列」に展開 ---------- */
  function densify(grid, plane) {
    var b = grid.bounds();
    if (!b) return null;
    var nx = b.ix1 - b.ix0 + 1, nz = b.iz1 - b.iz0 + 1;
    if (nx * nz > 6000000) return { tooBig: true, nx: nx, nz: nz };

    var N = nx * nz;
    var h    = new Float32Array(N);
    var hmn  = new Float32Array(N);
    var hmx  = new Float32Array(N);
    var cnt  = new Uint16Array(N);
    var cs = grid.cs;

    for (var s = 0; s < grid.n; s++) {
      var i = (grid.iz[s] - b.iz0) * nx + (grid.ix[s] - b.ix0);
      var x = (grid.ix[s] + 0.5) * cs, z = (grid.iz[s] + 0.5) * cs;
      var py = G.planeY(plane, x, z);
      h[i]   = grid.mean[s] - py;
      hmn[i] = grid.mn[s]   - py;
      hmx[i] = grid.mx[s]   - py;
      cnt[i] = grid.cnt[s] > 65535 ? 65535 : grid.cnt[s];
    }
    return {
      ix0: b.ix0, iz0: b.iz0, nx: nx, nz: nz, cs: cs,
      h: h, hmn: hmn, hmx: hmx, cnt: cnt
    };
  }

  /* ---------- 連結成分（4近傍）。最大の塊だけ残す ---------- */
  function largestBlob(mask, nx, nz, minCells) {
    var N = nx * nz;
    var lab = new Int32Array(N).fill(-1);
    var stack = new Int32Array(N);
    var best = -1, bestSize = 0, sizes = [];
    var id = 0;

    for (var start = 0; start < N; start++) {
      if (!mask[start] || lab[start] >= 0) continue;
      var sp = 0, size = 0;
      stack[sp++] = start; lab[start] = id;
      while (sp > 0) {
        var i = stack[--sp]; size++;
        var x = i % nx, z = (i / nx) | 0;
        if (x > 0      && mask[i-1]  && lab[i-1]  < 0) { lab[i-1]  = id; stack[sp++] = i-1; }
        if (x < nx - 1 && mask[i+1]  && lab[i+1]  < 0) { lab[i+1]  = id; stack[sp++] = i+1; }
        if (z > 0      && mask[i-nx] && lab[i-nx] < 0) { lab[i-nx] = id; stack[sp++] = i-nx; }
        if (z < nz - 1 && mask[i+nx] && lab[i+nx] < 0) { lab[i+nx] = id; stack[sp++] = i+nx; }
      }
      sizes.push(size);
      if (size > bestSize) { bestSize = size; best = id; }
      id++;
    }
    if (best < 0 || bestSize < (minCells || 1)) return null;
    var out = new Uint8Array(N);
    for (var k = 0; k < N; k++) if (lab[k] === best) out[k] = 1;
    return { mask: out, size: bestSize, blobs: sizes.length };
  }

  /* ---------- 内側の抜け（未計測セル）を埋める ----------
     領域の外側から塗りつぶして、届かなかった非領域セル＝内側の穴とみなす。
     穴の高さは周囲からのラプラス補間（反復平均）で埋める。 */
  function fillHoles(sel, dense) {
    var nx = dense.nx, nz = dense.nz, N = nx * nz;
    var outside = new Uint8Array(N);
    var stack = new Int32Array(N);
    var sp = 0, i, x, z;

    for (x = 0; x < nx; x++) {
      i = x;                 if (!sel[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; }
      i = (nz - 1) * nx + x; if (!sel[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; }
    }
    for (z = 0; z < nz; z++) {
      i = z * nx;            if (!sel[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; }
      i = z * nx + nx - 1;   if (!sel[i] && !outside[i]) { outside[i] = 1; stack[sp++] = i; }
    }
    while (sp > 0) {
      i = stack[--sp];
      x = i % nx; z = (i / nx) | 0;
      if (x > 0      && !sel[i-1]  && !outside[i-1])  { outside[i-1]  = 1; stack[sp++] = i-1; }
      if (x < nx - 1 && !sel[i+1]  && !outside[i+1])  { outside[i+1]  = 1; stack[sp++] = i+1; }
      if (z > 0      && !sel[i-nx] && !outside[i-nx]) { outside[i-nx] = 1; stack[sp++] = i-nx; }
      if (z < nz - 1 && !sel[i+nx] && !outside[i+nx]) { outside[i+nx] = 1; stack[sp++] = i+nx; }
    }

    // 埋める対象は 2 種類。
    //  ① 領域の内側なのに未計測だったセル（外から塗って届かなかったセル）
    //  ② クロージングで領域に入ったが、もともと観測が無いセル
    var holes = [];
    for (i = 0; i < N; i++) {
      if (!sel[i]) { if (!outside[i]) holes.push(i); }
      else if (!dense.cnt[i]) holes.push(i);
    }
    if (!holes.length) return { interp: new Uint8Array(N), holes: 0 };

    var interp = new Uint8Array(N);
    var h = dense.h, k;
    // 初期値: 領域のうち実際に観測できたセルの平均比高
    var sum = 0, cn = 0;
    for (i = 0; i < N; i++) if (sel[i] && dense.cnt[i]) { sum += h[i]; cn++; }
    var init = cn ? sum / cn : 0;
    for (k = 0; k < holes.length; k++) { h[holes[k]] = init; interp[holes[k]] = 1; sel[holes[k]] = 1; }

    // ラプラス補間（穴のセルだけを反復平均。周りが決まっているので数十回で落ち着く）
    var tmp = new Float32Array(holes.length);
    for (var it = 0; it < 200; it++) {
      var moved = 0;
      for (k = 0; k < holes.length; k++) {
        i = holes[k]; x = i % nx; z = (i / nx) | 0;
        var s = 0, c = 0;
        if (x > 0)      { s += h[i-1];  c++; }
        if (x < nx - 1) { s += h[i+1];  c++; }
        if (z > 0)      { s += h[i-nx]; c++; }
        if (z < nz - 1) { s += h[i+nx]; c++; }
        tmp[k] = c ? s / c : h[i];
        if (Math.abs(tmp[k] - h[i]) > 0.0005) moved++;
      }
      for (k = 0; k < holes.length; k++) h[holes[k]] = tmp[k];
      if (!moved) break;
    }
    for (k = 0; k < holes.length; k++) { dense.hmn[holes[k]] = h[holes[k]]; dense.hmx[holes[k]] = h[holes[k]]; }
    return { interp: interp, holes: holes.length };
  }

  /* ---------- 片側（盛土 or 掘削）の集計 ---------- */
  function tally(dense, sel, interp, sign) {
    var A = dense.cs * dense.cs;
    var v = 0, vA = 0, vB = 0, cells = 0, hMax = 0, hSum = 0;
    var h = dense.h, hmn = dense.hmn, hmx = dense.hmx;
    for (var i = 0; i < sel.length; i++) {
      if (!sel[i]) continue;
      var d = sign * h[i];
      if (d <= 0) continue;
      cells++;
      v  += d;
      vA += Math.max(0, sign * hmn[i]);
      vB += Math.max(0, sign * hmx[i]);
      hSum += d;
      if (d > hMax) hMax = d;
    }
    if (!cells) return null;
    return {
      vol:    v  * A,
      volLo:  Math.min(vA, vB) * A,
      volHi:  Math.max(vA, vB) * A,
      area:   cells * A,
      cells:  cells,
      hMax:   hMax,
      hMean:  hSum / cells
    };
  }

  /* ---------- 本体 ----------
     opt = {
       plane:      基準面 {a,b,c}。省略時は自動推定
       planeOffset 基準面の上下微調整(m)
       thr:        対象とみなす比高のしきい値(m) 既定 0.05
       minCnt:     有効セルの最小観測回数 既定 2
       poly:       [{x,z}] 手で囲んだ範囲。省略時は自動
       largestOnly 最大の塊だけにするか 既定 true
       minArea:    塊の最小面積(m2) 既定 0.25
       fillHoles:  内側の抜けを補間するか 既定 true
       side:       'fill' 盛土 / 'cut' 掘削 / 'auto' 大きいほう
     }                                                            */
  function compute(grid, opt) {
    opt = opt || {};
    var warn = [];
    var thr    = opt.thr === undefined ? 0.05 : opt.thr;
    var minCnt = opt.minCnt || 2;

    if (!grid || !grid.n) return { error: 'スキャンした点がありません。' };

    var sigma = gridSigma(grid, minCnt);        // 1セルあたりの高さのばらつき
    var plane = opt.plane || autoPlane(grid, { minCnt: minCnt, maxTilt: opt.maxTilt, sigma: sigma });
    if (!plane) return { error: '基準面を決められませんでした。地面をもう少し広く映してください。' };
    plane = { a: plane.a, b: plane.b, c: plane.c + (opt.planeOffset || 0), inliers: plane.inliers };
    var tilt = G.tiltDeg(plane);

    var dense = densify(grid, plane);
    if (!dense) return { error: 'データがありません。' };
    if (dense.tooBig) return { error: '範囲が広すぎます（' + dense.nx + '×' + dense.nz + '格子）。設定で格子を大きくしてください。' };
    if (opt.smooth !== false) medianSmooth(dense);

    var nx = dense.nx, nz = dense.nz, N = nx * nz, i, x, z;
    var h = dense.h, cnt = dense.cnt, cs = dense.cs;

    // 手で囲んだ範囲があれば、その外は最初から除く
    var inRange = null;
    if (opt.poly && opt.poly.length >= 3) {
      inRange = new Uint8Array(N);
      for (i = 0; i < N; i++) {
        x = (dense.ix0 + (i % nx) + 0.5) * cs;
        z = (dense.iz0 + ((i / nx) | 0) + 0.5) * cs;
        inRange[i] = G.inPoly(opt.poly, x, z) ? 1 : 0;
      }
    }

    function build(sign) {
      var mask = new Uint8Array(N), any = 0;
      for (var k = 0; k < N; k++) {
        if (cnt[k] < minCnt) continue;
        if (inRange && !inRange[k]) continue;
        if (sign * h[k] > thr) { mask[k] = 1; any++; }
      }
      if (!any) return null;
      // ノイズで開いた 1 セルの切れ目・穴をクロージングで閉じる。
      // これをしないと荒れた計測で山が細切れになり、
      // 「いちばん大きい塊」がその破片になって体積が激減する。
      if (opt.closing !== false) mask = closing(mask, nx, nz);
      var still = 0;
      for (var q = 0; q < N; q++) if (mask[q]) still++;
      if (!still) return null;
      var sel;
      if (opt.largestOnly === false) {
        sel = { mask: mask, size: still, blobs: 1 };
      } else {
        sel = largestBlob(mask, nx, nz, Math.max(1, Math.round((opt.minArea === undefined ? 0.25 : opt.minArea) / (cs * cs))));
        if (!sel) return null;
      }
      return sel;
    }

    var side = opt.side || 'auto';
    var res = { plane: plane, tilt: tilt, cellSize: cs, dense: dense, warn: warn, thr: thr };

    // 盛土側と掘削側は必ず両方とも計算しておく。
    // どちらを表に出すかだけを side で選ぶ（画面で切り替えられるようにするため）
    var work = [1, -1];

    for (var wI = 0; wI < work.length; wI++) {
      var sign = work[wI];
      var blob = build(sign);
      if (!blob) continue;
      // 集計は「そのときの sel」でやるため、密配列の高さを壊さないよう複製して扱う
      var dcopy = {
        nx: nx, nz: nz, cs: cs, ix0: dense.ix0, iz0: dense.iz0,
        h: h.slice(), hmn: dense.hmn.slice(), hmx: dense.hmx.slice(), cnt: cnt
      };
      var hole = { interp: new Uint8Array(N), holes: 0 };
      if (opt.fillHoles !== false) hole = fillHoles(blob.mask, dcopy);
      var t = tally(dcopy, blob.mask, hole.interp, sign);
      if (!t) continue;
      t.sign = sign;
      t.blobs = blob.blobs;
      t.interpCells = hole.holes;
      t.interpRatio = t.cells ? hole.holes / t.cells : 0;
      t.sel = blob.mask;
      t.denseH = dcopy.h;
      t.interp = hole.interp;
      t.touchesEdge = edgeTouch(blob.mask, nx, nz);
      t.openEdge = openEdgeRatio(blob.mask, cnt, nx, nz);
      if (sign > 0) res.fill = t; else res.cut = t;
    }

    // 表に出す側を決める
    var picked = null, pickedSide = null;
    if (side === 'fill')      { picked = res.fill; pickedSide = 'fill'; }
    else if (side === 'cut')  { picked = res.cut;  pickedSide = 'cut'; }
    else if (res.fill && res.cut) {
      if (res.fill.vol >= res.cut.vol) { picked = res.fill; pickedSide = 'fill'; }
      else { picked = res.cut; pickedSide = 'cut'; }
    } else if (res.fill) { picked = res.fill; pickedSide = 'fill'; }
    else if (res.cut)    { picked = res.cut;  pickedSide = 'cut'; }

    if (!picked) {
      var other = (side === 'fill' && res.cut) ? '掘削側' : (side === 'cut' && res.fill) ? '盛土側' : null;
      return { error: other
        ? '指定された側には、基準面から ' + (thr * 100).toFixed(0) + 'cm 以上ちがう場所がありません。'
          + '（' + other + 'なら見つかっています。「何を測りますか」の指定を確認してください）'
        : '基準面から ' + (thr * 100).toFixed(0) + 'cm 以上ちがう場所が見つかりません。'
          + '基準面が土砂の上に乗っている可能性があります。結果画面の「基準面の上下」で調整してください。',
        plane: plane, tilt: tilt, dense: dense, fill: res.fill, cut: res.cut };
    }

    res.main = picked;
    res.mainSide = pickedSide;
    res.sigma = sigma;
    res.smoothed = !!dense.smoothed;

    // --- 注意書き ---
    if (picked.openEdge > 0.20) {
      warn.push('対象の外周の ' + (picked.openEdge * 100).toFixed(0) + '% が、まったく計測できていない場所と接しています。'
        + '裏側や向こう側を撮り忘れている可能性が高く、この体積は少なめに出ます。ぐるっと回り込んで撮り足してください。');
    }
    if (tilt > 8)  warn.push('基準面が ' + tilt.toFixed(1) + '° 傾いています。地面が斜めか、平面の当てはめが外れている可能性があります。');
    if (sigma > thr / 2.5) {
      warn.push('計測のばらつきが大きめです（1格子あたり ± ' + (sigma * 100).toFixed(1) + ' cm）。'
        + 'しきい値 ' + (thr * 100).toFixed(0) + ' cm に対して大きいので、しきい値を '
        + Math.ceil(sigma * 250) + ' cm 以上にするか、明るい場所でゆっくり撮り直してください。');
    }
    if (picked.interpRatio > 0.15) warn.push('対象の ' + (picked.interpRatio * 100).toFixed(0) + '% が未計測で、周囲から補間しています。撮り足すと精度が上がります。');
    if (picked.touchesEdge) warn.push('対象がスキャン範囲の端に接しています。全体を撮りきれていない可能性があります。');
    if (picked.blobs > 3) warn.push('離れた塊が ' + picked.blobs + 'か所あります。いちばん大きいものだけを集計しました。');
    if (picked.cells < 100) warn.push('格子の数が ' + picked.cells + '個と少なめです。格子を細かくするか、もっと近づいて撮ってください。');

    return res;
  }

  /* 対象の外周のうち、「まったく計測できていない場所」と接している割合。
     裏側を撮り忘れた山では、この値が大きくなる。
     内側の抜けは補間済みなので、ここには出てこない。 */
  function openEdgeRatio(mask, cnt, nx, nz) {
    var bnd = 0, open = 0;
    for (var i = 0; i < mask.length; i++) {
      if (!mask[i]) continue;
      var x = i % nx, z = (i / nx) | 0, isB = false, isO = false;
      var nb = [x > 0 ? i-1 : -1, x < nx-1 ? i+1 : -1, z > 0 ? i-nx : -1, z < nz-1 ? i+nx : -1];
      for (var k = 0; k < 4; k++) {
        var j = nb[k];
        if (j < 0) { isB = true; isO = true; continue; }   // 格子の端＝その先は未知
        if (!mask[j]) { isB = true; if (!cnt[j]) isO = true; }
      }
      if (isB) { bnd++; if (isO) open++; }
    }
    return bnd ? open / bnd : 0;
  }

  function edgeTouch(mask, nx, nz) {
    var x, z;
    for (x = 0; x < nx; x++) if (mask[x] || mask[(nz-1)*nx + x]) return true;
    for (z = 0; z < nz; z++) if (mask[z*nx] || mask[z*nx + nx - 1]) return true;
    return false;
  }

  /* ---------- 断面（縦断図・横断図用） ----------
     世界座標の 2 点を結ぶ線に沿って、地表と基準面の高さを拾う */
  function profile(res, p0, p1, nSteps) {
    var d = dense_of(res);
    if (!d) return null;
    nSteps = nSteps || 200;
    var out = [], i;
    var dx = p1.x - p0.x, dz = p1.z - p0.z;
    var L = Math.sqrt(dx*dx + dz*dz);
    if (L < 1e-6) return null;
    var sel = res.main ? res.main.sel : null;
    var hArr = res.main ? res.main.denseH : d.h;
    for (i = 0; i <= nSteps; i++) {
      var t = i / nSteps;
      var x = p0.x + dx * t, z = p0.z + dz * t;
      var ix = Math.floor(x / d.cs) - d.ix0, iz = Math.floor(z / d.cs) - d.iz0;
      var v = null, inSel = false;
      if (ix >= 0 && ix < d.nx && iz >= 0 && iz < d.nz) {
        var k = iz * d.nx + ix;
        if (d.cnt[k] > 0 || (sel && sel[k])) { v = hArr[k]; inSel = !!(sel && sel[k]); }
      }
      out.push({ s: L * t, x: x, z: z, h: v, sel: inSel });
    }
    out.len = L;
    return out;
  }

  function dense_of(res) { return res && res.dense ? res.dense : null; }

  /* ---------- 土量の換算 ----------
     L = ほぐし率（ほぐし / 地山）、C = 締固め率（締固め / 地山）
     measuredAs: 'bank'=地山（掘削前の地面そのもの） / 'loose'=ほぐし（積んである残土） */
  function convert(vol, measuredAs, L, C) {
    L = L || 1.20; C = C || 0.90;
    var bank;
    if (measuredAs === 'loose') bank = vol / L;
    else if (measuredAs === 'comp') bank = vol / C;
    else bank = vol;
    return { bank: bank, loose: bank * L, comp: bank * C, L: L, C: C };
  }

  global.Volume = {
    autoPlane: autoPlane,
    densify: densify,
    compute: compute,
    profile: profile,
    convert: convert
  };
})(window);
