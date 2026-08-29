import type { SolvedField } from './types';

/**
 * GIẢI NGƯỢC LỚP OVERLAY
 * ----------------------
 * Phép ghép alpha mà dslrBooth dùng, với mỗi kênh màu:
 *
 *     t = c·a + s·(1 − a)
 *
 * trong đó s = ảnh gốc, t = ảnh đích (đã filter), c = màu overlay, a = alpha.
 * Đặt u = c·a (màu premultiplied) thì phương trình trở thành TUYẾN TÍNH theo
 * bốn ẩn (u_r, u_g, u_b, a):
 *
 *     t_k − s_k = u_k − a·s_k
 *
 * Một pixel đơn lẻ cho 3 phương trình / 4 ẩn — thiếu ràng buộc. Nên với mỗi
 * pixel ta gom mẫu từ một cửa sổ lân cận, trên TẤT CẢ các cặp ảnh, và giả thiết
 * overlay gần như không đổi trong cửa sổ đó. Khi ấy hệ trở thành thừa xác định
 * và có nghiệm bình phương tối thiểu dạng đóng:
 *
 *     a  = 1 − Σ(ŝ·t̂) / Σ(ŝ²)            (mũ ^ = đã trừ trung bình cửa sổ)
 *     u_k = T̄_k − (1 − a)·S̄_k
 *
 * Diễn giải trực quan: alpha chính là phần tương phản của ảnh gốc bị lớp phủ
 * "nuốt" mất, còn u là phần màu được cộng thêm. Đúng bằng định nghĩa của một
 * lớp fade/lift — thứ tạo nên cảm giác "soft light".
 *
 * Tổng cửa sổ được tính bằng bảng tổng tích luỹ (summed-area table) nên chi phí
 * mỗi pixel là O(1), không phụ thuộc bán kính cửa sổ.
 */

/** Bán kính cửa sổ lấy mẫu mặc định, tính bằng pixel trên lưới làm việc. */
export const WINDOW_RADIUS = 6;

/** Dựng bảng tổng tích luỹ (w+1)×(h+1) từ một trường float. */
function integral(v: Float64Array, w: number, h: number): Float64Array {
  const iw = w + 1;
  const out = new Float64Array(iw * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    const o = (y + 1) * iw;
    const p = y * iw;
    for (let x = 0; x < w; x++) {
      row += v[y * w + x];
      out[o + x + 1] = out[p + x + 1] + row;
    }
  }
  return out;
}

/** Tổng trên hình chữ nhật [x0,x1)×[y0,y1) từ bảng tích luỹ. */
function rectSum(I: Float64Array, iw: number, x0: number, y0: number, x1: number, y1: number): number {
  return I[y1 * iw + x1] - I[y0 * iw + x1] - I[y1 * iw + x0] + I[y0 * iw + x0];
}

export interface SolveInput {
  /** Ảnh gốc của từng cặp, RGB float 0..1, xen kẽ, đã căn về cùng lưới. */
  srcs: Float32Array[];
  /** Ảnh đích tương ứng. */
  dsts: Float32Array[];
  w: number;
  h: number;
  radius?: number;
}

/**
 * Giải trường overlay (alpha + màu premultiplied) trên toàn ảnh.
 */
export function solveField(input: SolveInput): SolvedField {
  const { srcs, dsts, w, h } = input;
  const R = input.radius ?? WINDOW_RADIUS;
  const n = w * h;
  const P = srcs.length;
  if (P === 0) throw new Error('Chưa có cặp ảnh nào để bake.');

  // Cộng dồn thống kê qua TẤT CẢ các cặp trước khi dựng bảng tích luỹ:
  // mọi tổng đều cộng được nên bộ nhớ không tăng theo số cặp.
  const accS = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const accT = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const accSS = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const accTT = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];
  const accST = [new Float64Array(n), new Float64Array(n), new Float64Array(n)];

  for (let p = 0; p < P; p++) {
    const S = srcs[p];
    const T = dsts[p];
    for (let i = 0, k = 0; i < n; i++, k += 3) {
      for (let c = 0; c < 3; c++) {
        const s = S[k + c];
        const t = T[k + c];
        accS[c][i] += s;
        accT[c][i] += t;
        accSS[c][i] += s * s;
        accTT[c][i] += t * t;
        accST[c][i] += s * t;
      }
    }
  }

  const iw = w + 1;
  const IS = accS.map((v) => integral(v, w, h));
  const IT = accT.map((v) => integral(v, w, h));
  const ISS = accSS.map((v) => integral(v, w, h));
  const ITT = accTT.map((v) => integral(v, w, h));
  const IST = accST.map((v) => integral(v, w, h));

  const a = new Float32Array(n);
  const u = new Float32Array(n * 3);
  const residual = new Float32Array(n);
  const weight = new Float32Array(n);

  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - R);
    const y1 = Math.min(h, y + R + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - R);
      const x1 = Math.min(w, x + R + 1);
      const px = (x1 - x0) * (y1 - y0);
      const m = px * P; // tổng số mẫu = số pixel cửa sổ × số cặp ảnh

      // Bước 1 — alpha, gộp cả 3 kênh vào một bài toán 1 chiều.
      let numer = 0; // Σ ŝ·t̂
      let denom = 0; // Σ ŝ²
      const sBar = [0, 0, 0];
      const tBar = [0, 0, 0];
      const sumSS = [0, 0, 0];
      const sumTT = [0, 0, 0];
      const sumST = [0, 0, 0];
      for (let c = 0; c < 3; c++) {
        const ss = rectSum(IS[c], iw, x0, y0, x1, y1);
        const st = rectSum(IT[c], iw, x0, y0, x1, y1);
        const s2 = rectSum(ISS[c], iw, x0, y0, x1, y1);
        const t2 = rectSum(ITT[c], iw, x0, y0, x1, y1);
        const sxt = rectSum(IST[c], iw, x0, y0, x1, y1);
        sBar[c] = ss / m;
        tBar[c] = st / m;
        sumSS[c] = s2;
        sumTT[c] = t2;
        sumST[c] = sxt;
        numer += sxt - (ss * st) / m;
        denom += s2 - (ss * ss) / m;
      }

      const i = y * w + x;
      weight[i] = denom;

      let av: number;
      if (denom < 1e-7) {
        // Vùng phẳng tuyệt đối: không suy ra được alpha. Đánh dấu trọng số 0,
        // giá trị ở đây sẽ do bước fit mô hình mượt nội suy từ vùng lân cận.
        av = 0;
      } else {
        av = 1 - numer / denom;
      }
      av = Math.min(0.98, Math.max(0, av));
      a[i] = av;

      // Bước 2 — màu premultiplied, mỗi kênh độc lập, kẹp về miền hợp lệ [0, a].
      let sse = 0;
      for (let c = 0; c < 3; c++) {
        let uc = tBar[c] - (1 - av) * sBar[c];
        uc = Math.min(av, Math.max(0, uc));
        u[i * 3 + c] = uc;
        // Σ r² với r = u − t + (1−a)·s, khai triển theo các tổng đã có.
        const b = 1 - av;
        sse +=
          m * uc * uc +
          sumTT[c] +
          b * b * sumSS[c] -
          2 * uc * (tBar[c] * m) +
          2 * uc * b * (sBar[c] * m) -
          2 * b * sumST[c];
      }
      residual[i] = Math.sqrt(Math.max(0, sse) / (m * 3));
    }
  }

  return { w, h, a, u, residual, weight };
}
