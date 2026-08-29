/**
 * SOFT LIGHT — dựng trực tiếp bằng tham số
 * ----------------------------------------
 * Hiệu ứng soft light kiểu Instagram, về bản chất alpha, là một chồng lớp sáng
 * mờ phủ lên ảnh:
 *
 *   1. Lớp "haze"    — màn sáng ấm phủ đều, nâng vùng tối, làm bạc màu nhẹ.
 *   2. Lớp "glow"    — quầng sáng toả từ một điểm, mô phỏng nguồn sáng hắt vào.
 *   3. Lớp "vignette"— tối bốn góc, kéo mắt vào giữa khung (mặc định tắt).
 *
 * Cả ba đều là lớp phủ alpha thuần nên xuất thẳng ra PNG được, không cần ảnh
 * mẫu, không cần giải ngược. Ghép chồng bằng đúng công thức source-over rồi
 * quy về MỘT cặp (màu, alpha) duy nhất — kết quả vẫn là một overlay hợp lệ.
 *
 * Thứ duy nhất soft light thật có mà lớp phủ tĩnh không tả được là bloom bám
 * theo vùng sáng của từng ảnh; phần còn lại tái tạo chính xác.
 */

export interface SoftLightParams {
  /** Hệ số nhân tổng — đây là slider "Cường độ". */
  strength: number;
  /** Alpha của màn sáng phủ đều, 0..0.5. */
  haze: number;
  /** Màu màn sáng, RGB 0..1. */
  color: [number, number, number];
  /** Alpha thêm vào tại tâm quầng sáng, tính theo bội của haze. */
  glow: number;
  /** Màu quầng sáng, RGB 0..1. */
  glowColor: [number, number, number];
  /** Tâm quầng sáng, toạ độ chuẩn hoá −1..1. */
  gx: number;
  gy: number;
  /** Bán kính quầng sáng theo nửa đường chéo khung. */
  radius: number;
  /** Alpha tối góc, 0 = tắt. */
  vignette: number;
  /** Bán kính bắt đầu tối góc, 0..1.5. */
  vignetteRadius: number;
  /** Biên độ hạt (độ lệch chuẩn trên thang 0..1). */
  grainSigma: number;
  /** Kích thước hạt tính theo pixel canvas đích ở 1800px cạnh dài. */
  grainSize: number;
  /** Mức đơn sắc của hạt, 1 = xám hoàn toàn. */
  grainMono: number;
}

export const SOFT_LIGHT_DEFAULT: SoftLightParams = {
  strength: 1,
  haze: 0.11,
  color: [1.0, 0.965, 0.945],
  glow: 0.9,
  glowColor: [1.0, 0.985, 0.97],
  gx: 0.35,
  gy: -0.45,
  radius: 1.25,
  vignette: 0,
  vignetteRadius: 0.7,
  grainSigma: 0.004,
  grainSize: 1.6,
  grainMono: 0.85,
};

export interface SoftLightPreset {
  label: string;
  params: SoftLightParams;
}

/** Các biến thể dựng sẵn — chỉ khác nhau ở tham số, cùng một mô hình. */
export const SOFT_LIGHT_PRESETS: SoftLightPreset[] = [
  { label: 'Soft light — chuẩn', params: { ...SOFT_LIGHT_DEFAULT } },
  {
    label: 'Soft light — nhẹ',
    params: { ...SOFT_LIGHT_DEFAULT, haze: 0.065, glow: 0.6, grainSigma: 0.003 },
  },
  {
    label: 'Soft light — mạnh',
    params: { ...SOFT_LIGHT_DEFAULT, haze: 0.18, glow: 1.15, radius: 1.4 },
  },
  {
    label: 'Soft light — ấm (hồng)',
    params: {
      ...SOFT_LIGHT_DEFAULT,
      haze: 0.13,
      color: [1.0, 0.925, 0.915],
      glowColor: [1.0, 0.955, 0.945],
    },
  },
  {
    label: 'Soft light — lạnh',
    params: {
      ...SOFT_LIGHT_DEFAULT,
      haze: 0.115,
      color: [0.945, 0.965, 1.0],
      glowColor: [0.965, 0.98, 1.0],
    },
  },
  {
    label: 'Soft light + tối góc',
    params: { ...SOFT_LIGHT_DEFAULT, haze: 0.1, vignette: 0.22, vignetteRadius: 0.62 },
  },
];

/** Nội suy mượt Hermite giữa hai mốc — dùng cho biên quầng sáng và tối góc. */
function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0 || 1e-6)));
  return t * t * (3 - 2 * t);
}

/** Ghép một lớp (màu c, alpha a) lên trên phần đã tích luỹ, theo source-over. */
function over(acc: Float64Array, a: number, cr: number, cg: number, cb: number): void {
  if (a <= 0) return;
  const inv = 1 - a;
  acc[1] = cr * a + acc[1] * inv;
  acc[2] = cg * a + acc[2] * inv;
  acc[3] = cb * a + acc[3] * inv;
  acc[0] = a + acc[0] * inv;
}

/**
 * Trả về hàm đánh giá overlay tại toạ độ chuẩn hoá (nx, ny) ∈ [−1, 1].
 * out = [alpha, u_r, u_g, u_b] với u là màu premultiplied.
 *
 * Hàm này giải tích hoàn toàn nên đánh giá được ở mọi kích thước canvas —
 * 1800×1200 hay 600×1800 đều sắc nét như nhau, không có bước kéo giãn bitmap.
 */
export function softLightEvaluator(p: SoftLightParams): (nx: number, ny: number, out: Float64Array) => void {
  const k = Math.max(0, p.strength);
  const haze = p.haze * k;
  const glowPeak = p.haze * p.glow * k;
  const vig = p.vignette * k;
  const invR = 1 / Math.max(0.05, p.radius);

  return (nx, ny, out) => {
    out[0] = 0;
    out[1] = 0;
    out[2] = 0;
    out[3] = 0;

    // 1 — màn sáng phủ đều.
    over(out, haze, p.color[0], p.color[1], p.color[2]);

    // 2 — quầng sáng toả từ (gx, gy), tắt dần theo Gauss.
    if (glowPeak > 0) {
      const dx = (nx - p.gx) * invR;
      const dy = (ny - p.gy) * invR;
      const g = Math.exp(-(dx * dx + dy * dy) * 1.35);
      over(out, glowPeak * g, p.glowColor[0], p.glowColor[1], p.glowColor[2]);
    }

    // 3 — tối góc, lớp đen trong suốt dần về phía tâm.
    if (vig > 0) {
      const r = Math.sqrt(nx * nx + ny * ny) / Math.SQRT2;
      const v = smoothstep(p.vignetteRadius, 1.0, r);
      over(out, vig * v, 0, 0, 0);
    }

    if (out[0] > 0.98) {
      const s = 0.98 / out[0];
      out[0] = 0.98;
      out[1] *= s;
      out[2] *= s;
      out[3] *= s;
    }
  };
}
