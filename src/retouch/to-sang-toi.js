import sharp from 'sharp';
import { boxMean, sstep } from './lam-min.js';
import { luoiMat } from './luoi-mat.js';

/**
 * TÔ SÁNG / TỐI (dodge & burn) — tự động hoá cách retouch "neutral gray" của
 * thợ Photoshop: lớp xám 50 % chế độ Soft Light, cọ mềm 5–10 % tô trắng chỗ
 * tối, tô đen chỗ sáng, cho tới khi da đều. Thợ dựng thêm nhóm "quan sát" (đen
 * trắng + curve) chỉ để mắt người NHÌN ra chỗ loang; máy đo thẳng được.
 *
 * Chỉ đổi ĐỘ SÁNG (nhân cả ba kênh cùng một hệ số, như lớp xám Soft Light):
 * màu da giữ nguyên, lỗ chân lông / hạt da giữ nguyên — khác làm mịn
 * (lam-min.js) là làm phẳng chi tiết. Chạy sau nhặt mụn, trước làm mịn.
 *
 * Mỗi mặt có lưới 478 điểm (luoi-mat.js), tính ở ảnh nhỏ của vùng mặt (mặt rộng
 * ~FACE_W px), độ sáng theo log. Bốn phần, cộng lại thành một bản đồ "tô":
 *
 *   1. Làm đều da: dải tần TRUNG của độ sáng (vết loang, sần, bóng lốm đốm —
 *      lớn hơn lỗ chân lông, nhỏ hơn khối mặt) bị trừ bớt. Lọc Gauss có chuẩn
 *      hoá theo mặt nạ da, nên lông mày, tóc, mắt ngay cạnh không kéo da tối đi
 *      (không có quầng sáng ở mép).
 *   2. Quầng thâm mắt + rãnh mũi–miệng + rãnh khoé miệng: so với da QUANH nó
 *      (lấy trung bình da xung quanh, chừa chính vùng đó ra) và chỉ TÔ SÁNG phần
 *      tối hơn.
 *   3. Tạo khối (tuỳ chọn): tô sáng sống mũi, giữa trán, cằm, đỉnh gò má; tô
 *      tối hõm dưới gò má, thái dương, dọc đường hàm. Hợp với ảnh đèn flash /
 *      softbox chính diện vốn phẳng, ít khối.
 *
 * Một thanh "mức" 0–100 cho cả bước; tạo khối là công tắc riêng chạy theo cùng
 * mức đó.
 */

const FACE_W = 520; // bề ngang mặt (má tới má) ở ảnh nhỏ
const MIN_FACE_PX = 90; // mặt hẹp hơn thế (px ảnh gốc) thì bỏ qua

// Chỉ số điểm của lưới MediaPipe ("phải" = bên phải CỦA NGƯỜI trong ảnh = bên trái ảnh).
const OVAL = [10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109];
const EYE_R = [33, 7, 163, 144, 145, 153, 154, 155, 133, 173, 157, 158, 159, 160, 161, 246];
const EYE_L = [263, 249, 390, 373, 374, 380, 381, 382, 362, 398, 384, 385, 386, 387, 388, 466];
const BROW_R = [156, 70, 63, 105, 66, 107, 55, 193, 65, 52, 53, 46, 124, 35];
const BROW_L = [383, 300, 293, 334, 296, 336, 285, 417, 295, 282, 283, 276, 353, 265];
const LIPS = [61, 146, 91, 181, 84, 17, 314, 405, 321, 375, 291, 409, 270, 269, 267, 0, 37, 39, 40, 185];
// Vùng dưới mắt: từ vòng mi dưới thứ nhất tới vòng thứ ba (quầng thâm nằm giữa).
const UNDER_R = [130, 25, 110, 24, 23, 22, 26, 112, 243, 245, 128, 121, 120, 119, 118, 117, 111, 143];
const UNDER_L = [359, 255, 339, 254, 253, 252, 256, 341, 463, 465, 357, 350, 349, 348, 347, 346, 340, 372];
// Rãnh mũi–miệng: từ cánh mũi xuống ngoài khoé miệng.
const FOLD_R = [129, 203, 206, 216, 212];
const FOLD_L = [358, 423, 426, 436, 432];

