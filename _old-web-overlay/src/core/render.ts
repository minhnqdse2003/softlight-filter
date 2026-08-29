import type { RenderSettings } from './types';
import { generateGrain } from './grain';

/** Alpha tối đa cho phép. Chặn ở 0.98 để overlay không bao giờ xoá hẳn ảnh. */
const A_MAX = 0.98;

/**
 * Hàm đánh giá overlay tại toạ độ chuẩn hoá (nx, ny) ∈ [−1, 1].
 * out = [alpha, u_r, u_g, u_b], u là màu premultiplied.
 *
 * Cả hai nguồn overlay đều cài đặt giao diện này: mô hình soft light dựng bằng
 * tham số, và mô hình đa thức giải ngược từ cặp ảnh. Nhờ vậy phần render, xem
 * trước và xuất file dùng chung một đường đi duy nhất.
 */
export type Evaluator = (nx: number, ny: number, out: Float64Array) => void;

export interface GrainSpec {
  /** Biên độ hạt, độ lệch chuẩn trên thang 0..1. */
  sigma: number;
  /** Kích thước hạt, tính bằng pixel ở độ phân giải tham chiếu refDim. */
  size: number;
  /** Mức đơn sắc, 1 = xám hoàn toàn. */
  mono: number;
  /** Cạnh dài của khung mà `size` được đo. */
  refDim: number;
  /** Bitmap hạt cố định (RGB xen kẽ) cho chế độ "giữ nguyên grain". */
  fixed?: Float32Array;
  fw?: number;
  fh?: number;
}

export interface RenderReport {
  /** Tỷ lệ pixel bị cắt hạt do alpha không đủ chỗ chứa biên độ hạt, 0..1. */
  grainClipped: number;
  /** Alpha trung bình trên vùng có phủ. */
  meanAlpha: number;
}

/** Lấy mẫu song tuyến bitmap hạt cố định theo toạ độ chuẩn hoá. */
function sampleFixed(g: GrainSpec, nx: number, ny: number, out: Float64Array): void {
  const data = g.fixed!;
  const gw = g.fw!;
  const gh = g.fh!;
  const fx = ((nx + 1) / 2) * (gw - 1);
  const fy = ((ny + 1) / 2) * (gh - 1);
  const x0 = Math.max(0, Math.min(gw - 1, Math.floor(fx)));
  const y0 = Math.max(0, Math.min(gh - 1, Math.floor(fy)));
  const x1 = Math.min(gw - 1, x0 + 1);
  const y1 = Math.min(gh - 1, y0 + 1);
  const tx = fx - x0;
  const ty = fy - y0;
  for (let c = 0; c < 3; c++) {
    const a = data[(y0 * gw + x0) * 3 + c] * (1 - tx) + data[(y0 * gw + x1) * 3 + c] * tx;
    const b = data[(y1 * gw + x0) * 3 + c] * (1 - tx) + data[(y1 * gw + x1) * 3 + c] * tx;
    out[c] = a * (1 - ty) + b * ty;
  }
}

/**
 * Render overlay RGBA — alpha thẳng, KHÔNG premultiplied, đúng chuẩn PNG mà
 * dslrBooth đọc — ở kích thước canvas đích.
 *
 * Chế độ 'sheet' trải overlay lên toàn tờ; chế độ 'cells' áp lại cho từng ô ảnh
 * và để phần ngoài ô trong suốt hoàn toàn.
 */
