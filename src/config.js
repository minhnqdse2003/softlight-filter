import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const CONFIG_PATH = join(ROOT, "softlight.config.json");

/**
 * Giá trị mặc định — file cấu hình chỉ cần ghi đè phần muốn đổi.
 *
 * Mặc định ở đây tái hiện đúng bản tham chiếu `instagram-soft-light-1.html`:
 * chỉ tầng `bloom` hoạt động, mọi tầng khác để 0 nên ảnh nền giữ nguyên nét.
 */
const DEFAULTS = {
  enabled: true,
  softFocus: {
    amount: 0, // Tắt: bản tham chiếu giữ toàn ảnh sắc nét, độ mềm đến từ bloom
    radiusPct: 0.22,
  },
  clarity: {
    amount: 0, // Tắt, cùng lý do trên
    radiusPct: 2.0,
  },
  bloom: {
    amount: 0.7, // = thanh trượt "Độ mịn / Phát sáng" 70% của bản HTML
    radiusPct: 2.5, // canvas.width / 40
    minRadiusPx: 16, // sàn tuyệt đối, để ảnh nhỏ vẫn có quầng
    brightness: 1.35, // filter: brightness(1.35)
    contrast: 0.95, // filter: contrast(0.95)
    skinOnly: true, // chỉ phát sáng vùng tông da
    highlightCutoff: 0.863, // luminance 220/255 — trên mức này bị loại (chấm bi, đèn)
  },
  tone: {
    contrast: 0,
    lift: 0,
  },
  warm: {
    temp: 0,
    tint: 0,
    highlightWarmth: 0,
    highlightColor: "#ffd9a8",
  },
  output: { quality: 95, chromaSubsampling: "4:4:4" },
  backup: { enabled: true, folder: "_original" },
  skip: { pathContains: [] },
  limits: { minEdge: 400, maxMs: 1500 },
};

const num = (v, lo, hi, dflt) => {
  const n = typeof v === "number" && Number.isFinite(v) ? v : dflt;
  return Math.min(hi, Math.max(lo, n));
};

/**
 * Đọc và kẹp cấu hình về miền an toàn. Cấu hình do người vận hành sửa tay giữa
 * các sự kiện nên mọi giá trị đều phải chịu được số nhập sai mà không làm hỏng
 * ảnh của khách — kẹp im lặng, không ném lỗi.
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
  const sf = { ...d.softFocus, ...raw.softFocus };
  const c = { ...d.clarity, ...raw.clarity };
  const bl = { ...d.bloom, ...raw.bloom };
  const t = { ...d.tone, ...raw.tone };
  const w = { ...d.warm, ...raw.warm };
  const o = { ...d.output, ...raw.output };
  const b = { ...d.backup, ...raw.backup };
  const sk = { ...d.skip, ...raw.skip };
  const l = { ...d.limits, ...raw.limits };

  return {
    enabled: raw.enabled !== false,
    softFocus: {
      amount: num(sf.amount, 0, 0.9, d.softFocus.amount),
      radiusPct: num(sf.radiusPct, 0.02, 3, d.softFocus.radiusPct),
    },
    clarity: {
      amount: num(c.amount, 0, 0.9, d.clarity.amount),
      radiusPct: num(c.radiusPct, 0.1, 10, d.clarity.radiusPct),
    },
    bloom: {
      amount: num(bl.amount, 0, 1, d.bloom.amount),
      radiusPct: num(bl.radiusPct, 0.1, 10, d.bloom.radiusPct),
      minRadiusPx: num(bl.minRadiusPx, 0, 200, d.bloom.minRadiusPx),
      brightness: num(bl.brightness, 0.5, 3, d.bloom.brightness),
      contrast: num(bl.contrast, 0.2, 2, d.bloom.contrast),
      skinOnly: bl.skinOnly !== false,
      highlightCutoff: num(bl.highlightCutoff, 0.2, 1, d.bloom.highlightCutoff),
    },
    tone: {
      contrast: num(t.contrast, -0.6, 0.6, d.tone.contrast),
      lift: num(t.lift, 0, 0.2, d.tone.lift),
    },
    warm: {
      temp: num(w.temp, -0.4, 0.4, d.warm.temp),
      tint: num(w.tint, -0.4, 0.4, d.warm.tint),
      highlightWarmth: num(w.highlightWarmth, 0, 0.5, d.warm.highlightWarmth),
      highlightColor: /^#[0-9a-fA-F]{6}$/.test(w.highlightColor)
        ? w.highlightColor
        : d.warm.highlightColor,
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

export function hexToRgb(hex) {
  return {
    r: parseInt(hex.slice(1, 3), 16),
    g: parseInt(hex.slice(3, 5), 16),
    b: parseInt(hex.slice(5, 7), 16),
  };
}