/**
 * Tham số theo mức 0–100 (nội suy tuyến tính theo t = mức / 100):
 *   even    — bớt bao nhiêu phần dải tần trung (làm đều da)
 *   lift    — tô sáng bao nhiêu phần chỗ thiếu sáng ở quầng mắt / rãnh
 *   contour — biên độ tạo khối (đơn vị log độ sáng; 0,1 ≈ 10 %)
 *   cap     — trần cho mỗi điểm (log), để không bao giờ thành mảng loang mới
 */
export function thamSoToSang(muc) {
  const t = Math.min(100, Math.max(0, Number(muc) || 0)) / 100;
  return { even: 0.85 * t, lift: 0.9 * t, contour: 1.1 * t, cap: 0.12 + 0.28 * t };
}

const gaussR = (sigma) => Math.max(1, Math.round((-1 + Math.sqrt(1 + 4 * sigma * sigma)) / 2));

/** Làm mờ Gauss (ba lượt hộp) — `src` không đổi. */
function gauss(src, w, h, sigma, ws) {
  const r = gaussR(sigma);
  const a = boxMean(src, w, h, r, new Float32Array(w * h), ws.tmp, ws.acc);
  const b = boxMean(a, w, h, r, new Float32Array(w * h), ws.tmp, ws.acc);
  return boxMean(b, w, h, r, a, ws.tmp, ws.acc);
}

/** Gauss có chuẩn hoá theo mặt nạ: trung bình của `v` chỉ trên chỗ `m` > 0. */
function nconv(v, m, w, h, sigma, ws) {
  const n = w * h;
  const vm = new Float32Array(n);
  for (let i = 0; i < n; i++) vm[i] = v[i] * m[i];
  const a = gauss(vm, w, h, sigma, ws);
  const b = gauss(m, w, h, sigma, ws);
  for (let i = 0; i < n; i++) a[i] = b[i] > 1e-4 ? a[i] / b[i] : 0;
  return a;
}

/** Tô đa giác (chẵn–lẻ) lên lưới w×h, toạ độ tâm điểm ảnh. */
function fillPoly(pts, w, h, out = new Float32Array(w * h), val = 1) {
  const xs = [];
  for (let y = 0; y < h; y++) {
    const py = y + 0.5;
    xs.length = 0;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      const [x0, y0] = pts[j];
      const [x1, y1] = pts[i];
      if ((y0 <= py && y1 > py) || (y1 <= py && y0 > py)) xs.push(x0 + ((py - y0) / (y1 - y0)) * (x1 - x0));
    }
    xs.sort((a, b) => a - b);
    for (let k = 0; k + 1 < xs.length; k += 2) {
      const a = Math.max(0, Math.ceil(xs[k] - 0.5));
      const b = Math.min(w - 1, Math.floor(xs[k + 1] - 0.5));
      for (let x = a; x <= b; x++) out[y * w + x] = val;
    }
  }
  return out;
}

/** Phóng đa giác quanh trọng tâm của nó. */
function phong(pts, k) {
  const cx = pts.reduce((s, p) => s + p[0], 0) / pts.length;
  const cy = pts.reduce((s, p) => s + p[1], 0) / pts.length;
  return pts.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
}

/**
 * Cộng một "nét cọ" dọc đường gấp khúc `line` vào `acc`: Gauss theo khoảng cách
 * tới đường, bề rộng `sd`, biên độ `amp` (có thể đổi dần từ đầu tới cuối:
 * `amp` là [đầu, cuối]).
 */
function net(acc, w, h, line, sd, amp) {
  const [a0, a1] = Array.isArray(amp) ? amp : [amp, amp];
  const lens = [0];
  for (let i = 1; i < line.length; i++) lens.push(lens[i - 1] + Math.hypot(line[i][0] - line[i - 1][0], line[i][1] - line[i - 1][1]));
  const total = lens[lens.length - 1] || 1;
  const pad = 3 * sd;
  const x0 = Math.max(0, Math.floor(Math.min(...line.map((p) => p[0])) - pad));
  const x1 = Math.min(w - 1, Math.ceil(Math.max(...line.map((p) => p[0])) + pad));
  const y0 = Math.max(0, Math.floor(Math.min(...line.map((p) => p[1])) - pad));
  const y1 = Math.min(h - 1, Math.ceil(Math.max(...line.map((p) => p[1])) + pad));
  const k = -1 / (2 * sd * sd);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      let best = Infinity;
      let along = 0;
      for (let i = 1; i < line.length; i++) {
        const [px, py] = line[i - 1];
        const dx = line[i][0] - px;
        const dy = line[i][1] - py;
        const L2 = dx * dx + dy * dy || 1;
        const t = Math.max(0, Math.min(1, ((x - px) * dx + (y - py) * dy) / L2));
        const d2 = (x - px - t * dx) ** 2 + (y - py - t * dy) ** 2;
        if (d2 < best) {
          best = d2;
          along = (lens[i - 1] + t * Math.sqrt(L2)) / total;
        }
      }
      if (best > pad * pad) continue;
      acc[y * w + x] += (a0 + (a1 - a0) * along) * Math.exp(best * k);
    }
  }
}