export function renderOverlay(
  evalAt: Evaluator,
  grain: GrainSpec | null,
  s: RenderSettings,
): { image: ImageData; report: RenderReport } {
  const W = s.canvas.w;
  const H = s.canvas.h;
  const img = new ImageData(W, H);
  const d = img.data;
  const ev = new Float64Array(4);
  const gs = new Float64Array(3);

  // Hạt được đo ở độ phân giải tham chiếu; quy về canvas đích theo tỷ lệ khung
  // hình để giữ nguyên cảm giác thị giác ở mọi kích thước in.
  let proc: Float32Array | null = null;
  const wantGrain = !!grain && s.grainMode !== 'off' && s.grainAmount > 0;
  if (wantGrain && s.grainMode === 'procedural') {
    const k = Math.max(W, H) / grain!.refDim;
    const cellPx = Math.max(1, grain!.size * k * s.grainScale);
    proc = generateGrain(W, H, cellPx, grain!.sigma * s.grainAmount, grain!.mono);
  }
  const useFixed = wantGrain && s.grainMode === 'original' && !!grain!.fixed;
  const useCells = s.applyMode === 'cells' && s.cells.length > 0;

  let clipped = 0;
  let covered = 0;
  let alphaSum = 0;

  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const i = y * W + x;
      const o = i * 4;

      let nx = 0;
      let ny = 0;
      if (useCells) {
        let hit = false;
        for (const cell of s.cells) {
          const cx0 = cell.x * W;
          const cy0 = cell.y * H;
          const cw = cell.w * W;
          const ch = cell.h * H;
          if (x >= cx0 && x < cx0 + cw && y >= cy0 && y < cy0 + ch) {
            nx = ((x - cx0) / Math.max(1, cw - 1)) * 2 - 1;
            ny = ((y - cy0) / Math.max(1, ch - 1)) * 2 - 1;
            hit = true;
            break;
          }
        }
        if (!hit) {
          d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
          continue;
        }
      } else {
        nx = (x / (W - 1)) * 2 - 1;
        ny = (y / (H - 1)) * 2 - 1;
      }

      evalAt(nx, ny, ev);
      const a = Math.min(A_MAX, Math.max(0, ev[0]));
      const u = [Math.max(0, ev[1]), Math.max(0, ev[2]), Math.max(0, ev[3])];

      if (useFixed) {
        sampleFixed(grain!, nx, ny, gs);
        for (let c = 0; c < 3; c++) u[c] += gs[c] * s.grainAmount;
      } else if (proc) {
        for (let c = 0; c < 3; c++) u[c] += proc[i * 3 + c];
      }

      // Ràng buộc vật lý: màu premultiplied phải nằm trong [0, a], nếu vượt thì
      // cặp (màu, alpha) không còn biểu diễn được bằng một lớp PNG hợp lệ.
      let clip = false;
      for (let c = 0; c < 3; c++) {
        if (u[c] > a) { u[c] = a; clip = true; }
        else if (u[c] < 0) { u[c] = 0; clip = true; }
      }
      if (clip) clipped++;

      if (a <= 0.0005) {
        d[o] = 0; d[o + 1] = 0; d[o + 2] = 0; d[o + 3] = 0;
        continue;
      }
      covered++;
      alphaSum += a;
      d[o] = Math.round(Math.min(255, (u[0] / a) * 255));
      d[o + 1] = Math.round(Math.min(255, (u[1] / a) * 255));
      d[o + 2] = Math.round(Math.min(255, (u[2] / a) * 255));
      d[o + 3] = Math.round(a * 255);
    }
  }

  return {
    image: img,
    report: {
      grainClipped: clipped / (W * H),
      meanAlpha: covered ? alphaSum / covered : 0,
    },
  };
}

/**
 * Ghép overlay lên ảnh nền đúng theo cách dslrBooth làm (source-over trên giá
 * trị sRGB 8-bit) để xem trước khớp với kết quả in ra.
 */
export function compositeOver(base: ImageData, overlay: ImageData): ImageData {
  const out = new ImageData(base.width, base.height);
  const b = base.data;
  const o = overlay.data;
  const r = out.data;
  const n = base.width * base.height;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    const a = o[k + 3] / 255;
    r[k] = Math.round(o[k] * a + b[k] * (1 - a));
    r[k + 1] = Math.round(o[k + 1] * a + b[k + 1] * (1 - a));
    r[k + 2] = Math.round(o[k + 2] * a + b[k + 2] * (1 - a));
    r[k + 3] = 255;
  }
  return out;
}

/** Bản đồ nhiệt sai lệch giữa hai ảnh, thang 0..maxDelta mức 8-bit. */
export function errorHeatmap(a: ImageData, b: ImageData, maxDelta = 12): ImageData {
  const out = new ImageData(a.width, a.height);
  const n = a.width * a.height;
  for (let i = 0, k = 0; i < n; i++, k += 4) {
    const dr = a.data[k] - b.data[k];
    const dg = a.data[k + 1] - b.data[k + 1];
    const db = a.data[k + 2] - b.data[k + 2];
    const e = Math.sqrt((dr * dr + dg * dg + db * db) / 3);
    const t = Math.min(1, e / maxDelta);
    out.data[k] = Math.round(255 * Math.min(1, t * 2));
    out.data[k + 1] = Math.round(255 * Math.min(1, Math.max(0, 2 - t * 2)) * Math.min(1, t * 2));
    out.data[k + 2] = Math.round(255 * Math.max(0, 1 - t * 2));
    out.data[k + 3] = 255;
  }
  return out;
}
