import { boxMean, sstep, vungMat } from './lam-min.js';

/**
 * NHẶT MỤN — tìm và chữa từng đốm (mụn, vết thâm, đốm nhỏ) trên da mặt, như
 * "Remove Blemishes" của Capture One. Chạy TRƯỚC bước làm mịn: làm mịn chỉ làm
 * mụn nhạt đi chứ không làm mất (02/11/2026, tiệm 1510 phàn nàn đúng chỗ này).
 *
 * DÒ (ở ảnh nhỏ của vùng mặt, mặt rộng FACE_W px):
 *   vùng   = sâu trong mặt, đúng màu da quanh đó; chừa mắt, cả dải lông mày,
 *            môi, cánh mũi, hai khoé miệng (bóng tự nhiên trông như vết thâm)
 *   tín hiệu = tối + 3 × đỏ (sắc độ r = R/(R+G+B))
 *   đốm    = cực đại của hiệu hai lớp làm mờ Gauss (DoG) theo cả vị trí lẫn cỡ —
 *            chỉ đốm TRÒN đúng cỡ mới nổi; bóng chuyển dần (mũi, má hồng, ánh
 *            sáng lệch) gần như bằng 0. Trước đó đã thử cắt ngưỡng trên một nền
 *            mượt rồi gom vùng liền: mụn sát rãnh mũi / bóng dưới môi bị gom
 *            chung với bóng thành một mảng lớn rồi bị bỏ (thử 02/11). Lọc tiếp:
 *            - cỡ: bán kính ~0,4%…1,5% bề ngang mặt (nhỏ hơn là lỗ chân lông,
 *              to hơn là bóng cánh mũi, đầu nếp cười, mép vật che)
 *            - hình: Hessian hai chiều cong gần như nhau (rãnh, nếp dài thì không)
 *            - lõi đốm nằm trọn trên da được dò
 *            - quanh đốm phải là DA TRƠN: vành quanh nó không có vệt tối (sợi
 *              tóc, nếp), không có sợi gì chạy qua (tóc nhuộm đỏ không tối
 *              nhưng có hướng), không lổn nhổn, không gồ ghề (mép ngón tay áp
 *              má), và đúng màu da của mặt đó — hoặc đỏ hơn, như quầng quanh
 *              mụn viêm, chứ không vàng hơn như lông thú bông (xem VANH_*)
 *   Ngưỡng đặt theo 78 ảnh thật của tiệm + mụn giả chấm lên má: ưu tiên KHÔNG
 *   chữa nhầm. Đốm sát cánh mũi, ngay dưới sợi tóc, sát ngón tay thì bỏ qua.
 *
 * CHỮA (trên ảnh gốc, từng đốm một — như chổi chữa / healing brush):
 *   màu   = mặt phẳng màu khớp với VÀNH DA SÁT NGOÀI đốm (giữ được chỗ da
 *           sáng dần / tối dần). Không lấy trung bình cả vùng rộng: ngón tay
 *           áp lên má thì trung bình đó lẫn cả màu má lẫn màu tay (thử 02/11)
 *   vân   = vân da của một mảng sạch bên cạnh (8 hướng × 2 khoảng cách, cả mảng
 *           phải là da, không dính đốm khác hay sợi tóc, cùng sáng nhất) trừ
 *           trung bình của chính mảng đó
 *   ảnh   = gốc × (1 − α) + (màu + vân) × α, α mềm dần ra ngoài viền đốm
 * Vành quanh đốm không phẳng (lệch nhiều so với mặt phẳng — hai thứ khác màu
 * chạm nhau) thì KHÔNG chữa. Có vân thì chỗ chữa không phẳng lì như bị tẩy;
 * bước làm mịn chạy sau đó.
 */

/** Mặt rộng bao nhiêu px khi dò: mụn nhỏ nhất còn ~2 px bán kính. */
const FACE_W = 450;
/**
 * Elip mặt nới ra chừng này khi dò: elip của bước làm mịn dừng trước chân tóc
 * và đường quai hàm, mà chấm thâm / nốt ruồi ở đó vẫn là thứ cần nhặt (thử
 * 02/11). Ra tới tóc, tai, cổ thì các luật về vành bên dưới gạt đi.
 */
const RONG = 1.18;
/** Một mặt chữa tối đa chừng này đốm (đốm rõ nhất trước) — phòng khi dò sai hàng loạt. */
const MAX_MUN = 40;

/** Gần như Gauss: ba lần lọc hộp bán kính r (σ ≈ r). */
function blur3(src, w, h, r, tmp, acc) {
  const out = Float32Array.from(src);
  for (let k = 0; k < 3; k++) boxMean(out, w, h, r, out, tmp, acc);
  return out;
}

/**
 * Dò đốm trên một vùng mặt (`v` của vungMat). `nhay` > 1 bắt cả đốm mờ hơn.
 * Trả về đốm theo toạ độ ảnh nhỏ và các bản đồ cho bước chữa.
 */