const lerp = (p, q, t) => [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];

/**
 * Bản đồ tô (log độ sáng) cho một mặt ở ảnh nhỏ. `P`: 478 điểm theo toạ độ
 * ảnh nhỏ, `fw`: bề ngang mặt ở ảnh nhỏ. Trả `{ delta, skin }`.
 */
function banDoTo(R, G, B, w, h, P, fw, p, contour) {
  const n = w * h;
  const ws = { tmp: new Float32Array(n), acc: new Float64Array(w) };
  const pick = (ids) => ids.map((i) => P[i]);

  // ── Mặt nạ da: trong viền mặt, chừa mắt / lông mày / môi, đúng màu da của
  //    mặt này, không quá tối (lỗ mũi, lông mày, tóc rủ, râu).
  const oval = fillPoly(pick(OVAL), w, h);
  const excl = new Float32Array(n);
  fillPoly(phong(pick(EYE_R), 1.45), w, h, excl);
  fillPoly(phong(pick(EYE_L), 1.45), w, h, excl);
  fillPoly(phong(pick(BROW_R), 1.2), w, h, excl);
  fillPoly(phong(pick(BROW_L), 1.2), w, h, excl);
  fillPoly(phong(pick(LIPS), 1.08), w, h, excl);
  const Y = new Float32Array(n);
  const L = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    Y[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
    L[i] = Math.log(Y[i] + 4);
  }
  const samp = [];
  for (let i = 0; i < n; i++) if (oval[i] > 0 && excl[i] === 0) samp.push(i);
  if (samp.length < 200) return null;
  const med = (arr) => {
    const s = Float32Array.from(arr).sort();
    return s[s.length >> 1];
  };
  const step = Math.max(1, Math.floor(samp.length / 6000));
  const ss = samp.filter((_, k) => k % step === 0);
  const cr = ss.map((i) => R[i] / (R[i] + G[i] + B[i] + 1e-3));
  const cg = ss.map((i) => G[i] / (R[i] + G[i] + B[i] + 1e-3));
  const mr = med(cr);
  const mg = med(cg);
  const my = med(ss.map((i) => Y[i]));
  const sr = Math.max(0.008, 1.4826 * med(cr.map((x) => Math.abs(x - mr))));
  const sg = Math.max(0.006, 1.4826 * med(cg.map((x) => Math.abs(x - mg))));
  const hard = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (oval[i] === 0 || excl[i] > 0) continue;
    const s = R[i] + G[i] + B[i] + 1e-3;
    const d2 = ((R[i] / s - mr) / sr) ** 2 + ((G[i] / s - mg) / sg) ** 2;
    hard[i] = (1 - sstep(9, 25, d2)) * sstep(0.45 * my, 0.62 * my, Y[i]);
  }
  const skin = gauss(hard, w, h, 0.004 * fw, ws);

  // ── 1. Làm đều da: dải tần trung (σ 0,6 % → 4 % bề ngang mặt).
  const g1 = nconv(L, hard, w, h, 0.006 * fw, ws);
  const g2 = nconv(L, hard, w, h, 0.04 * fw, ws);
  // Hai thứ KHÔNG phải vết loang, phải chừa:
  //   - chênh lớn (> ~12 %) là khối thật: cạnh mũi, khoé miệng, hõm mắt;
  //   - dải sát viền mặt: bóng đổ ra quai hàm / thái dương tạo khối mặt — làm
  //     đều chỗ đó là mặt phẳng bẹt ra.
  const vien = gauss(oval, w, h, 0.035 * fw, ws);
  const delta = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const b = g1[i] - g2[i];
    delta[i] = -p.even * b * (1 - sstep(0.06, 0.16, Math.abs(b))) * sstep(0.55, 0.92, vien[i]);
  }

  // ── 2. Quầng mắt + rãnh: tô sáng phần tối hơn da quanh đó.
  const reg = new Float32Array(n);
  fillPoly(pick(UNDER_R), w, h, reg);
  fillPoly(pick(UNDER_L), w, h, reg);
  const fold = new Float32Array(n);
  const mc = [P[61], P[291]];
  const down = [(P[152][0] - P[168][0]) / 1, (P[152][1] - P[168][1]) / 1];
  const dl = Math.hypot(down[0], down[1]) || 1;
  const dn = [down[0] / dl, down[1] / dl];
  for (const [ids, c] of [[FOLD_R, mc[0]], [FOLD_L, mc[1]]]) {
    net(fold, w, h, pick(ids), 0.022 * fw, 1);
    // Rãnh khoé miệng: từ khoé miệng chéo xuống cằm một đoạn ngắn.
    const tip = [c[0] + dn[0] * 0.13 * fw, c[1] + dn[1] * 0.13 * fw];
    net(fold, w, h, [c, lerp(c, tip, 0.5), lerp(tip, P[152], 0.12)], 0.02 * fw, [0.3, 0.8]);
  }
  for (let i = 0; i < n; i++) reg[i] = Math.max(reg[i], Math.min(1, fold[i]));
  const regSoft = gauss(reg, w, h, 0.012 * fw, ws);
  const ref = new Float32Array(n);
  for (let i = 0; i < n; i++) ref[i] = hard[i] * (1 - Math.min(1, reg[i] * 1.5));
  const around = nconv(L, ref, w, h, 0.05 * fw, ws);
  const loc = nconv(L, hard, w, h, 0.008 * fw, ws);
  for (let i = 0; i < n; i++) {
    const r = regSoft[i];
    if (r < 0.002) continue;
    const lift = p.lift * Math.max(0, around[i] - loc[i]);
    if (lift > delta[i]) delta[i] += r * (lift - delta[i]);
  }

  // Trần mềm: tô nhẹ tay như cọ 5–10 %, không bao giờ thành vệt.
  for (let i = 0; i < n; i++) delta[i] = p.cap * Math.tanh(delta[i] / p.cap);

  // ── 3. Tạo khối.
  if (contour && p.contour > 0) {
    const c = new Float32Array(n);
    const a = p.contour;
    // Sáng: sống mũi, giữa trán, cằm, đỉnh gò má.
    net(c, w, h, pick([168, 6, 197, 195, 5]), 0.03 * fw, 0.07 * a);
    net(c, w, h, [lerp(P[9], P[151], 0.3), lerp(P[151], P[10], 0.4)], 0.08 * fw, 0.06 * a);
    net(c, w, h, [lerp(P[200], P[199], 0.5), lerp(P[199], P[175], 0.5)], 0.05 * fw, 0.05 * a);
    net(c, w, h, pick([117, 118]), 0.04 * fw, 0.045 * a);
    net(c, w, h, pick([346, 347]), 0.04 * fw, 0.045 * a);
    // Tối: hõm dưới gò má (từ tai chéo về phía khoé miệng, nhạt dần),
    // thái dương, dọc đường hàm (đậm ở hai bên, nhạt dần về cằm).
    net(c, w, h, [P[93], lerp(P[93], P[61], 0.3), lerp(P[93], P[61], 0.52)], 0.035 * fw, [-0.08 * a, -0.015 * a]);
    net(c, w, h, [P[323], lerp(P[323], P[291], 0.3), lerp(P[323], P[291], 0.52)], 0.035 * fw, [-0.08 * a, -0.015 * a]);
    net(c, w, h, pick([67, 54, 21, 162]), 0.045 * fw, -0.05 * a);
    net(c, w, h, pick([297, 284, 251, 389]), 0.045 * fw, -0.05 * a);
    net(c, w, h, pick([132, 58, 172, 136, 150, 149, 176]), 0.04 * fw, [-0.07 * a, -0.03 * a]);
    net(c, w, h, pick([361, 288, 397, 365, 379, 378, 400]), 0.04 * fw, [-0.07 * a, -0.03 * a]);
    const cs = gauss(skin, w, h, 0.012 * fw, ws);
    for (let i = 0; i < n; i++) delta[i] += c[i] * Math.min(1, cs[i] * 1.3);
  }

  for (let i = 0; i < n; i++) delta[i] *= skin[i];
  return { delta, skin };
}

