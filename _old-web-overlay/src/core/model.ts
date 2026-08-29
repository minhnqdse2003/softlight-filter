import type { SmoothModel, SolvedField } from './types';

/**
 * MÔ HÌNH MƯỢT
 * ------------
 * Trường nghiệm giải ra ở lưới làm việc bị dính nhiễu và bị "thủng" ở những
 * vùng phông trơn (không đủ biến thiên để suy ra alpha). Thay vì xuất thẳng
 * bitmap đó ra, ta fit nó bằng một hàm giải tích mượt của toạ độ chuẩn hoá.
 *
 * Lợi ích quyết định: hàm này đánh giá lại được ở BẤT KỲ kích thước và tỷ lệ
 * khung hình nào. Ảnh mẫu dọc 1206×2622 vẫn sinh ra overlay 1800×1200 ngang
 * sắc nét, không kéo giãn, không vỡ hạt — điều mà một pixel-map không làm được.
 *
 * Cơ sở hàm gồm đa thức toàn bậc theo (nx, ny) cộng thêm vài số hạng bán kính
 * phi đa thức để tả vignette / light-leak toả tròn bằng rất ít hệ số.
 */

export function termCount(degree: number, radial: boolean): number {
  return ((degree + 1) * (degree + 2)) / 2 + (radial ? 3 : 0);
}

/** Tính vector cơ sở tại toạ độ chuẩn hoá nx, ny ∈ [−1, 1]. */
export function basis(nx: number, ny: number, degree: number, radial: boolean, out: Float64Array): void {
  let k = 0;
  for (let total = 0; total <= degree; total++) {
    for (let i = total; i >= 0; i--) {
      const j = total - i;
      out[k++] = Math.pow(nx, i) * Math.pow(ny, j);
    }
  }
  if (radial) {
    const r2 = nx * nx + ny * ny;
    const r = Math.sqrt(r2);
    out[k++] = r;
    out[k++] = r * r2;
    out[k++] = 1 - Math.exp(-2 * r2);
  }
}

/** Giải hệ tuyến tính đối xứng bằng khử Gauss có chọn trục, kèm ridge nhẹ. */
function solveLinear(A: Float64Array, b: Float64Array, m: number): Float64Array {
  let trace = 0;
  for (let i = 0; i < m; i++) trace += A[i * m + i];
  const ridge = (trace / m) * 1e-9 + 1e-12;
  for (let i = 0; i < m; i++) A[i * m + i] += ridge;

  const x = new Float64Array(m);
  for (let col = 0; col < m; col++) {
    let piv = col;
    for (let r = col + 1; r < m; r++) if (Math.abs(A[r * m + col]) > Math.abs(A[piv * m + col])) piv = r;
    if (piv !== col) {
      for (let c = 0; c < m; c++) {
        const t = A[col * m + c];
        A[col * m + c] = A[piv * m + c];
        A[piv * m + c] = t;
      }
      const t = b[col];
      b[col] = b[piv];
      b[piv] = t;
    }
    const d = A[col * m + col];
    if (Math.abs(d) < 1e-14) continue;
    for (let r = col + 1; r < m; r++) {
      const f = A[r * m + col] / d;
      if (!f) continue;
      for (let c = col; c < m; c++) A[r * m + c] -= f * A[col * m + c];
      b[r] -= f * b[col];
    }
  }
  for (let r = m - 1; r >= 0; r--) {
    let s = b[r];
    for (let c = r + 1; c < m; c++) s -= A[r * m + c] * x[c];
    const d = A[r * m + r];
    x[r] = Math.abs(d) < 1e-14 ? 0 : s / d;
  }
  return x;
}

/**
 * Fit mô hình mượt vào trường đã giải, có trọng số theo độ tin cậy mỗi pixel.
 * Bốn kênh (a, u_r, u_g, u_b) dùng chung ma trận chuẩn tắc nên chỉ phân tích
 * một lần rồi giải bốn vế phải.
 */