function timMun(v, nhay, onDo) {
  const { sw: w, sh: h, R, G, B, Y, gs, da } = v;
  const n = w * h;
  const fw = 2.2 * gs.ed;
  const tmp = new Float32Array(n);
  const acc = new Float64Array(w);

  // Vùng được dò: sâu trong mặt, quanh đó đúng là da (mụn lệch màu thì `mau`
  // tại chỗ nó thấp, nên xét da QUANH nó), ngoài khu cánh mũi. Hai cỡ: cỡ lớn
  // lấp được cả mụn to; cỡ nhỏ (vừa một cái mụn) loại mảng không phải da —
  // nơ, áo, tay khác màu — mà cỡ lớn đã lấn vào mép của nó.
  const quanh = blur3(da.mau, w, h, Math.max(3, Math.round(0.07 * fw)), tmp, acc);
  const quanhNho = blur3(da.mau, w, h, Math.max(2, Math.round(0.025 * fw)), tmp, acc);
  const [ux, uy] = gs.u;
  const [vx, vy] = gs.v;
  // Chỉ chừa lỗ mũi + chân cánh mũi (bóng tối tự nhiên), không chừa cả mũi:
  // chấm trên sống mũi, đầu mũi vẫn nhặt (thử 02/11).
  const mx = gs.nose[0] - ux * 0.12 * gs.ed;
  const my = gs.nose[1] - uy * 0.12 * gs.ed;
  // Hai khoé miệng: nếp cười, lúm đồng tiền — bóng tự nhiên trông như vết thâm.
  const k1x = gs.M[0] - vx * gs.mouthW * 0.5;
  const k1y = gs.M[1] - vy * gs.mouthW * 0.5;
  const k2x = gs.M[0] + vx * gs.mouthW * 0.5;
  const k2y = gs.M[1] + vy * gs.mouthW * 0.5;
  const rKhoe2 = (0.17 * gs.ed) ** 2;
  // Môi, rộng hơn vùng chừa của bước làm mịn: môi dày / chu môi tràn ra ngoài nó.
  const moiX = gs.M[0] - ux * 0.06 * gs.ed;
  const moiY = gs.M[1] - uy * 0.06 * gs.ed;
  const moiA = 0.6 * gs.mouthW + 0.1 * gs.ed;
  const moiB = 0.3 * gs.ed;
  // Dải lông mày mỗi bên: TÌM trên ảnh — phía trên mắt, dải tối nhất trong
  // khoảng 0,18–0,52 khoảng cách mắt (trung bình trên bề ngang ±0,25 quanh mắt),
  // rộng ±0,42 — rộng hơn thì hai dải chạm nhau, nuốt mất giữa hai đầu mày.
  // Lông mày người cao người thấp (0,23–0,41); đặt cố định thì người mày thấp bị
  // chừa mất trán ngay trên mày, đúng chỗ có nốt (thử 02/11). Lệch vào giữa 0,08,
  // dày ±0,13. Không thấy dải nào tối hơn hẳn da thì đặt ở 0,34.
  const timMay = ([ex, ey]) => {
    let toiNhat = Infinity;
    let dTot = 0.34;
    let sangNhat = 0;
    for (let d = 0.18; d <= 0.52; d += 0.02) {
      let tong = 0;
      let so = 0;
      for (let a = -0.25; a <= 0.25001; a += 0.05) {
        const x = Math.round(ex + ux * d * gs.ed + vx * a * gs.ed);
        const y = Math.round(ey + uy * d * gs.ed + vy * a * gs.ed);
        if (x < 0 || y < 0 || x >= w || y >= h) continue;
        tong += Y[y * w + x];
        so++;
      }
      if (so < 5) continue;
      const tb = tong / so;
      if (tb > sangNhat) sangNhat = tb;
      if (tb < toiNhat) {
        toiNhat = tb;
        dTot = d;
      }
    }
    return toiNhat < 0.85 * sangNhat ? dTot : 0.34;
  };
  const ex0 = (gs.eyes[0][0] + gs.eyes[1][0]) / 2;
  const ey0 = (gs.eyes[0][1] + gs.eyes[1][1]) / 2;
  const may = gs.eyes.map(([ex, ey]) => {
    const ra = (ex - ex0) * vx + (ey - ey0) * vy;
    const vao = ra > 0 ? -0.08 * gs.ed : 0.08 * gs.ed;
    const d = timMay([ex, ey]);
    return [ex + ux * d * gs.ed + vx * vao, ey + uy * d * gs.ed + vy * vao];
  });
  const vung = new Uint8Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (da.geo[i] < 0.85 || quanh[i] < 0.25 || quanhNho[i] < 0.55) continue;
      const qx = x - mx;
      const qy = y - my;
      const a = (qx * vx + qy * vy) / (0.36 * gs.ed);
      const b = (qx * ux + qy * uy) / (0.14 * gs.ed);
      if (a * a + b * b < 1) continue;
      // Cả dải lông mày, tới tận đầu mày (mày nhạt màu lọt qua vùng chừa của
      // bước làm mịn — đầu mày bị "chữa" mất, thử 02/11).
      let mayBan = false;
      for (const [bx, by] of may) {
        const px = x - bx;
        const py = y - by;
        if (((px * vx + py * vy) / (0.42 * gs.ed)) ** 2 + ((px * ux + py * uy) / (0.13 * gs.ed)) ** 2 < 1) mayBan = true;
      }
      if (mayBan) continue;
      if ((x - k1x) ** 2 + (y - k1y) ** 2 < rKhoe2 || (x - k2x) ** 2 + (y - k2y) ** 2 < rKhoe2) continue;
      const mx2 = x - moiX;
      const my2 = y - moiY;
      if (((mx2 * vx + my2 * vy) / moiA) ** 2 + ((mx2 * ux + my2 * uy) / moiB) ** 2 < 1) continue;
      vung[i] = 1;
    }
  }

  // Tín hiệu: tối + 3 × đỏ (sắc độ r). Phần nền chậm — bóng của mũi, má hồng,
  // ánh sáng lệch một bên — để phép hiệu Gauss bên dưới tự bỏ đi.
  const S = new Float32Array(n);
  const wv = new Float32Array(n);
  let tongY = 0;
  let soY = 0;
  for (let i = 0; i < n; i++) {
    if (!vung[i]) continue;
    tongY += Y[i];
    soY++;
  }
  if (soY < 200) return { spots: [], vung };
  const yTb = tongY / soY;
  for (let i = 0; i < n; i++) {
    if (!vung[i]) continue;
    wv[i] = 1;
    S[i] = -Y[i] / yTb + 3 * (R[i] / (R[i] + G[i] + B[i] + 1e-3));
  }

  // Ngoài vùng dò (mắt, tóc, nền) lấp bằng giá trị trơn của vùng dò gần đó, để
  // mép vùng không thành một bậc mà các tầng làm mờ bên dưới tưởng là đốm.
  const rLap = Math.max(4, Math.round(0.03 * fw));
  const SW = new Float32Array(n);
  for (let i = 0; i < n; i++) SW[i] = S[i] * wv[i];
  const num = blur3(SW, w, h, rLap, tmp, acc);
  const den = blur3(wv, w, h, rLap, tmp, acc);
  let tbS = 0;
  for (let i = 0; i < n; i++) tbS += SW[i];
  tbS /= soY;
  for (let i = 0; i < n; i++) if (!vung[i]) S[i] = den[i] > 1e-3 ? num[i] / den[i] : tbS;

  // Các tầng Gauss: bán kính hộp 1,2,3,5,8 — ba lần lọc hộp bán kính r ≈ σ = √(r(r+1)).
  const RS = [1, 2, 3, 5, 8];
  const SIG = RS.map((r) => Math.sqrt(r * (r + 1)));
  const gau = RS.map((r) => blur3(S, w, h, r, tmp, acc));
  // DoG từng tầng, chia cho (tỉ lệ σ − 1) để các tầng so được với nhau.
  const dog = [];
  for (let k = 0; k + 1 < RS.length; k++) {
    const d = new Float32Array(n);
    const chia = (SIG[k + 1] / SIG[k] - 1) / 0.6;
    for (let i = 0; i < n; i++) d[i] = vung[i] ? (gau[k][i] - gau[k + 1][i]) / chia : 0;
    dog.push(d);
  }
  // "Có gì nổi lên ở đây không" — cho vành quanh đốm và cho mảng nguồn vân da.
  const sc = new Float32Array(n);
  for (const d of dog) for (let i = 0; i < n; i++) if (d[i] > sc[i]) sc[i] = d[i];

  // 0,036: thử trên 78 ảnh thật của tiệm 02/11. Ở 0,030 bắt thêm vài chấm mờ thật
  // nhưng cũng bắt nhầm khe tóc mái mà luật vành không gạt được.
  const T = 0.036 / nhay;
  const TL = 0.5 * T;
  const rMin = 0.004 * fw;
  // Đốm to hơn ~1,5% bề ngang mặt (bán kính ~15 px trên mặt rộng 1000 px) hầu như
  // là bóng — cánh mũi, đầu nếp cười, mép vật che — không phải mụn (thử 02/11).
  const rMax = 0.015 * fw;
  // Vành quanh đốm phải là da trơn — các ngưỡng đặt theo số đo 02/11 trên mụn
  // giả (vành: tối 0, nổi ≤ 0,17, lệch ≤ 0,029, màu ≤ 1,3) và chỗ bắt nhầm
  // trên ảnh thật của tiệm (sợi tóc, nếp cười, cánh mũi, lông thú bông).
  /** Tỉ lệ điểm tối hơn hẳn trung vị (sợi tóc, nếp chạy xuyên qua vành). */
  const VANH_TOI = 0.03;
  /** Tỉ lệ điểm cũng nổi lên (vùng lổn nhổn). Rộng tay: quầng đỏ quanh mụn viêm cũng nổi. */
  const VANH_NOI = 0.6;
  /** Lệch trung bình / trung vị độ sáng. */
  const VANH_LECH = 0.032;
  /** Màu lệch khỏi màu da của mặt (bình phương khoảng cách Mahalanobis, sắc độ r,g). */
  // 2,5 lúc đầu là để chặn thú bông; nay VANH_VANG lo việc đó. Má xa mũi (mặt quay,
  // trong bóng) nhạt hơn mẫu da lấy quanh mũi tới d2 ~5 — vẫn là da (thử 02/11).
  const VANH_MAU = 6;
  /** …trừ khi lệch về phía ĐỎ (quầng quanh mụn viêm, má hồng): lông thú màu be lệch về vàng. */
  const VANH_MAU_DO = 5;
  /** Độ cùng hướng của biến thiên sáng quanh đốm: sợi tóc 0,66–0,85; mụn thật ≤ 0,31. */
  const VANH_HUONG = 0.55;
  /**
   * Từng chỉ số trên đều dưới ngưỡng mà cả ba cùng sát ngưỡng (nổi / ngưỡng +
   * hướng / ngưỡng + lệch / ngưỡng) thì vẫn là chỗ lổn nhổn: lông thú bông, khe
   * tóc mái, chân tóc, mép nơ. Thử 02/11: đốm thật ≤ 1,50, chỗ nhầm ≥ 1,77.
   */
  const VANH_GOGH = 1.7;
  /**
   * Vành ngả VÀNG so với da của mặt (sắc độ r và g cùng tăng, ×1000): lông thú
   * màu be, đầu lông mày nhạt màu. Đốm thật ≤ 10, chỗ nhầm 20–23 (thử 02/11).
   */
  const VANH_VANG = 15;
  /** Dài / rộng tối đa (theo ma trận Hessian) — hơn thế là rãnh, nếp, sợi tóc. */
  const DEP = 4;

  // Vành quanh đốm: phần lớn phải là da được dò (không sát mắt / tóc / mép
  // mặt), và là DA TRƠN. Mụn thật nằm giữa da trơn; còn chỗ bắt nhầm thì vành
  // có thứ khác (thử trên ảnh thật 02/11): sợi tóc hay nếp tối chạy xuyên qua
  // (điểm tối hơn hẳn trung vị), hoặc cả vùng lổn nhổn — lông thú bông màu be
  // che mặt (nhiều điểm cũng nổi lên).
  const vanhSach = (cx, cy, rEq) => {
    const rIn = 1.6 * rEq + 1;
    const rOut = rIn + Math.max(2, 0.8 * rEq);
    let tong = 0;
    let ngoai = 0;
    let noi = 0;
    let tongD2 = 0;
    let tongA = 0;
    let tongB = 0;
    const { mr, mg, irr, igg, irg } = da.moHinh;
    const ys = [];
    for (let y = Math.max(0, Math.floor(cy - rOut)); y <= Math.min(h - 1, Math.ceil(cy + rOut)); y++) {
      for (let x = Math.max(0, Math.floor(cx - rOut)); x <= Math.min(w - 1, Math.ceil(cx + rOut)); x++) {
        const d2 = (x - cx) ** 2 + (y - cy) ** 2;
        if (d2 < rIn * rIn || d2 > rOut * rOut) continue;
        tong++;
        const i = y * w + x;
        if (!vung[i]) {
          ngoai++;
          continue;
        }
        ys.push(Y[i]);
        const su = R[i] + G[i] + B[i] + 1e-3;
        const a = R[i] / su - mr;
        const b = G[i] / su - mg;
        tongD2 += a * a * irr + b * b * igg + 2 * a * b * irg;
        tongA += a;
        tongB += b;
        if (sc[i] > TL) noi++;
      }
    }
    // Mụn giữa má thì vành nằm trọn trong da; chạm vùng chừa / vật che là ở mép.
    if (!tong || ngoai > 0.1 * tong || ys.length < 8) return 'vanh-ngoai';
    // Độ cùng hướng của biến thiên sáng trong cả đĩa tới rOut (tensor cấu trúc):
    // sợi tóc chạy qua → gần 1; nốt mụn, quầng đỏ, da trơn → thấp.
    let jxx = 0;
    let jyy = 0;
    let jxy = 0;
    for (let y = Math.max(1, Math.floor(cy - rOut)); y <= Math.min(h - 2, Math.ceil(cy + rOut)); y++) {
      for (let x = Math.max(1, Math.floor(cx - rOut)); x <= Math.min(w - 2, Math.ceil(cx + rOut)); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > rOut * rOut) continue;
        const i = y * w + x;
        const gx = (Y[i + 1] - Y[i - 1]) / 2;
        const gy = (Y[i + w] - Y[i - w]) / 2;
        jxx += gx * gx;
        jyy += gy * gy;
        jxy += gx * gy;
      }
    }
    const huong = Math.sqrt((jxx - jyy) ** 2 + 4 * jxy * jxy) / Math.max(1e-6, jxx + jyy);
    const xep = Float32Array.from(ys).sort();
    const trungVi = xep[xep.length >> 1];
    let toi = 0;
    let lech = 0;
    for (const q of ys) {
      if (q < 0.9 * trungVi) toi++;
      lech += Math.abs(q - trungVi);
    }
    const n2 = ys.length;
    const st = `toi=${(toi / n2).toFixed(3)} noi=${(noi / n2).toFixed(2)} lech=${(lech / n2 / trungVi).toFixed(3)} d2=${(tongD2 / n2).toFixed(1)} dr=${(1000 * tongA / n2).toFixed(1)} dg=${(1000 * tongB / n2).toFixed(1)} huong=${huong.toFixed(2)}`;
    if (toi / n2 > VANH_TOI) return `vanh-toi ${st}`;
    if (huong > VANH_HUONG) return `vanh-huong ${st}`;
    if (noi / n2 > VANH_NOI) return `vanh-noi ${st}`;
    if (lech / n2 / trungVi > VANH_LECH) return `vanh-lech ${st}`;
    if (tongD2 / n2 > (tongA > 0 && tongB < 0 ? VANH_MAU_DO : VANH_MAU)) return `vanh-mau ${st}`;
    // Lông thú be có khi chỉ lệch xanh lá (g) mà không đỏ: dg ~17 (thử 02/11); má thật ≤ 10,4.
    if ((1000 * (tongA + tongB)) / n2 > VANH_VANG || (1000 * tongB) / n2 > 13) return `vanh-vang ${st}`;
    if (noi / n2 / VANH_NOI + huong / VANH_HUONG + lech / n2 / trungVi / VANH_LECH > VANH_GOGH) return `vanh-gogh ${st}`;
    return { st };
  };

  // Cực đại cục bộ theo cả vị trí lẫn cỡ: mỗi đốm nổi nhất ở đúng một tầng.
  const ung = [];
  for (let k = 0; k < dog.length; k++) {
    const d = dog[k];
    const rho = 1.25 * Math.sqrt(SIG[k] * SIG[k + 1]);
    if (rho < rMin || rho > rMax) continue;
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        const v0 = d[i];
        if (v0 <= T) continue;
        if (v0 < d[i - 1] || v0 < d[i + 1] || v0 < d[i - w] || v0 < d[i + w] ||
            v0 < d[i - w - 1] || v0 < d[i - w + 1] || v0 < d[i + w - 1] || v0 < d[i + w + 1]) continue;
        if ((k > 0 && v0 < dog[k - 1][i]) || (k + 1 < dog.length && v0 < dog[k + 1][i])) continue;
        ung.push({ x, y, k, v0, rho });
      }
    }
  }
  ung.sort((p, q) => q.v0 - p.v0);
  const spots = [];
  for (const c of ung) {
    const loai = (lyDo) => {
      if (onDo) onDo({ cx: c.x, cy: c.y, cnt: Math.round(c.rho * 10) / 10, peak: c.v0, lyDo });
    };
    if (spots.length >= MAX_MUN) break;
    if (spots.some((s) => Math.hypot(s.cx - c.x, s.cy - c.y) < 0.8 * (s.rho + c.rho))) continue;
    // Hessian của tín hiệu đã làm mờ ở tầng đó: đốm tròn thì hai chiều cong như nhau.
    const g = gau[c.k];
    const i = c.y * w + c.x;
    const dxx = g[i - 1] + g[i + 1] - 2 * g[i];
    const dyy = g[i - w] + g[i + w] - 2 * g[i];
    const dxy = (g[i - w - 1] + g[i + w + 1] - g[i - w + 1] - g[i + w - 1]) / 4;
    const det = dxx * dyy - dxy * dxy;
    if (det <= 0 || ((dxx + dyy) ** 2) / det > ((DEP + 1) ** 2) / DEP) { loai('dai'); continue; }
    // Cả lõi đốm phải nằm trên da được dò — không vắt qua mép nơ, tóc, tay.
    let loiNgoai = false;
    const rl = 1.2 * c.rho + 0.5;
    for (let y = Math.floor(c.y - rl); y <= Math.ceil(c.y + rl) && !loiNgoai; y++) {
      for (let x = Math.floor(c.x - rl); x <= Math.ceil(c.x + rl); x++) {
        if ((x - c.x) ** 2 + (y - c.y) ** 2 > rl * rl) continue;
        if (x < 0 || y < 0 || x >= w || y >= h || !vung[y * w + x]) {
          loiNgoai = true;
          break;
        }
      }
    }
    if (loiNgoai) { loai('loi-ngoai'); continue; }
    const vanh = vanhSach(c.x, c.y, c.rho);
    if (typeof vanh === 'string') { loai(vanh); continue; }
    loai(`NHAN ${vanh.st}`);
    spots.push({ cx: c.x, cy: c.y, rho: c.rho, ra: c.rho, rb: c.rho, ang: 0, peak: c.v0 });
  }

  // Vùng của các đốm (cả quầng): mảng nguồn vân da và vành lấy màu tránh nó ra.
  const ban = new Uint8Array(n);
  for (const sp of spots) {
    const R0 = 1.9 * sp.rho + 1;
    for (let y = Math.max(0, Math.floor(sp.cy - R0)); y <= Math.min(h - 1, Math.ceil(sp.cy + R0)); y++) {
      for (let x = Math.max(0, Math.floor(sp.cx - R0)); x <= Math.min(w - 1, Math.ceil(sp.cx + R0)); x++) {
        if ((x - sp.cx) ** 2 + (y - sp.cy) ** 2 <= R0 * R0) ban[y * w + x] = 1;
      }
    }
  }
  return { spots, vung, ban, sc, TL };
}

