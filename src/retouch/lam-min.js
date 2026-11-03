import sharp from 'sharp';

/**
 * LÀM MỊN DA trên từng khuôn mặt — thay cho Retouch của Capture One (tiệm 1510,
 * 11/2026: Retouch của Capture One lúc ăn lúc không vào file tự xuất, và phải
 * đợi nó nhận diện mặt xong mới xuất được).
 *
 * Chỉ đụng vào DA MẶT. Ảnh của tiệm có phông hoa hồng cùng tông với da, nên
 * lọc theo màu da trên cả ảnh là làm nhoè phông; ở đây mỗi mặt (khuon-mat.js)
 * cho một vùng riêng, và trong vùng đó mặt nạ là:
 *
 *   elip mặt (xoay theo trục mắt–miệng, trán dài hơn cằm)
 *   × màu da CỦA CHÍNH MẶT ĐÓ (mẫu lấy ở má và mũi, đo bằng sắc độ r,g — ít
 *     phụ thuộc sáng tối, nên má trong bóng vẫn là da, còn tóc nhuộm đỏ, nơ,
 *     bàn tay khác màu, phông hồng thì không)
 *   × không quá tối (lông mày, mi, lỗ mũi, tóc đen)
 *   × chừa mắt, miệng, và chừa một phần lông mày theo 5 điểm mốc.
 *
 * Làm mịn theo kiểu TÁCH TẦN SỐ, tính ở ảnh thu nhỏ của vùng mặt (mặt còn
 * `faceW` px — tấm 26MP có mặt rộng ~1000 px thì thu ~3 lần):
 *
 *   S  = vùng mặt thu nhỏ   (mất dải tần mịn nhất: hạt, lỗ chân lông nhỏ)
 *   Q  = guided filter(S)   (xoá vết, lỗ chân lông lớn, loang màu; giữ cạnh
 *                            mắt, mũi, môi vì ở đó phương sai lớn hơn eps)
 *   ảnh mới = gốc + α·m·(Q − S)↑ − β·m·(gốc − S↑)
 *
 * Số hạng đầu là phần mịn chính; dải tần mịn nhất của ảnh gốc vẫn được giữ
 * (bớt đi β), nên da không bị bóng như sáp. Cả việc nặng chạy ở ảnh nhỏ; ảnh
 * gốc chỉ bị đọc / ghi đúng các pixel có mặt nạ.
 */

/**
 * Thang ĐỘ MỊN 0–100 (nhân viên chọn). Mỗi điểm neo là một bộ tham số đã thử
 * trên ảnh thật của tiệm; giữa hai điểm neo thì nội suy tuyến tính.
 *   alpha  — bao nhiêu phần của phần mịn chính được áp
 *   beta   — bớt bao nhiêu dải tần mịn nhất (hạt, lỗ chân lông nhỏ)
 *   faceW  — mặt còn bao nhiêu px ở ảnh nhỏ: lớn hơn = xoá được chi tiết nhỏ hơn
 *   radius — bán kính guided filter, theo khoảng cách hai mắt
 *   sigmaE — dưới độ tương phản này là "da" để làm phẳng, trên là cạnh để giữ
 */
const NEO = [
  { at: 0, alpha: 0, beta: 0, faceW: 260, radius: 0.045, sigmaE: 0.025 },
  { at: 30, alpha: 0.6, beta: 0.1, faceW: 300, radius: 0.05, sigmaE: 0.03 },
  { at: 60, alpha: 0.8, beta: 0.2, faceW: 340, radius: 0.06, sigmaE: 0.04 },
  { at: 90, alpha: 1, beta: 0.4, faceW: 420, radius: 0.075, sigmaE: 0.05 },
  { at: 100, alpha: 1, beta: 0.5, faceW: 460, radius: 0.085, sigmaE: 0.055 },
];

/** Ba mức có tên trên bảng nhân viên — chỉ là ba điểm trên thang độ mịn. */
export const MUC = {
  nhe: { ten: 'Nhẹ', doMin: 30 },
  vua: { ten: 'Vừa', doMin: 60 },
  manh: { ten: 'Mạnh', doMin: 90 },
};