/**
 * Tô sáng / tối mọi mặt trong `faces` trên `rgb` (Buffer RGB 8 bit, SỬA TẠI
 * CHỖ) với mức `muc` (0–100), `contour` = có tạo khối không. Trả số mặt đã làm.
 */
export async function toSangToi(rgb, width, height, faces, { muc = 50, contour = false, debug = null } = {}) {
  const p = thamSoToSang(muc);
  if (p.even <= 0 && p.lift <= 0) return 0;
  let done = 0;
  for (const f of faces) {
    const m = await luoiMat(rgb, width, height, f);
    if (!m) continue;
    const pts = m.pts;
    const fwImg = Math.hypot(pts[454][0] - pts[234][0], pts[454][1] - pts[234][1]);
    if (fwImg < MIN_FACE_PX) continue;

    // Vùng làm việc: khung bao viền mặt, nới 12 %.
    const ov = OVAL.map((i) => pts[i]);
    const xs = ov.map((q) => q[0]);
    const ys = ov.map((q) => q[1]);
    const pad = 0.12 * fwImg;
    const left = Math.max(0, Math.floor(Math.min(...xs) - pad));
    const top = Math.max(0, Math.floor(Math.min(...ys) - pad));
    const roi = {
      left,
      top,
      width: Math.min(width, Math.ceil(Math.max(...xs) + pad)) - left,
      height: Math.min(height, Math.ceil(Math.max(...ys) + pad)) - top,
    };
    if (roi.width < 32 || roi.height < 32) continue;
    const k = Math.min(1, FACE_W / fwImg);
    const sw = Math.max(16, Math.round(roi.width * k));
    const sh = Math.max(16, Math.round(roi.height * k));
    const kx = sw / roi.width;
    const ky = sh / roi.height;
    const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .extract(roi)
      .resize(sw, sh, { fit: 'fill', kernel: 'cubic' })
      .raw()
      .toBuffer();
    const n = sw * sh;
    const R = new Float32Array(n);
    const G = new Float32Array(n);
    const B = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      R[i] = small[i * 3];
      G[i] = small[i * 3 + 1];
      B[i] = small[i * 3 + 2];
    }
    const P = pts.map(([x, y]) => [(x - roi.left + 0.5) * kx - 0.5, (y - roi.top + 0.5) * ky - 0.5]);
    const bd = banDoTo(R, G, B, sw, sh, P, fwImg * k, p, contour);
    if (!bd) continue;
    if (debug) debug.push({ roi, sw, sh, delta: bd.delta, skin: bd.skin, P });
    apDung(rgb, width, roi, bd.delta, sw, sh, kx, ky);
    done++;
  }
  return done;
}