/** Mặt phẳng a + b·dx + c·dy khớp bình phương nhỏ nhất với `mau` ([dx, dy, giá trị]). */
function khopPhang(mau) {
  let n = 0;
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  let sv = 0;
  let sxv = 0;
  let syv = 0;
  for (const [x, y, val] of mau) {
    n++;
    sx += x;
    sy += y;
    sxx += x * x;
    syy += y * y;
    sxy += x * y;
    sv += val;
    sxv += x * val;
    syv += y * val;
  }
  const det3 = (m) =>
    m[0] * (m[4] * m[8] - m[5] * m[7]) - m[1] * (m[3] * m[8] - m[5] * m[6]) + m[2] * (m[3] * m[7] - m[4] * m[6]);
  const A = [n, sx, sy, sx, sxx, sxy, sy, sxy, syy];
  const D = det3(A);
  if (Math.abs(D) < 1e-6) return [sv / Math.max(1, n), 0, 0];
  const cot = (j, rhs) => A.map((val, i) => (i % 3 === j ? rhs[Math.floor(i / 3)] : val));
  const rhs = [sv, sxv, syv];
  return [det3(cot(0, rhs)) / D, det3(cot(1, rhs)) / D, det3(cot(2, rhs)) / D];
}

/**
 * Chữa một đốm trên ảnh gốc (`rgb`, sửa tại chỗ). Trả về false nếu bỏ qua.
 * `onMun` (chỉ để thử): nhận { x, y, ra, rb, ang, nguon } theo toạ độ ảnh gốc.
 */