/** Tham số làm mịn cho một độ mịn 0–100. */
export function thamSo(doMin) {
  const s = Math.min(100, Math.max(0, Number(doMin) || 0));
  let i = 0;
  while (i < NEO.length - 2 && s > NEO[i + 1].at) i++;
  const a = NEO[i];
  const b = NEO[i + 1];
  const t = (s - a.at) / (b.at - a.at);
  const p = {};
  for (const k of ['alpha', 'beta', 'faceW', 'radius', 'sigmaE']) p[k] = a[k] + (b[k] - a[k]) * t;
  return p;
}

/** Mặt nhỏ hơn thế này (khoảng cách hai mắt, px ảnh gốc) thì bỏ qua: người ở xa, ảnh trong ảnh. */
const MIN_EYE_PX = 40;

export const sstep = (a, b, x) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
const dist = (p, q) => Math.hypot(p[0] - q[0], p[1] - q[1]);

/**
 * Hình học của một mặt (toạ độ ảnh gốc). Điểm mốc vô lý so với khung — mặt bị
 * che một nửa, YuNet đoán miệng sai — thì dựng lại từ khung, mặt coi như thẳng.
 */
function geometry(f) {
  const [e0, e1, , m0, m1] = f.lm;
  let E = mid(e0, e1);
  let M = mid(m0, m1);
  let ed = dist(e0, e1);
  let em = dist(E, M);
  let eyes = [e0, e1];
  let mouthW = dist(m0, m1);
  let nose = f.lm[2];
  const ok = ed > 0.25 * f.w && ed < 0.7 * f.w && em > 0.18 * f.h && em < 0.6 * f.h;
  if (!ok) {
    E = [f.x + f.w / 2, f.y + 0.38 * f.h];
    M = [f.x + f.w / 2, f.y + 0.75 * f.h];
    ed = 0.42 * f.w;
    em = 0.37 * f.h;
    eyes = [[E[0] - ed / 2, E[1]], [E[0] + ed / 2, E[1]]];
    mouthW = 0.6 * ed;
    nose = [E[0] + (M[0] - E[0]) * 0.6, E[1] + (M[1] - E[1]) * 0.6];
  }
  const u = [(E[0] - M[0]) / em, (E[1] - M[1]) / em]; // hướng lên trán
  const v = [-u[1], u[0]];
  const C = [E[0] + (M[0] - E[0]) * 0.45, E[1] + (M[1] - E[1]) * 0.45];
  // Mặt QUAY nghiêng (ba phần tư): hai mắt co lại gần nhau, elip theo khoảng
  // cách mắt vừa hẹp vừa lệch về phía mũi — má gần máy ảnh (thường là chỗ có
  // mụn) nằm ngoài cả vùng làm mịn lẫn vùng nhặt mụn (thử 02/11, khoảng cách mắt
  // còn 0,28 bề ngang khung; mặt thẳng ~0,42). Khi đó: cỡ mọi thứ (elip, vùng
  // chừa, cỡ mụn) lấy sàn 0,38 bề ngang khung, và gộp thêm elip theo khung YuNet.
  const quay = ok && ed < 0.36 * f.w;
  if (quay) ed = 0.38 * f.w;
  const box = { cx: f.x + f.w / 2, cy: f.y + f.h / 2, a: 0.55 * f.w, b: 0.6 * f.h };
  // ok = false: điểm mốc vô lý, hình học dựng từ khung — vùng chừa chỉ là ước chừng.
  return { E, M, ed, em, u, v, C, eyes, mouthW, nose, ok, quay, box };
}

/** Hình chữ nhật (ảnh gốc) bao elip mặt đã xoay (nới `rong` lần), kể cả viền mờ. */
function roiOf(g, width, height, rong = 1) {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (let k = 0; k < 48; k++) {
    const t = (k / 48) * 2 * Math.PI;
    const dx = Math.cos(t) * 1.1 * g.ed * 1.06 * rong;
    const dy = Math.sin(t) * (Math.sin(t) > 0 ? 1.75 : 1.3) * g.em * 1.06 * rong;
    const pts = [[g.C[0] + dx * g.v[0] + dy * g.u[0], g.C[1] + dx * g.v[1] + dy * g.u[1]]];
    if (g.quay) {
      pts.push([g.box.cx + Math.cos(t) * g.box.a * 1.06 * rong, g.box.cy + Math.sin(t) * g.box.b * 1.06 * rong]);
    }
    for (const [x, y] of pts) {
      x0 = Math.min(x0, x);
      y0 = Math.min(y0, y);
      x1 = Math.max(x1, x);
      y1 = Math.max(y1, y);
    }
  }
  const left = Math.max(0, Math.floor(x0));
  const top = Math.max(0, Math.floor(y0));
  return {
    left,
    top,
    width: Math.min(width, Math.ceil(x1)) - left,
    height: Math.min(height, Math.ceil(y1)) - top,
  };
}

