import type { GrainStats, SolvedField } from './types';

/**
 * TÁCH VÀ TÁI TẠO LỚP HẠT
 * -----------------------
 * Mô hình mượt chỉ tả được thành phần tần số thấp. Hạt film nằm ở tần số cao và
 * phải xử lý riêng, vì kéo giãn một bitmap hạt từ ảnh mẫu lên 300dpi sẽ ra
 * những cục mờ chứ không phải hạt.
 *
 * Từ phương trình ghép alpha, sau khi lọc thông cao (u là thành phần mượt nên
 * bị lọc bỏ):
 *
 *     hp(t) = (1 − a)·hp(s) + hp(grain)
 *
 * nên phần hạt do filter thêm vào tách được trực tiếp:
 *
 *     g = hp(t) − (1 − a)·hp(s)
 *
 * Trung bình g qua nhiều cặp ảnh cho ra thành phần hạt CỐ ĐỊNH (đúng thứ mà một
 * overlay tĩnh tái tạo được); độ lệch chuẩn của từng cặp cho ra biên độ tổng để
 * sinh lại hạt bằng nhiễu procedural.
 */

/** Lọc thông cao bằng cách trừ đi trung bình cửa sổ 3×3. */
function highpass(v: Float32Array, w: number, h: number, ch: number, c: number): Float32Array {
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const ym = Math.max(0, y - 1);
    const yp = Math.min(h - 1, y + 1);
    for (let x = 0; x < w; x++) {
      const xm = Math.max(0, x - 1);
      const xp = Math.min(w - 1, x + 1);
      let s = 0;
      for (const yy of [ym, y, yp]) for (const xx of [xm, x, xp]) s += v[(yy * w + xx) * ch + c];
      out[y * w + x] = v[(y * w + x) * ch + c] - s / 9;
    }
  }
  return out;
}

export interface GrainResult {
  stats: GrainStats;
  /** Thành phần hạt cố định, RGB xen kẽ, độ dài w*h*3. Dùng cho chế độ "giữ nguyên". */
  fixed: Float32Array;
  w: number;
  h: number;
}

export function analyzeGrain(
  srcs: Float32Array[],
  dsts: Float32Array[],
  field: SolvedField,
): GrainResult {
  const { w, h } = field;
  const n = w * h;
  const P = srcs.length;
  const fixed = new Float32Array(n * 3);
  const sigmaCh = [0, 0, 0];

  const perPair: Float32Array[][] = [];
  for (let p = 0; p < P; p++) {
    const chans: Float32Array[] = [];
    for (let c = 0; c < 3; c++) {
      const hs = highpass(srcs[p], w, h, 3, c);
      const ht = highpass(dsts[p], w, h, 3, c);
      const g = new Float32Array(n);
      for (let i = 0; i < n; i++) g[i] = ht[i] - (1 - field.a[i]) * hs[i];
      chans.push(g);
      let sum = 0;
      for (let i = 0; i < n; i++) sum += g[i];
      const mean = sum / n;
      let varr = 0;
      for (let i = 0; i < n; i++) varr += (g[i] - mean) ** 2;
      sigmaCh[c] += Math.sqrt(varr / n) / P;
      for (let i = 0; i < n; i++) fixed[i * 3 + c] += g[i] / P;
    }
    perPair.push(chans);
  }

  // Kích thước hạt suy từ tự tương quan trễ 1. Với hạt gần dạng khối cạnh L thì
  // rho ≈ 1 − 1/L, nên L ≈ 1/(1 − rho).
  const probe = perPair[0][1]; // kênh lục, nhiễu thấp nhất
  let num = 0;
  let den = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      const i = y * w + x;
      num += probe[i] * probe[i + 1];
      den += probe[i] * probe[i];
    }
  }
  const rho = den > 1e-12 ? Math.max(-0.5, Math.min(0.95, num / den)) : 0;
  const size = Math.max(0.7, Math.min(8, 1 / Math.max(0.12, 1 - rho)));

  // Mức đơn sắc: tương quan giữa kênh đỏ và lam của phần hạt.
  let rb = 0;
  let rr = 0;
  let bb = 0;
  const g0 = perPair[0];
  for (let i = 0; i < n; i++) {
    rb += g0[0][i] * g0[2][i];
    rr += g0[0][i] * g0[0][i];
    bb += g0[2][i] * g0[2][i];
  }
  const mono = rr > 1e-12 && bb > 1e-12 ? Math.max(0, Math.min(1, rb / Math.sqrt(rr * bb))) : 1;

  const stats: GrainStats = {
    sigmaA: 0,
    sigmaC: (sigmaCh[0] + sigmaCh[1] + sigmaCh[2]) / 3,
    size,
    mono,
  };
  return { stats, fixed, w, h };
}

/** Bộ sinh số giả ngẫu nhiên tất định để mỗi lần render ra cùng một kết quả. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function gauss(rand: () => number): number {
  // Box–Muller, chỉ lấy một nhánh.
  const u = Math.max(1e-9, rand());
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rand());
}

/**
 * Sinh hạt procedural ở ĐÚNG độ phân giải đích. `cellPx` là kích thước một hạt
 * tính theo pixel của canvas đích, nên hạt luôn sắc nét ở 300dpi thay vì bị
 * phóng to từ ảnh mẫu.
 */
export function generateGrain(
  w: number,
  h: number,
  cellPx: number,
  sigma: number,
  mono: number,
  seed = 1234,
): Float32Array {
  const cw = Math.max(1, Math.ceil(w / cellPx));
  const chh = Math.max(1, Math.ceil(h / cellPx));
  const rand = mulberry32(seed);
  const lo = new Float32Array(cw * chh * 3);
  for (let i = 0; i < cw * chh; i++) {
    const g = gauss(rand);
    for (let c = 0; c < 3; c++) lo[i * 3 + c] = mono * g + (1 - mono) * gauss(rand);
  }

  // Nội suy song tuyến lên kích thước đích rồi chuẩn hoá lại biên độ, vì phép
  // nội suy làm giảm phương sai.
  const out = new Float32Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    const gy = Math.min(chh - 1.0001, (y / cellPx));
    const y0 = Math.floor(gy);
    const y1 = Math.min(chh - 1, y0 + 1);
    const fy = gy - y0;
    for (let x = 0; x < w; x++) {
      const gx = Math.min(cw - 1.0001, x / cellPx);
      const x0 = Math.floor(gx);
      const x1 = Math.min(cw - 1, x0 + 1);
      const fx = gx - x0;
      for (let c = 0; c < 3; c++) {
        const a = lo[(y0 * cw + x0) * 3 + c] * (1 - fx) + lo[(y0 * cw + x1) * 3 + c] * fx;
        const b = lo[(y1 * cw + x0) * 3 + c] * (1 - fx) + lo[(y1 * cw + x1) * 3 + c] * fx;
        out[(y * w + x) * 3 + c] = a * (1 - fy) + b * fy;
      }
    }
  }
  let sum = 0;
  for (let i = 0; i < out.length; i++) sum += out[i] * out[i];
  const cur = Math.sqrt(sum / out.length) || 1;
  const k = sigma / cur;
  for (let i = 0; i < out.length; i++) out[i] *= k;
  return out;
}
