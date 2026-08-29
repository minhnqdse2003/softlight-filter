import type { Align } from './types';

/**
 * Độ phân giải lưới làm việc (cạnh dài nhất). Toàn bộ việc giải nghiệm chạy
 * trên lưới này; overlay cuối cùng được render lại từ mô hình mượt nên
 * độ phân giải ở đây không giới hạn chất lượng file xuất ra.
 */
export const WORK_MAX = 720;

/**
 * LƯU Ý QUAN TRỌNG VỀ KHÔNG GIAN MÀU:
 * dslrBooth — như mọi trình composite 2D — trộn overlay trên giá trị sRGB
 * đã mã hoá 8-bit, không phải ánh sáng tuyến tính. Vì vậy toàn bộ pipeline ở
 * đây cố ý làm việc thẳng trên giá trị sRGB 0..1, KHÔNG chuyển sang linear.
 * Chuyển sang linear sẽ cho nghiệm "đúng vật lý" nhưng sai so với cách
 * dslrBooth thực sự ghép ảnh.
 */

export async function loadBitmap(file: Blob): Promise<ImageBitmap> {
  return createImageBitmap(file, { colorSpaceConversion: 'default' });
}

function scratch(w: number, h: number): CanvasRenderingContext2D {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('Trình duyệt không tạo được canvas 2D.');
  return ctx;
}

/** Kích thước lưới làm việc suy ra từ ảnh gốc, cạnh dài nhất = WORK_MAX. */
export function workSize(bmp: { width: number; height: number }): { w: number; h: number } {
  const k = Math.min(1, WORK_MAX / Math.max(bmp.width, bmp.height));
  return { w: Math.max(2, Math.round(bmp.width * k)), h: Math.max(2, Math.round(bmp.height * k)) };
}

/**
 * Vẽ bitmap vào lưới w×h theo kiểu "cover" (giữ tỷ lệ, cắt phần thừa), rồi
 * áp thêm phép căn chỉnh scale-quanh-tâm + dịch. Trả về ImageData.
 */
export function rasterize(bmp: ImageBitmap, w: number, h: number, align?: Align): ImageData {
  const ctx = scratch(w, h);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, w, h);

  const cover = Math.max(w / bmp.width, h / bmp.height);
  const s = cover * (align?.scale ?? 1);
  const dw = bmp.width * s;
  const dh = bmp.height * s;
  const dx = (w - dw) / 2 + (align?.dx ?? 0);
  const dy = (h - dh) / 2 + (align?.dy ?? 0);
  ctx.drawImage(bmp, dx, dy, dw, dh);
  return ctx.getImageData(0, 0, w, h);
}

/** Tách ImageData thành 3 mảng float 0..1 theo kênh, bỏ alpha. */
export function toFloatRGB(img: ImageData): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  const d = img.data;
  for (let i = 0, j = 0, k = 0; i < n; i++, j += 4, k += 3) {
    out[k] = d[j] / 255;
    out[k + 1] = d[j + 1] / 255;
    out[k + 2] = d[j + 2] / 255;
  }
  return out;
}

/** Độ sáng (luma Rec.709) từ mảng RGB float, dùng cho việc căn ảnh. */
export function luma(rgb: Float32Array, n: number): Float32Array {
  const out = new Float32Array(n);
  for (let i = 0, k = 0; i < n; i++, k += 3) {
    out[i] = 0.2126 * rgb[k] + 0.7152 * rgb[k + 1] + 0.0722 * rgb[k + 2];
  }
  return out;
}

/**
 * Biên độ gradient chuẩn hoá. Filter làm đổi màu và độ sáng rất mạnh nên
 * so khớp trực tiếp theo pixel sẽ sai; cấu trúc cạnh thì gần như bất biến,
 * nên việc căn ảnh dựa hoàn toàn vào trường này.
 */
export function gradientMag(v: Float32Array, w: number, h: number): Float32Array {
  const g = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = v[i + 1] - v[i - 1];
      const gy = v[i + w] - v[i - w];
      g[i] = Math.hypot(gx, gy);
    }
  }
  // Chuẩn hoá về trung bình 0, phương sai 1 để so khớp không phụ thuộc tương phản.
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const mean = sum / g.length;
  let varr = 0;
  for (let i = 0; i < g.length; i++) varr += (g[i] - mean) ** 2;
  const sd = Math.sqrt(varr / g.length) || 1;
  for (let i = 0; i < g.length; i++) g[i] = (g[i] - mean) / sd;
  return g;
}

/** Thu nhỏ một trường float theo hệ số nguyên bằng lấy trung bình khối. */
export function downsample(
  v: Float32Array,
  w: number,
  h: number,
  factor: number,
): { v: Float32Array; w: number; h: number } {
  const nw = Math.max(1, Math.floor(w / factor));
  const nh = Math.max(1, Math.floor(h / factor));
  const out = new Float32Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      let s = 0;
      let c = 0;
      for (let j = 0; j < factor; j++) {
        const sy = y * factor + j;
        if (sy >= h) break;
        for (let i = 0; i < factor; i++) {
          const sx = x * factor + i;
          if (sx >= w) break;
          s += v[sy * w + sx];
          c++;
        }
      }
      out[y * nw + x] = c ? s / c : 0;
    }
  }
  return { v: out, w: nw, h: nh };
}
