import type { SoftLightParams } from './softlight';

/** Kiểu dữ liệu dùng chung cho toàn bộ pipeline bake overlay. */

/** Một cặp ảnh: bản gốc và bản đã áp filter (cùng khung hình). */
export interface Pair {
  id: string;
  name: string;
  /** Ảnh gốc, đã chuẩn hoá về lưới làm việc. */
  src: ImageData;
  /** Ảnh đã filter, đã chuẩn hoá + căn chỉnh về cùng lưới với src. */
  dst: ImageData;
  /** Ảnh gốc/đích ở kích thước đầy đủ (giữ để căn lại khi user chỉnh tay). */
  rawSrc: ImageBitmap;
  rawDst: ImageBitmap;
  /** Hiệu chỉnh căn ảnh do auto-align tìm ra hoặc user chỉnh tay. */
  align: Align;
  /** Bật/tắt cặp này khi bake. */
  enabled: boolean;
}

/** Phép biến đổi đưa ảnh đã filter về khớp ảnh gốc: scale quanh tâm rồi dịch. */
export interface Align {
  /** Dịch theo trục X, đơn vị = pixel trên lưới làm việc. */
  dx: number;
  dy: number;
  /** Hệ số phóng quanh tâm ảnh. 1 = giữ nguyên. */
  scale: number;
}

export const IDENTITY_ALIGN: Align = { dx: 0, dy: 0, scale: 1 };

/**
 * Trường overlay đã giải, ở độ phân giải lưới làm việc.
 * Lưu dạng premultiplied để phép nội suy và làm mượt không sinh màu rác
 * ở những vùng alpha gần 0.
 */
export interface SolvedField {
  w: number;
  h: number;
  /** Alpha 0..1, độ dài w*h. */
  a: Float32Array;
  /** Màu premultiplied (u = c*a) 0..1, xen kẽ RGB, độ dài w*h*3. */
  u: Float32Array;
  /** Sai số RMS của nghiệm least-squares tại mỗi pixel, 0..1. */
  residual: Float32Array;
  /**
   * Độ tin cậy của nghiệm tại mỗi pixel = năng lượng biến thiên của ảnh gốc
   * trong cửa sổ. Vùng phông trơn không có biến thiên nên không nói lên điều gì
   * về alpha; trọng số này khiến bước fit mô hình mượt bỏ qua chúng.
   */
  weight: Float32Array;
}

/** Mô hình đa thức mượt: hệ số cho từng kênh, đánh giá lại được ở mọi tỷ lệ. */
export interface SmoothModel {
  /** Bậc đa thức theo mỗi trục (tensor product). */
  degree: number;
  /** Có thêm số hạng bán kính (r, r², r³) để tả vignette không. */
  radial: boolean;
  /** Số hệ số của một kênh. */
  terms: number;
  /** Hệ số kênh alpha, độ dài = terms. */
  ca: Float64Array;
  /** Hệ số 3 kênh màu premultiplied, độ dài = terms*3. */
  cu: Float64Array;
}

/** Thống kê lớp hạt (grain) tách được từ phần dư tần số cao. */
export interface GrainStats {
  /** Biên độ hạt trên kênh alpha (độ lệch chuẩn, 0..1). */
  sigmaA: number;
  /** Biên độ hạt trên kênh màu (độ lệch chuẩn, 0..1). */
  sigmaC: number;
  /** Kích thước hạt tính bằng pixel trên lưới làm việc. */
  size: number;
  /** Tỷ lệ hạt đơn sắc (1 = xám hoàn toàn, 0 = hạt màu). */
  mono: number;
}

/** Kết quả một lần bake: mô hình mượt + lớp hạt + chẩn đoán. */
export interface BakeResult {
  field: SolvedField;
  model: SmoothModel;
  grain: GrainStats;
  /** Ảnh grain gốc đã tách (dùng cho chế độ "giữ nguyên grain"). */
  grainField: SolvedField | null;
  diag: Diagnostics;
}

export interface Diagnostics {
  /** Số cặp ảnh tham gia. */
  pairs: number;
  /** Sai số RMS trung bình khi tái tạo ảnh đích, tính theo mức 0..255. */
  rmse255: number;
  /** Phần trăm pixel tái tạo lệch dưới 3/255. */
  within3: number;
  /** Tỷ lệ phương sai ảnh đích mà mô hình alpha giải thích được, 0..1. */
  explained: number;
  /** Cảnh báo dành cho người dùng (tiếng Việt). */
  warnings: string[];
}

/** Kích thước canvas overlay đích. */
export interface CanvasSpec {
  w: number;
  h: number;
  dpi: number;
  label: string;
}

/** Một ô ảnh trong template, toạ độ chuẩn hoá 0..1 theo canvas đích. */
export interface Cell {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export type GrainMode = 'procedural' | 'original' | 'off';
export type ApplyMode = 'sheet' | 'cells';

/** Toàn bộ tham số render — đây cũng là nội dung file preset. */
export interface RenderSettings {
  /** Hệ số nhân cường độ alpha. */
  strength: number;
  /** Bậc đa thức khi fit mô hình mượt. */
  degree: number;
  radial: boolean;
  grainMode: GrainMode;
  /** Hệ số nhân biên độ hạt. */
  grainAmount: number;
  /** Hệ số nhân kích thước hạt. */
  grainScale: number;
  applyMode: ApplyMode;
  canvas: CanvasSpec;
  cells: Cell[];
}

export interface PresetFile {
  format: 'filmong-overlay-preset';
  version: 1;
  /** 'soft' = tham số soft light; 'baked' = mô hình giải ngược từ cặp ảnh. */
  kind: 'soft' | 'baked';
  name: string;
  createdAt: string;
  settings: RenderSettings;
  /** Có khi kind = 'soft'. */
  soft?: SoftLightParams;
  /** Có khi kind = 'baked'. */
  model?: {
    degree: number;
    radial: boolean;
    terms: number;
    ca: number[];
    cu: number[];
  };
  grain?: GrainStats;
  diag?: Diagnostics;
}