function chua(rgb, width, height, v, s, t, onMun) {
  const { roi, kx, ky, sw, sh } = v;
  const k = (kx + ky) / 2;
  const toSmall = (X, Y) => [(X - roi.left + 0.5) * kx - 0.5, (Y - roi.top + 0.5) * ky - 0.5];
  const nhoTai = (X, Y) => {
    const [fx, fy] = toSmall(X, Y);
    const x = Math.round(fx);
    const y = Math.round(fy);
    return x < 0 || y < 0 || x >= sw || y >= sh ? -1 : y * sw + x;
  };
  const cx = (s.cx + 0.5) / kx - 0.5 + roi.left;
  const cy = (s.cy + 0.5) / ky - 0.5 + roi.top;
  // Lõi đốm trên ảnh gốc, nới ra để lấy cả quầng đỏ / mép mờ; α tắt hẳn ở R1.
  const rc = (s.rho * 1.6 + 1) / k;
  const R1 = 1.6 * rc;

  // 1. Màu: mặt phẳng khớp với vành da sát ngoài R1 (bỏ điểm thuộc đốm khác,
  //    điểm có gì nổi lên, điểm ngoài vùng da).
  const rIn = R1 + 1;
  const rOut = R1 + Math.max(3, 0.5 * rc);
  const vanh = [[], [], []];
  for (let y = Math.max(0, Math.floor(cy - rOut)); y <= Math.min(height - 1, Math.ceil(cy + rOut)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rOut)); x <= Math.min(width - 1, Math.ceil(cx + rOut)); x++) {
      const d2 = (x - cx) ** 2 + (y - cy) ** 2;
      if (d2 < rIn * rIn || d2 > rOut * rOut) continue;
      const i = nhoTai(x, y);
      if (i < 0 || t.vung[i] !== 1 || t.sc[i] > t.TL) continue;
      const o = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) vanh[c].push([x - cx, y - cy, rgb[o + c]]);
    }
  }
  if (vanh[0].length < 24) return false;
  const phang = vanh.map(khopPhang);
  // Vành không phẳng (lệch trung bình so với mặt phẳng lớn) = hai thứ khác
  // nhau chạm quanh đốm — ngón tay áp má, mép tóc. Không chữa.
  let lech = 0;
  for (let c = 0; c < 3; c++) {
    const [a0, b0, c0] = phang[c];
    for (const [x, y, val] of vanh[c]) lech += Math.abs(val - (a0 + b0 * x + c0 * y));
  }
  lech /= 3 * vanh[0].length;
  if (lech > 0.035 * Math.max(phang[0][0], phang[1][0], phang[2][0])) return false;
  const mauTai = (x, y) => phang.map(([a0, b0, c0]) => a0 + b0 * (x - cx) + c0 * (y - cy));

  // 2. Vân: mảng nguồn — cả đĩa bán kính R1 quanh nó là da sạch, cùng sáng nhất.
  const diaSach = (X, Y) => {
    const [fx, fy] = toSmall(X, Y);
    const r = R1 * k + 1;
    let xau = 0;
    let tong = 0;
    for (let y = Math.floor(fy - r); y <= Math.ceil(fy + r); y++) {
      for (let x = Math.floor(fx - r); x <= Math.ceil(fx + r); x++) {
        if ((x - fx) ** 2 + (y - fy) ** 2 > r * r) continue;
        if (x < 0 || y < 0 || x >= sw || y >= sh) return null;
        const i = y * sw + x;
        tong++;
        if (t.vung[i] !== 1 || t.ban[i] !== 0 || t.sc[i] > t.TL) xau++;
      }
    }
    return tong > 0 && xau <= 0.03 * tong ? tong : null;
  };
  const sangDich = 0.299 * phang[0][0] + 0.587 * phang[1][0] + 0.114 * phang[2][0];
  let nguon = null;
  let tot = Infinity;
  for (const kc of [2.4, 3.2]) {
    for (let h8 = 0; h8 < 8; h8++) {
      const goc = (h8 / 8) * 2 * Math.PI;
      const ox = Math.round(Math.cos(goc) * kc * R1 * 0.85);
      const oy = Math.round(Math.sin(goc) * kc * R1 * 0.85);
      const px = cx + ox;
      const py = cy + oy;
      if (px - R1 < 0 || py - R1 < 0 || px + R1 >= width || py + R1 >= height) continue;
      if (!diaSach(px, py)) continue;
      const i = nhoTai(px, py);
      const lechSang = Math.abs(v.Y[i] - sangDich) + kc;
      if (lechSang < tot) {
        tot = lechSang;
        nguon = [ox, oy];
      }
    }
  }
  let tbNguon = null;
  if (nguon) {
    tbNguon = [0, 0, 0];
    let so = 0;
    for (let y = Math.ceil(cy - R1); y <= Math.floor(cy + R1); y++) {
      for (let x = Math.ceil(cx - R1); x <= Math.floor(cx + R1); x++) {
        if ((x - cx) ** 2 + (y - cy) ** 2 > R1 * R1) continue;
        const o = ((y + nguon[1]) * width + x + nguon[0]) * 3;
        for (let c = 0; c < 3; c++) tbNguon[c] += rgb[o + c];
        so++;
      }
    }
    for (let c = 0; c < 3; c++) tbNguon[c] /= Math.max(1, so);
  }

  // Chỉ sửa điểm ảnh là da: vùng chữa có chạm mép nơ, tóc, mắt thì phần đó giữ nguyên.
  const laDa = (X, Y) => {
    const [fx, fy] = toSmall(X, Y);
    const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const x1 = Math.min(sw - 1, x0 + 1);
    const y1 = Math.min(sh - 1, y0 + 1);
    const tx = Math.max(0, Math.min(1, fx - x0));
    const ty = Math.max(0, Math.min(1, fy - y0));
    return (t.vung[y0 * sw + x0] * (1 - tx) + t.vung[y0 * sw + x1] * tx) * (1 - ty) +
      (t.vung[y1 * sw + x0] * (1 - tx) + t.vung[y1 * sw + x1] * tx) * ty;
  };

  // 3. Ghép: tính hết vào bộ đệm rồi mới ghi — mảng nguồn có thể chồng lên rìa.
  const x0 = Math.max(0, Math.floor(cx - R1));
  const x1 = Math.min(width - 1, Math.ceil(cx + R1));
  const y0 = Math.max(0, Math.floor(cy - R1));
  const y1 = Math.min(height - 1, Math.ceil(cy + R1));
  const ww = x1 - x0 + 1;
  const ra2 = new Float32Array(ww * (y1 - y0 + 1) * 4);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const al = (1 - sstep(rc, R1, Math.hypot(x - cx, y - cy))) * laDa(x, y);
      if (al <= 0) continue;
      const m = mauTai(x, y);
      const o = ((y - y0) * ww + (x - x0)) * 4;
      ra2[o + 3] = al;
      if (nguon) {
        const so = ((y + nguon[1]) * width + x + nguon[0]) * 3;
        for (let c = 0; c < 3; c++) ra2[o + c] = m[c] + (rgb[so + c] - tbNguon[c]);
      } else {
        for (let c = 0; c < 3; c++) ra2[o + c] = m[c];
      }
    }
  }
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const o = ((y - y0) * ww + (x - x0)) * 4;
      const al = ra2[o + 3];
      if (al <= 0) continue;
      const d = (y * width + x) * 3;
      for (let c = 0; c < 3; c++) {
        const val = rgb[d + c] * (1 - al) + ra2[o + c] * al + 0.5;
        rgb[d + c] = val <= 0 ? 0 : val >= 255 ? 255 : val | 0;
      }
    }
  }
  if (onMun) onMun({ x: cx, y: cy, ra: rc, rb: rc, ang: 0, nguon });
  return true;
}

