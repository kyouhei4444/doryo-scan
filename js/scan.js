/* ============================================================
   scan.js  WebXR でカメラの深度を取り、点群にして貯める

   流れ:
     1. immersive-ar のセッションを depth-sensing 付きで開く
     2. 毎フレーム frame.getDepthInformation(view) で深度画像をもらう
     3. 画面上の格子状の位置で深度を読み、視点座標→世界座標に逆投影する
     4. HGrid（高さ格子）と VCloud（表示用ボクセル点群）に入れる

   深度値の約束ごと（W3C Depth Sensing Module）:
     ・getDepthInMeters(u,v) の u,v は「ビューの正規化座標」。原点は左上、
       u は右へ、v は下へ 0→1。
     ・返る値は「カメラ平面からの距離」であって、視線に沿った長さではない。
       つまり視点座標の -z にそのまま入れてよい。
   ============================================================ */
(function (global) {
  'use strict';

  var G = global.Geom;
  var W3 = new Float64Array(3);        // 逆投影の作業用（毎点の確保を避ける）

  var VS = [
    'precision mediump float;',
    'attribute vec3 aPos;',
    'uniform mat4 uProj;',
    'uniform mat4 uView;',
    'uniform vec3 uPlane;',      // 基準面 a,b,c
    'uniform vec2 uRange;',      // x=しきい値, y=色を振る最大比高
    'uniform vec4 uFlat;',       // a>0 なら単色で描く
    'uniform float uSize;',
    'varying vec4 vCol;',
    'vec3 ramp(float t){',
    '  t = clamp(t, 0.0, 1.0);',
    '  if(t < 0.25) return mix(vec3(0.16,0.40,0.85), vec3(0.10,0.74,0.86), t/0.25);',
    '  if(t < 0.50) return mix(vec3(0.10,0.74,0.86), vec3(0.24,0.76,0.30), (t-0.25)/0.25);',
    '  if(t < 0.75) return mix(vec3(0.24,0.76,0.30), vec3(0.98,0.84,0.16), (t-0.50)/0.25);',
    '  return mix(vec3(0.98,0.84,0.16), vec3(0.92,0.20,0.14), (t-0.75)/0.25);',
    '}',
    'void main(){',
    '  vec4 v = uView * vec4(aPos, 1.0);',
    '  gl_Position = uProj * v;',
    '  float d = max(-v.z, 0.05);',
    '  gl_PointSize = clamp(uSize / d, 2.0, 18.0);',
    '  if(uFlat.a > 0.0){ vCol = uFlat; return; }',
    '  float rel = aPos.y - (uPlane.x*aPos.x + uPlane.y*aPos.z + uPlane.z);',
    '  float m = max(uRange.y, 0.2);',
    '  if(abs(rel) < uRange.x)      vCol = vec4(0.70,0.74,0.78,0.80);',
    '  else if(rel > 0.0)           vCol = vec4(ramp(rel/m), 0.95);',
    '  else                         vCol = vec4(mix(vec3(0.30,0.22,0.52), vec3(0.78,0.40,0.98), clamp(-rel/m,0.0,1.0)), 0.95);',
    '}'
  ].join('\n');

  var FS = [
    'precision mediump float;',
    'varying vec4 vCol;',
    'uniform float uRound;',
    'void main(){',
    '  if(uRound > 0.5){',
    '    vec2 p = gl_PointCoord - vec2(0.5);',
    '    if(dot(p,p) > 0.25) discard;',
    '  }',
    '  gl_FragColor = vCol;',
    '}'
  ].join('\n');

  function compile(gl, type, src) {
    var s = gl.createShader(type);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  /* ============================================================ */
  function Scanner() {
    this.session = null;
    this.grid = null;
    this.cloud = null;
    this.running = false;
    this.paused = false;
    this.tool = 'none';                 // none / ground / measure / bound
    this.groundPts = [];                // 手で拾った地面の点
    this.measurePts = [];               // 距離測定の 2 点
    this.boundPts = [];                 // 手で囲んだ範囲の頂点
    this.plane = null;                  // 表示用の暫定基準面
    this.stats = { pts: 0, cells: 0, frames: 0, valid: 0, tried: 0, fps: 0, elapsed: 0, cloud: 0, dropFast: 0 };
    this.on = {};                       // イベント: ready / tick / end / error / note
    this.cfg = {};
  }

  Scanner.prototype.emit = function (name, a, b) {
    var f = this.on[name];
    if (f) { try { f(a, b); } catch (e) { console.error(e); } }
  };

  /* ---------- 対応状況の判定 ---------- */
  Scanner.support = function () {
    return new Promise(function (res) {
      var r = {
        secure: (global.isSecureContext === true),
        webxr: !!(navigator.xr && navigator.xr.isSessionSupported),
        ar: false, depth: false, webgl: false, reason: ''
      };
      try {
        var c = document.createElement('canvas');
        r.webgl = !!(c.getContext('webgl') || c.getContext('experimental-webgl'));
      } catch (e) { r.webgl = false; }

      if (!r.secure) { r.reason = 'HTTPS のページではありません。カメラと WebXR は https:// でしか動きません。'; return res(r); }
      if (!r.webxr)  { r.reason = 'このブラウザは WebXR に対応していません。Android の Chrome で開いてください。'; return res(r); }

      // isSessionSupported が返ってこない環境があるので必ず打ち切る。
      // 返らなかったときは「分からない」扱いにして、開始だけはできるようにする
      var done = false;
      var timer = setTimeout(function () {
        if (done) return;
        done = true;
        r.timedOut = true;
        r.reason = 'AR に対応しているかの確認が時間内に終わりませんでした。'
                 + '端末の対応状況は、実際に開始してみないと分かりません。';
        res(r);
      }, 4000);

      navigator.xr.isSessionSupported('immersive-ar').then(function (ok) {
        if (done) return;
        done = true; clearTimeout(timer);
        r.ar = ok;
        if (!ok) {
          r.reason = 'この端末では AR セッションを開始できません。Google Play開発者サービス(AR) が入っているか、'
                   + '端末が ARCore 対応機種かを確認してください。';
        }
        res(r);
      }).catch(function (e) {
        if (done) return;
        done = true; clearTimeout(timer);
        r.reason = String(e && e.message || e);
        res(r);
      });
    });
  };

  /* ---------- 開始 ---------- */
  Scanner.prototype.start = function (opt) {
    var self = this;
    opt = opt || {};
    this.cfg = {
      cellSize:  opt.cellSize  || 0.05,
      voxel:     opt.voxel     || 0.03,
      cloudCap:  opt.cloudCap  || 300000,
      dMin:      opt.dMin      || 0.30,
      dMax:      opt.dMax      || 5.00,
      samples:   opt.samples   || 6000,
      rateHz:    opt.rateHz    || 10,
      edgeAbs:   opt.edgeAbs   === undefined ? 0.03 : opt.edgeAbs,
      edgeRel:   opt.edgeRel   === undefined ? 0.06 : opt.edgeRel,
      maxSpeed:  opt.maxSpeed  || 1.5,
      depthType: opt.depthType || 'smooth',
      overlay:   opt.overlay   || null
    };

    this.grid  = new global.HGrid(this.cfg.cellSize);
    this.cloud = new global.VCloud(this.cfg.voxel, this.cfg.cloudCap);
    this.disp  = new Float32Array(this.cfg.cloudCap * 3);
    this.dispN = 0;
    this.uploadedN = 0;
    this.groundPts = []; this.measurePts = []; this.boundPts = [];
    this.plane = null;
    this.stats = { pts: 0, cells: 0, frames: 0, valid: 0, tried: 0, fps: 0, elapsed: 0, cloud: 0, dropFast: 0 };

    var init = {
      requiredFeatures: ['depth-sensing'],
      optionalFeatures: ['hit-test', 'local-floor', 'anchors', 'light-estimation'],
      depthSensing: {
        // frame.getDepthInformation() は CPU 最適化の深度でないと例外になる。
        // GPU 版をもらっても読めないので、はじめから CPU 版だけを頼む。
        usagePreference: ['cpu-optimized'],
        dataFormatPreference: ['luminance-alpha', 'float32', 'unsigned-short'],
        depthTypeRequest: this.cfg.depthType === 'raw' ? ['raw', 'smooth'] : ['smooth', 'raw']
      }
    };
    if (this.cfg.overlay) {
      init.optionalFeatures.push('dom-overlay');
      init.domOverlay = { root: this.cfg.overlay };
    }

    return navigator.xr.requestSession('immersive-ar', init)
      .then(function (s) { return self._setup(s); })
      .catch(function (e) {
        var msg = String(e && e.message || e);
        if (/depth/i.test(msg) || /NotSupported/i.test(msg)) {
          msg = 'この端末では深度センシング（depth-sensing）が使えませんでした。\n'
              + 'ARCore の深度に対応していない機種か、Google Play開発者サービス(AR) が古い可能性があります。\n'
              + '（元のエラー: ' + msg + '）';
        }
        self.emit('error', msg);
        throw e;
      });
  };

  Scanner.prototype._setup = function (session) {
    var self = this;
    this.session = session;
    this.running = true;
    this.t0 = performance.now();

    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl', {
      xrCompatible: true, alpha: true, antialias: false, depth: true, preserveDrawingBuffer: false
    });
    if (!gl) { this.emit('error', 'WebGL を初期化できませんでした。'); session.end(); return; }
    this.gl = gl;

    var prog = gl.createProgram();
    gl.attachShader(prog, compile(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(prog, compile(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) {
      this.emit('error', '描画プログラムを作れませんでした: ' + gl.getProgramInfoLog(prog));
      session.end(); return;
    }
    this.prog = prog;
    this.loc = {
      aPos:  gl.getAttribLocation(prog, 'aPos'),
      uProj: gl.getUniformLocation(prog, 'uProj'),
      uView: gl.getUniformLocation(prog, 'uView'),
      uPlane:gl.getUniformLocation(prog, 'uPlane'),
      uRange:gl.getUniformLocation(prog, 'uRange'),
      uFlat: gl.getUniformLocation(prog, 'uFlat'),
      uSize: gl.getUniformLocation(prog, 'uSize'),
      uRound:gl.getUniformLocation(prog, 'uRound')
    };
    this.buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, this.cfg.cloudCap * 12, gl.DYNAMIC_DRAW);
    this.aux = gl.createBuffer();          // 目印・線を描くための小さいバッファ

    return Promise.resolve()
      .then(function () {
        var p = session.requestReferenceSpace('local-floor')
          .catch(function () { return session.requestReferenceSpace('local'); });
        return p;
      })
      .then(function (ref) {
        self.refSpace = ref;
        return session.requestReferenceSpace('viewer');
      })
      .then(function (viewerSpace) {
        self.viewerSpace = viewerSpace;
        if (session.requestHitTestSource) {
          return session.requestHitTestSource({ space: viewerSpace })
            .then(function (src) { self.hitSource = src; })
            .catch(function () { self.hitSource = null; });
        }
      })
      .then(function () {
        session.updateRenderState({ baseLayer: new XRWebGLLayer(session, gl) });

        session.addEventListener('end', function () {
          self.running = false;
          if (self.hitSource && self.hitSource.cancel) { try { self.hitSource.cancel(); } catch (e) {} }
          self.session = null;
          self.emit('end');
        });
        session.addEventListener('select', function () { self._onSelect(); });

        self.lastIngest = 0; self.lastPlane = 0; self.lastFps = performance.now(); self.fpsFrames = 0;
        self.prevCam = null; self.prevCamT = 0;

        // 実際にもらえた深度の種類を記録して知らせる（機種ごとの当たり外れの手がかり）
        self.depthInfo = {
          usage: session.depthUsage || '(不明)',
          format: session.depthDataFormat || '(不明)',
          type: session.depthActiveType || '(不明)'
        };
        if (session.depthUsage && session.depthUsage !== 'cpu-optimized') {
          self.emit('error', 'この端末からは GPU 用の深度（' + session.depthUsage + '）しか受け取れず、'
            + 'このアプリの計算方式では読み取れません。');
          session.end();
          return session;
        }
        self.emit('note', '深度: ' + self.depthInfo.type + ' / ' + self.depthInfo.format
          + '　ゆっくり動かして、まず地面を広めに映してください。', 5000);

        session.requestAnimationFrame(function (t, f) { self._frame(t, f); });
        self.emit('ready');
        return session;
      });
  };

  Scanner.prototype.end = function () { if (this.session) { try { this.session.end(); } catch (e) {} } };
  Scanner.prototype.pause = function (v) { this.paused = !!v; };

  /* ---------- タップ（画面のUI以外を触ったとき） ---------- */
  Scanner.prototype._onSelect = function () {
    if (!this.hit) { this.emit('note', '平面が見つかっていません。もう少し地面を映してからタップしてください。'); return; }
    var p = { x: this.hit[0], y: this.hit[1], z: this.hit[2] };
    if (this.tool === 'ground') {
      this.groundPts.push(p);
      this.emit('note', '地面の点を ' + this.groundPts.length + ' 点登録しました。3点以上で基準面が決まります。');
    } else if (this.tool === 'measure') {
      this.measurePts.push(p);
      if (this.measurePts.length > 2) this.measurePts = [p];
      if (this.measurePts.length === 2) {
        var a = this.measurePts[0], b = this.measurePts[1];
        var d = Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y) + (a.z-b.z)*(a.z-b.z));
        var dh = Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.z-b.z)*(a.z-b.z));
        this.emit('note', '距離 ' + d.toFixed(3) + ' m（水平 ' + dh.toFixed(3) + ' m / 高低差 ' + (b.y-a.y).toFixed(3) + ' m）');
        this.emit('measure', { dist: d, horiz: dh, dz: b.y - a.y });
      } else {
        this.emit('note', '1 点目を置きました。もう 1 点タップしてください。');
      }
    } else if (this.tool === 'bound') {
      this.boundPts.push(p);
      this.emit('note', '範囲の頂点を ' + this.boundPts.length + ' 点置きました。');
    }
    this.emit('tick', this.stats);
  };

  Scanner.prototype.undo = function () {
    if (this.tool === 'ground') this.groundPts.pop();
    else if (this.tool === 'measure') this.measurePts.pop();
    else if (this.tool === 'bound') this.boundPts.pop();
  };

  /* ---------- 毎フレーム ---------- */
  Scanner.prototype._frame = function (time, frame) {
    var self = this, session = this.session;
    if (!session) return;
    session.requestAnimationFrame(function (t, f) { self._frame(t, f); });

    var pose = frame.getViewerPose(this.refSpace);
    var gl = this.gl;
    var layer = session.renderState.baseLayer;
    gl.bindFramebuffer(gl.FRAMEBUFFER, layer.framebuffer);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!pose) return;

    this.stats.frames++;
    this.fpsFrames++;

    // スキャンを始めたときにカメラが向いていた方位（平面図の向きの手がかり）
    if (!this.startDir) {
      var pm = pose.transform.matrix;              // 端末→世界。第3列の逆向きが正面
      var fx = -pm[8], fz = -pm[10];
      var fl = Math.sqrt(fx*fx + fz*fz);
      if (fl > 0.2) this.startDir = { x: fx / fl, z: fz / fl };
    }
    var now = performance.now();
    if (now - this.lastFps > 500) {
      this.stats.fps = this.fpsFrames * 1000 / (now - this.lastFps);
      this.lastFps = now; this.fpsFrames = 0;
    }
    this.stats.elapsed = (now - this.t0) / 1000;

    // 端末の移動速度。速く振っているときのフレームはブレるので捨てる
    var cam = pose.transform.position;
    var speed = 0;
    if (this.prevCam) {
      var dt = (now - this.prevCamT) / 1000;
      if (dt > 0.001) {
        speed = Math.sqrt(Math.pow(cam.x-this.prevCam.x,2) + Math.pow(cam.y-this.prevCam.y,2) +
                          Math.pow(cam.z-this.prevCam.z,2)) / dt;
      }
    }
    this.prevCam = { x: cam.x, y: cam.y, z: cam.z }; this.prevCamT = now;
    this.stats.speed = speed;

    // ヒットテスト（タップの照準）
    this.hit = null;
    if (this.hitSource && frame.getHitTestResults) {
      var hr = frame.getHitTestResults(this.hitSource);
      if (hr && hr.length) {
        var hp = hr[0].getPose(this.refSpace);
        if (hp) this.hit = [hp.transform.position.x, hp.transform.position.y, hp.transform.position.z];
      }
    }

    var doIngest = this.running && !this.paused &&
                   (now - this.lastIngest) >= (1000 / this.cfg.rateHz) &&
                   !pose.emulatedPosition;
    if (doIngest && speed > this.cfg.maxSpeed) { this.stats.dropFast++; doIngest = false; }

    for (var i = 0; i < pose.views.length; i++) {
      var view = pose.views[i];
      var vp = layer.getViewport(view);
      if (!vp) continue;
      if (doIngest && i === 0) {
        var di = null;
        try { di = frame.getDepthInformation(view); } catch (e) { di = null; }
        if (di) { this._ingest(di, view, vp); this.lastIngest = now; }
        else if (!this._warnedNoDepth && this.stats.frames > 60) {
          this._warnedNoDepth = true;
          this.emit('note', '深度が返ってきません。明るい場所で、模様のある面をゆっくり映してください。');
        }
      }
      gl.viewport(vp.x, vp.y, vp.width, vp.height);
      this._draw(view);
    }

    // 表示用の暫定基準面を 2 秒おきに更新
    if (now - this.lastPlane > 2000 && this.grid.n > 200) {
      this.lastPlane = now;
      var pl = G.ransacPlane(this.grid.toPoints(2, 4000), { thr: 0.05, iter: 120, maxTilt: 30 });
      if (pl) this.plane = pl;
    }

    this.stats.cells = this.grid.n;
    this.stats.cloud = this.cloud.n;
    this.emit('tick', this.stats);
  };

  /* ---------- 深度を点にする ---------- */
  Scanner.prototype._ingest = function (di, view, vp) {
    var cfg = this.cfg;
    var up = G.unprojParams(view.projectionMatrix);
    var M = view.transform.matrix;             // 視点座標 → 世界座標（剛体変換なので w 除算は不要）

    var aspect = (vp.width && vp.height) ? (vp.width / vp.height) : 0.75;
    var sh = Math.max(16, Math.round(Math.sqrt(cfg.samples / aspect)));
    var sw = Math.max(16, Math.round(sh * aspect));
    if (!this.dbuf || this.dbuf.length < sw * sh) this.dbuf = new Float32Array(sw * sh);
    var db = this.dbuf, i, j, k, d;

    // --- 1回目: 深度をまとめて読む ---
    var got = 0;
    for (j = 0; j < sh; j++) {
      var v = (j + 0.5) / sh;
      for (i = 0; i < sw; i++) {
        var u = (i + 0.5) / sw;
        d = 0;
        try { d = di.getDepthInMeters(u, v); } catch (e) { d = 0; }
        if (!(d > cfg.dMin && d < cfg.dMax)) d = 0; else got++;
        db[j * sw + i] = d;
      }
    }
    this.stats.tried += sw * sh;
    this.stats.valid += got;
    if (!got) return;

    // --- 2回目: 縁の飛び値を落として世界座標へ ---
    var eA = cfg.edgeAbs, eR = cfg.edgeRel;
    var grid = this.grid, cloud = this.cloud, disp = this.disp;
    var added = 0;
    for (j = 0; j < sh; j++) {
      for (i = 0; i < sw; i++) {
        k = j * sw + i;
        d = db[k];
        if (!d) continue;
        // 隣と深度が大きく飛んでいたら物の縁。奥と手前が混ざった偽の点になるので捨てる
        var lim = eA + eR * d;
        if (i + 1 < sw) { var dr = db[k+1];  if (dr && Math.abs(dr - d) > lim) continue; }
        if (j + 1 < sh) { var dd = db[k+sw]; if (dd && Math.abs(dd - d) > lim) continue; }

        var u = (i + 0.5) / sw, vv = (j + 0.5) / sh;
        var wx, wy, wz;
        if (up.ok) {
          G.unproject(W3, up, M, u, vv, d);
          wx = W3[0]; wy = W3[1]; wz = W3[2];
        } else {
          // 想定外の形の投影行列。逆行列で視線を求める遅い経路
          if (!this._invProj) this._invProj = new Float64Array(16);
          if (!this._tmp3) this._tmp3 = new Float64Array(3);
          G.invert(this._invProj, view.projectionMatrix);
          G.xform(this._tmp3, this._invProj, 2*u - 1, 1 - 2*vv, 0);
          var sc = d / Math.max(1e-6, -this._tmp3[2]);
          var px = this._tmp3[0] * sc, py = this._tmp3[1] * sc, pz = -d;
          wx = M[0]*px + M[4]*py + M[8] *pz + M[12];
          wy = M[1]*px + M[5]*py + M[9] *pz + M[13];
          wz = M[2]*px + M[6]*py + M[10]*pz + M[14];
        }

        grid.add(wx, wy, wz);
        var n0 = cloud.n;
        cloud.add(wx, wy, wz);
        if (cloud.n > n0 && this.dispN + 3 <= disp.length) {
          disp[this.dispN++] = wx; disp[this.dispN++] = wy; disp[this.dispN++] = wz;
        }
        added++;
      }
    }
    this.stats.pts += added;
  };

  /* ---------- 描画 ---------- */
  Scanner.prototype._draw = function (view) {
    var gl = this.gl, L = this.loc;
    gl.useProgram(this.prog);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    gl.uniformMatrix4fv(L.uProj, false, view.projectionMatrix);
    gl.uniformMatrix4fv(L.uView, false, view.transform.inverse.matrix);
    var pl = this.plane || { a: 0, b: 0, c: -1e9 };
    gl.uniform3f(L.uPlane, pl.a, pl.b, pl.c);
    gl.uniform2f(L.uRange, 0.05, 1.5);
    gl.uniform1f(L.uSize, 55);
    gl.uniform1f(L.uRound, 1);
    gl.enableVertexAttribArray(L.aPos);

    // --- 点群 ---
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    if (this.dispN > this.uploadedN) {
      var sub = this.disp.subarray(this.uploadedN, this.dispN);
      gl.bufferSubData(gl.ARRAY_BUFFER, this.uploadedN * 4, sub);
      this.uploadedN = this.dispN;
    }
    gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.uniform4f(L.uFlat, 0, 0, 0, 0);
    if (this.uploadedN >= 3) gl.drawArrays(gl.POINTS, 0, (this.uploadedN / 3) | 0);

    // --- 目印と線 ---
    var self = this;
    function put(arr, mode, r, g, b, size) {
      if (!arr.length) return;
      gl.bindBuffer(gl.ARRAY_BUFFER, self.aux);
      gl.bufferData(gl.ARRAY_BUFFER, new Float32Array(arr), gl.STREAM_DRAW);
      gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
      gl.uniform4f(L.uFlat, r, g, b, 1);
      gl.uniform1f(L.uSize, size);
      gl.uniform1f(L.uRound, mode === gl.POINTS ? 1 : 0);
      gl.drawArrays(mode, 0, arr.length / 3);
    }
    function flat(pts) {
      var a = [];
      for (var i = 0; i < pts.length; i++) { a.push(pts[i].x, pts[i].y, pts[i].z); }
      return a;
    }

    gl.disable(gl.DEPTH_TEST);
    if (this.groundPts.length)  put(flat(this.groundPts),  gl.POINTS, 0.15, 0.95, 0.45, 220);
    if (this.boundPts.length) {
      put(flat(this.boundPts), gl.POINTS, 1.0, 0.55, 0.05, 220);
      if (this.boundPts.length > 1) put(flat(this.boundPts.concat([this.boundPts[0]])), gl.LINE_STRIP, 1.0, 0.55, 0.05, 1);
    }
    if (this.measurePts.length) {
      put(flat(this.measurePts), gl.POINTS, 1.0, 0.25, 0.25, 220);
      if (this.measurePts.length === 2) put(flat(this.measurePts), gl.LINE_STRIP, 1.0, 0.25, 0.25, 1);
    }
    if (this.hit && this.tool !== 'none') {
      put([this.hit[0], this.hit[1], this.hit[2]], gl.POINTS, 1, 1, 1, 320);
    }
    gl.enable(gl.DEPTH_TEST);
    gl.uniform1f(L.uSize, 55);
  };

  /* 手で拾った地面の点から基準面を作る */
  Scanner.prototype.manualPlane = function () {
    if (this.groundPts.length < 3) return null;
    return G.fitPlane(this.groundPts.map(function (p) { return { x: p.x, y: p.y, z: p.z }; }));
  };

  // シェーダは実機の AR でしか動かない部分なので、
  // せめてコンパイルが通るかを test/render.html から確かめられるように出しておく
  Scanner.SHADERS = { VS: VS, FS: FS, compile: compile };

  global.Scanner = Scanner;
})(window);