/**
 * Trung bình hộp bán kính r, chia theo số pixel THẬT trong hộp ở mép (như bản
 * gốc của guided filter). Tổng chạy theo hàng rồi cộng dồn theo hàng — đi tuần
 * tự trong bộ nhớ, không có phép kẹp chỉ số trong vòng trong.
 */
export function boxMean(src, w, h, r, out, tmp, acc) {
  for (let y = 0; y < h; y++) {
    const o = y * w;
    let s = 0;
    for (let x = 0; x <= Math.min(r, w - 1); x++) s += src[o + x];
    for (let x = 0; x < w; x++) {
      tmp[o + x] = s;
      if (x + r + 1 < w) s += src[o + x + r + 1];
      if (x - r >= 0) s -= src[o + x - r];
    }
  }
  acc.fill(0);
  for (let y = 0; y <= Math.min(r, h - 1); y++) for (let x = 0, o = y * w; x < w; x++) acc[x] += tmp[o + x];
  // 1 / số pixel trong hộp theo chiều ngang: như nhau ở mọi hàng, tính một lần.
  const inx = new Float64Array(w);
  for (let x = 0; x < w; x++) inx[x] = 1 / (Math.min(w - 1, x + r) - Math.max(0, x - r) + 1);
  for (let y = 0; y < h; y++) {
    const iny = 1 / (Math.min(h - 1, y + r) - Math.max(0, y - r) + 1);
    const o = y * w;
    for (let x = 0; x < w; x++) out[o + x] = acc[x] * inx[x] * iny;
    if (y + r + 1 < h) for (let x = 0, a = (y + r + 1) * w; x < w; x++) acc[x] += tmp[a + x];
    if (y - r >= 0) for (let x = 0, a = (y - r) * w; x < w; x++) acc[x] -= tmp[a + x];
  }
  return out;
}

/** Guided filter (He, Sun, Tang 2010) dẫn bằng độ sáng I, lọc từng kênh trong `ps`. */
function guided(I, ps, w, h, r, eps) {
  const n = w * h;
  const tmp = new Float32Array(n);
  const acc = new Float64Array(w);
  const box = (src) => boxMean(src, w, h, r, new Float32Array(n), tmp, acc);
  const mI = box(I);
  const sq = new Float32Array(n);
  for (let i = 0; i < n; i++) sq[i] = I[i] * I[i];
  const varI = box(sq);
  for (let i = 0; i < n; i++) varI[i] -= mI[i] * mI[i];
  const a = new Float32Array(n);
  const b = new Float32Array(n);
  return ps.map((p) => {
    const mp = box(p);
    for (let i = 0; i < n; i++) sq[i] = I[i] * p[i];
    const mIp = box(sq);
    for (let i = 0; i < n; i++) {
      a[i] = (mIp[i] - mI[i] * mp[i]) / (varI[i] + eps);
      b[i] = mp[i] - a[i] * mI[i];
    }
    const ma = box(a);
    const mb = box(b);
    for (let i = 0; i < n; i++) ma[i] = ma[i] * I[i] + mb[i];
    return ma;
  });
}

const median = (arr) => {
  const s = Float32Array.from(arr).sort();
  return s[s.length >> 1];
};

/**
 * Mặt nạ da trên ảnh nhỏ của vùng mặt. `g`: hình học đã đổi sang toạ độ ảnh
 * nhỏ. Trả về `{ mask, geo, mau }` (0…1):
 *   mask — mặt nạ để làm mịn: đã lấp lỗ nhỏ và làm mềm viền
 *   geo  — chỉ phần hình học: elip mặt × chừa mắt / lông mày / miệng
 *   mau  — geo × đúng màu da × không quá tối, CHƯA lấp lỗ: mụn đỏ / thâm ở đây
 *          thấp hơn da quanh nó
 * null = không lấy được mẫu da (mặt bị che gần hết).
 */