/**
 * KHỬ ĐỎ — vết đỏ / thâm đỏ mà bước chữa đốm bỏ qua vì chúng không tròn hoặc
 * không nằm giữa da trơn: cụm mụn viêm, vết sau mụn sát ngón tay áp má, nốt sần
 * ửng hồng trong vùng bóng sáng trên trán (thử 02/11 trên ảnh khách). Chỉ kéo
 * MÀU về màu da quanh đó và nâng nhẹ chỗ bị sẫm; độ sáng và vân da giữ nguyên,
 * nên làm sát mép ngón tay hay sợi tóc cũng không lem.
 *
 *   nền     = sắc độ r, g và độ sáng trung bình của da quanh mỗi điểm (bán kính
 *             ~4% bề ngang mặt), hai vòng — vòng sau bỏ các điểm đỏ hơn hẳn
 *   đỏ dư   = r − nền r, chỉ phần dương
 *   mặt nạ  = đỏ dư từ KHU_DO_TU tới KHU_DO_DU, trong vùng da được dò (đã chừa
 *             mắt, mày, môi, lỗ mũi), trừ mảng đỏ RỘNG — má hồng, tai, đầu mũi:
 *             quá nửa vùng quanh nó cũng đỏ — rồi mềm viền
 */
const KHU_DO_TU = 0.006;
const KHU_DO_DU = 0.02;

