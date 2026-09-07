import { readFileSync } from "node:fs";
import { join } from "node:path";
// ROOT là thư mục cài đặt, tính một lần ở src/config.js. Mượn lại thay vì tính
// lại ở đây để hai bộ lọc không bao giờ trỏ về hai gốc khác nhau.
import { ROOT } from "../../config.js";

const CONFIG_PATH = join(ROOT, "instax.config.json");

/**
 * Cấu hình bộ lọc INSTAX WIDE — mô phỏng chất phim lấy liền.
 *
 * Mọi con số ở đây là dạng CHUẨN HOÁ (chia 100 so với thanh trượt trong trang
 * tuner). Ví dụ "Vibrance +35" trên giao diện = 0.35 trong file này. Giữ đúng
 * tỉ lệ đó là điều kiện để trang xem trước và bộ xử lý thật cho ra cùng một ảnh
 * — pipeline nhân lại 100 rồi dùng nguyên công thức của bản tham chiếu.
 *
 * Hai bộ số đáng nhớ:
 *   - "mô phỏng film"  : bộ mặc định bên dưới, ảnh xem trên màn hình.
 *   - "bù sáng để in"  : vibrance 0.10 · exposure 0.22 · contrast -0.08 ·
 *                        matte 0 · warmHighlight -0.04 · shadowCyan 0 · grain 0.
 *     Máy in Instax ăn tối hơn màn hình khoảng nửa khẩu và tự đẩy màu, nên bản
 *     đưa đi in phải sáng hơn và nhạt hơn bản để xem.
 */
const DEFAULTS = {
  enabled: true,
  colour: {
    vibrance: 0.35, // rực màu có chọn lọc: màu nào đang nhạt mới được đẩy
    exposure: 0, // ±0.5 ≈ ±1 khẩu trên thang 8-bit của bản tham chiếu
    contrast: 0.25,
  },
  film: {
    matte: 0.18, // nâng đáy đen — vệt "sương" đặc trưng của phim lấy liền
    warmHighlight: 0.12, // ám kem ấm ở vùng sáng, kéo tông da về phía Instax
    shadowCyan: 0.15, // ám lam-lục ở vùng tối, đối trọng với vùng sáng ấm
  },
  // Dùng đúng cỗ máy hạt của bộ lọc Soft Light: nhiễu trắng làm mờ để kết cụm,
  // rải theo đường cong sắc độ. Bản HTML tham chiếu cộng nhiễu từng điểm ảnh,
  // trên ảnh 24MP thì thứ đó biến mất khi in — hạt kết cụm mới nhìn ra chất phim.
  grain: {
    amount: 0.022,
    sizePx: 1.8,
    chroma: 0.25,
    mono: true, // phim lấy liền cho hạt gần như xám, không tách ba lớp rõ như phim âm bản
    shadowRolloff: 0.06,
    highlightRolloff: 0.85,
    seed: 0,
  },
  output: { quality: 95, chromaSubsampling: "4:4:4" },
  backup: { enabled: true, folder: "_original" },
  skip: { pathContains: [] },
  limits: { minEdge: 400, maxMs: 2500 },
};

export const INSTAX_DEFAULTS = DEFAULTS;

/** Bộ số bù sáng cho máy in Instax — trang tuner và README cùng đọc từ đây. */
export const INSTAX_PREPRINT = {
  colour: { vibrance: 0.1, exposure: 0.22, contrast: -0.08 },
  film: { matte: 0, warmHighlight: -0.04, shadowCyan: 0 },
  grain: { ...DEFAULTS.grain, amount: 0 },
};

const num = (v, lo, hi, dflt) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Đọc và kẹp cấu hình về miền an toàn. Cùng nguyên tắc với bộ lọc Soft Light:
 * file này do người vận hành sửa tay giữa các sự kiện nên số nhập sai phải bị
 * kẹp im lặng, không được ném lỗi làm gián đoạn phiên chụp.
 */
export function loadConfig(path = CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Cấu hình hỏng (${path}): ${err.message}`);
    }
  }

  const d = DEFAULTS;
  const c = { ...d.colour, ...raw.colour };
  const f = { ...d.film, ...raw.film };
  const gr = { ...d.grain, ...raw.grain };
  const o = { ...d.output, ...raw.output };
  const b = { ...d.backup, ...raw.backup };
  const sk = { ...d.skip, ...raw.skip };
  const l = { ...d.limits, ...raw.limits };

  return {
    enabled: raw.enabled !== false,
    colour: {
      vibrance: num(c.vibrance, -0.5, 1, d.colour.vibrance),
      exposure: num(c.exposure, -0.5, 0.5, d.colour.exposure),
      contrast: num(c.contrast, -0.5, 0.5, d.colour.contrast),
    },
    film: {
      matte: num(f.matte, 0, 0.5, d.film.matte),
      warmHighlight: num(f.warmHighlight, -0.3, 0.3, d.film.warmHighlight),
      shadowCyan: num(f.shadowCyan, 0, 0.4, d.film.shadowCyan),
    },
    grain: {
      amount: num(gr.amount, 0, 0.15, d.grain.amount),
      sizePx: num(gr.sizePx, 0.3, 6, d.grain.sizePx),
      chroma: num(gr.chroma, 0, 1, d.grain.chroma),
      mono: gr.mono !== false,
      shadowRolloff: num(gr.shadowRolloff, 0.001, 0.5, d.grain.shadowRolloff),
      highlightRolloff: num(gr.highlightRolloff, 0.5, 0.999, d.grain.highlightRolloff),
      seed: Math.round(num(gr.seed, 0, 4294967295, d.grain.seed)),
    },
    output: {
      quality: Math.round(num(o.quality, 60, 100, d.output.quality)),
      chromaSubsampling: o.chromaSubsampling === "4:2:0" ? "4:2:0" : "4:4:4",
    },
    backup: {
      enabled: b.enabled !== false,
      folder:
        typeof b.folder === "string" && b.folder.trim()
          ? b.folder.trim()
          : d.backup.folder,
    },
    skip: {
      pathContains: Array.isArray(sk.pathContains)
        ? sk.pathContains
            .filter((x) => typeof x === "string" && x.trim())
            .map((x) => x.trim())
        : [],
    },
    limits: {
      minEdge: Math.round(num(l.minEdge, 0, 20000, d.limits.minEdge)),
      maxMs: Math.round(num(l.maxMs, 100, 60000, d.limits.maxMs)),
    },
  };
}