/** Phóng (song tuyến) bản đồ tô lên ảnh gốc và nhân độ sáng: điểm ảnh × e^delta. */
function apDung(rgb, width, roi, delta, sw, sh, kx, ky) {
  const cx0 = new Int32Array(roi.width);
  const cx1 = new Int32Array(roi.width);
  const ctx = new Float32Array(roi.width);
  for (let x = 0; x < roi.width; x++) {
    const fx = (x + 0.5) * kx - 0.5;
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
    cx0[x] = x0;
    cx1[x] = Math.min(sw - 1, x0 + 1);
    ctx[x] = Math.max(0, Math.min(1, fx - x0));
  }
  for (let y = 0; y < roi.height; y++) {
    const fy = (y + 0.5) * ky - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    const ty = Math.max(0, Math.min(1, fy - y0));
    const r0 = y0 * sw;
    const r1 = y1 * sw;
    const row = ((roi.top + y) * width + roi.left) * 3;
    for (let x = 0; x < roi.width; x++) {
      const tx = ctx[x];
      const d =
        (delta[r0 + cx0[x]] * (1 - tx) + delta[r0 + cx1[x]] * tx) * (1 - ty) +
        (delta[r1 + cx0[x]] * (1 - tx) + delta[r1 + cx1[x]] * tx) * ty;
      if (d > -0.002 && d < 0.002) continue;
      const g = Math.exp(d);
      const o = row + x * 3;
      for (let c = 0; c < 3; c++) {
        const v = rgb[o + c] * g + 0.5;
        rgb[o + c] = v >= 255 ? 255 : v | 0;
      }
    }
  }
}
