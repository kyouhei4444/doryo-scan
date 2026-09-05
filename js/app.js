/* ============================================================
   app.js  画面の制御
   ============================================================ */
(function () {
  'use strict';

  var cfg = Store.cfg;
  var scanner = new Scanner();
  var mapView = null;
  var cur = null;      // いま表示している計測 {grid,cloud,res,poly,section,planeMode,manualPlane,id,name,memo,startDir}
  var support = null;

  function el(id) { return document.getElementById(id); }
  function show(e, v) { e.classList.toggle('hidden', !v); }

  var toastT = 0;
  function toast(msg, ms) {
    var t = el('toast');
    t.textContent = msg; show(t, true);
    clearTimeout(toastT);
    toastT = setTimeout(function () { show(t, false); }, ms || 3000);
  }
  function arToast(msg, ms) {
    var t = el('ar-toast');
    t.textContent = msg; show(t, true);
    clearTimeout(t._t);
    t._t = setTimeout(function () { show(t, false); }, ms || 3500);
  }

  /* 桁数を値の大きさに合わせる */
  function fmt(v, unit) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    var a = Math.abs(v), s;
    if (a < 1) s = v.toFixed(3);
    else if (a < 100) s = v.toFixed(2);
    else if (a < 1000) s = v.toFixed(1);
    else s = Math.round(v).toLocaleString('ja-JP');
    return unit ? s + ' ' + unit : s;
  }

  /* ============================================================
     タブ・使い方
     ============================================================ */
  function bindTabs() {
    var btns = el('tabs').querySelectorAll('button');
    Array.prototype.forEach.call(btns, function (b) {
      b.addEventListener('click', function () {
        Array.prototype.forEach.call(btns, function (o) { o.classList.toggle('on', o === b); });
        ['scan', 'result', 'list', 'cfg'].forEach(function (v) {
          el('view-' + v).classList.toggle('active', v === b.dataset.v);
        });
        if (b.dataset.v === 'list') renderList();
        if (b.dataset.v === 'result' && mapView) setTimeout(function () { mapView.draw(); }, 30);
        if (b.dataset.v === 'cfg') renderUsage();
      });
    });
    el('btn-help').addEventListener('click', function () { show(el('help'), true); });
    el('help-x').addEventListener('click', function () { show(el('help'), false); });
    el('help').addEventListener('click', function (e) { if (e.target === el('help')) show(el('help'), false); });
  }
  function goTab(v) {
    var b = el('tabs').querySelector('button[data-v="' + v + '"]');
    if (b) b.click();
  }

  /* ============================================================
     対応状況の判定
     ============================================================ */
  function checkSupport() {
    Scanner.support().then(function (r) {
      support = r;
      var ul = el('caps');
      function li(cls, text) { return '<li class="' + cls + '">' + text + '</li>'; }
      ul.innerHTML =
        li(r.secure ? 'ok' : 'ng', 'HTTPS で開いている' + (r.secure ? '' : '（http では動きません）')) +
        li(r.webxr  ? 'ok' : 'ng', 'WebXR に対応したブラウザ' + (r.webxr ? '' : '（Android の Chrome で開いてください）')) +
        li(r.webgl  ? 'ok' : 'ng', 'WebGL が使える') +
        li(r.ar ? 'ok' : (r.timedOut ? 'wait' : 'ng'),
           r.timedOut ? 'AR の対応確認が終わりませんでした（開始して試せます）'
                      : 'AR セッションを開始できる' + (r.ar ? '' : '（ARCore 未対応か未インストール）'));
      var ok = r.secure && r.webxr && r.webgl && r.ar;
      // 確認が終わらなかったときは、判定を待たずに試せるようにしておく
      el('btn-start').disabled = !(ok || (r.timedOut && r.secure && r.webxr && r.webgl));
      if (!ok) {
        el('cap-note').innerHTML = r.reason ||
          'この端末では使えません。ARCore 対応機種かどうかは<br>' +
          '<a href="https://developers.google.com/ar/devices" target="_blank" rel="noopener">Google の対応端末一覧</a>で確認できます。';
        show(el('cap-note'), true);
      } else {
        el('cap-note').innerHTML = '深度センシングに実際に対応しているかは、開始してみないと分かりません。'
          + '開始できなかった場合はここに理由が出ます。';
        show(el('cap-note'), true);
      }
    });
  }

  /* ============================================================
     計測タブ
     ============================================================ */
  var PRESETS = {
    fine: { cellSize: 0.02, voxel: 0.015, dMax: 2.5, samples: 8000, thr: 0.02 },
    std:  { cellSize: 0.05, voxel: 0.03,  dMax: 5.0, samples: 6000, thr: 0.05 },
    wide: { cellSize: 0.10, voxel: 0.06,  dMax: 8.0, samples: 6000, thr: 0.10 }
  };

  function bindSeg(id, onPick) {
    var box = el(id);
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (!b) return;
      Array.prototype.forEach.call(box.querySelectorAll('button'), function (o) { o.classList.toggle('on', o === b); });
      onPick(b.dataset.v);
    });
  }

  function bindScan() {
    bindSeg('seg-side', function (v) { Store.set('side', v); });
    bindSeg('seg-preset', function (v) {
      Store.setAll(PRESETS[v]);
      renderCfg();
      toast('設定を「' + ({ fine: '細かく', std: '標準', wide: '広く' })[v] + '」にしました');
    });
    el('btn-start').addEventListener('click', startScan);

    // AR オーバーレイのボタンを押したときに XR の select が発火しないようにする
    el('ar-overlay').addEventListener('beforexrselect', function (e) { e.preventDefault(); });

    bindSeg('ar-tools', function (v) {
      scanner.tool = v;
      arToast({
        none:    'ふつうに撮ります。ゆっくり動かしてください。',
        ground:  '中央の丸を「平らな地面」に合わせて画面をタップ。3 点以上で基準面を作れます。',
        measure: '2 点タップすると実距離が出ます。コンベックスの実測と比べてみてください。',
        bound:   '山の法尻をタップで囲むと、その中だけを集計します。'
      }[v]);
    });
    el('ar-undo').addEventListener('click', function () { scanner.undo(); arToast('1 つ戻しました'); });
    el('ar-pause').addEventListener('click', function () {
      scanner.pause(!scanner.paused);
      var b = el('ar-pause');
      b.textContent = scanner.paused ? '再開する' : '一時停止';
      b.classList.toggle('paused', scanner.paused);
    });
    el('ar-done').addEventListener('click', function () { scanner.end(); });
  }

  function startScan() {
    show(el('start-err'), false);
    var ov = el('ar-overlay');
    show(ov, true);
    el('ar-pause').textContent = '一時停止';
    el('ar-pause').classList.remove('paused');
    Array.prototype.forEach.call(el('ar-tools').querySelectorAll('button'), function (o, i) { o.classList.toggle('on', i === 0); });
    scanner.tool = 'none';

    scanner.on.tick = function (s) {
      el('ar-cells').textContent = s.cells.toLocaleString('ja-JP');
      el('ar-pts').textContent = s.cloud.toLocaleString('ja-JP');
      el('ar-valid').textContent = s.tried ? Math.round(s.valid / s.tried * 100) + '%' : '—';
      el('ar-time').textContent = Math.round(s.elapsed);
      show(el('ar-speed'), s.speed > cfg.maxSpeed);
    };
    scanner.on.note = function (m) { arToast(m, 4000); };
    scanner.on.error = function (m) {
      show(ov, false);
      el('start-err').textContent = m;
      show(el('start-err'), true);
    };
    scanner.on.end = function () {
      show(ov, false);
      finishScan();
    };

    scanner.start({
      cellSize: cfg.cellSize, voxel: cfg.voxel, cloudCap: cfg.cloudCap,
      dMin: cfg.dMin, dMax: cfg.dMax, samples: cfg.samples, rateHz: cfg.rateHz,
      depthType: cfg.depthType, maxSpeed: cfg.maxSpeed, overlay: ov
    }).catch(function () { show(ov, false); });
  }

  function finishScan() {
    if (!scanner.grid || scanner.grid.n < 20) {
      el('start-err').textContent = '点がほとんど取れませんでした。\n'
        + '・明るい場所で、模様のある面を 1〜3m の距離からゆっくり映してください\n'
        + '・深度が出ない機種の可能性もあります（設定で「深度の種類」を切り替えて試してください）';
      show(el('start-err'), true);
      return;
    }
    cur = {
      grid: scanner.grid, cloud: scanner.cloud,
      poly: scanner.boundPts.length >= 3 ? scanner.boundPts.map(function (p) { return { x: p.x, z: p.z }; }) : null,
      manualPlane: scanner.manualPlane(),
      planeMode: 'auto',
      startDir: scanner.startDir || null,
      depthInfo: scanner.depthInfo || null,
      scanStats: {
        秒: Math.round(scanner.stats.elapsed),
        取り込んだ点: scanner.stats.pts,
        深度の有効率: scanner.stats.tried ? +(scanner.stats.valid / scanner.stats.tried * 100).toFixed(1) : null,
        速すぎて捨てた回数: scanner.stats.dropFast
      },
      section: null, name: '', memo: '', id: null
    };
    if (mapView) { mapView.poly = cur.poly ? cur.poly.slice() : []; mapView.section = null; }
    el('rng-off').value = 0; el('lbl-off').textContent = '0 cm';
    el('rng-thr').value = Math.round(cfg.thr * 100); el('lbl-thr').textContent = Math.round(cfg.thr * 100) + ' cm';
    el('in-name').value = ''; el('in-memo').value = '';
    goTab('result');
    setTimeout(recompute, 50);
  }

  /* ============================================================
     結果タブ
     ============================================================ */
  function bindResult() {
    mapView = new Render.MapView(el('map'));
    mapView.onChange = function (what) {
      if (what === 'poly') { cur.poly = mapView.poly.slice(); recompute(true); }
      if (what === 'section') drawSection();
    };
    bindSeg('seg-map', function (v) { mapView.mode = v; });

    el('btn-poly-clear').addEventListener('click', function () {
      mapView.poly = []; cur.poly = null; recompute(true);
    });
    el('btn-poly-undo').addEventListener('click', function () {
      mapView.poly.pop(); cur.poly = mapView.poly.length >= 3 ? mapView.poly.slice() : null; recompute(true);
    });
    el('btn-fit').addEventListener('click', function () { mapView.fit(); mapView.draw(); });

    el('btn-side-fill').addEventListener('click', function () {
      if (!cur) return; cur.lockedSide = 'fill'; Store.set('side', 'auto'); recompute(true);
    });
    el('btn-side-cut').addEventListener('click', function () {
      if (!cur) return; cur.lockedSide = 'cut'; Store.set('side', 'auto'); recompute(true);
    });

    el('rng-off').addEventListener('input', function () {
      el('lbl-off').textContent = this.value + ' cm';
    });
    el('rng-off').addEventListener('change', function () { recompute(true); });
    el('rng-thr').addEventListener('input', function () {
      el('lbl-thr').textContent = this.value + ' cm';
    });
    el('rng-thr').addEventListener('change', function () { recompute(true); });

    el('btn-plane-manual').addEventListener('click', function () {
      if (!cur || !cur.manualPlane) { toast('スキャン中に「地面点」を 3 点以上拾っていません'); return; }
      cur.planeMode = 'manual'; recompute(true);
      toast('拾った地面の点から基準面を作りました');
    });
    el('btn-plane-auto').addEventListener('click', function () {
      if (!cur) return;
      cur.planeMode = 'auto'; recompute(true);
      toast('基準面を自動推定に戻しました');
    });

    ['sel-measured', 'in-L', 'in-C', 'in-dump'].forEach(function (id) {
      el(id).addEventListener('change', function () {
        Store.set({ 'sel-measured': 'measuredAs', 'in-L': 'L', 'in-C': 'C', 'in-dump': 'dumpCap' }[id],
          id === 'sel-measured' ? this.value : parseFloat(this.value));
        renderConvert();
      });
    });

    el('btn-save').addEventListener('click', saveCurrent);
    el('btn-png').addEventListener('click', exportPng);
    el('btn-ply').addEventListener('click', function () { if (cur) Exporter.ply(cur.cloud, nameOf()); });
    el('btn-cloudcsv').addEventListener('click', function () { if (cur) Exporter.cloudCsv(cur.cloud, nameOf()); });
    el('btn-gridcsv').addEventListener('click', function () { if (cur && cur.res) Exporter.gridCsv(cur.res, nameOf()); });
    el('btn-sectcsv').addEventListener('click', function () {
      if (!cur || !mapView.section) { toast('先に断面線を引いてください'); return; }
      var p = Volume.profile(cur.res, mapView.section.a, mapView.section.b, 300);
      if (p) Exporter.sectionCsv(p, nameOf());
    });
    el('btn-json').addEventListener('click', function () {
      if (!cur || !cur.res) return;
      Exporter.json({
        name: nameOf(), memo: el('in-memo').value,
        plane: cur.res.plane, opts: cur.opts, summary: cur.summary,
        poly: cur.poly, section: mapView.section,
        depthInfo: cur.depthInfo, scanStats: cur.scanStats
      }, nameOf());
    });
  }

  function nameOf() {
    var n = (el('in-name').value || '').trim();
    return n ? n.replace(/[\\/:*?"<>|]/g, '_') : 'doryo';
  }

  function recompute(keepView) {
    if (!cur) return;
    var opts = {
      thr: parseFloat(el('rng-thr').value) / 100,
      minCnt: cfg.minCnt,
      maxTilt: cfg.maxTilt,
      largestOnly: cfg.largestOnly,
      fillHoles: cfg.fillHoles,
      smooth: cfg.smooth,
      closing: cfg.closing,
      // 「おまかせ」で一度どちら側か決まったら、そのあとの微調整では固定する。
      // 固定しないと、基準面を少し上げただけで広い地面全体が「掘削」と判定され、
      // 表示が土量から掘削量に裏返ってしまう
      side: cfg.side === 'auto' ? (cur.lockedSide || 'auto') : cfg.side,
      poly: cur.poly,
      planeOffset: parseFloat(el('rng-off').value) / 100,
      plane: cur.planeMode === 'manual' ? cur.manualPlane : null
    };
    cur.opts = opts;
    var res;
    try { res = Volume.compute(cur.grid, opts); }
    catch (e) { console.error(e); res = { error: '計算中にエラーが出ました: ' + e.message }; }
    cur.res = res;

    show(el('res-empty'), false);
    show(el('res-body'), true);

    if (res.error) {
      el('res-vol').textContent = '—';
      el('res-range').textContent = '';
      el('res-kind').textContent = '計算できません';
      el('res-warn').innerHTML = '<div class="w">' + esc(res.error) + '</div>';
      ['res-area', 'res-hmax', 'res-hmean', 'res-cells'].forEach(function (i) { el(i).textContent = '—'; });
      el('tbl-conv').innerHTML = ''; el('res-dump').textContent = '—';
      show(el('side-switch'), false);
      if (res.dense) { mapView.setResult(res, keepView); }
      renderPlaneInfo(res);
      return;
    }

    var m = res.main;
    var isCut = res.mainSide === 'cut';
    if (cfg.side === 'auto' && !cur.lockedSide) cur.lockedSide = res.mainSide;

    // 盛土と掘削の両方が見つかったときだけ、見る側を選べるようにする
    var both = !!(res.fill && res.cut);
    show(el('side-switch'), both);
    el('btn-side-fill').classList.toggle('on', !isCut);
    el('btn-side-cut').classList.toggle('on', isCut);
    el('res-kind').textContent = isCut ? '掘削量（基準面より下）' : '土量（基準面より上）';
    el('res-vol').textContent = fmt(m.vol);
    el('res-range').textContent = '参考幅 ' + fmt(m.volLo) + ' 〜 ' + fmt(m.volHi) + ' m³'
      + (res.fill && res.cut ? '　／　反対側 ' + fmt(isCut ? res.fill.vol : res.cut.vol) + ' m³' : '');
    el('res-area').textContent = fmt(m.area, 'm²');
    el('res-hmax').textContent = fmt(m.hMax, 'm');
    el('res-hmean').textContent = fmt(m.hMean, 'm');
    el('res-cells').textContent = m.cells.toLocaleString('ja-JP') + ' 個';

    el('res-warn').innerHTML = (res.warn || []).map(function (w) { return '<div class="w">' + esc(w) + '</div>'; }).join('');

    cur.summary = {
      種別: isCut ? '掘削量' : '土量',
      体積m3: +m.vol.toFixed(3),
      参考幅m3: [+m.volLo.toFixed(3), +m.volHi.toFixed(3)],
      面積m2: +m.area.toFixed(3),
      最大高さm: +m.hMax.toFixed(3),
      平均高さm: +m.hMean.toFixed(3),
      格子数: m.cells,
      格子m: res.cellSize,
      補間セル率: +(m.interpRatio * 100).toFixed(1),
      基準面の傾きdeg: +res.tilt.toFixed(2)
    };

    mapView.setResult(res, keepView);
    renderPlaneInfo(res);
    renderConvert();
    drawSection();
  }

  function renderPlaneInfo(res) {
    if (!res || !res.plane) { el('plane-info').textContent = ''; return; }
    var p = res.plane;
    el('plane-info').textContent =
      '基準面： y = ' + p.a.toFixed(4) + '·x + ' + p.b.toFixed(4) + '·z + ' + p.c.toFixed(4) +
      '（傾き ' + res.tilt.toFixed(1) + '°' +
      (cur && cur.planeMode === 'manual' ? ' / 手動 ' + (cur.manualPlane ? cur.manualPlane.n : 0) + '点' : ' / 自動') + '）' +
      (res.sigma !== undefined ? '　計測のばらつき ± ' + (res.sigma * 100).toFixed(1) + ' cm/格子'
        + (res.smoothed ? '（平滑化あり）' : '') : '');
  }

  function renderConvert() {
    if (!cur || !cur.res || !cur.res.main) { el('tbl-conv').innerHTML = ''; return; }
    var v = cur.res.main.vol;
    var c = Volume.convert(v, cfg.measuredAs, cfg.L, cfg.C);
    var mark = { bank: '地山', loose: 'ほぐし', comp: '締固め' }[cfg.measuredAs];
    function row(label, val, on) {
      return '<tr><td>' + label + (on ? '（測った値）' : '') + '</td><td>' + fmt(val) + ' m³</td></tr>';
    }
    el('tbl-conv').innerHTML =
      row('地山土量',   c.bank,  mark === '地山') +
      row('ほぐし土量', c.loose, mark === 'ほぐし') +
      row('締固め土量', c.comp,  mark === '締固め');
    var n = cfg.dumpCap > 0 ? c.loose / cfg.dumpCap : 0;
    el('res-dump').textContent = 'ダンプ ' + Math.ceil(n) + ' 台ぶん（' + n.toFixed(1) + ' 台 ／ 1台 ' + cfg.dumpCap + ' m³ ほぐし）';
  }

  function drawSection() {
    if (!cur || !cur.res || !mapView.section) { Render.drawSection(el('sect'), null); return; }
    var p = Volume.profile(cur.res, mapView.section.a, mapView.section.b, 240);
    Render.drawSection(el('sect'), p);
    cur.section = mapView.section;
  }

  function exportPng() {
    if (!cur || !cur.res || !cur.res.main) { toast('先に計測してください'); return; }
    var m = cur.res.main, s = cur.summary;
    var c = Volume.convert(m.vol, cfg.measuredAs, cfg.L, cfg.C);
    var lines = [
      (el('in-name').value || '（無題）') + '　' + new Date().toLocaleString('ja-JP'),
      s.種別 + '　' + fmt(m.vol) + ' m³　（参考幅 ' + fmt(m.volLo) + '〜' + fmt(m.volHi) + ' m³）',
      '対象面積 ' + fmt(m.area) + ' m²　最大高さ ' + fmt(m.hMax) + ' m　平均高さ ' + fmt(m.hMean) + ' m',
      '格子 ' + (cur.res.cellSize * 100).toFixed(0) + ' cm × ' + m.cells.toLocaleString('ja-JP') + ' 個'
        + '　補間 ' + s.補間セル率 + '%　基準面の傾き ' + s.基準面の傾きdeg + '°',
      '地山 ' + fmt(c.bank) + ' m³ ／ ほぐし ' + fmt(c.loose) + ' m³ ／ 締固め ' + fmt(c.comp) + ' m³（L=' + c.L + ' C=' + c.C + '）',
      '※ スマホ深度による概算値。出来形数量に用いる場合は監督員と計測方法を協議のこと'
    ];
    if (el('in-memo').value) lines.splice(1, 0, 'メモ： ' + el('in-memo').value);
    Exporter.png(el('map'), lines, '土量スキャナ 計測結果', nameOf());
  }

  function saveCurrent() {
    if (!cur || !cur.res) { toast('保存できる結果がありません'); return; }
    Store.save({
      id: cur.id, name: el('in-name').value || '無題', memo: el('in-memo').value,
      grid: cur.grid, cloud: cur.cloud, plane: cur.res.plane,
      poly: cur.poly, section: cur.section, opts: cur.opts, summary: cur.summary,
      startDir: cur.startDir, depthInfo: cur.depthInfo, scanStats: cur.scanStats
    }).then(function (id) {
      cur.id = id;
      toast('保存しました');
    }).catch(function (e) { toast('保存に失敗しました: ' + e); });
  }

  /* ============================================================
     一覧タブ
     ============================================================ */
  function renderList() {
    Store.list().then(function (a) {
      var box = el('list');
      if (!a.length) { box.innerHTML = '<div class="empty">保存された計測はまだありません。</div>'; renderUsage(); return; }
      box.innerHTML = a.map(function (o) {
        var s = o.summary || {};
        return '<div class="item" data-id="' + o.id + '">' +
          '<div class="nm">' + esc(o.name) + '</div>' +
          '<div class="dt">' + new Date(o.date).toLocaleString('ja-JP') + '</div>' +
          '<div class="vv">' + (s.体積m3 !== undefined ? (s.種別 || '体積') + ' ' + fmt(s.体積m3) + ' m³' : '（結果なし）') + '</div>' +
          (o.memo ? '<div class="mm">' + esc(o.memo) + '</div>' : '') +
          '<div class="row-btns">' +
            '<button class="btn tiny act-open">開く</button>' +
            '<button class="btn tiny act-ren">名前</button>' +
            '<button class="btn tiny danger act-del">削除</button>' +
          '</div></div>';
      }).join('');
      Array.prototype.forEach.call(box.querySelectorAll('.item'), function (it) {
        var id = it.dataset.id;
        it.querySelector('.act-open').addEventListener('click', function () { openSaved(id); });
        it.querySelector('.act-ren').addEventListener('click', function () {
          var n = prompt('名前', it.querySelector('.nm').textContent);
          if (n !== null) Store.rename(id, n).then(renderList);
        });
        it.querySelector('.act-del').addEventListener('click', function () {
          if (confirm('この計測を削除しますか？')) Store.remove(id).then(renderList);
        });
      });
      renderUsage();
    });
  }

  function openSaved(id) {
    Store.load(id).then(function (o) {
      if (!o || !o.grid) { toast('データを読めませんでした'); return; }
      cur = {
        grid: HGrid.unpack(o.grid),
        cloud: o.cloud ? VCloud.unpack(o.cloud) : new VCloud(0.03, 1),
        poly: o.poly || null, manualPlane: null, planeMode: 'auto',
        section: o.section || null, startDir: o.startDir || null,
        id: o.id, name: o.name, memo: o.memo
      };
      el('in-name').value = o.name === '無題' ? '' : o.name;
      el('in-memo').value = o.memo || '';
      if (o.opts) {
        el('rng-thr').value = Math.round((o.opts.thr || 0.05) * 100);
        el('lbl-thr').textContent = el('rng-thr').value + ' cm';
        el('rng-off').value = Math.round((o.opts.planeOffset || 0) * 100);
        el('lbl-off').textContent = el('rng-off').value + ' cm';
      }
      mapView.poly = cur.poly ? cur.poly.slice() : [];
      mapView.section = cur.section;
      goTab('result');
      setTimeout(function () { recompute(); }, 50);
    });
  }

  function renderUsage() {
    Store.usage().then(function (u) {
      if (!u) return;
      var t = '端末の保存領域： ' + (u.usage / 1048576).toFixed(1) + ' MB 使用'
            + (u.quota ? '（上限の目安 ' + (u.quota / 1048576).toFixed(0) + ' MB）' : '');
      if (el('usage')) el('usage').textContent = t;
      if (el('usage2')) el('usage2').textContent = t;
    });
  }

  function bindList() {
    el('btn-list-clear').addEventListener('click', function () {
      if (confirm('保存されたすべての計測を削除します。よろしいですか？')) Store.clear().then(renderList);
    });
  }

  /* ============================================================
     設定タブ
     ============================================================ */
  var RANGES = [
    ['cf-cs',   'lbl-cs',   'cellSize', function (v) { return v / 100; }, function (v) { return Math.round(v * 100); }, function (v) { return (v * 100).toFixed(0) + ' cm'; }],
    ['cf-dmax', 'lbl-dmax', 'dMax',     function (v) { return v; },       function (v) { return v; },                   function (v) { return v.toFixed(1) + ' m'; }],
    ['cf-samp', 'lbl-samp', 'samples',  function (v) { return v; },       function (v) { return v; },                   function (v) { return v.toLocaleString('ja-JP') + ' 点'; }],
    ['cf-rate', 'lbl-rate', 'rateHz',   function (v) { return v; },       function (v) { return v; },                   function (v) { return v + ' 回/秒'; }],
    ['cf-spd',  'lbl-spd',  'maxSpeed', function (v) { return v; },       function (v) { return v; },                   function (v) { return v.toFixed(1) + ' m/s'; }],
    ['cf-mcnt', 'lbl-mcnt', 'minCnt',   function (v) { return v; },       function (v) { return v; },                   function (v) { return v + ' 回'; }],
    ['cf-tilt', 'lbl-tilt', 'maxTilt',  function (v) { return v; },       function (v) { return v; },                   function (v) { return v + ' °'; }]
  ];

  function renderCfg() {
    RANGES.forEach(function (r) {
      var inp = el(r[0]);
      inp.value = r[4](cfg[r[2]]);
      el(r[1]).textContent = r[5](cfg[r[2]]);
    });
    el('cf-dtype').value = cfg.depthType;
    el('cf-largest').checked = !!cfg.largestOnly;
    el('cf-holes').checked = !!cfg.fillHoles;
    el('cf-smooth').checked = !!cfg.smooth;
    el('cf-closing').checked = !!cfg.closing;
    el('sel-measured').value = cfg.measuredAs;
    el('in-L').value = cfg.L; el('in-C').value = cfg.C; el('in-dump').value = cfg.dumpCap;
    var sb = el('seg-side').querySelector('button[data-v="' + cfg.side + '"]');
    if (sb) Array.prototype.forEach.call(el('seg-side').querySelectorAll('button'),
      function (o) { o.classList.toggle('on', o === sb); });
  }

  function bindCfg() {
    RANGES.forEach(function (r) {
      var inp = el(r[0]);
      inp.addEventListener('input', function () {
        var v = r[3](parseFloat(this.value));
        Store.set(r[2], v);
        el(r[1]).textContent = r[5](v);
      });
    });
    el('cf-dtype').addEventListener('change', function () { Store.set('depthType', this.value); });
    [['cf-largest', 'largestOnly'], ['cf-holes', 'fillHoles'],
     ['cf-smooth', 'smooth'], ['cf-closing', 'closing']].forEach(function (p) {
      el(p[0]).addEventListener('change', function () {
        Store.set(p[1], this.checked);
        if (cur && cur.res) recompute(true);
      });
    });
    el('btn-reset').addEventListener('click', function () {
      if (!confirm('設定を初期値に戻しますか？（保存した計測は消えません）')) return;
      Store.reset(); cfg = Store.cfg; renderCfg(); toast('初期値に戻しました');
    });

    el('btn-check').addEventListener('click', function () {
      var t = parseFloat(el('ck-true').value), m = parseFloat(el('ck-meas').value);
      if (!(t > 0) || !(m > 0)) { toast('2 つとも入力してください'); return; }
      var e = (m - t) / t * 100;
      el('ck-out').textContent = '誤差 ' + (e >= 0 ? '+' : '') + e.toFixed(1) + ' %'
        + '（差 ' + (m - t >= 0 ? '+' : '') + (m - t).toFixed(3) + ' m³）';
      var log = [];
      try { log = JSON.parse(localStorage.getItem('doryoScan.checks') || '[]'); } catch (x) {}
      log.unshift({ d: new Date().toISOString(), t: t, m: m, e: +e.toFixed(1) });
      log = log.slice(0, 20);
      try { localStorage.setItem('doryoScan.checks', JSON.stringify(log)); } catch (x) {}
      renderChecks();
    });
    renderChecks();
  }

  function renderChecks() {
    var log = [];
    try { log = JSON.parse(localStorage.getItem('doryoScan.checks') || '[]'); } catch (x) {}
    if (!log.length) { el('ck-log').innerHTML = ''; return; }
    var avg = log.reduce(function (s, o) { return s + Math.abs(o.e); }, 0) / log.length;
    el('ck-log').innerHTML = '<table class="tbl">' + log.map(function (o) {
      return '<tr><td>' + new Date(o.d).toLocaleDateString('ja-JP') + '　実 ' + o.t + ' / 測 ' + o.m +
             '</td><td>' + (o.e >= 0 ? '+' : '') + o.e + ' %</td></tr>';
    }).join('') + '</table><p class="note">この端末の平均誤差（絶対値）： <b>' + avg.toFixed(1) + ' %</b></p>';
  }

  /* ============================================================
     その他
     ============================================================ */
  function esc(s) {
    return String(s).replace(/[&<>"]/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c];
    });
  }

  function registerSW() {
    if ('serviceWorker' in navigator) {
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js').catch(function (e) { console.warn('SW', e); });
      });
    }
  }

  /* ---- 起動 ---- */
  bindTabs();
  bindScan();
  bindResult();
  bindCfg();
  bindList();
  renderCfg();
  checkSupport();
  registerSW();
  window.addEventListener('resize', function () { if (mapView) mapView.draw(); });
})();
