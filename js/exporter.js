/* ============================================================
   exporter.js  書き出し
     ・PLY   点群（CloudCompare / MeshLab / Blender で開ける）
     ・CSV   点群 と 格子（比高つき）
     ・CSV   断面
     ・PNG   結果の平面図（工事写真・報告書に貼る用）
     ・JSON  計算条件つきの全記録

   座標について:
     原点は「スキャンを始めたときの端末の位置」、Y は鉛直上向き。
     現場座標（平面直角座標）とは結び付いていないので、CSV/PLY のヘッダにもそう書く。
   ============================================================ */
(function (global) {
  'use strict';

  function download(blob, filename) {
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    setTimeout(function () { document.body.removeChild(a); URL.revokeObjectURL(url); }, 1500);
  }

  function stamp(d) {
    d = d || new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return d.getFullYear() + p(d.getMonth()+1) + p(d.getDate()) + '_' + p(d.getHours()) + p(d.getMinutes());
  }

  /* ---------- PLY（binary_little_endian）---------- */
  function ply(cloud, name) {
    var n = cloud.n;
    var head = [
      'ply',
      'format binary_little_endian 1.0',
      // PLY のヘッダは ASCII だけにする（CloudCompare 等で確実に読めるように）
      'comment doryo-scan (Doryo Scanner)',
      'comment origin = scan start position, Y = up (meters)',
      'element vertex ' + n,
      'property float x', 'property float y', 'property float z',
      'end_header', ''
    ].join('\n');
    var hb = new TextEncoder().encode(head);
    var body = new ArrayBuffer(n * 12);
    var dv = new DataView(body);
    for (var i = 0, o = 0; i < n; i++, o += 12) {
      dv.setFloat32(o,     cloud.px[i], true);
      dv.setFloat32(o + 4, cloud.py[i], true);
      dv.setFloat32(o + 8, cloud.pz[i], true);
    }
    download(new Blob([hb, body], { type: 'application/octet-stream' }), (name || 'cloud') + '_' + stamp() + '.ply');
  }

  /* ---------- 点群 CSV ---------- */
  function cloudCsv(cloud, name) {
    var out = ['# 土量スキャナ 点群 (原点=スキャン開始位置, Y=鉛直上向き, 単位 m)', 'X,Y,Z'];
    for (var i = 0; i < cloud.n; i++) {
      out.push(cloud.px[i].toFixed(4) + ',' + cloud.py[i].toFixed(4) + ',' + cloud.pz[i].toFixed(4));
    }
    download(new Blob([out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }),
      (name || 'cloud') + '_' + stamp() + '.csv');
  }

  /* ---------- 格子 CSV（点高法の計算表そのもの）---------- */
  function gridCsv(res, name) {
    var d = res.dense, main = res.main;
    if (!d) return;
    var hArr = main ? main.denseH : d.h;
    var sel = main ? main.sel : null;
    var interp = main ? main.interp : null;
    var A = d.cs * d.cs;
    var out = [];
    out.push('# 土量スキャナ 格子データ（点高法）');
    out.push('# 原点=スキャン開始位置 / Y=鉛直上向き / 単位 m');
    out.push('# 格子 ' + d.cs.toFixed(3) + ' m 角  1格子の面積 ' + A.toFixed(5) + ' m2');
    out.push('# 基準面 y = ' + res.plane.a.toFixed(6) + '*x + ' + res.plane.b.toFixed(6) + '*z + ' + res.plane.c.toFixed(6));
    out.push('X,Z,基準面Y,比高H,体積寄与(m3),対象,補間,観測回数');
    for (var i = 0; i < d.nx * d.nz; i++) {
      if (!d.cnt[i] && !(sel && sel[i])) continue;
      var ix = d.ix0 + (i % d.nx), iz = d.iz0 + ((i / d.nx) | 0);
      var x = (ix + 0.5) * d.cs, z = (iz + 0.5) * d.cs;
      var py = global.Geom.planeY(res.plane, x, z);
      var h = hArr[i];
      var on = sel && sel[i] ? 1 : 0;
      out.push([x.toFixed(3), z.toFixed(3), py.toFixed(4), h.toFixed(4),
                (on ? (h * A).toFixed(6) : '0'), on, (interp && interp[i] ? 1 : 0), d.cnt[i]].join(','));
    }
    download(new Blob(['﻿' + out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }),
      (name || 'grid') + '_' + stamp() + '.csv');
  }

  /* ---------- 断面 CSV ---------- */
  function sectionCsv(prof, name) {
    var out = ['# 土量スキャナ 断面', '追加距離,比高H,X,Z'];
    prof.forEach(function (p) {
      out.push(p.s.toFixed(3) + ',' + (p.h === null ? '' : p.h.toFixed(4)) + ',' + p.x.toFixed(3) + ',' + p.z.toFixed(3));
    });
    download(new Blob(['﻿' + out.join('\r\n') + '\r\n'], { type: 'text/csv;charset=utf-8' }),
      (name || 'section') + '_' + stamp() + '.csv');
  }

  /* ---------- 結果の PNG（平面図＋数値）---------- */
  function png(mapCanvas, lines, title, name) {
    var pad = 16, lineH = 26, headH = 34 + lineH * lines.length + pad;
    var W = Math.max(mapCanvas.width, 720);
    var H = headH + mapCanvas.height + pad;
    var cv = document.createElement('canvas');
    cv.width = W; cv.height = H;
    var c = cv.getContext('2d');
    c.fillStyle = '#ffffff'; c.fillRect(0, 0, W, H);

    c.fillStyle = '#12395c'; c.fillRect(0, 0, W, 34);
    c.fillStyle = '#fff'; c.font = 'bold 18px system-ui,sans-serif';
    c.textAlign = 'left'; c.textBaseline = 'middle';
    c.fillText(title || '土量スキャナ 計測結果', pad, 17);

    c.fillStyle = '#14202b'; c.font = '15px system-ui,sans-serif';
    c.textBaseline = 'top';
    lines.forEach(function (t, i) { c.fillText(t, pad, 34 + pad / 2 + i * lineH); });

    c.drawImage(mapCanvas, (W - mapCanvas.width) / 2, headH);
    c.strokeStyle = '#c9d2da'; c.lineWidth = 1;
    c.strokeRect(0.5, 0.5, W - 1, H - 1);

    cv.toBlob(function (b) { download(b, (name || 'doryo') + '_' + stamp() + '.png'); }, 'image/png');
  }

  /* ---------- JSON（計算条件ごと残す）---------- */
  function json(rec, name) {
    var o = {
      app: '土量スキャナ (doryo-scan)',
      date: new Date().toISOString(),
      name: rec.name, memo: rec.memo,
      注意: '座標の原点はスキャン開始位置、Y は鉛直上向き。現場座標とは結び付いていません。',
      基準面: rec.plane,
      計算条件: rec.opts,
      結果: rec.summary,
      範囲: rec.poly,
      断面: rec.section,
      深度の種類: rec.depthInfo,
      スキャンの記録: rec.scanStats
    };
    download(new Blob([JSON.stringify(o, null, 2)], { type: 'application/json' }),
      (name || 'doryo') + '_' + stamp() + '.json');
  }

  global.Exporter = {
    download: download, stamp: stamp,
    ply: ply, cloudCsv: cloudCsv, gridCsv: gridCsv, sectionCsv: sectionCsv, png: png, json: json
  };
})(window);
