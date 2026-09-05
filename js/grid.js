/* ============================================================
   grid.js  スキャン中に点を貯めておく入れ物

   HGrid : 高さ格子（2.5次元）。世界の水平面 XZ を正方形に区切り、
           セルごとに高さ Y の 平均・回数・最小・最大 を持つ。
           体積計算（点高法／メッシュ法）はこれだけあれば足りる。
   VCloud: 3次元のボクセル点群。表示と PLY 書き出し用。
           同じ場所の点は 1 個にまとめるので、いくら撮っても増え続けない。

   どちらも「開番地法（オープンアドレス）のハッシュ表＋型付き配列」で持つ。
   毎秒 10万点を投げ込んでも GC が走らないようにするための作り。
   ============================================================ */
(function (global) {
  'use strict';

  function nextPow2(n) { var p = 1; while (p < n) p *= 2; return p; }

  /* ============================================================
     HGrid  高さ格子
     ============================================================ */
  function HGrid(cellSize) {
    this.cs   = cellSize || 0.05;
    this.n    = 0;                       // 使用中のセル数
    this.capa = 4096;                    // 配列の確保数
    this.ix   = new Int32Array(this.capa);
    this.iz   = new Int32Array(this.capa);
    this.mean = new Float32Array(this.capa);
    this.cnt  = new Uint32Array(this.capa);
    this.mn   = new Float32Array(this.capa);
    this.mx   = new Float32Array(this.capa);
    this._rehash(nextPow2(this.capa * 2));
  }

  HGrid.prototype._rehash = function (size) {
    this.tsize = size;
    this.mask  = size - 1;
    this.table = new Int32Array(size).fill(-1);
    for (var s = 0; s < this.n; s++) {
      var h = (Math.imul(this.ix[s], 73856093) ^ Math.imul(this.iz[s], 19349663)) & this.mask;
      while (this.table[h] >= 0) h = (h + 1) & this.mask;
      this.table[h] = s;
    }
  };

  HGrid.prototype._grow = function () {
    var c = this.capa * 2;
    function up(A, T) { var b = new T(c); b.set(A); return b; }
    this.ix   = up(this.ix,   Int32Array);
    this.iz   = up(this.iz,   Int32Array);
    this.mean = up(this.mean, Float32Array);
    this.cnt  = up(this.cnt,  Uint32Array);
    this.mn   = up(this.mn,   Float32Array);
    this.mx   = up(this.mx,   Float32Array);
    this.capa = c;
  };

  /* セルの番地を返す。無ければ作る */
  HGrid.prototype.slot = function (ix, iz, create) {
    var h = (Math.imul(ix, 73856093) ^ Math.imul(iz, 19349663)) & this.mask;
    var t = this.table;
    while (t[h] >= 0) {
      var s = t[h];
      if (this.ix[s] === ix && this.iz[s] === iz) return s;
      h = (h + 1) & this.mask;
    }
    if (!create) return -1;
    if (this.n >= this.capa) this._grow();
    var ns = this.n++;
    this.ix[ns] = ix; this.iz[ns] = iz;
    this.mean[ns] = 0; this.cnt[ns] = 0;
    this.mn[ns] =  1e9; this.mx[ns] = -1e9;
    t[h] = ns;
    if (this.n * 10 > this.tsize * 6) this._rehash(this.tsize * 2);
    return ns;
  };

  /* 点を 1 個入れる。平均は逐次更新（合計を持たないので桁落ちしにくい） */
  HGrid.prototype.add = function (x, y, z) {
    var s = this.slot(Math.floor(x / this.cs), Math.floor(z / this.cs), true);
    var c = this.cnt[s] + 1;
    this.cnt[s]  = c;
    this.mean[s] += (y - this.mean[s]) / c;
    if (y < this.mn[s]) this.mn[s] = y;
    if (y > this.mx[s]) this.mx[s] = y;
    return s;
  };

  HGrid.prototype.cellX = function (s) { return (this.ix[s] + 0.5) * this.cs; };
  HGrid.prototype.cellZ = function (s) { return (this.iz[s] + 0.5) * this.cs; };
  HGrid.prototype.area  = function ()  { return this.cs * this.cs; };

  HGrid.prototype.bounds = function () {
    if (!this.n) return null;
    var b = { ix0: 1e9, ix1: -1e9, iz0: 1e9, iz1: -1e9, y0: 1e9, y1: -1e9 };
    for (var s = 0; s < this.n; s++) {
      if (this.ix[s] < b.ix0) b.ix0 = this.ix[s];
      if (this.ix[s] > b.ix1) b.ix1 = this.ix[s];
      if (this.iz[s] < b.iz0) b.iz0 = this.iz[s];
      if (this.iz[s] > b.iz1) b.iz1 = this.iz[s];
      if (this.mean[s] < b.y0) b.y0 = this.mean[s];
      if (this.mean[s] > b.y1) b.y1 = this.mean[s];
    }
    b.w = (b.ix1 - b.ix0 + 1) * this.cs;
    b.d = (b.iz1 - b.iz0 + 1) * this.cs;
    return b;
  };

  /* 平面当てはめ用の点配列。minCnt 回未満しか観測できていないセルは捨てる。
     max を超えるときは間引く（RANSAC を軽くするため） */
  HGrid.prototype.toPoints = function (minCnt, max) {
    minCnt = minCnt || 2; max = max || 20000;
    var step = 1, i, out = [];
    var usable = 0;
    for (i = 0; i < this.n; i++) if (this.cnt[i] >= minCnt) usable++;
    if (usable > max) step = Math.ceil(usable / max);
    var k = 0;
    for (i = 0; i < this.n; i++) {
      if (this.cnt[i] < minCnt) continue;
      if ((k++ % step) !== 0) continue;
      out.push({ x: this.cellX(i), z: this.cellZ(i), y: this.mean[i], w: 1, s: i });
    }
    return out;
  };

  /* IndexedDB 保存用に、使っている範囲だけ切り出す */
  HGrid.prototype.pack = function () {
    return {
      cs: this.cs, n: this.n,
      ix:   this.ix.slice(0, this.n),
      iz:   this.iz.slice(0, this.n),
      mean: this.mean.slice(0, this.n),
      cnt:  this.cnt.slice(0, this.n),
      mn:   this.mn.slice(0, this.n),
      mx:   this.mx.slice(0, this.n)
    };
  };

  HGrid.unpack = function (o) {
    var g = new HGrid(o.cs);
    g.capa = Math.max(4096, nextPow2(o.n + 1));
    g.ix   = new Int32Array(g.capa);   g.ix.set(o.ix);
    g.iz   = new Int32Array(g.capa);   g.iz.set(o.iz);
    g.mean = new Float32Array(g.capa); g.mean.set(o.mean);
    g.cnt  = new Uint32Array(g.capa);  g.cnt.set(o.cnt);
    g.mn   = new Float32Array(g.capa); g.mn.set(o.mn);
    g.mx   = new Float32Array(g.capa); g.mx.set(o.mx);
    g.n    = o.n;
    g._rehash(nextPow2(g.capa * 2));
    return g;
  };

  /* ============================================================
     VCloud  3次元ボクセル点群（表示・書き出し用）
     ============================================================ */
  function VCloud(voxel, cap) {
    this.vs   = voxel || 0.03;
    this.cap  = cap   || 300000;
    this.n    = 0;
    this.capa = 8192;
    this.gx = new Int32Array(this.capa);
    this.gy = new Int32Array(this.capa);
    this.gz = new Int32Array(this.capa);
    this.px = new Float32Array(this.capa);
    this.py = new Float32Array(this.capa);
    this.pz = new Float32Array(this.capa);
    this.cnt = new Uint16Array(this.capa);
    this.dirty = true;                   // 描画用バッファの作り直しが要るか
    this._rehash(nextPow2(this.capa * 2));
  }

  VCloud.prototype._rehash = function (size) {
    this.tsize = size; this.mask = size - 1;
    this.table = new Int32Array(size).fill(-1);
    for (var s = 0; s < this.n; s++) {
      var h = (Math.imul(this.gx[s], 73856093) ^ Math.imul(this.gy[s], 19349663) ^
               Math.imul(this.gz[s], 83492791)) & this.mask;
      while (this.table[h] >= 0) h = (h + 1) & this.mask;
      this.table[h] = s;
    }
  };

  VCloud.prototype._grow = function () {
    var c = Math.min(this.capa * 2, nextPow2(this.cap));
    if (c <= this.capa) return false;
    function up(A, T) { var b = new T(c); b.set(A); return b; }
    this.gx = up(this.gx, Int32Array); this.gy = up(this.gy, Int32Array); this.gz = up(this.gz, Int32Array);
    this.px = up(this.px, Float32Array); this.py = up(this.py, Float32Array); this.pz = up(this.pz, Float32Array);
    this.cnt = up(this.cnt, Uint16Array);
    this.capa = c;
    return true;
  };

  VCloud.prototype.add = function (x, y, z) {
    var ix = Math.floor(x / this.vs), iy = Math.floor(y / this.vs), iz = Math.floor(z / this.vs);
    var h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663) ^ Math.imul(iz, 83492791)) & this.mask;
    var t = this.table, s;
    while (t[h] >= 0) {
      s = t[h];
      if (this.gx[s] === ix && this.gy[s] === iy && this.gz[s] === iz) {
        var c = this.cnt[s] < 65535 ? this.cnt[s] + 1 : 65535;
        this.cnt[s] = c;
        this.px[s] += (x - this.px[s]) / c;
        this.py[s] += (y - this.py[s]) / c;
        this.pz[s] += (z - this.pz[s]) / c;
        this.dirty = true;
        return s;
      }
      h = (h + 1) & this.mask;
    }
    if (this.n >= this.cap) return -1;                 // 上限。以後は新しい場所を足さない
    if (this.n >= this.capa && !this._grow()) return -1;
    s = this.n++;
    this.gx[s] = ix; this.gy[s] = iy; this.gz[s] = iz;
    this.px[s] = x;  this.py[s] = y;  this.pz[s] = z;
    this.cnt[s] = 1;
    t[h] = s;
    if (this.n * 10 > this.tsize * 6) this._rehash(this.tsize * 2);
    this.dirty = true;
    return s;
  };

  /* WebGL / PLY 用に xyz を連続した Float32Array で返す */
  VCloud.prototype.xyz = function () {
    var a = new Float32Array(this.n * 3);
    for (var s = 0, k = 0; s < this.n; s++) { a[k++] = this.px[s]; a[k++] = this.py[s]; a[k++] = this.pz[s]; }
    return a;
  };

  VCloud.prototype.pack = function (maxPts) {
    maxPts = maxPts || 150000;
    var step = this.n > maxPts ? Math.ceil(this.n / maxPts) : 1;
    var m = Math.ceil(this.n / step);
    var a = new Float32Array(m * 3);
    for (var s = 0, k = 0; s < this.n; s += step) { a[k++] = this.px[s]; a[k++] = this.py[s]; a[k++] = this.pz[s]; }
    return { vs: this.vs, n: m, xyz: a };
  };

  VCloud.unpack = function (o) {
    var c = new VCloud(o.vs, Math.max(o.n + 1024, 8192));
    for (var i = 0; i < o.n; i++) c.add(o.xyz[i*3], o.xyz[i*3+1], o.xyz[i*3+2]);
    return c;
  };

  global.HGrid = HGrid;
  global.VCloud = VCloud;
})(window);