export function fitModel(f: SolvedField, degree: number, radial: boolean): SmoothModel {
  const m = termCount(degree, radial);
  const phi = new Float64Array(m);
  const ATA = new Float64Array(m * m);
  const ATb = [new Float64Array(m), new Float64Array(m), new Float64Array(m), new Float64Array(m)];

  // Chuẩn hoá trọng số để ridge không phụ thuộc kích thước ảnh.
  let wMax = 0;
  for (let i = 0; i < f.weight.length; i++) if (f.weight[i] > wMax) wMax = f.weight[i];
  const wScale = wMax > 0 ? 1 / wMax : 0;

  const stride = Math.max(1, Math.round(Math.max(f.w, f.h) / 320));
  for (let y = 0; y < f.h; y += stride) {
    const ny = (y / (f.h - 1)) * 2 - 1;
    for (let x = 0; x < f.w; x += stride) {
      const i = y * f.w + x;
      const wt = f.weight[i] * wScale;
      if (wt <= 1e-4) continue;
      const nx = (x / (f.w - 1)) * 2 - 1;
      basis(nx, ny, degree, radial, phi);
      for (let r = 0; r < m; r++) {
        const pw = phi[r] * wt;
        for (let c = r; c < m; c++) ATA[r * m + c] += pw * phi[c];
        ATb[0][r] += pw * f.a[i];
        ATb[1][r] += pw * f.u[i * 3];
        ATb[2][r] += pw * f.u[i * 3 + 1];
        ATb[3][r] += pw * f.u[i * 3 + 2];
      }
    }
  }
  for (let r = 0; r < m; r++) for (let c = 0; c < r; c++) ATA[r * m + c] = ATA[c * m + r];

  const ca = solveLinear(ATA.slice(), ATb[0].slice(), m);
  const cu = new Float64Array(m * 3);
  for (let ch = 0; ch < 3; ch++) {
    const sol = solveLinear(ATA.slice(), ATb[ch + 1].slice(), m);
    for (let k = 0; k < m; k++) cu[k * 3 + ch] = sol[k];
  }

  return { degree, radial, terms: m, ca: new Float64Array(ca), cu };
}

/** Đánh giá mô hình tại toạ độ chuẩn hoá, trả [a, u_r, u_g, u_b] chưa kẹp. */
export function evalModel(model: SmoothModel, nx: number, ny: number, phi: Float64Array, out: Float64Array): void {
  basis(nx, ny, model.degree, model.radial, phi);
  let a = 0;
  let ur = 0;
  let ug = 0;
  let ub = 0;
  for (let k = 0; k < model.terms; k++) {
    const p = phi[k];
    a += model.ca[k] * p;
    ur += model.cu[k * 3] * p;
    ug += model.cu[k * 3 + 1] * p;
    ub += model.cu[k * 3 + 2] * p;
  }
  out[0] = a;
  out[1] = ur;
  out[2] = ug;
  out[3] = ub;
}

/** Dựng lại mô hình trên đúng lưới làm việc, dùng để tách phần dư (grain). */
export function renderModelToField(model: SmoothModel, w: number, h: number): SolvedField {
  const n = w * h;
  const a = new Float32Array(n);
  const u = new Float32Array(n * 3);
  const phi = new Float64Array(model.terms);
  const out = new Float64Array(4);
  for (let y = 0; y < h; y++) {
    const ny = (y / (h - 1)) * 2 - 1;
    for (let x = 0; x < w; x++) {
      const nx = (x / (w - 1)) * 2 - 1;
      evalModel(model, nx, ny, phi, out);
      const i = y * w + x;
      const av = Math.min(0.98, Math.max(0, out[0]));
      a[i] = av;
      for (let c = 0; c < 3; c++) u[i * 3 + c] = Math.min(av, Math.max(0, out[c + 1]));
    }
  }
  return { w, h, a, u, residual: new Float32Array(n), weight: new Float32Array(n) };
}

/**
 * Bọc mô hình đa thức thành hàm đánh giá dùng chung với soft light, kèm việc
 * kẹp nghiệm về miền hợp lệ (alpha ≥ 0, màu premultiplied trong [0, alpha]).
 */
export function evaluatorFromModel(
  model: SmoothModel,
  strength = 1,
): (nx: number, ny: number, out: Float64Array) => void {
  const phi = new Float64Array(model.terms);
  const tmp = new Float64Array(4);
  return (nx, ny, out) => {
    evalModel(model, nx, ny, phi, tmp);
    const a = Math.min(0.98, Math.max(0, tmp[0] * strength));
    out[0] = a;
    for (let c = 0; c < 3; c++) out[c + 1] = Math.min(a, Math.max(0, tmp[c + 1] * strength));
  };
}