function skinMask(R, G, B, Y, w, h, g, rong = 1) {
  const n = w * h;
  const { ed, em, C, eyes, M, mouthW } = g;
  const [ux, uy] = g.u;
  const [vx, vy] = g.v;
  const fA = 1 / (1.1 * ed * rong);
  const fUp = 1 / (1.75 * em * rong);
  const fDown = 1 / (1.3 * em * rong);
  const eyeA = 1 / (0.3 * ed);
  const eyeB = 1 / (0.16 * ed);
  // Lông mày rộng hơn mắt và chạy vào gần giữa trán hơn: elip lệch vào trong.
  const browA = 1 / (0.44 * ed);
  const browB = 1 / (0.12 * ed);
  const browUp = 0.33 * ed;
  const browIn = 0.07 * ed;
  // Mỗi mắt nằm phía nào của trục mặt (+1 / −1 theo hướng v).
  const phia = eyes.map((e) => Math.sign((e[0] - (eyes[0][0] + eyes[1][0]) / 2) * vx + (e[1] - (eyes[0][1] + eyes[1][1]) / 2) * vy) || 1);
  const mouthA = 1 / Math.max(0.56 * mouthW, 0.3 * ed);
  const mouthB = 1 / (0.15 * ed);
  const mouthDown = 0.03 * ed;
  const sampA = 1 / (0.75 * ed);
  const sampB = 1 / (0.55 * em);
  // Mặt quay: thêm elip theo khung YuNet (toạ độ ảnh nhỏ), xem geometry().
  const box = g.quay ? g.box : null;
  const fBx = box ? 1 / (box.a * rong) : 0;
  const fBy = box ? 1 / (box.b * rong) : 0;

  // 1. Elip mặt, vùng chừa, và chỗ lấy mẫu màu da (má + mũi, ngoài vùng chừa).
  const prior = new Float32Array(n);
  const keep = new Float32Array(n);
  const samp = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const px = x - C[0];
      const py = y - C[1];
      const dx = px * vx + py * vy;
      const dy = px * ux + py * uy;
      const fb = dy > 0 ? fUp : fDown;
      let rho = Math.sqrt(dx * dx * fA * fA + dy * dy * fb * fb);
      if (box) rho = Math.min(rho, Math.hypot((x - box.cx) * fBx, (y - box.cy) * fBy));
      if (rho >= 1.05) continue;
      const i = y * w + x;
      prior[i] = 1 - sstep(0.82, 1.05, rho);
      let k = 1;
      for (let j = 0; j < 2; j++) {
        const e = eyes[j];
        const qx = x - e[0];
        const qy = y - e[1];
        const ex = qx * vx + qy * vy;
        const ey = qx * ux + qy * uy;
        const re2 = (ex * eyeA) ** 2 + (ey * eyeB) ** 2;
        if (re2 < 1.35 * 1.35) k *= sstep(0.85, 1.35, Math.sqrt(re2));
        const rb2 = ((ex + phia[j] * browIn) * browA) ** 2 + ((ey - browUp) * browB) ** 2;
        if (rb2 < 1.3 * 1.3) k *= 0.35 + 0.65 * sstep(0.8, 1.3, Math.sqrt(rb2));
      }
      const qx = x - M[0];
      const qy = y - M[1];
      const rm2 = ((qx * vx + qy * vy) * mouthA) ** 2 + ((qx * ux + qy * uy + mouthDown) * mouthB) ** 2;
      if (rm2 < 1.25 * 1.25) k *= sstep(0.8, 1.25, Math.sqrt(rm2));
      keep[i] = k;
      if (k > 0.99 && (dx * sampA) ** 2 + (dy * sampB) ** 2 < 1) samp.push(i);
    }
  }
  if (samp.length < 50) return null;
  if (samp.length > 4000) {
    const step = samp.length / 4000;
    for (let k = 0; k < 4000; k++) samp[k] = samp[Math.floor(k * step)];
    samp.length = 4000;
  }

  // 2. Màu da của chính mặt này: trung vị + hiệp phương sai trên mẫu đã bỏ ngoại lai.
  const sum = (i) => R[i] + G[i] + B[i] + 1e-3;
  const sr = samp.map((i) => R[i] / sum(i));
  const sg = samp.map((i) => G[i] / sum(i));
  const mr = median(sr);
  const mg = median(sg);
  const my = median(samp.map((i) => Y[i]));
  const madR = median(sr.map((x) => Math.abs(x - mr))) * 1.4826 + 1e-4;
  const madG = median(sg.map((x) => Math.abs(x - mg))) * 1.4826 + 1e-4;
  let crr = 0;
  let cgg = 0;
  let crg = 0;
  let cnt = 0;
  for (let k = 0; k < samp.length; k++) {
    const a = sr[k] - mr;
    const b = sg[k] - mg;
    if (Math.abs(a) > 3 * madR || Math.abs(b) > 3 * madG) continue;
    crr += a * a;
    cgg += b * b;
    crg += a * b;
    cnt++;
  }
  // Sàn cho độ lệch: mặt trang điểm rất đều thì mẫu gần như một màu, không có
  // sàn thì má trong bóng hay vùng hơi hồng cũng bị coi là "không phải da".
  const floor = 0.006 ** 2;
  crr = crr / cnt + floor;
  cgg = cgg / cnt + floor;
  crg /= cnt;
  const det = crr * cgg - crg * crg;
  const irr = cgg / det;
  const igg = crr / det;
  const irg = -crg / det;

  const m = new Float32Array(n);
  const lo = 0.35 * my;
  const hi = 0.6 * my;
  for (let i = 0; i < n; i++) {
    if (keep[i] <= 0) continue;
    const s = sum(i);
    const a = R[i] / s - mr;
    const b = G[i] / s - mg;
    const d2 = a * a * irr + b * b * igg + 2 * a * b * irg;
    m[i] = prior[i] * keep[i] * (1 - sstep(6.25, 25, d2)) * sstep(lo, hi, Y[i]);
  }

  // 3. Lấp lỗ nhỏ (mụn đỏ lệch màu vẫn phải được làm mịn) và làm mềm viền,
  //    rồi cắt lại theo vùng chừa để mắt / miệng không bị loang vào.
  const rr = Math.max(1, Math.round(0.03 * ed));
  const tmp = new Float32Array(n);
  const acc = new Float64Array(w);
  const s1 = boxMean(m, w, h, rr, new Float32Array(n), tmp, acc);
  const s2 = boxMean(s1, w, h, rr, new Float32Array(n), tmp, acc);
  for (let i = 0; i < n; i++) s2[i] = Math.max(s2[i], m[i]) * Math.min(1, keep[i] * 1.2) * Math.min(1, prior[i] * 1.2);
  const geo = new Float32Array(n);
  for (let i = 0; i < n; i++) geo[i] = prior[i] * keep[i];
  // moHinh: mô hình màu da của mặt này (sắc độ r,g) — nhat-mun.js đo độ giống da chặt hơn.
  return { mask: s2, geo, mau: m, moHinh: { mr, mg, irr, igg, irg } };
}