/** Bản đồ khử đỏ ở ảnh nhỏ của vùng mặt: mặt nạ, nền sắc độ, độ sẫm cần nâng. */
function banDoDo(v, t) {
  const { sw: w, sh: h, R, G, B, Y, gs } = v;
  const n = w * h;
  const fw = 2.2 * gs.ed;
  const tmp = new Float32Array(n);
  const acc = new Float64Array(w);
  const cr = new Float32Array(n);
  const cg = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const su = R[i] + G[i] + B[i] + 1e-3;
    cr[i] = R[i] / su;
    cg[i] = G[i] / su;
  }
  const rN = Math.max(3, Math.round(0.04 * fw));
  // Hai lượt lọc hộp là đủ cho nền (mượt sẵn) — bước này chạy trên cả vùng mặt
  // mỗi tấm, ba lượt thì tốn gần gấp rưỡi.
  const blur2 = (src, r) => {
    const out = Float32Array.from(src);
    boxMean(out, w, h, r, out, tmp, acc);
    return boxMean(out, w, h, r, out, tmp, acc);
  };
  const nen = (wgt, kenh) => {
    const den = blur2(wgt, rN);
    return kenh.map((c) => {
      const pp = new Float32Array(n);
      for (let i = 0; i < n; i++) pp[i] = c[i] * wgt[i];
      const q = blur2(pp, rN);
      for (let i = 0; i < n; i++) q[i] = den[i] > 1e-3 ? q[i] / den[i] : c[i];
      return q;
    });
  };
  const crMo = boxMean(cr, w, h, 1, new Float32Array(n), tmp, acc);
  const w1 = new Float32Array(n);
  for (let i = 0; i < n; i++) w1[i] = t.vung[i];
  const [nr1] = nen(w1, [cr]);
  const w2 = new Float32Array(n);
  for (let i = 0; i < n; i++) w2[i] = t.vung[i] && crMo[i] - nr1[i] < KHU_DO_TU ? 1 : 0;
  const [nr, ng, nY] = nen(w2, [cr, cg, Y]);

  // Chỉ phần lõi vùng da (lùi khỏi mép vùng dò chừng 1–2% bề ngang mặt) và chỉ điểm
  // không tối hơn hẳn da quanh đó: chân tóc, đường viền hàm, mép môi, mí dưới,
  // lỗ mũi đều đỏ hơn da một cách tự nhiên — khử đỏ ở đó thì lỗ mũi thành tím,
  // chân tóc loang màu (thử 02/11).
  const vf = new Float32Array(n);
  for (let i = 0; i < n; i++) vf[i] = t.vung[i];
  const loi = blur2(vf, Math.max(2, Math.round(0.025 * fw)));
  // Cả hai cánh mũi + rãnh cánh mũi: đỏ hơn má một cách tự nhiên. Mặt quay thì
  // điểm mốc mũi là chóp mũi, còn cánh mũi phía gần máy ảnh lệch hẳn sang phía
  // khung mặt: dời tâm sang đó và nới ra — không thì viền lỗ mũi ngả tím (thử 02/11).
  const [ux, uy] = gs.u;
  const [vx, vy] = gs.v;
  const phiaGan = gs.quay ? Math.sign((gs.box.cx - gs.nose[0]) * vx + (gs.box.cy - gs.nose[1]) * vy) || 1 : 0;
  const noseA = gs.quay ? 0.7 : 0.46;
  const mx = gs.nose[0] - ux * 0.04 * gs.ed + vx * phiaGan * 0.2 * gs.ed;
  const my = gs.nose[1] - uy * 0.04 * gs.ed + vy * phiaGan * 0.2 * gs.ed;
  const m = new Float32Array(n);
  const la = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    if (!t.vung[i]) continue;
    const x = i % w;
    const y = (i - x) / w;
    const qa = ((x - mx) * vx + (y - my) * vy) / (noseA * gs.ed);
    const qb = ((x - mx) * ux + (y - my) * uy) / ((gs.quay ? 0.32 : 0.22) * gs.ed);
    const ngoaiMui = sstep(0.9, 1.2, Math.sqrt(qa * qa + qb * qb));
    // Chỗ đốm vừa chữa (t.ban): bản đồ này tính trên ảnh TRƯỚC khi chữa, khử đỏ
    // lần nữa là nâng sáng chồng lên thành mảng lấm tấm trắng (thử 02/11).
    const daChua = t.ban ? 1 - t.ban[i] : 1;
    m[i] = sstep(KHU_DO_TU, KHU_DO_DU, crMo[i] - nr[i]) * sstep(0.65, 0.85, loi[i]) * sstep(0.7, 0.85, Y[i] / Math.max(nY[i], 1)) * ngoaiMui * daChua;
    la[i] = m[i] > 0.5 ? 1 : 0;
  }
  // Mảng đỏ rộng (quá nửa vùng quanh nó, bán kính ~5% bề ngang mặt, cũng đỏ)
  // là màu tự nhiên của chỗ đó — má hồng, tai, đầu mũi — không phải vết.
  const rong = blur2(la, Math.max(3, Math.round(0.05 * fw)));
  for (let i = 0; i < n; i++) m[i] *= 1 - sstep(0.35, 0.6, rong[i]);
  const mm = blur2(m, 1);
  for (let i = 0; i < n; i++) if (!t.vung[i]) mm[i] = Math.min(mm[i], 0.3);
  const yMo = boxMean(Y, w, h, 1, new Float32Array(n), tmp, acc);
  const sam = new Float32Array(n);
  for (let i = 0; i < n; i++) sam[i] = Math.max(0, nY[i] - yMo[i]);
  return { m: mm, nr, ng, nY, sam };
}

