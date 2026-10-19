/* ============================================================
   mesh.js  点群から「面を張った3Dモデル」を作る

   2通りの作り方を用意する。

   ① solidFromResult  …… 高さ格子から作る「閉じた立体」
        上面＝計測した地表、底面＝基準面、側面＝法尻の壁。
        水密（穴のない閉じた形）なので、立体としての体積が計算でき、
        それが画面に出している体積と一致する。土砂の山・掘削穴向け。
        ただし真上から見て高さが1つに決まる形（2.5次元）しか作れないので、
        オーバーハングや物体の裏側は表現できない。

   ② surfaceFromCloud …… 3次元の点群から作る「表面」
        点群までの距離場をつくり、等距離面を Surface Nets で拾う。
        側面も裏側も出るので、土以外の物体（機械・構造物・岩など）向け。
        点の無いところは埋まらないので、ぐるっと撮るほど形が出る。

   どちらも 位置・法線・頂点色・三角形 の配列を返す。
   ============================================================ */
(function (global) {
  'use strict';

  var G = global.Geom;

  /* ---------- 共通の入れ物 ---------- */
  function Builder() {
    this.pos = [];      // x,y,z,...
    this.col = [];      // r,g,b (0-255)
    this.idx = [];      // 三角形の頂点番号
  }
  Builder.prototype.vert = function (x, y, z, c) {
    this.pos.push(x, y, z);
    this.col.push(c[0], c[1], c[2]);
    return (this.pos.length / 3) - 1;
  };
  Builder.prototype.tri = function (a, b, c) { this.idx.push(a, b, c); };
  Builder.prototype.quad = function (a, b, c, d) { this.idx.push(a, b, c, a, c, d); };

  Builder.prototype.finish = function (extra) {
    var m = {
      positions: new Float32Array(this.pos),
      colors: new Uint8Array(this.col),
      indices: new Uint32Array(this.idx),
      vertexCount: this.pos.length / 3,
      triangleCount: this.idx.length / 3
    };
    m.normals = computeNormals(m.positions, m.indices);
    m.bounds = bounds(m.positions);
    if (extra) for (var k in extra) if (extra.hasOwnProperty(k)) m[k] = extra[k];
    return m;
  };

  /* 面法線を頂点に足し込んで正規化する（滑らかな陰影になる） */
  function computeNormals(P, I) {
    var N = new Float32Array(P.length);
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t] * 3, b = I[t+1] * 3, c = I[t+2] * 3;
      var ux = P[b]-P[a], uy = P[b+1]-P[a+1], uz = P[b+2]-P[a+2];
      var vx = P[c]-P[a], vy = P[c+1]-P[a+1], vz = P[c+2]-P[a+2];
      var nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
      N[a]+=nx; N[a+1]+=ny; N[a+2]+=nz;
      N[b]+=nx; N[b+1]+=ny; N[b+2]+=nz;
      N[c]+=nx; N[c+1]+=ny; N[c+2]+=nz;
    }
    for (var i = 0; i < N.length; i += 3) {
      var L = Math.sqrt(N[i]*N[i] + N[i+1]*N[i+1] + N[i+2]*N[i+2]);
      if (L > 1e-12) { N[i]/=L; N[i+1]/=L; N[i+2]/=L; } else { N[i+1] = 1; }
    }
    return N;
  }

  function bounds(P) {
    var b = { x0: 1e30, y0: 1e30, z0: 1e30, x1: -1e30, y1: -1e30, z1: -1e30 };
    for (var i = 0; i < P.length; i += 3) {
      if (P[i]   < b.x0) b.x0 = P[i];   if (P[i]   > b.x1) b.x1 = P[i];
      if (P[i+1] < b.y0) b.y0 = P[i+1]; if (P[i+1] > b.y1) b.y1 = P[i+1];
      if (P[i+2] < b.z0) b.z0 = P[i+2]; if (P[i+2] > b.z1) b.z1 = P[i+2];
    }
    b.w = b.x1 - b.x0; b.h = b.y1 - b.y0; b.d = b.z1 - b.z0;
    return b;
  }

  /* 閉じた立体の体積（発散定理）。符号は面の向きで決まる */
  function volume(m) {
    var P = m.positions, I = m.indices, v = 0;
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t]*3, b = I[t+1]*3, c = I[t+2]*3;
      v += (P[a]   * (P[b+1]*P[c+2] - P[b+2]*P[c+1])
          - P[a+1] * (P[b]  *P[c+2] - P[b+2]*P[c]  )
          + P[a+2] * (P[b]  *P[c+1] - P[b+1]*P[c]  )) / 6;
    }
    return Math.abs(v);
  }

  /* ---------- 色 ---------- */
  function ramp(t) {
    t = Math.max(0, Math.min(1, t));
    function mix(a, b, s) {
      return [Math.round(a[0]+(b[0]-a[0])*s), Math.round(a[1]+(b[1]-a[1])*s), Math.round(a[2]+(b[2]-a[2])*s)];
    }
    if (t < 0.25) return mix([41,102,217],  [26,189,219],  t/0.25);
    if (t < 0.50) return mix([26,189,219],  [61,194,77],  (t-0.25)/0.25);
    if (t < 0.75) return mix([61,194,77],   [250,214,41], (t-0.50)/0.25);
    return               mix([250,214,41],  [235,51,36],  (t-0.75)/0.25);
  }
  var GRAY = [170, 170, 170], BASE = [120, 110, 100];

  /* ============================================================
     ① 高さ格子から「閉じた立体」を作る
     opt = { colorBy: 'height'|'none', skirt: 底面を付けるか(既定 true) }
     ============================================================ */
  function solidFromResult(res, opt) {
    opt = opt || {};
    if (!res || !res.dense || !res.main) return null;
    var d = res.dense, main = res.main;
    var nx = d.nx, nz = d.nz, cs = d.cs;
    var H = main.denseH, sel = main.sel;
    var sign = main.sign;
    var colorBy = opt.colorBy === undefined ? 'height' : opt.colorBy;
    var hMax = Math.max(0.05, main.hMax);

    // --- 格子の「角」の高さ。隣り合う選択セルの平均を取る ---
    var cnx = nx + 1, cnz = nz + 1;
    var ch = new Float32Array(cnx * cnz);
    var cn = new Uint8Array(cnx * cnz);
    var used = new Uint8Array(cnx * cnz);
    var i, x, z, k;
    for (z = 0; z < nz; z++) {
      for (x = 0; x < nx; x++) {
        i = z * nx + x;
        if (!sel[i]) continue;
        var h = H[i];
        for (var dz = 0; dz <= 1; dz++) {
          for (var dx = 0; dx <= 1; dx++) {
            k = (z + dz) * cnx + (x + dx);
            ch[k] += h; cn[k]++; used[k] = 1;
          }
        }
      }
    }
    for (k = 0; k < ch.length; k++) if (cn[k]) ch[k] /= cn[k];

    var B = new Builder();
    var topIdx = new Int32Array(cnx * cnz).fill(-1);
    var botIdx = new Int32Array(cnx * cnz).fill(-1);
    var skirt = opt.skirt !== false;

    function cx(ix) { return (d.ix0 + ix) * cs; }
    function cz(iz) { return (d.iz0 + iz) * cs; }

    function topV(ix, iz) {
      var kk = iz * cnx + ix;
      if (topIdx[kk] >= 0) return topIdx[kk];
      var X = cx(ix), Z = cz(iz), h = ch[kk];
      var y = G.planeY(res.plane, X, Z) + h;
      var c = colorBy === 'height' ? ramp(Math.abs(h) / hMax) : GRAY;
      return (topIdx[kk] = B.vert(X, y, Z, c));
    }
    function botV(ix, iz) {
      var kk = iz * cnx + ix;
      if (botIdx[kk] >= 0) return botIdx[kk];
      var X = cx(ix), Z = cz(iz);
      return (botIdx[kk] = B.vert(X, G.planeY(res.plane, X, Z), Z, BASE));
    }

    // --- 上面 ---
    for (z = 0; z < nz; z++) {
      for (x = 0; x < nx; x++) {
        if (!sel[z * nx + x]) continue;
        var a = topV(x, z), b = topV(x+1, z), c2 = topV(x+1, z+1), e = topV(x, z+1);
        // 盛土は上から見て反時計回り、掘削は逆（外向き法線にそろえる）
        if (sign > 0) B.quad(a, e, c2, b); else B.quad(a, b, c2, e);
      }
    }

    if (skirt) {
      // --- 底面（基準面）---
      for (z = 0; z < nz; z++) {
        for (x = 0; x < nx; x++) {
          if (!sel[z * nx + x]) continue;
          var a2 = botV(x, z), b2 = botV(x+1, z), c3 = botV(x+1, z+1), e2 = botV(x, z+1);
          if (sign > 0) B.quad(a2, b2, c3, e2); else B.quad(a2, e2, c3, b2);
        }
      }
      // --- 側面（選択の外周に壁を立てる）---
      for (z = 0; z < nz; z++) {
        for (x = 0; x < nx; x++) {
          i = z * nx + x;
          if (!sel[i]) continue;
          // 左(-x)
          if (x === 0 || !sel[i-1])      wall(x, z, x, z+1);
          // 右(+x)
          if (x === nx-1 || !sel[i+1])   wall(x+1, z+1, x+1, z);
          // 手前(-z)
          if (z === 0 || !sel[i-nx])     wall(x+1, z, x, z);
          // 奥(+z)
          if (z === nz-1 || !sel[i+nx])  wall(x, z+1, x+1, z+1);
        }
      }
    }
    function wall(ix0, iz0, ix1, iz1) {
      var t0 = topV(ix0, iz0), t1 = topV(ix1, iz1);
      var b0 = botV(ix0, iz0), b1 = botV(ix1, iz1);
      if (sign > 0) B.quad(b0, b1, t1, t0); else B.quad(b0, t0, t1, b1);
    }

    var m = B.finish({ kind: 'solid', watertight: skirt, cellSize: cs });
    m.meshVolume = volume(m);
    m.reportedVolume = main.vol;
    return m;
  }

  /* ============================================================
     ② 点群から「表面」を作る（距離場 ＋ Surface Nets）

     1. 点群を包む箱を voxel 間隔で切り、点のあるボクセルを 0 とする
     2. チャンファー距離変換で、各ボクセルの「最寄りの点までの距離」を出す
     3. 距離 = iso の等値面を Surface Nets で拾う
        → 点群を iso だけ膨らませた殻になる。法線も穴埋めも要らないので頑丈

     opt = { voxel: 格子間隔(m), iso: 膨らませ量(m), maxCells: 上限,
             crop: {plane, sel, dense, below} 対象だけ切り出す条件, colorBy }
     ============================================================ */
  function surfaceFromCloud(cloud, opt) {
    opt = opt || {};
    if (!cloud || !cloud.n) return null;

    // --- 使う点を選ぶ（対象だけに絞ることができる）---
    var pts = pickPoints(cloud, opt.crop);
    if (pts.n < 50) return { error: '使える点が ' + pts.n + ' 個しかありません。もっと撮ってください。' };

    var bb = { x0: 1e30, y0: 1e30, z0: 1e30, x1: -1e30, y1: -1e30, z1: -1e30 };
    var i, j;
    for (i = 0; i < pts.n; i++) {
      var X = pts.x[i], Y = pts.y[i], Z = pts.z[i];
      if (X < bb.x0) bb.x0 = X; if (X > bb.x1) bb.x1 = X;
      if (Y < bb.y0) bb.y0 = Y; if (Y > bb.y1) bb.y1 = Y;
      if (Z < bb.z0) bb.z0 = Z; if (Z > bb.z1) bb.z1 = Z;
    }

    // --- 格子間隔を決める。細かすぎて落ちないよう上限で丸める ---
    var vs = opt.voxel || 0.03;
    var iso = opt.iso === undefined ? vs * 1.2 : opt.iso;
    var maxCells = opt.maxCells || 3000000;
    var pad = iso * 2 + vs * 2;
    var W = (bb.x1 - bb.x0) + pad * 2, Hh = (bb.y1 - bb.y0) + pad * 2, D = (bb.z1 - bb.z0) + pad * 2;
    var need = (W / vs) * (Hh / vs) * (D / vs);
    var scaled = false;
    if (need > maxCells) {
      vs = Math.cbrt((W * Hh * D) / maxCells);
      iso = opt.iso === undefined ? vs * 1.2 : Math.max(opt.iso, vs * 0.8);
      pad = iso * 2 + vs * 2;
      W = (bb.x1 - bb.x0) + pad * 2; Hh = (bb.y1 - bb.y0) + pad * 2; D = (bb.z1 - bb.z0) + pad * 2;
      scaled = true;
    }
    var nx = Math.max(3, Math.ceil(W / vs) + 1);
    var ny = Math.max(3, Math.ceil(Hh / vs) + 1);
    var nz = Math.max(3, Math.ceil(D / vs) + 1);
    var ox = bb.x0 - pad, oy = bb.y0 - pad, oz = bb.z0 - pad;

    // --- 1. 点のあるボクセルを 0、それ以外を大きな値に ---
    var N = nx * ny * nz;
    var F = new Float32Array(N);
    var BIG = 1e9;
    F.fill(BIG);
    for (i = 0; i < pts.n; i++) {
      var ix = Math.round((pts.x[i] - ox) / vs);
      var iy = Math.round((pts.y[i] - oy) / vs);
      var iz = Math.round((pts.z[i] - oz) / vs);
      if (ix < 0 || iy < 0 || iz < 0 || ix >= nx || iy >= ny || iz >= nz) continue;
      F[(iz * ny + iy) * nx + ix] = 0;
    }

    // --- 2. チャンファー距離変換（前進・後退の2パス）---
    chamfer3(F, nx, ny, nz);

    // --- 3. 距離を実寸にして iso を引き、符号付きの場にする ---
    for (i = 0; i < N; i++) F[i] = F[i] * vs - iso;

    var mesh = surfaceNets(F, nx, ny, nz, vs, ox, oy, oz, opt, pts);
    mesh.kind = 'surface';
    mesh.voxel = vs;
    mesh.iso = iso;
    mesh.usedPoints = pts.n;
    mesh.scaledDown = scaled;
    mesh.gridSize = nx + '×' + ny + '×' + nz;
    return mesh;
  }

  /* 対象だけに絞る。crop = {plane, dense, sel, thr} */
  function pickPoints(cloud, crop) {
    var n = cloud.n, keep = null, cnt = n, i;
    if (crop && crop.sel && crop.dense && crop.plane) {
      keep = new Uint8Array(n); cnt = 0;
      var d = crop.dense, sel = crop.sel, cs = d.cs;
      var lo = crop.thr === undefined ? 0.03 : crop.thr;
      for (i = 0; i < n; i++) {
        var ix = Math.floor(cloud.px[i] / cs) - d.ix0;
        var iz = Math.floor(cloud.pz[i] / cs) - d.iz0;
        if (ix < 0 || iz < 0 || ix >= d.nx || iz >= d.nz) continue;
        if (!sel[iz * d.nx + ix]) continue;
        // 基準面より下（地面側）に潜り込んだ点は落とす。掘削のときは逆
        var rel = cloud.py[i] - G.planeY(crop.plane, cloud.px[i], cloud.pz[i]);
        if (crop.sign > 0 ? (rel < -lo) : (rel > lo)) continue;
        keep[i] = 1; cnt++;
      }
    }
    var out = { n: cnt, x: new Float32Array(cnt), y: new Float32Array(cnt), z: new Float32Array(cnt) };
    var k = 0;
    for (i = 0; i < n; i++) {
      if (keep && !keep[i]) continue;
      out.x[k] = cloud.px[i]; out.y[k] = cloud.py[i]; out.z[k] = cloud.pz[i]; k++;
    }
    out.n = k;
    return out;
  }

  /* 3次元チャンファー距離変換。重み 1 / √2 / √3 */
  function chamfer3(F, nx, ny, nz) {
    var W1 = 1, W2 = Math.SQRT2, W3 = Math.sqrt(3);
    var x, y, z, i, v;
    function at(x, y, z) { return (z * ny + y) * nx + x; }
    function rel(i, dx, dy, dz, w, x, y, z) {
      var X = x + dx, Y = y + dy, Z = z + dz;
      if (X < 0 || Y < 0 || Z < 0 || X >= nx || Y >= ny || Z >= nz) return;
      var c = F[at(X, Y, Z)] + w;
      if (c < F[i]) F[i] = c;
    }
    // 前進
    for (z = 0; z < nz; z++) for (y = 0; y < ny; y++) for (x = 0; x < nx; x++) {
      i = at(x, y, z); if (F[i] === 0) continue;
      rel(i,-1,0,0,W1,x,y,z); rel(i,0,-1,0,W1,x,y,z); rel(i,0,0,-1,W1,x,y,z);
      rel(i,-1,-1,0,W2,x,y,z); rel(i,1,-1,0,W2,x,y,z);
      rel(i,-1,0,-1,W2,x,y,z); rel(i,1,0,-1,W2,x,y,z);
      rel(i,0,-1,-1,W2,x,y,z); rel(i,0,1,-1,W2,x,y,z);
      rel(i,-1,-1,-1,W3,x,y,z); rel(i,1,-1,-1,W3,x,y,z);
      rel(i,-1,1,-1,W3,x,y,z); rel(i,1,1,-1,W3,x,y,z);
    }
    // 後退
    for (z = nz-1; z >= 0; z--) for (y = ny-1; y >= 0; y--) for (x = nx-1; x >= 0; x--) {
      i = at(x, y, z); if (F[i] === 0) continue;
      rel(i,1,0,0,W1,x,y,z); rel(i,0,1,0,W1,x,y,z); rel(i,0,0,1,W1,x,y,z);
      rel(i,1,1,0,W2,x,y,z); rel(i,-1,1,0,W2,x,y,z);
      rel(i,1,0,1,W2,x,y,z); rel(i,-1,0,1,W2,x,y,z);
      rel(i,0,1,1,W2,x,y,z); rel(i,0,-1,1,W2,x,y,z);
      rel(i,1,1,1,W3,x,y,z); rel(i,-1,1,1,W3,x,y,z);
      rel(i,1,-1,1,W3,x,y,z); rel(i,-1,-1,1,W3,x,y,z);
    }
  }

  /* Surface Nets
     セルの8隅の符号が揃っていなければ、交差点の平均を頂点にする。
     辺を共有する4セルの頂点をつないで四角形にする（表を出すだけなので表が作りやすい）*/
  var CORNER = [[0,0,0],[1,0,0],[0,1,0],[1,1,0],[0,0,1],[1,0,1],[0,1,1],[1,1,1]];
  var EDGES = [[0,1],[0,2],[0,4],[1,3],[1,5],[2,3],[2,6],[3,7],[4,5],[4,6],[5,7],[6,7]];

  function surfaceNets(F, nx, ny, nz, vs, ox, oy, oz, opt, pts) {
    var cx = nx - 1, cy = ny - 1, cz = nz - 1;
    var vidx = new Int32Array(cx * cy * cz).fill(-1);
    var B = new Builder();
    var v = new Float64Array(8);
    var x, y, z, e, c, i;

    var colorBy = opt.colorBy === undefined ? 'height' : opt.colorBy;
    var plane = opt.crop && opt.crop.plane;
    var yLo = 1e30, yHi = -1e30;
    for (i = 0; i < pts.n; i++) { if (pts.y[i] < yLo) yLo = pts.y[i]; if (pts.y[i] > yHi) yHi = pts.y[i]; }
    var span = Math.max(0.05, yHi - yLo);

    function sample(x, y, z) { return F[(z * ny + y) * nx + x]; }

    for (z = 0; z < cz; z++) {
      for (y = 0; y < cy; y++) {
        for (x = 0; x < cx; x++) {
          var mask = 0;
          for (c = 0; c < 8; c++) {
            v[c] = sample(x + CORNER[c][0], y + CORNER[c][1], z + CORNER[c][2]);
            if (v[c] < 0) mask |= (1 << c);
          }
          if (mask === 0 || mask === 255) continue;

          var sx = 0, sy = 0, sz = 0, nCross = 0;
          for (e = 0; e < 12; e++) {
            var a = EDGES[e][0], b = EDGES[e][1];
            var va = v[a], vb = v[b];
            if ((va < 0) === (vb < 0)) continue;
            var t = va / (va - vb);
            sx += CORNER[a][0] + t * (CORNER[b][0] - CORNER[a][0]);
            sy += CORNER[a][1] + t * (CORNER[b][1] - CORNER[a][1]);
            sz += CORNER[a][2] + t * (CORNER[b][2] - CORNER[a][2]);
            nCross++;
          }
          if (!nCross) continue;
          var wx = ox + (x + sx / nCross) * vs;
          var wy = oy + (y + sy / nCross) * vs;
          var wz = oz + (z + sz / nCross) * vs;
          var col = GRAY;
          if (colorBy === 'height') {
            var h = plane ? (wy - G.planeY(plane, wx, wz)) : (wy - yLo);
            col = ramp(Math.abs(h) / span);
          }
          vidx[(z * cy + y) * cx + x] = B.vert(wx, wy, wz, col);
        }
      }
    }

    // 辺に交差があれば、その辺を囲む4セルの頂点で四角形を作る
    function cell(x, y, z) { return vidx[(z * cy + y) * cx + x]; }
    for (z = 0; z < cz; z++) {
      for (y = 0; y < cy; y++) {
        for (x = 0; x < cx; x++) {
          if (cell(x, y, z) < 0) continue;
          var v0 = sample(x, y, z) < 0;
          // +x 方向の辺
          if (y > 0 && z > 0 && (sample(x+1, y, z) < 0) !== v0) {
            quad4(cell(x, y-1, z-1), cell(x, y, z-1), cell(x, y, z), cell(x, y-1, z), v0);
          }
          // +y 方向の辺
          if (x > 0 && z > 0 && (sample(x, y+1, z) < 0) !== v0) {
            quad4(cell(x-1, y, z-1), cell(x-1, y, z), cell(x, y, z), cell(x, y, z-1), v0);
          }
          // +z 方向の辺
          if (x > 0 && y > 0 && (sample(x, y, z+1) < 0) !== v0) {
            quad4(cell(x-1, y-1, z), cell(x, y-1, z), cell(x, y, z), cell(x-1, y, z), v0);
          }
        }
      }
    }
    function quad4(a, b, c, d, flip) {
      if (a < 0 || b < 0 || c < 0 || d < 0) return;
      if (flip) B.quad(a, b, c, d); else B.quad(a, d, c, b);
    }

    return B.finish({});
  }

  global.Mesh = {
    solidFromResult: solidFromResult,
    surfaceFromCloud: surfaceFromCloud,
    volume: volume,
    computeNormals: computeNormals,
    bounds: bounds
  };
})(window);
