/* ============================================================
   geom.js  行列と基準面の計算
   - mat4  : WebXR と同じ「列優先」の 4x4 行列
   - 逆投影: 深度値(カメラ平面からの距離)を世界座標の点に戻す
   - 基準面: y = a*x + b*z + c を最小二乗 / RANSAC で当てはめる
   世界座標は WebXR の参照空間。ARCore が重力に合わせるので Y が鉛直上向き。
   ============================================================ */
(function (global) {
  'use strict';

  /* ---------- 4x4 行列（列優先） ---------- */

  function ident() {
    return new Float64Array([1,0,0,0, 0,1,0,0, 0,0,1,0, 0,0,0,1]);
  }

  /* out = a * b */
  function mul(out, a, b) {
    for (var c = 0; c < 4; c++) {
      var b0 = b[c*4], b1 = b[c*4+1], b2 = b[c*4+2], b3 = b[c*4+3];
      out[c*4]   = a[0]*b0 + a[4]*b1 + a[8] *b2 + a[12]*b3;
      out[c*4+1] = a[1]*b0 + a[5]*b1 + a[9] *b2 + a[13]*b3;
      out[c*4+2] = a[2]*b0 + a[6]*b1 + a[10]*b2 + a[14]*b3;
      out[c*4+3] = a[3]*b0 + a[7]*b1 + a[11]*b2 + a[15]*b3;
    }
    return out;
  }

  /* 一般の 4x4 逆行列（余因子法）。特異なら null */
  function invert(out, m) {
    var a00=m[0],a01=m[1],a02=m[2],a03=m[3],
        a10=m[4],a11=m[5],a12=m[6],a13=m[7],
        a20=m[8],a21=m[9],a22=m[10],a23=m[11],
        a30=m[12],a31=m[13],a32=m[14],a33=m[15];
    var b00=a00*a11-a01*a10, b01=a00*a12-a02*a10, b02=a00*a13-a03*a10,
        b03=a01*a12-a02*a11, b04=a01*a13-a03*a11, b05=a02*a13-a03*a12,
        b06=a20*a31-a21*a30, b07=a20*a32-a22*a30, b08=a20*a33-a23*a30,
        b09=a21*a32-a22*a31, b10=a21*a33-a23*a31, b11=a22*a33-a23*a32;
    var det = b00*b11 - b01*b10 + b02*b09 + b03*b08 - b04*b07 + b05*b06;
    if (!det) return null;
    det = 1.0 / det;
    out[0]  = (a11*b11 - a12*b10 + a13*b09)*det;
    out[1]  = (a02*b10 - a01*b11 - a03*b09)*det;
    out[2]  = (a31*b05 - a32*b04 + a33*b03)*det;
    out[3]  = (a22*b04 - a21*b05 - a23*b03)*det;
    out[4]  = (a12*b08 - a10*b11 - a13*b07)*det;
    out[5]  = (a00*b11 - a02*b08 + a03*b07)*det;
    out[6]  = (a32*b02 - a30*b05 - a33*b01)*det;
    out[7]  = (a20*b05 - a22*b02 + a23*b01)*det;
    out[8]  = (a10*b10 - a11*b08 + a13*b06)*det;
    out[9]  = (a01*b08 - a00*b10 - a03*b06)*det;
    out[10] = (a30*b04 - a31*b02 + a33*b00)*det;
    out[11] = (a21*b02 - a20*b04 - a23*b00)*det;
    out[12] = (a11*b07 - a10*b09 - a12*b06)*det;
    out[13] = (a00*b09 - a01*b07 + a02*b06)*det;
    out[14] = (a31*b01 - a30*b03 - a32*b00)*det;
    out[15] = (a20*b03 - a21*b01 + a22*b00)*det;
    return out;
  }

  /* out(長さ3) = m * (x,y,z,1) を w で割ったもの */
  function xform(out, m, x, y, z) {
    var w = m[3]*x + m[7]*y + m[11]*z + m[15];
    if (!w) w = 1;
    out[0] = (m[0]*x + m[4]*y + m[8] *z + m[12]) / w;
    out[1] = (m[1]*x + m[5]*y + m[9] *z + m[13]) / w;
    out[2] = (m[2]*x + m[6]*y + m[10]*z + m[14]) / w;
    return out;
  }

  /* ---------- 深度 → 視点座標 の逆投影パラメータ ----------
     WebXR の投影行列は、非対称な視錐台であっても次の形になる（列優先）。
        m0        0        m8       0
        0         m5       m9       0
        0         0        m10      m14
        0         0        -1       0
     深度 d は「カメラ平面からの距離」＝視点座標の -z なので
        clip.w = -z = d
        ndcX = (m0*x + m8*(-d)) / d  →  x = d*(ndcX + m8)/m0
        ndcY = (m5*y + m9*(-d)) / d  →  y = d*(ndcY + m9)/m5
        z    = -d
     となり、1 点あたり数回の掛け算だけで戻せる。
     想定外の形（斜め成分あり）なら ok=false を返し、逆行列を使う経路に落とす。
  ------------------------------------------------------------ */
  function unprojParams(p) {
    function zero(v) { return Math.abs(v) < 1e-9; }
    var ok = !zero(p[0]) && !zero(p[5]) &&
             zero(p[1]) && zero(p[2]) && zero(p[3]) &&
             zero(p[4]) && zero(p[6]) && zero(p[7]) &&
             zero(p[12]) && zero(p[13]) && Math.abs(p[11] + 1) < 1e-6;
    return { ok: ok, fx: p[0], fy: p[5], cx: p[8], cy: p[9] };
  }

  /* ビューの正規化座標 (u,v)（原点は左上）と深度 d[m] から世界座標へ戻す。
     up = unprojParams(projectionMatrix)、M = view.transform.matrix（視点→世界）。
     M は剛体変換なので w の除算は不要。 */
  function unproject(out, up, M, u, v, d) {
    var ndcX = 2 * u - 1, ndcY = 1 - 2 * v;
    var px = d * (ndcX + up.cx) / up.fx;
    var py = d * (ndcY + up.cy) / up.fy;
    var pz = -d;
    out[0] = M[0]*px + M[4]*py + M[8] *pz + M[12];
    out[1] = M[1]*px + M[5]*py + M[9] *pz + M[13];
    out[2] = M[2]*px + M[6]*py + M[10]*pz + M[14];
    return out;
  }

  /* ---------- 平面 y = a*x + b*z + c ---------- */

  function planeY(pl, x, z) { return pl.a * x + pl.b * z + pl.c; }

  /* 平面の傾き（度） */
  function tiltDeg(pl) {
    return Math.atan(Math.sqrt(pl.a * pl.a + pl.b * pl.b)) * 180 / Math.PI;
  }

  /* 重み付き最小二乗。pts = [{x,z,y,w}]（w 省略可）
     x,z を平均で中心化してから解き、条件数の悪化を避ける */
  function fitPlane(pts) {
    var n = pts.length;
    if (n < 3) return null;
    var S = 0, Sx = 0, Sz = 0, i, p, w;
    for (i = 0; i < n; i++) { p = pts[i]; w = p.w === undefined ? 1 : p.w; S += w; Sx += w*p.x; Sz += w*p.z; }
    if (S <= 0) return null;
    var mx = Sx / S, mz = Sz / S;

    var Axx = 0, Axz = 0, Azz = 0, Axy = 0, Azy = 0, Sy = 0, dx, dz;
    for (i = 0; i < n; i++) {
      p = pts[i]; w = p.w === undefined ? 1 : p.w;
      dx = p.x - mx; dz = p.z - mz;
      Axx += w*dx*dx; Axz += w*dx*dz; Azz += w*dz*dz;
      Axy += w*dx*p.y; Azy += w*dz*p.y; Sy += w*p.y;
    }
    var my = Sy / S;
    var det = Axx*Azz - Axz*Axz;
    var a, b;
    if (Math.abs(det) < 1e-9 * (Axx + Azz + 1e-9)) {
      a = 0; b = 0;                 // 点がほぼ一直線。水平面として扱う
    } else {
      a = ( Azz*Axy - Axz*Azy) / det;
      b = (-Axz*Axy + Axx*Azy) / det;
    }
    return { a: a, b: b, c: my - a*mx - b*mz, n: n };
  }

  /* 3 点から平面。ほぼ一直線なら null */
  function planeFrom3(p0, p1, p2) {
    var x1 = p1.x - p0.x, z1 = p1.z - p0.z, y1 = p1.y - p0.y;
    var x2 = p2.x - p0.x, z2 = p2.z - p0.z, y2 = p2.y - p0.y;
    var det = x1*z2 - x2*z1;
    if (Math.abs(det) < 1e-6) return null;
    var a = (y1*z2 - y2*z1) / det;
    var b = (x1*y2 - x2*y1) / det;
    return { a: a, b: b, c: p0.y - a*p0.x - b*p0.z, n: 3 };
  }

  function d2(p, q) { var dx = p.x-q.x, dz = p.z-q.z; return dx*dx + dz*dz; }

  /* RANSAC で「いちばん広い平面」を探す。
     opt = { thr:内外判定(m), iter:試行回数, maxTilt:許容傾斜(度), minSpan:3点の最小間隔(m) }
     地面は普通いちばん面積が広いので、土砂の山や穴の底に引っ張られにくい。
     同点に近い候補が出たときは低いほうを採る（山の天端を地面と誤認しないため）。 */
  function ransacPlane(pts, opt) {
    opt = opt || {};
    var thr     = opt.thr     || 0.05;
    var iter    = opt.iter    || 400;
    var maxTilt = opt.maxTilt === undefined ? 25 : opt.maxTilt;
    var minSpan = opt.minSpan || 0.3;
    var n = pts.length, i;
    if (n < 8) return fitPlane(pts);

    var gx = 0, gz = 0;                       // 全点の重心。候補どうしの高さ比較に使う
    for (i = 0; i < n; i++) { gx += pts[i].x; gz += pts[i].z; }
    gx /= n; gz /= n;

    var best = null, bestCnt = 0, bestH = Infinity;
    var span2 = minSpan * minSpan;

    for (var it = 0; it < iter; it++) {
      var p0 = pts[(Math.random()*n)|0], p1 = pts[(Math.random()*n)|0], p2 = pts[(Math.random()*n)|0];
      if (d2(p0,p1) < span2 || d2(p1,p2) < span2 || d2(p0,p2) < span2) continue;
      var pl = planeFrom3(p0, p1, p2);
      if (!pl || tiltDeg(pl) > maxTilt) continue;

      var cnt = 0;
      for (i = 0; i < n; i++) {
        if (Math.abs(pts[i].y - (pl.a*pts[i].x + pl.b*pts[i].z + pl.c)) < thr) cnt++;
      }
      var h = planeY(pl, gx, gz);
      if (cnt > bestCnt || (cnt > bestCnt * 0.95 && h < bestH - 0.10)) {
        best = pl;
        if (cnt > bestCnt) bestCnt = cnt;
        bestH = h;
      }
    }
    if (!best) return fitPlane(pts);

    for (var k = 0; k < 2; k++) {             // 内点だけで 2 回精密化
      var inl = [];
      for (i = 0; i < n; i++) {
        if (Math.abs(pts[i].y - planeY(best, pts[i].x, pts[i].z)) < thr) inl.push(pts[i]);
      }
      if (inl.length < 3) break;
      var ref = fitPlane(inl);
      if (ref && tiltDeg(ref) <= maxTilt + 5) best = ref; else break;
    }
    best.inliers = 0;
    for (i = 0; i < n; i++) if (Math.abs(pts[i].y - planeY(best, pts[i].x, pts[i].z)) < thr) best.inliers++;
    return best;
  }

  /* ---------- 多角形 ---------- */

  /* 点が多角形の内側か（交差数判定）。poly = [{x,z},...] */
  function inPoly(poly, x, z) {
    var inside = false, n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) {
      var xi = poly[i].x, zi = poly[i].z, xj = poly[j].x, zj = poly[j].z;
      if (((zi > z) !== (zj > z)) && (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) inside = !inside;
    }
    return inside;
  }

  function polyArea(poly) {
    var s = 0, n = poly.length;
    for (var i = 0, j = n - 1; i < n; j = i++) s += (poly[j].x + poly[i].x) * (poly[j].z - poly[i].z);
    return Math.abs(s) / 2;
  }

  global.Geom = {
    ident: ident, mul: mul, invert: invert, xform: xform,
    unprojParams: unprojParams, unproject: unproject,
    planeY: planeY, tiltDeg: tiltDeg, fitPlane: fitPlane, planeFrom3: planeFrom3,
    ransacPlane: ransacPlane, inPoly: inPoly, polyArea: polyArea
  };
})(window);