/** Áp bản đồ khử đỏ lên ảnh gốc (song tuyến từ ảnh nhỏ), chỉ chỗ có mặt nạ. */
function apDo(rgb, width, v, bd) {
  const { roi, kx, ky, sw, sh } = v;
  const { m, nr, ng, nY, sam } = bd;
  const mau = (arr, i00, i01, i10, i11, w00, w01, w10, w11) =>
    arr[i00] * w00 + arr[i01] * w01 + arr[i10] * w10 + arr[i11] * w11;
  // Hàng ảnh nhỏ nào có mặt nạ: bỏ qua cả hàng ảnh gốc tương ứng.
  const coHang = new Uint8Array(sh);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < sw; x++) {
      if (m[y * sw + x] > 0.01) {
        coHang[y] = 1;
        break;
      }
    }
  }
  let doi = 0;
  for (let y = 0; y < roi.height; y++) {
    const fy = (y + 0.5) * ky - 0.5;
    const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
    const y1 = Math.min(sh - 1, y0 + 1);
    if (!coHang[y0] && !coHang[y1]) continue;
    const ty = Math.max(0, Math.min(1, fy - y0));
    for (let x = 0; x < roi.width; x++) {
      const fx = (x + 0.5) * kx - 0.5;
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const i00 = y0 * sw + x0;
      const i01 = y0 * sw + x1;
      const i10 = y1 * sw + x0;
      const i11 = y1 * sw + x1;
      const w00 = (1 - tx) * (1 - ty);
      const w01 = tx * (1 - ty);
      const w10 = (1 - tx) * ty;
      const w11 = tx * ty;
      let a = mau(m, i00, i01, i10, i11, w00, w01, w10, w11);
      if (a < 0.01) continue;
      const o = ((roi.top + y) * width + roi.left + x) * 3;
      const R = rgb[o];
      const G = rgb[o + 1];
      const B = rgb[o + 2];
      const su = R + G + B;
      if (su < 30) continue;
      // Điểm tối hơn hẳn da quanh đó (lòng lỗ mũi, kẽ tóc) nằm sát mép mặt nạ:
      // đổi sắc độ ở đó là ra màu tím (thử 02/11) — để nguyên.
      a *= sstep(0.7, 0.9, (0.299 * R + 0.587 * G + 0.114 * B) / Math.max(1, mau(nY, i00, i01, i10, i11, w00, w01, w10, w11)));
      if (a < 0.01) continue;
      const r = R / su;
      const g = G / su;
      const r0 = mau(nr, i00, i01, i10, i11, w00, w01, w10, w11);
      if (r <= r0) continue;
      const g0 = mau(ng, i00, i01, i10, i11, w00, w01, w10, w11);
      const r2 = r - a * (r - r0);
      const g2 = g - a * (g - g0);
      const b2 = 1 - r2 - g2;
      const Y2 = 0.299 * R + 0.587 * G + 0.114 * B + 0.8 * a * mau(sam, i00, i01, i10, i11, w00, w01, w10, w11);
      const k = Y2 / (0.299 * r2 + 0.587 * g2 + 0.114 * b2);
      const vals = [k * r2, k * g2, k * b2];
      for (let c = 0; c < 3; c++) {
        const val = vals[c] + 0.5;
        rgb[o + c] = val <= 0 ? 0 : val >= 255 ? 255 : val | 0;
      }
      doi++;
    }
  }
  return doi;
}

