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

  /* ============================================================
     3Dモデル（メッシュ）の書き出し

     OBJ … どのソフトでも読める文字の形式。頂点色は "v x y z r g b" の
            並びで付ける（MeshLab / CloudCompare / Blender が読む書き方）
     STL … CAD・3Dプリンタ向け。色は持てないが取り回しが一番確実
     GLB … glTF 2.0 のバイナリ。Windows の「3D ビューアー」やブラウザで
            そのまま開け、頂点色も残る
     ============================================================ */

  function objMesh(m, name) {
    var P = m.positions, N = m.normals, C = m.colors, I = m.indices;
    var out = [];
    out.push('# 土量スキャナ / doryo-scan');
    out.push('# origin = scan start position, Y = up, unit = meter');
    out.push('# vertices ' + m.vertexCount + ' / triangles ' + m.triangleCount);
    out.push('o ' + (name || 'doryo'));
    var i;
    for (i = 0; i < P.length; i += 3) {
      out.push('v ' + P[i].toFixed(4) + ' ' + P[i+1].toFixed(4) + ' ' + P[i+2].toFixed(4)
             + ' ' + (C[i]/255).toFixed(3) + ' ' + (C[i+1]/255).toFixed(3) + ' ' + (C[i+2]/255).toFixed(3));
    }
    for (i = 0; i < N.length; i += 3) {
      out.push('vn ' + N[i].toFixed(4) + ' ' + N[i+1].toFixed(4) + ' ' + N[i+2].toFixed(4));
    }
    for (i = 0; i < I.length; i += 3) {
      var a = I[i]+1, b = I[i+1]+1, c = I[i+2]+1;
      out.push('f ' + a + '//' + a + ' ' + b + '//' + b + ' ' + c + '//' + c);
    }
    download(new Blob([out.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' }),
      (name || 'model') + '_' + stamp() + '.obj');
  }

  function stlMesh(m, name) {
    var P = m.positions, I = m.indices;
    var tri = m.triangleCount;
    var buf = new ArrayBuffer(84 + tri * 50);
    var dv = new DataView(buf);
    var head = 'doryo-scan binary STL  meters  Y-up';
    for (var h = 0; h < 80; h++) dv.setUint8(h, h < head.length ? head.charCodeAt(h) : 32);
    dv.setUint32(80, tri, true);
    var o = 84;
    for (var t = 0; t < I.length; t += 3) {
      var a = I[t]*3, b = I[t+1]*3, c = I[t+2]*3;
      var ux = P[b]-P[a], uy = P[b+1]-P[a+1], uz = P[b+2]-P[a+2];
      var vx = P[c]-P[a], vy = P[c+1]-P[a+1], vz = P[c+2]-P[a+2];
      var nx = uy*vz-uz*vy, ny = uz*vx-ux*vz, nz = ux*vy-uy*vx;
      var L = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
      dv.setFloat32(o, nx/L, true); dv.setFloat32(o+4, ny/L, true); dv.setFloat32(o+8, nz/L, true);
      dv.setFloat32(o+12, P[a],   true); dv.setFloat32(o+16, P[a+1], true); dv.setFloat32(o+20, P[a+2], true);
      dv.setFloat32(o+24, P[b],   true); dv.setFloat32(o+28, P[b+1], true); dv.setFloat32(o+32, P[b+2], true);
      dv.setFloat32(o+36, P[c],   true); dv.setFloat32(o+40, P[c+1], true); dv.setFloat32(o+44, P[c+2], true);
      dv.setUint16(o+48, 0, true);
      o += 50;
    }
    download(new Blob([buf], { type: 'model/stl' }), (name || 'model') + '_' + stamp() + '.stl');
  }

  function glbMesh(m, name) {
    var P = m.positions, N = m.normals, C = m.colors, I = m.indices;
    var nV = m.vertexCount;

    // 頂点色は 1成分1バイトの RGBA（正規化）。4バイト境界にもそろう
    var col = new Uint8Array(nV * 4);
    for (var i = 0, k = 0; i < nV; i++) {
      col[k++] = C[i*3]; col[k++] = C[i*3+1]; col[k++] = C[i*3+2]; col[k++] = 255;
    }

    var parts = [
      { name: 'idx', data: new Uint8Array(I.buffer, I.byteOffset, I.byteLength) },
      { name: 'pos', data: new Uint8Array(P.buffer, P.byteOffset, P.byteLength) },
      { name: 'nrm', data: new Uint8Array(N.buffer, N.byteOffset, N.byteLength) },
      { name: 'col', data: col }
    ];
    var off = 0, views = [];
    parts.forEach(function (p) {
      off = Math.ceil(off / 4) * 4;
      views.push({ byteOffset: off, byteLength: p.data.length });
      off += p.data.length;
    });
    var binLen = Math.ceil(off / 4) * 4;
    var bin = new Uint8Array(binLen);
    parts.forEach(function (p, j) { bin.set(p.data, views[j].byteOffset); });

    var b = m.bounds;
    var json = {
      asset: { version: '2.0', generator: '土量スキャナ (doryo-scan)' },
      scene: 0,
      scenes: [{ nodes: [0] }],
      nodes: [{ mesh: 0, name: name || 'doryo' }],
      meshes: [{ name: name || 'doryo', primitives: [{
        attributes: { POSITION: 1, NORMAL: 2, COLOR_0: 3 }, indices: 0, material: 0, mode: 4
      }] }],
      materials: [{
        name: 'vertexColor',
        pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0, roughnessFactor: 0.9 },
        doubleSided: true
      }],
      accessors: [
        { bufferView: 0, componentType: 5125, count: I.length, type: 'SCALAR' },
        { bufferView: 1, componentType: 5126, count: nV, type: 'VEC3',
          min: [b.x0, b.y0, b.z0], max: [b.x1, b.y1, b.z1] },
        { bufferView: 2, componentType: 5126, count: nV, type: 'VEC3' },
        { bufferView: 3, componentType: 5121, count: nV, type: 'VEC4', normalized: true }
      ],
      bufferViews: [
        { buffer: 0, byteOffset: views[0].byteOffset, byteLength: views[0].byteLength, target: 34963 },
        { buffer: 0, byteOffset: views[1].byteOffset, byteLength: views[1].byteLength, target: 34962 },
        { buffer: 0, byteOffset: views[2].byteOffset, byteLength: views[2].byteLength, target: 34962 },
        { buffer: 0, byteOffset: views[3].byteOffset, byteLength: views[3].byteLength, target: 34962 }
      ],
      buffers: [{ byteLength: binLen }]
    };

    var jsonBytes = new TextEncoder().encode(JSON.stringify(json));
    var jsonLen = Math.ceil(jsonBytes.length / 4) * 4;
    var jsonPad = new Uint8Array(jsonLen);
    jsonPad.fill(0x20);                       // JSON チャンクの詰めものは空白
    jsonPad.set(jsonBytes);

    var total = 12 + 8 + jsonLen + 8 + binLen;
    var out = new ArrayBuffer(total);
    var dv = new DataView(out), u8 = new Uint8Array(out);
    dv.setUint32(0, 0x46546C67, true);        // 'glTF'
    dv.setUint32(4, 2, true);
    dv.setUint32(8, total, true);
    dv.setUint32(12, jsonLen, true);
    dv.setUint32(16, 0x4E4F534A, true);       // 'JSON'
    u8.set(jsonPad, 20);
    dv.setUint32(20 + jsonLen, binLen, true);
    dv.setUint32(24 + jsonLen, 0x004E4942, true); // 'BIN'
    u8.set(bin, 28 + jsonLen);

    download(new Blob([out], { type: 'model/gltf-binary' }), (name || 'model') + '_' + stamp() + '.glb');
  }

  global.Exporter = {
    download: download, stamp: stamp,
    ply: ply, cloudCsv: cloudCsv, gridCsv: gridCsv, sectionCsv: sectionCsv, png: png, json: json,
    objMesh: objMesh, stlMesh: stlMesh, glbMesh: glbMesh
  };
})(window);
