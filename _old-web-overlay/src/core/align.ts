import type { Align } from './types';
import { IDENTITY_ALIGN } from './types';
import { downsample, gradientMag } from './image';

/**
 * Lấy mẫu song tuyến một trường float, trả 0 nếu ra ngoài biên.
 */
function sample(v: Float32Array, w: number, h: number, x: number, y: number): number {
  if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(x0 + 1, w - 1);
  const y1 = Math.min(y0 + 1, h - 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = v[y0 * w + x0] * (1 - fx) + v[y0 * w + x1] * fx;
  const b = v[y1 * w + x0] * (1 - fx) + v[y1 * w + x1] * fx;
  return a * (1 - fy) + b * fy;
}

/**
 * Biến đổi ngược của rasterize(): với overlay align (scale quanh tâm rồi dịch),
 * giá trị tại (x,y) của ảnh đã căn bằng giá trị tại toạ độ này của ảnh gốc-cover.
 */
function inverse(x: number, y: number, w: number, h: number, al: Align): [number, number] {
  const cx = w / 2;
  const cy = h / 2;
  return [(x - cx - al.dx) / al.scale + cx, (y - cy - al.dy) / al.scale + cy];
}

/**
 * Điểm khớp giữa hai trường gradient đã chuẩn hoá: tích vô hướng trung bình
 * trên vùng chồng lấn. Càng cao càng khớp.
 */
function score(
  ref: Float32Array,
  mov: Float32Array,
  w: number,
  h: number,
  al: Align,
): number {
  // Bỏ 8% viền để phần đen do dịch ảnh không kéo điểm số xuống một cách giả tạo.
  const mx = Math.round(w * 0.08);
  const my = Math.round(h * 0.08);
  let s = 0;
  let n = 0;
  for (let y = my; y < h - my; y += 2) {
    for (let x = mx; x < w - mx; x += 2) {
      const [sx, sy] = inverse(x, y, w, h, al);
      s += ref[y * w + x] * sample(mov, w, h, sx, sy);
      n++;
    }
  }
  return n ? s / n : -Infinity;
}

export interface AlignResult {
  align: Align;
  /** Điểm khớp cuối cùng (đã chuẩn hoá). Dưới ~0.25 là đáng ngờ. */
  score: number;
  /** Điểm khớp khi không căn gì cả, để biết auto-align có cải thiện không. */
  baseScore: number;
}

/**
 * Tự động căn ảnh đã filter về ảnh gốc bằng cách tối đa hoá tương quan giữa
 * hai trường biên độ gradient. Dùng gradient chứ không dùng pixel vì filter
 * làm đổi màu/độ sáng rất mạnh nhưng gần như không đổi vị trí cạnh.
 *
 * Tìm thô ở độ phân giải 1/4 rồi tinh dần ở độ phân giải đầy đủ.
 */
export function autoAlign(
  srcLuma: Float32Array,
  dstLuma: Float32Array,
  w: number,
  h: number,
): AlignResult {
  const gs = gradientMag(srcLuma, w, h);
  const gd = gradientMag(dstLuma, w, h);

  const cs = downsample(gs, w, h, 4);
  const cd = downsample(gd, w, h, 4);
  const baseScore = score(gs, gd, w, h, IDENTITY_ALIGN);

  // Giai đoạn thô: quét scale rộng, dịch tới ±7% cạnh, trên lưới 1/4.
  let best: Align = { ...IDENTITY_ALIGN };
  let bestScore = -Infinity;
  const rangeX = Math.round(cs.w * 0.07);
  const rangeY = Math.round(cs.h * 0.07);
  for (let sc = 0.90; sc <= 1.1005; sc += 0.02) {
    for (let dy = -rangeY; dy <= rangeY; dy += 2) {
      for (let dx = -rangeX; dx <= rangeX; dx += 2) {
        const cand: Align = { dx, dy, scale: sc };
        const v = score(cs.v, cd.v, cs.w, cs.h, cand);
        if (v > bestScore) {
          bestScore = v;
          best = cand;
        }
      }
    }
  }
  // Đưa dịch chuyển từ lưới thô về lưới đầy đủ.
  best = { dx: best.dx * 4, dy: best.dy * 4, scale: best.scale };

  // Giai đoạn tinh: thu hẹp dần bước nhảy quanh nghiệm thô.
  let stepD = 4;
  let stepS = 0.01;
  for (let pass = 0; pass < 4; pass++) {
    let improved = true;
    while (improved) {
      improved = false;
      const cands: Align[] = [];
      for (const ds of [-stepS, 0, stepS]) {
        for (const dy of [-stepD, 0, stepD]) {
          for (const dx of [-stepD, 0, stepD]) {
            if (!ds && !dx && !dy) continue;
            cands.push({ dx: best.dx + dx, dy: best.dy + dy, scale: best.scale + ds });
          }
        }
      }
      for (const c of cands) {
        const v = score(gs, gd, w, h, c);
        if (v > bestScore) {
          bestScore = v;
          best = c;
          improved = true;
        }
      }
    }
    stepD /= 2;
    stepS /= 2;
  }

  return { align: best, score: bestScore, baseScore };
}
