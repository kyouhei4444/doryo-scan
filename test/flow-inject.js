<script>
/* 実際の画面を通した通しテスト（index.html に差し込んで使う一時ファイル）
   合成した格子を保存 → 一覧タブ →「開く」→ 結果タブ の順に本物のボタンを押していき、
   表示された数値が理論値と合うかを見る。

   注意: ヘッドレスの仮想時間では IndexedDB の完了を待てないので、保存層だけ
   メモリに差し替える。格子の pack/unpack は本物を通るので往復は確認できる。 */
(function () {
  var L = [], NG = 0, STEP = 'start', done = false;
  function g(id) { return document.getElementById(id); }
  function say(ok, s) { L.push((ok ? 'OK  ' : 'NG  ') + s); if (!ok) NG++; }
  function wait(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function num(t) { var m = String(t).match(/-?[\d,]+\.?\d*/); return m ? parseFloat(m[0].replace(/,/g, '')) : NaN; }
  function dump(tail) {
    if (done) return; done = true;
    var p = document.createElement('pre'); p.id = '__smoke';
    p.textContent = L.join('\n') + '\n' + tail;
    document.body.appendChild(p);
  }
  setTimeout(function () {
    dump('\nRESULT STALL  最後に通った所: ' + STEP + '\nJSエラー: ' + (window.__errs.join(' | ') || 'なし'));
  }, 60000);

  /* --- 保存層をメモリに差し替え（本物と同じ形に pack する） --- */
  var MEM = {};
  Store.save = function (rec) {
    var id = rec.id || ('m' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5));
    MEM[id] = {
      id: id, name: rec.name || '無題', memo: rec.memo || '', date: new Date().toISOString(),
      grid: rec.grid ? rec.grid.pack() : null,
      cloud: rec.cloud ? rec.cloud.pack(150000) : null,
      plane: rec.plane || null, poly: rec.poly || null, section: rec.section || null,
      opts: rec.opts || null, summary: rec.summary || null
    };
    return Promise.resolve(id);
  };
  Store.list = function () {
    var a = Object.keys(MEM).map(function (k) {
      var o = {}; for (var f in MEM[k]) if (f !== 'grid' && f !== 'cloud') o[f] = MEM[k][f];
      return o;
    });
    a.sort(function (p, q) { return p.date < q.date ? 1 : -1; });
    return Promise.resolve(a);
  };
  Store.load   = function (id) { return Promise.resolve(MEM[id] || null); };
  Store.remove = function (id) { delete MEM[id]; return Promise.resolve(); };
  Store.rename = function (id, n) { if (MEM[id]) MEM[id].name = n; return Promise.resolve(); };
  Store.clear  = function () { MEM = {}; return Promise.resolve(); };
  Store.usage  = function () { return Promise.resolve(null); };

  var R = 1.5, H = 1.0;
  var Rp = R * (1 - 0.05 / H);
  var WANT = 2 * Math.PI * H * (Rp*Rp/2 - Rp*Rp*Rp/(3*R));   // 裾を 5cm で切った円錐の体積

  wait(200).then(function () {
    STEP = '1 合成と保存';
    var grid = new HGrid(0.04), cloud = new VCloud(0.04, 200000);
    for (var i = 0; i < 400000; i++) {
      var x = (Math.random()-0.5)*7, z = (Math.random()-0.5)*7;
      var r = Math.sqrt(x*x + z*z);
      var y = (r < R ? H*(1 - r/R) : 0) + (Math.random()-0.5)*0.012;
      grid.add(x, y, z); cloud.add(x, y, z);
    }
    say(grid.n > 1000, '合成した格子 ' + grid.n.toLocaleString() + ' セル / 点群 ' + cloud.n.toLocaleString() + ' 点');
    return Store.save({ name: '通しテスト', memo: '合成した円錐', grid: grid, cloud: cloud });
  })
  .then(function () {
    STEP = '2 一覧';
    document.querySelector('#tabs button[data-v="list"]').click();
    return wait(400);
  })
  .then(function () {
    STEP = '3 開く';
    var items = document.querySelectorAll('#list .item');
    say(items.length === 1, '一覧に ' + items.length + ' 件表示された');
    var b = document.querySelector('#list .act-open');
    say(!!b, '「開く」ボタンがある');
    if (b) b.click();
    return wait(1500);
  })
  .then(function () {
    STEP = '4 結果の数値';
    say(document.querySelector('.view.active').id === 'view-result', '結果タブに切り替わった');
    say(!g('res-body').classList.contains('hidden'), '結果が表示されている');

    var vol = num(g('res-vol').textContent);
    var err = (vol - WANT) / WANT * 100;
    say(Math.abs(err) < 5, '体積 ' + vol.toFixed(4) + ' m3（理論値 ' + WANT.toFixed(4) + ' / 差 ' + err.toFixed(2) + '%）');

    var area = num(g('res-area').textContent), hmax = num(g('res-hmax').textContent);
    say(Math.abs(area - Math.PI*Rp*Rp) / (Math.PI*Rp*Rp) < 0.12,
        '面積 ' + area.toFixed(3) + ' m2（理論値 ' + (Math.PI*Rp*Rp).toFixed(3) + '）');
    say(Math.abs(hmax - H) < 0.10, '最大高さ ' + hmax.toFixed(3) + ' m（真値 ' + H + '）');
    say(g('res-cells').textContent.indexOf('個') > 0, '格子数 ' + g('res-cells').textContent);
    say(g('plane-info').textContent.indexOf('基準面') === 0, g('plane-info').textContent.slice(0, 96));
    say(g('res-kind').textContent.indexOf('土量') >= 0, '種別 ' + g('res-kind').textContent);
    say(g('res-range').textContent.indexOf('参考幅') >= 0, g('res-range').textContent.slice(0, 56));

    var conv = g('tbl-conv').textContent.replace(/\s+/g, ' ').trim();
    say(conv.indexOf('地山土量') >= 0 && conv.indexOf('ほぐし土量') >= 0 && conv.indexOf('締固め土量') >= 0,
        '土量換算表 ' + conv);
    var shown = num(conv.replace('地山土量', ''));
    say(Math.abs(shown - vol/1.20) < 0.02, '地山換算が L=1.2 と整合（' + shown.toFixed(3) + ' ≒ ' + (vol/1.2).toFixed(3) + '）');
    say(g('res-dump').textContent.indexOf('ダンプ') === 0, g('res-dump').textContent);

    var cv = g('map');
    var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, cols = {};
    for (var k = 0; k < d.length; k += 4*29) cols[d[k]+','+d[k+1]+','+d[k+2]] = 1;
    say(Object.keys(cols).length > 20, '平面図が描けている（' + Object.keys(cols).length + ' 色）');
    return vol;
  })
  .then(function (vol0) {
    STEP = '5 基準面スライダー';
    g('rng-off').value = '10';
    g('rng-off').dispatchEvent(new Event('input'));
    g('rng-off').dispatchEvent(new Event('change'));
    return wait(1200).then(function () {
      var v2 = num(g('res-vol').textContent);
      say(v2 < vol0, '基準面を +10cm すると体積が減る: ' + vol0.toFixed(3) + ' → ' + v2.toFixed(3) + ' m3');
      say(g('lbl-off').textContent === '10 cm', 'スライダーの表示 ' + g('lbl-off').textContent);
      g('rng-off').value = '0';
      g('rng-off').dispatchEvent(new Event('input'));
      g('rng-off').dispatchEvent(new Event('change'));
      return wait(1200).then(function () {
        say(Math.abs(num(g('res-vol').textContent) - vol0) < 1e-6, '0 に戻すと元の体積に戻る');
        return num(g('res-vol').textContent);
      });
    });
  })
  .then(function (v0) {
    STEP = '6 しきい値スライダー';
    g('rng-thr').value = '25';
    g('rng-thr').dispatchEvent(new Event('input'));
    g('rng-thr').dispatchEvent(new Event('change'));
    return wait(1200).then(function () {
      var v1 = num(g('res-vol').textContent);
      say(v1 < v0, 'しきい値 5cm→25cm で体積が減る: ' + v0.toFixed(3) + ' → ' + v1.toFixed(3) + ' m3');
      g('rng-thr').value = '5';
      g('rng-thr').dispatchEvent(new Event('input'));
      g('rng-thr').dispatchEvent(new Event('change'));
      return wait(1200);
    });
  })
  .then(function () {
    STEP = '6b 側の切り替え';
    var swVisible = !g('side-switch').classList.contains('hidden');
    say(true, '盛土/掘削の切り替えボタン: ' + (swVisible ? '表示あり' : '表示なし（片側だけ検出）'));
    STEP = '7 断面';
    var ok = false;
    try {
      var cvs = g('map');
      cvs.setPointerCapture = function () {};
      var r = cvs.getBoundingClientRect();
      function ev(t, x, y) {
        return new PointerEvent(t, { pointerId: 1, clientX: x, clientY: y, bubbles: true, isPrimary: true });
      }
      document.querySelector('#seg-map button[data-v="section"]').click();
      cvs.dispatchEvent(ev('pointerdown', r.left + r.width*0.15, r.top + r.height*0.5));
      cvs.dispatchEvent(ev('pointermove', r.left + r.width*0.85, r.top + r.height*0.5));
      cvs.dispatchEvent(ev('pointerup',   r.left + r.width*0.85, r.top + r.height*0.5));
      ok = true;
    } catch (e) { say(false, '断面の操作で例外: ' + e.message); }
    return wait(500).then(function () {
      var cv = g('sect');
      var d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data, cols = {};
      for (var k = 0; k < d.length; k += 4*17) cols[d[k]+','+d[k+1]+','+d[k+2]] = 1;
      say(ok && Object.keys(cols).length > 6, '平面図をなぞって断面図が描けた（' + Object.keys(cols).length + ' 色）');
    });
  })
  .then(function () {
    STEP = '7b 3Dモデル（閉じた立体）';
    document.querySelector('#seg-mesh button[data-v="solid"]').click();
    g('btn-mesh').click();
    return wait(1500).then(function () {
      var info = g('mesh-info').textContent;
      say(info.indexOf('三角形') > 0, '3Dモデルができた: ' + info.split('\n')[0]);
      var m = info.match(/立体としての体積 ([\d.]+) m³（画面の体積 ([\d.]+)/);
      if (m) {
        var e = (parseFloat(m[1]) - parseFloat(m[2])) / parseFloat(m[2]) * 100;
        say(Math.abs(e) < 1, '立体の体積が画面の体積と一致: ' + m[1] + ' ＝ ' + m[2] + ' m³（差 ' + e.toFixed(2) + '%）');
      } else { say(false, '体積の照合行が出ていません: ' + info); }
      say(!g('btn-glb').disabled && !g('btn-obj').disabled && !g('btn-stl').disabled,
          'GLB / OBJ / STL の書き出しボタンが押せる状態になった');
    });
  })
  .then(function () {
    STEP = '7c 3Dモデル（物体の表面）';
    document.querySelector('#seg-mesh button[data-v="surface"]').click();
    say(!g('mesh-opt-surface').classList.contains('hidden'), '表面モードの設定欄が出た');
    g('btn-mesh').click();
    return wait(2500).then(function () {
      var info = g('mesh-info').textContent;
      say(info.indexOf('三角形') > 0, '点群から表面を起こせた: ' + info.split('\n')[0]);
      say(info.indexOf('格子') >= 0, info.split('\n')[2] || '');
      // 結果を変えるとモデルは作り直しが要るので、いったん消えること
      g('rng-thr').value = '6';
      g('rng-thr').dispatchEvent(new Event('input'));
      g('rng-thr').dispatchEvent(new Event('change'));
      return wait(1200).then(function () {
        say(g('btn-glb').disabled, '計算し直したら3Dモデルは作り直しになる（書き出しボタンが無効に戻る）');
        g('rng-thr').value = '5';
        g('rng-thr').dispatchEvent(new Event('input'));
        g('rng-thr').dispatchEvent(new Event('change'));
        return wait(1200);
      });
    });
  })
  .then(function () {
    STEP = '8 保存し直し';
    g('in-name').value = '通しテスト2';
    g('in-memo').value = '再計算後';
    g('btn-save').click();
    return wait(600).then(function () {
      document.querySelector('#tabs button[data-v="list"]').click();
      return wait(500);
    });
  })
  .then(function () {
    STEP = '9 削除';
    var items = document.querySelectorAll('#list .item');
    say(items.length === 1, '上書き保存なので一覧は ' + items.length + ' 件のまま');
    say(items[0] && items[0].querySelector('.nm').textContent === '通しテスト2',
        '名前が更新された: ' + (items[0] ? items[0].querySelector('.nm').textContent : ''));
    say(items[0] && items[0].querySelector('.vv').textContent.indexOf('土量') >= 0,
        '一覧に体積が出ている: ' + (items[0] ? items[0].querySelector('.vv').textContent.trim() : ''));
    window.confirm = function () { return true; };
    var del = document.querySelectorAll('#list .act-del');
    for (var i = 0; i < del.length; i++) del[i].click();
    return wait(700);
  })
  .then(function () {
    say(document.querySelectorAll('#list .item').length === 0, '削除して一覧が空になった');
    say(window.__errs.length === 0, 'JS エラー: ' + (window.__errs.length ? window.__errs.join(' | ') : 'なし'));
    dump('\n' + (NG ? 'RESULT FAIL  ' + NG + ' 件' : 'RESULT PASS  ' + L.length + ' 項目'));
  })
  .catch(function (e) {
    dump('\nRESULT FAIL（例外 at ' + STEP + '）\n' + e.message + '\n' + e.stack);
  });
})();
</script>
