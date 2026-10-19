/* ============================================================
   store.js  設定(localStorage)と測定結果(IndexedDB)の保存
   点群と格子は型付き配列のまま IndexedDB に入る（構造化複製が効く）ので、
   文字列に直さずそのまま保存・復元できる。
   ============================================================ */
(function (global) {
  'use strict';

  var KEY_CFG = 'doryoScan.config.v1';
  var DB_NAME = 'doryoScan', DB_VER = 1, ST = 'scans';

  var DEFAULTS = {
    // --- スキャン ---
    cellSize:  0.05,     // 格子の大きさ(m)  体積計算の刻み
    voxel:     0.03,     // 表示用点群の間引き(m)
    dMin:      0.30,     // 使う深度の下限(m)
    dMax:      5.00,     // 使う深度の上限(m)  ARCore は 5m を超えると急に荒くなる
    samples:   6000,     // 1回の取り込みで読む画素数
    rateHz:    10,       // 1秒あたりの取り込み回数
    depthType: 'smooth', // smooth=平滑化済み(穴が少ない) / raw=生(縁がシャープ)
    maxSpeed:  1.5,      // これより速く動かしたフレームは捨てる(m/s)
    cloudCap:  300000,   // 表示用点群の上限

    // --- 計算 ---
    thr:       0.05,     // 対象とみなす比高のしきい値(m)
    minCnt:    2,        // 有効セルの最小観測回数
    maxTilt:   25,       // 基準面として許す傾き(度)
    largestOnly: true,   // いちばん大きい塊だけ集計する
    fillHoles: true,     // 内側の未計測セルを補間する
    smooth:    true,     // 3x3メディアンで高さのノイズをならす
    closing:   true,     // 領域の1セルの切れ目・穴を閉じる
    side:      'auto',   // auto / fill(盛土) / cut(掘削)

    // --- 土量換算 ---
    measuredAs: 'loose', // bank=地山 / loose=ほぐし / comp=締固め
    L: 1.20,             // ほぐし率
    C: 0.90,             // 締固め率
    dumpCap: 4.0,        // ダンプ1台の積載量(m3, ほぐし土量)

    // --- 3Dモデル ---
    meshMode:  'solid',  // solid=閉じた立体 / surface=物体の表面
    meshVoxel: 0.03,     // 表面を起こすときの格子間隔(m)
    meshCrop:  true,     // 対象だけ切り出す（地面を含めない）

    keepAwake: true
  };

  function load() {
    try {
      var s = localStorage.getItem(KEY_CFG);
      return Object.assign({}, DEFAULTS, s ? JSON.parse(s) : {});
    } catch (e) { return Object.assign({}, DEFAULTS); }
  }
  var cfg = load();

  function saveCfg() {
    try { localStorage.setItem(KEY_CFG, JSON.stringify(cfg)); } catch (e) { console.warn(e); }
  }

  /* ---------- IndexedDB ---------- */
  var dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res, rej) {
      var q = indexedDB.open(DB_NAME, DB_VER);
      q.onupgradeneeded = function () {
        var d = q.result;
        if (!d.objectStoreNames.contains(ST)) {
          var s = d.createObjectStore(ST, { keyPath: 'id' });
          s.createIndex('date', 'date');
        }
      };
      q.onsuccess = function () { res(q.result); };
      q.onerror = function () { rej(q.error); };
    });
    return dbp;
  }

  function tx(mode, fn) {
    return db().then(function (d) {
      return new Promise(function (res, rej) {
        var t = d.transaction(ST, mode);
        var out;
        var r = fn(t.objectStore(ST));
        if (r) r.onsuccess = function () { out = r.result; };
        t.oncomplete = function () { res(out); };
        t.onerror = function () { rej(t.error); };
        t.onabort = function () { rej(t.error); };
      });
    });
  }

  function nextId() { return 'v' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6); }

  var Store = {
    cfg: cfg,
    DEFAULTS: DEFAULTS,
    get: function (k) { return cfg[k]; },
    set: function (k, v) { cfg[k] = v; saveCfg(); },
    setAll: function (o) { Object.assign(cfg, o); saveCfg(); },
    reset: function () { cfg = Object.assign({}, DEFAULTS); Store.cfg = cfg; saveCfg(); },

    /* rec = {name, memo, grid(HGrid), cloud(VCloud), plane, poly, opts, summary, section} */
    save: function (rec) {
      var o = {
        id:      rec.id || nextId(),
        name:    rec.name || '無題',
        memo:    rec.memo || '',
        date:    rec.date || new Date().toISOString(),
        cellSize: rec.grid ? rec.grid.cs : cfg.cellSize,
        grid:    rec.grid  ? rec.grid.pack()  : null,
        cloud:   rec.cloud ? rec.cloud.pack(150000) : null,
        plane:   rec.plane || null,
        poly:    rec.poly || null,
        section: rec.section || null,
        opts:    rec.opts || null,
        summary: rec.summary || null,
        startDir: rec.startDir || null,
        depthInfo: rec.depthInfo || null,
        scanStats: rec.scanStats || null
      };
      return tx('readwrite', function (s) { s.put(o); }).then(function () { return o.id; });
    },

    list: function () {
      return tx('readonly', function (s) { return s.getAll(); }).then(function (a) {
        a = a || [];
        // 一覧では重い配列を持ち歩かない
        a.forEach(function (o) { delete o.grid; delete o.cloud; });
        a.sort(function (p, q) { return p.date < q.date ? 1 : -1; });
        return a;
      });
    },

    load: function (id) {
      return tx('readonly', function (s) { return s.get(id); });
    },

    remove: function (id) { return tx('readwrite', function (s) { s.delete(id); }); },

    rename: function (id, name, memo) {
      return Store.load(id).then(function (o) {
        if (!o) return;
        o.name = name; if (memo !== undefined) o.memo = memo;
        return tx('readwrite', function (s) { s.put(o); });
      });
    },

    clear: function () { return tx('readwrite', function (s) { s.clear(); }); },

    /* 端末の使用容量の目安 */
    usage: function () {
      if (navigator.storage && navigator.storage.estimate) return navigator.storage.estimate();
      return Promise.resolve(null);
    }
  };

  global.Store = Store;
})(window);