/**
 * Một khuôn mặt thu nhỏ còn rộng ~`faceW` px: vùng cắt trên ảnh gốc, ảnh nhỏ
 * (Buffer RGB + từng kênh số thực), hình học theo toạ độ ảnh nhỏ, mặt nạ da.
 * `rong` > 1 nới elip mặt ra (nhặt mụn: tới sát chân tóc, đường quai hàm).
 * null = mặt quá nhỏ, nằm gần hết ngoài ảnh, hoặc không lấy được mẫu da.
 */
export async function vungMat(rgb, width, height, f, faceW, rong = 1) {
  const g = geometry(f);
  if (g.ed < MIN_EYE_PX) return null;
  const roi = roiOf(g, width, height, rong);
  if (roi.width < 16 || roi.height < 16) return null;

  const d = Math.max(1, (2.2 * g.ed) / faceW);
  const sw = Math.max(8, Math.round(roi.width / d));
  const sh = Math.max(8, Math.round(roi.height / d));
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
  const Y = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    R[i] = small[i * 3];
    G[i] = small[i * 3 + 1];
    B[i] = small[i * 3 + 2];
    Y[i] = 0.299 * R[i] + 0.587 * G[i] + 0.114 * B[i];
  }
  const toSmall = (p) => [(p[0] - roi.left + 0.5) * kx - 0.5, (p[1] - roi.top + 0.5) * ky - 0.5];
  const k = (kx + ky) / 2;
  const gs = {
    ...g,
    ed: g.ed * k,
    em: g.em * k,
    C: toSmall(g.C),
    M: toSmall(g.M),
    nose: toSmall(g.nose),
    eyes: g.eyes.map(toSmall),
    mouthW: g.mouthW * k,
    box: (() => {
      const [cx, cy] = toSmall([g.box.cx, g.box.cy]);
      return { cx, cy, a: g.box.a * kx, b: g.box.b * ky };
    })(),
  };
  const da = skinMask(R, G, B, Y, sw, sh, gs, rong);
  if (!da) return null;
  return { roi, small, sw, sh, kx, ky, R, G, B, Y, gs, da };
}

