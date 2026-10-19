/* ============================================================
   view3d.js  作ったメッシュを指で回して確かめる小さなビューア

   ・1本指でドラッグ … 回転
   ・2本指 or ホイール … 拡大縮小
   ・2本指ドラッグ     … 平行移動
   陰影はカメラ位置からの平行光（ヘッドライト）＋環境光。
   頂点色をそのまま出すので、書き出した GLB と同じ見え方になる。
   ============================================================ */
(function (global) {
  'use strict';

  var VS = [
    'attribute vec3 aPos;',
    'attribute vec3 aNrm;',
    'attribute vec3 aCol;',
    'uniform mat4 uMVP;',
    'uniform mat4 uMV;',
    'uniform mat3 uNM;',
    'varying vec3 vN;',
    'varying vec3 vC;',
    'varying vec3 vP;',
    'void main(){',
    '  gl_Position = uMVP * vec4(aPos, 1.0);',
    '  vN = uNM * aNrm;',
    '  vC = aCol;',
    '  vP = (uMV * vec4(aPos, 1.0)).xyz;',
    '}'
  ].join('\n');

  var FS = [
    'precision mediump float;',
    'varying vec3 vN;',
    'varying vec3 vC;',
    'varying vec3 vP;',
    'uniform float uWire;',
    'void main(){',
    '  vec3 n = normalize(vN);',
    '  if(!gl_FrontFacing) n = -n;',          // 裏面も照らす（殻メッシュ対策）
    '  vec3 L = normalize(-vP);',             // カメラ位置からの光
    '  float d = max(dot(n, L), 0.0);',
    '  float rim = pow(1.0 - max(dot(n, L), 0.0), 2.0) * 0.18;',
    '  vec3 c = vC * (0.34 + 0.66 * d) + rim;',
    '  gl_FragColor = vec4(c, 1.0);',
    '}'
  ].join('\n');

  function sh(gl, t, src) {
    var s = gl.createShader(t);
    gl.shaderSource(s, src); gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
    return s;
  }

  /* --- 4x4 行列（列優先） --- */
  function perspective(out, fovy, aspect, near, far) {
    var f = 1 / Math.tan(fovy / 2);
    out.fill(0);
    out[0] = f / aspect; out[5] = f; out[11] = -1;
    out[10] = (far + near) / (near - far);
    out[14] = 2 * far * near / (near - far);
    return out;
  }
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

  function View3D(canvas) {
    this.cv = canvas;
    this.mesh = null;
    this.yaw = 0.7; this.pitch = 0.55; this.dist = 5; this.panX = 0; this.panY = 0;
    this.ok = false;
    try { this._init(); this.ok = true; }
    catch (e) { this.err = e.message; }
    this._bind();
  }

  View3D.prototype._init = function () {
    var gl = this.cv.getContext('webgl2') || this.cv.getContext('webgl') || this.cv.getContext('experimental-webgl');
    if (!gl) throw new Error('WebGL が使えません');
    this.gl = gl;
    this.isGL2 = !!(global.WebGL2RenderingContext && gl instanceof global.WebGL2RenderingContext);
    if (!this.isGL2) this.extUint = gl.getExtension('OES_element_index_uint');

    var p = gl.createProgram();
    gl.attachShader(p, sh(gl, gl.VERTEX_SHADER, VS));
    gl.attachShader(p, sh(gl, gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
    this.prog = p;
    this.loc = {
      aPos: gl.getAttribLocation(p, 'aPos'),
      aNrm: gl.getAttribLocation(p, 'aNrm'),
      aCol: gl.getAttribLocation(p, 'aCol'),
      uMVP: gl.getUniformLocation(p, 'uMVP'),
      uMV:  gl.getUniformLocation(p, 'uMV'),
      uNM:  gl.getUniformLocation(p, 'uNM')
    };
    this.bPos = gl.createBuffer();
    this.bNrm = gl.createBuffer();
    this.bCol = gl.createBuffer();
    this.bIdx = gl.createBuffer();
  };

  View3D.prototype.setMesh = function (m) {
    this.mesh = m;
    if (!this.ok || !m) { this.draw(); return; }
    var gl = this.gl;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.bufferData(gl.ARRAY_BUFFER, m.positions, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bNrm); gl.bufferData(gl.ARRAY_BUFFER, m.normals, gl.STATIC_DRAW);
    var col = new Float32Array(m.colors.length);
    for (var i = 0; i < col.length; i++) col[i] = m.colors[i] / 255;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCol); gl.bufferData(gl.ARRAY_BUFFER, col, gl.STATIC_DRAW);

    // 頂点が 65536 を超えると 16bit では足りない。32bit が使えるか確かめる
    this.idx32 = this.isGL2 || !!this.extUint;
    var I = this.idx32 ? m.indices : new Uint16Array(m.indices);
    this.idxType = this.idx32 ? gl.UNSIGNED_INT : gl.UNSIGNED_SHORT;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx); gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, I, gl.STATIC_DRAW);
    this.count = m.indices.length;
    this.fit();
    this.draw();
  };

  View3D.prototype.fit = function () {
    var m = this.mesh;
    if (!m || !m.bounds) return;
    var b = m.bounds;
    this.cx = (b.x0 + b.x1) / 2; this.cy = (b.y0 + b.y1) / 2; this.cz = (b.z0 + b.z1) / 2;
    this.radius = Math.max(0.2, Math.sqrt(b.w*b.w + b.h*b.h + b.d*b.d) / 2);
    this.dist = this.radius * 2.6;
    this.panX = 0; this.panY = 0;
    this.yaw = 0.7; this.pitch = 0.5;
  };

  View3D.prototype.draw = function () {
    var cv = this.cv;
    var dpr = global.devicePixelRatio || 1;
    var W = Math.max(1, Math.round(cv.clientWidth * dpr)), H = Math.max(1, Math.round(cv.clientHeight * dpr));
    if (cv.width !== W || cv.height !== H) { cv.width = W; cv.height = H; }
    if (!this.ok) return;
    var gl = this.gl;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0.933, 0.945, 0.957, 1);
    gl.enable(gl.DEPTH_TEST);
    gl.disable(gl.CULL_FACE);                 // 殻メッシュは裏も見せる
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    if (!this.mesh || !this.count) return;

    // カメラ（注視点まわりを回る）
    var cp = Math.cos(this.pitch), sp = Math.sin(this.pitch);
    var cyw = Math.cos(this.yaw), syw = Math.sin(this.yaw);
    var ex = this.dist * cp * syw, ey = this.dist * sp, ez = this.dist * cp * cyw;

    // 視線を -Z にそろえた視点行列を直接作る
    var zx = ex, zy = ey, zz = ez;
    var zl = Math.sqrt(zx*zx+zy*zy+zz*zz) || 1; zx/=zl; zy/=zl; zz/=zl;
    var xx = zz, xy = 0, xz = -zx;            // up=(0,1,0) との外積
    var xl = Math.sqrt(xx*xx+xz*xz) || 1; xx/=xl; xz/=xl;
    var yx = zy*xz - zz*xy, yy = zz*xx - zx*xz, yz = zx*xy - zy*xx;

    var tx = this.cx - (xx * this.panX + yx * this.panY);
    var ty = this.cy - (xy * this.panX + yy * this.panY);
    var tz = this.cz - (xz * this.panX + yz * this.panY);
    var px = tx + ex, py = ty + ey, pz = tz + ez;

    var MV = new Float32Array(16);
    MV[0]=xx; MV[4]=xy; MV[8] =xz;  MV[12]=-(xx*px + xy*py + xz*pz);
    MV[1]=yx; MV[5]=yy; MV[9] =yz;  MV[13]=-(yx*px + yy*py + yz*pz);
    MV[2]=zx; MV[6]=zy; MV[10]=zz;  MV[14]=-(zx*px + zy*py + zz*pz);
    MV[3]=0;  MV[7]=0;  MV[11]=0;   MV[15]=1;

    var Pm = perspective(new Float32Array(16), 0.9, W / H,
                         Math.max(0.01, this.radius * 0.02), this.radius * 40 + 50);
    var MVP = mul(new Float32Array(16), Pm, MV);
    var NM = new Float32Array([MV[0],MV[1],MV[2], MV[4],MV[5],MV[6], MV[8],MV[9],MV[10]]);

    gl.useProgram(this.prog);
    gl.uniformMatrix4fv(this.loc.uMVP, false, MVP);
    gl.uniformMatrix4fv(this.loc.uMV, false, MV);
    gl.uniformMatrix3fv(this.loc.uNM, false, NM);

    var L = this.loc;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bPos); gl.enableVertexAttribArray(L.aPos); gl.vertexAttribPointer(L.aPos, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bNrm); gl.enableVertexAttribArray(L.aNrm); gl.vertexAttribPointer(L.aNrm, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.bCol); gl.enableVertexAttribArray(L.aCol); gl.vertexAttribPointer(L.aCol, 3, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, this.bIdx);
    gl.drawElements(gl.TRIANGLES, this.count, this.idxType, 0);
  };

  /* --- 指の操作 --- */
  View3D.prototype._bind = function () {
    var self = this, pts = {}, last = null;
    function xy(e) {
      var r = self.cv.getBoundingClientRect();
      return { x: e.clientX - r.left, y: e.clientY - r.top };
    }
    function count() { return Object.keys(pts).length; }
    function dist(a, b) { return Math.sqrt((a.x-b.x)*(a.x-b.x) + (a.y-b.y)*(a.y-b.y)); }

    this.cv.addEventListener('pointerdown', function (e) {
      self.cv.setPointerCapture(e.pointerId);
      pts[e.pointerId] = xy(e);
      var k = Object.keys(pts);
      if (k.length === 2) last = { d: dist(pts[k[0]], pts[k[1]]), m: mid(pts[k[0]], pts[k[1]]) };
      e.preventDefault();
    });
    function mid(a, b) { return { x: (a.x+b.x)/2, y: (a.y+b.y)/2 }; }

    this.cv.addEventListener('pointermove', function (e) {
      if (!pts[e.pointerId]) return;
      var p = xy(e), prev = pts[e.pointerId];
      pts[e.pointerId] = p;
      var k = Object.keys(pts);
      if (k.length === 1) {
        self.yaw   -= (p.x - prev.x) * 0.01;
        self.pitch += (p.y - prev.y) * 0.01;
        self.pitch = Math.max(-1.5, Math.min(1.5, self.pitch));
      } else if (k.length === 2 && last) {
        var a = pts[k[0]], b = pts[k[1]];
        var d1 = dist(a, b), m1 = mid(a, b);
        if (last.d > 4) self.dist *= last.d / d1;
        self.dist = Math.max(self.radius * 0.15, Math.min(self.radius * 30, self.dist));
        var s = self.dist * 0.0022;
        self.panX -= (m1.x - last.m.x) * s;
        self.panY += (m1.y - last.m.y) * s;
        last = { d: d1, m: m1 };
      }
      self.draw();
      e.preventDefault();
    });

    function up(e) { delete pts[e.pointerId]; if (Object.keys(pts).length < 2) last = null; }
    this.cv.addEventListener('pointerup', up);
    this.cv.addEventListener('pointercancel', up);

    this.cv.addEventListener('wheel', function (e) {
      self.dist *= (e.deltaY < 0 ? 1 / 1.15 : 1.15);
      self.dist = Math.max(self.radius * 0.15, Math.min(self.radius * 30, self.dist));
      self.draw(); e.preventDefault();
    }, { passive: false });
  };

  global.View3D = View3D;
})(window);