/**
 * Nhặt mụn trên mọi mặt trong `faces` (`rgb`: Buffer RGB 8 bit, SỬA TẠI CHỖ):
 * chữa từng đốm, rồi khử đỏ phần còn lại. Trả về số đốm đã chữa. `nhay`: độ
 * nhạy (1 = mặc định). `onDoDo` (chỉ để thử): nhận bản đồ khử đỏ của mỗi mặt.
 */
export async function nhatMun(rgb, width, height, faces, { nhay = 1, khuDo = true, onMun = null, onDo = null, onDoDo = null } = {}) {
  let tong = 0;
  for (const f of faces) {
    const v = await vungMat(rgb, width, height, f, FACE_W, RONG);
    // Điểm mốc không tin được (mặt bị che, nghiêng quá): vùng chừa mắt / môi /
    // mũi chỉ là ước chừng — làm mịn thì không sao, chữa đốm thì dễ chữa nhầm.
    if (!v || !v.gs.ok) continue;
    // onDo (chỉ để thử / chỉnh ngưỡng): mọi ứng viên, kèm lý do bị loại, toạ độ ảnh gốc.
    const doGoc = onDo && ((d) => onDo({ ...d, x: (d.cx + 0.5) / v.kx - 0.5 + v.roi.left, y: (d.cy + 0.5) / v.ky - 0.5 + v.roi.top }));
    const t = timMun(v, nhay, doGoc);
    for (const s of t.spots) if (chua(rgb, width, height, v, s, t, onMun)) tong++;
    // Bản đồ tính trên ảnh nhỏ TRƯỚC khi chữa đốm, nên chừa hẳn chỗ vừa chữa.
    if (khuDo && t.sc) {
      const bd = banDoDo(v, t);
      if (onDoDo) onDoDo({ v, bd });
      apDo(rgb, width, v, bd);
    }
  }
  return tong;
}