/**
 * Làm mịn da mọi mặt trong `faces` trên `rgb` (Buffer RGB 8 bit, SỬA TẠI CHỖ)
 * với độ mịn `doMin` (0–100). Trả về số mặt đã làm.
 */
export async function smoothFaces(rgb, width, height, faces, doMin = MUC.vua.doMin) {
  const muc = thamSo(doMin);
  if (muc.alpha <= 0 && muc.beta <= 0) return 0;
  let done = 0;
  for (const f of faces) {
    const v = await vungMat(rgb, width, height, f, muc.faceW);
    if (!v) continue;
    const { roi, small, sw, sh, kx, ky, R, G, B, Y, gs } = v;
    const n = sw * sh;
    const { mask } = v.da;

    const unit = (c) => c.map((x) => x / 255);
    const r = Math.max(2, Math.round(muc.radius * gs.ed));
    const [qR, qG, qB] = guided(unit(Y), [unit(R), unit(G), unit(B)], sw, sh, r, muc.sigmaE ** 2);
    // α·m·(Q − S) ở ảnh nhỏ, theo thang 0–255.
    const D = new Float32Array(n * 3);
    for (let i = 0; i < n; i++) {
      const am = muc.alpha * mask[i];
      D[i * 3] = am * (qR[i] * 255 - R[i]);
      D[i * 3 + 1] = am * (qG[i] * 255 - G[i]);
      D[i * 3 + 2] = am * (qB[i] * 255 - B[i]);
    }

    // Mỗi hàng ảnh nhỏ: khoảng cột có mặt nạ — hàng ảnh gốc chỉ đi qua khoảng đó.
    const x0s = new Int32Array(sh).fill(sw);
    const x1s = new Int32Array(sh).fill(-1);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (mask[y * sw + x] > 0.004) {
          if (x < x0s[y]) x0s[y] = x;
          x1s[y] = x;
        }
      }
    }

    applyUp(rgb, width, roi, { small, D, mask, sw, sh, kx, ky, x0s, x1s, beta: muc.beta });
    done++;
  }
  return done;
}

/** Phóng (song tuyến) phần chênh ở ảnh nhỏ lên và áp vào ảnh gốc, chỉ trên vùng có mặt nạ. */
function applyUp(rgb, width, roi, { small, D, mask, sw, sh, kx, ky, x0s, x1s, beta }) {
  // Cột ảnh nhỏ bên trái / phải và trọng số của từng cột ảnh gốc: như nhau ở mọi hàng.
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
    const sx0 = Math.min(x0s[y0], x0s[y1]);
    const sx1 = Math.max(x1s[y0], x1s[y1]);
    if (sx1 < 0) continue;
    const xa = Math.max(0, Math.floor((sx0 - 1 + 0.5) / kx));
    const xb = Math.min(roi.width, Math.ceil((sx1 + 1 + 0.5) / kx));
    const r0 = y0 * sw;
    const r1 = y1 * sw;
    const row = ((roi.top + y) * width + roi.left) * 3;
    for (let x = xa; x < xb; x++) {
      const tx = ctx[x];
      const i00 = r0 + cx0[x];
      const i01 = r0 + cx1[x];
      const i10 = r1 + cx0[x];
      const i11 = r1 + cx1[x];
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      const mm = mask[i00] * w00 + mask[i01] * w01 + mask[i10] * w10 + mask[i11] * w11;
      if (mm < 0.004) continue;
      const bm = beta * mm;
      const o = row + x * 3;
      const a00 = i00 * 3;
      const a01 = i01 * 3;
      const a10 = i10 * 3;
      const a11 = i11 * 3;
      for (let c = 0; c < 3; c++) {
        const dd = D[a00 + c] * w00 + D[a01 + c] * w01 + D[a10 + c] * w10 + D[a11 + c] * w11;
        const ss = small[a00 + c] * w00 + small[a01 + c] * w01 + small[a10 + c] * w10 + small[a11 + c] * w11;
        const O = rgb[o + c];
        const val = O + dd - bm * (O - ss) + 0.5;
        rgb[o + c] = val <= 0 ? 0 : val >= 255 ? 255 : val | 0;
      }
    }
  }
}
