/**
 * LOOK v3 — bộ công cụ chỉnh màu / tông dùng chung cho Instax và Tuyết, theo
 * đúng công thức của Capture One (dịch ngược ImgCoreDll.dll, 03/11/2026).
 *
 * Một file, hai nơi chạy: bộ lọc Node (src/filters/instax/pipeline.js,
 * src/filters/snow/pipeline.js) import thẳng, còn trang chỉnh web/instax.html và
 * web/snow.html được build-offline.mjs dán nguyên văn file này vào (bỏ chữ
 * `export`). Vì vậy ở đây chỉ được dùng JavaScript thuần — không fs, không
 * sharp, không DOM — và chỉ `export function` / `export const` ở đầu dòng.
 *
 * Số trong cấu hình là đúng số trên thanh trượt của Capture One (Contrast +12,
 * Exposure 0.3 EV, Kelvin 5800…), không chia 100.
 *
 * Capture One làm mọi thứ trong ProPhoto RGB (ROMM): tuyến tính cho phơi sáng /
 * màu, rồi mã hoá gamma 1.8 cho tông. Ảnh vào đây là JPEG sRGB nên được đổi
 * sang ProPhoto tuyến tính trước, và đổi ngược về sRGB ở cuối.
 *
 * Thứ tự (giống ImgOpApplyExposure / ColorManagement / Levels của Capture One):
 *   LUT ngoài (.cube) → White Balance → Exposure → Color Balance Master
 *   → [High Dynamic Range — theo vùng, chạy giữa hai LUT]
 *   → Color Editor (L*C*h) → gamma 1.8 → Saturation → Contrast → Brightness
 *   → Levels → Curve → Color Balance 3 vùng → về sRGB → Black & White
 *   → Clarity / Structure → Vignetting → Film Grain     (theo vùng, chạy sau)
 *
 * Mức khớp với Capture One:
 *   ĐÚNG CÔNG THỨC: Exposure, Saturation, Contrast, Brightness, Levels, Color
 *     Balance Master, Color Editor, Vignetting, khung HDR (bản đồ độ sáng log,
 *     bốn hệ số highlight/shadow/white/black).
 *   XẤP XỈ: White Balance (Capture One đổi Kelvin theo hồ sơ từng máy ảnh),
 *     miền của Saturation (công thức đúng, nhưng Capture One có hai bản —
 *     tuyến tính và ColorManagement — chưa chốt được bản nào chạy; ở đây đặt
 *     trên gamma 1.8 vì ảnh vào đã là ảnh hiển thị), vùng sáng vượt 1 sau
 *     Exposure bị cắt (Capture One còn film curve của máy ảnh để nén),
 *     bộ lọc dẫn hướng của HDR, trọng số 3 vùng Color Balance, Curve (spline
 *     tự nhiên — chưa đối chiếu điều kiện biên), Clarity (công thức lõi đúng,
 *     tháp ảnh thay bằng làm mờ hộp).
 *   GIỮ BẢN CŨ: Black & White, Film Grain (chưa dịch ngược phần pixel).
 *
 * `strength` (0–100) là thanh "độ đậm" duy nhất người vận hành cần chạm: nó
 * trộn cả look với ảnh gốc.
 */

/* ═════════════════════════ miền giá trị ═════════════════════════ */

/** [min, max, mặc định trung tính] — dùng chung cho kẹp số, thanh trượt, reset. */
export const LOOK_RANGES = {
  strength: [0, 100, 100],
  lutOpacity: [0, 100, 100],
  kelvin: [2500, 10000, 5500],
  tint: [-50, 50, 0],
  exposure: [-4, 4, 0],
  contrast: [-50, 50, 0],
  brightness: [-50, 50, 0],
  saturation: [-100, 100, 0],
  hdr: [-100, 100, 0],
  level: [0, 255, 0],
  midtone: [-100, 100, 0],
  gamma: [0.1, 9.99, 1],
  hue: [0, 359, 0],
  hueShift: [-30, 30, 0],
  editorSat: [-100, 200, 0],
  amount100: [-100, 100, 0],
  sat100: [0, 100, 0],
  vignette: [-4, 4, 0],
  impact: [0, 100, 0],
  granularity: [0, 100, 50],
};

/** 8 lát Color Editor của Capture One (thứ tự theo hue L*C*h tăng dần từ đỏ). */
export const COLOR_EDITOR_BANDS = ["red", "orange", "yellow", "green", "cyan", "blue", "purple", "magenta"];
export const BW_BANDS = ["red", "yellow", "green", "cyan", "blue", "magenta"];
const BW_CENTERS = [0, 60, 120, 180, 240, 300];
export const CURVE_CHANNELS = ["rgb", "luma", "r", "g", "b"];
export const LEVEL_CHANNELS = ["rgb", "r", "g", "b"];
export const CLARITY_METHODS = ["natural", "punch", "neutral", "classic"];
export const VIGNETTE_METHODS = ["elliptic", "circular"];
export const GRAIN_TYPES = ["fine", "silverRich", "soft", "cubic", "tabular", "harsh"];

/* ═════════════════════════ bộ số ═════════════════════════ */

function neutralLevels() {
  return { inBlack: 0, inWhite: 255, midtone: 0, outBlack: 0, outWhite: 255 };
}

/** Không chỉnh gì: ảnh ra đúng bằng ảnh vào. */
export function neutralLook() {
  const ce = {};
  COLOR_EDITOR_BANDS.forEach((b) => { ce[b] = { hue: 0, saturation: 0, lightness: 0 }; });
  const curve = {};
  CURVE_CHANNELS.forEach((c) => { curve[c] = [[0, 0], [255, 255]]; });
  const levels = {};
  LEVEL_CHANNELS.forEach((c) => { levels[c] = neutralLevels(); });
  return {
    strength: 100,
    lut: { file: "", opacity: 100 },
    whiteBalance: { kelvin: 5500, tint: 0 },
    exposure: { exposure: 0, contrast: 0, brightness: 0, saturation: 0 },
    hdr: { highlight: 0, shadow: 0, white: 0, black: 0 },
    levels,
    curve,
    colorBalance: {
      master: { hue: 0, saturation: 0 },
      shadow: { hue: 0, saturation: 0, lightness: 0 },
      midtone: { hue: 0, saturation: 0, lightness: 0 },
      highlight: { hue: 0, saturation: 0, lightness: 0 },
    },
    colorEditor: ce,
    blackWhite: {
      enabled: false,
      red: 0, yellow: 0, green: 0, cyan: 0, blue: 0, magenta: 0,
      highlightHue: 0, highlightSaturation: 0, shadowHue: 0, shadowSaturation: 0,
    },
    clarity: { method: "natural", clarity: 0, structure: 0 },
    vignetting: { amount: 0, method: "elliptic" },
    grain: { type: "fine", impact: 0, granularity: 50, seed: 0 },
  };
}

/**
 * Bộ mặc định "chuẩn cộng đồng" cho chất Instax. Không có bộ số Instax nào
 * được công bố chính thức; các con số dưới đây theo đúng những nguyên tắc mà
 * hướng dẫn film-look nào cũng nhắc: tương phản dịu, vùng sáng hạ xuống và
 * trắng hơi đục, đáy đen nâng lên kiểu "sữa" (matte), vùng sáng ấm / bóng đổ
 * lạnh, lục ngả về lam-lục và bớt rực, hạt dày ở trung tông nhưng mỏng ở vùng
 * tối, vignetting nhẹ. Là điểm xuất phát để chỉnh tiếp, không phải đích đến.
 *
 * HDR theo quy ước Capture One hiện hành: Highlight ÂM là kéo vùng sáng xuống.
 */
export function communityLook() {
  const l = neutralLook();
  l.whiteBalance = { kelvin: 5800, tint: 2 };
  l.exposure = { exposure: 0.1, contrast: -10, brightness: 5, saturation: -8 };
  l.hdr = { highlight: -30, shadow: 15, white: -12, black: 0 };
  l.curve.rgb = [[0, 20], [70, 72], [190, 194], [255, 248]];
  l.colorBalance.shadow = { hue: 195, saturation: 12, lightness: 0 };
  l.colorBalance.highlight = { hue: 45, saturation: 10, lightness: 0 };
  l.colorEditor.green = { hue: 8, saturation: -15, lightness: 0 };
  l.colorEditor.orange = { hue: 0, saturation: -5, lightness: 5 };
  l.colorEditor.blue = { hue: 0, saturation: -10, lightness: 0 };
  l.blackWhite = {
    enabled: false,
    red: 10, yellow: 5, green: 0, cyan: 0, blue: -10, magenta: 0,
    highlightHue: 40, highlightSaturation: 5, shadowHue: 0, shadowSaturation: 0,
  };
  l.clarity = { method: "natural", clarity: -10, structure: 0 };
  l.vignetting = { amount: -0.3, method: "elliptic" };
  l.grain = { type: "fine", impact: 20, granularity: 45, seed: 0 };
  return l;
}

/* ═════════════════════════ kẹp số ═════════════════════════ */

function num(v, range, dflt) {
  const d = dflt === undefined ? range[2] : dflt;
  const n = typeof v === "number" && Number.isFinite(v) ? v : d;
  return Math.min(range[1], Math.max(range[0], n));
}
function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function pick(v, list, dflt) { return list.indexOf(v) >= 0 ? v : dflt; }

function normPoints(v, dflt) {
  if (!Array.isArray(v)) return dflt.map((p) => p.slice());
  const pts = v
    .filter((p) => Array.isArray(p) && p.length >= 2 && Number.isFinite(p[0]) && Number.isFinite(p[1]))
    .map((p) => [Math.min(255, Math.max(0, p[0])), Math.min(255, Math.max(0, p[1]))])
    .sort((a, b) => a[0] - b[0]);
  const out = [];
  pts.forEach((p) => { if (!out.length || p[0] > out[out.length - 1][0]) out.push(p); });
  return out.length >= 2 ? out : dflt.map((p) => p.slice());
}

/**
 * Cấu hình cũ (v2) lưu Levels bằng `gamma`. Đổi sang midtone của Capture One
 * sao cho điểm 50% ra cùng chỗ: tìm m với c1Midtone(0.5, m) = 0.5^(1/gamma).
 */
function gammaToMidtone(gamma) {
  if (!(gamma > 0) || gamma === 1) return 0;
  const want = Math.pow(0.5, 1 / gamma);
  let lo = -1, hi = 1;
  for (let i = 0; i < 40; i++) {
    const mid = (lo + hi) / 2;
    if (c1Midtone(0.5, mid) < want) lo = mid; else hi = mid;
  }
  return Math.round(((lo + hi) / 2) * 1000) / 10;
}

/**
 * Trộn với `base` (mặc định: bộ chuẩn cộng đồng) và kẹp mọi số về miền hợp lệ.
 * File cấu hình do người sửa tay giữa các buổi chụp: số sai phải bị kẹp im
 * lặng, không được ném lỗi làm hỏng một bản digital.
 */
export function normalizeLook(raw, base) {
  const d = base || communityLook();
  const r = obj(raw);
  const R = LOOK_RANGES;
  const o = neutralLook();

  o.strength = num(r.strength, R.strength, d.strength);
  const lut = obj(r.lut);
  o.lut = {
    file: typeof lut.file === "string" ? lut.file.trim() : d.lut.file,
    opacity: num(lut.opacity, R.lutOpacity, d.lut.opacity),
  };
  const wb = obj(r.whiteBalance);
  o.whiteBalance = { kelvin: num(wb.kelvin, R.kelvin, d.whiteBalance.kelvin), tint: num(wb.tint, R.tint, d.whiteBalance.tint) };
  const ex = obj(r.exposure);
  o.exposure = {
    exposure: num(ex.exposure, R.exposure, d.exposure.exposure),
    contrast: num(ex.contrast, R.contrast, d.exposure.contrast),
    brightness: num(ex.brightness, R.brightness, d.exposure.brightness),
    saturation: num(ex.saturation, R.saturation, d.exposure.saturation),
  };
  const hd = obj(r.hdr);
  o.hdr = {};
  ["highlight", "shadow", "white", "black"].forEach((k) => { o.hdr[k] = num(hd[k], R.hdr, d.hdr[k]); });

  const lv = obj(r.levels);
  LEVEL_CHANNELS.forEach((c) => {
    const s = obj(lv[c]), dd = d.levels[c] || neutralLevels();
    const inBlack = Math.min(254, num(s.inBlack, R.level, dd.inBlack));
    const inWhite = Math.max(inBlack + 1, num(s.inWhite, R.level, dd.inWhite));
    const legacy = typeof s.midtone !== "number" && typeof s.gamma === "number" ? gammaToMidtone(num(s.gamma, R.gamma)) : undefined;
    o.levels[c] = {
      inBlack, inWhite,
      midtone: num(legacy !== undefined ? legacy : s.midtone, R.midtone, dd.midtone !== undefined ? dd.midtone : gammaToMidtone(dd.gamma)),
      outBlack: num(s.outBlack, R.level, dd.outBlack),
      outWhite: num(s.outWhite, R.level, dd.outWhite),
    };
  });

  const cv = obj(r.curve);
  CURVE_CHANNELS.forEach((c) => { o.curve[c] = normPoints(cv[c], d.curve[c]); });

  const cb = obj(r.colorBalance);
  const cbm = obj(cb.master);
  o.colorBalance.master = { hue: num(cbm.hue, R.hue, d.colorBalance.master.hue), saturation: num(cbm.saturation, R.sat100, d.colorBalance.master.saturation) };
  ["shadow", "midtone", "highlight"].forEach((z) => {
    const s = obj(cb[z]), dd = d.colorBalance[z];
    o.colorBalance[z] = {
      hue: num(s.hue, R.hue, dd.hue),
      saturation: num(s.saturation, R.sat100, dd.saturation),
      lightness: num(s.lightness, R.amount100, dd.lightness),
    };
  });

  const ce = obj(r.colorEditor);
  COLOR_EDITOR_BANDS.forEach((b) => {
    const s = obj(ce[b]), dd = d.colorEditor[b] || { hue: 0, saturation: 0, lightness: 0 };
    o.colorEditor[b] = {
      hue: num(s.hue, R.hueShift, dd.hue),
      saturation: num(s.saturation, R.editorSat, dd.saturation),
      lightness: num(s.lightness, R.amount100, dd.lightness),
    };
  });

  const bw = obj(r.blackWhite), dbw = d.blackWhite;
  o.blackWhite = { enabled: typeof bw.enabled === "boolean" ? bw.enabled : dbw.enabled };
  BW_BANDS.forEach((b) => { o.blackWhite[b] = num(bw[b], R.amount100, dbw[b]); });
  o.blackWhite.highlightHue = num(bw.highlightHue, R.hue, dbw.highlightHue);
  o.blackWhite.highlightSaturation = num(bw.highlightSaturation, R.sat100, dbw.highlightSaturation);
  o.blackWhite.shadowHue = num(bw.shadowHue, R.hue, dbw.shadowHue);
  o.blackWhite.shadowSaturation = num(bw.shadowSaturation, R.sat100, dbw.shadowSaturation);

  const cl = obj(r.clarity);
  o.clarity = {
    method: pick(cl.method, CLARITY_METHODS, d.clarity.method),
    clarity: num(cl.clarity, R.amount100, d.clarity.clarity),
    structure: num(cl.structure, R.amount100, d.clarity.structure),
  };
  const vg = obj(r.vignetting);
  o.vignetting = { amount: num(vg.amount, R.vignette, d.vignetting.amount), method: pick(vg.method, VIGNETTE_METHODS, d.vignetting.method) };
  const gr = obj(r.grain);
  o.grain = {
    type: pick(gr.type, GRAIN_TYPES, d.grain.type),
    impact: num(gr.impact, R.impact, d.grain.impact),
    granularity: num(gr.granularity, R.granularity, d.grain.granularity),
    seed: Math.round(num(gr.seed, [0, 4294967295, 0], d.grain.seed)),
  };
  return o;
}

/* ═════════════════════════ mục về file ═════════════════════════ */

/** Chất lượng JPEG, backup, bỏ qua, giới hạn — không thuộc look, giữ nguyên qua trang chỉnh. */
export function normalizeFileOptions(raw) {
  const r = obj(raw);
  const o = obj(r.output), b = obj(r.backup), sk = obj(r.skip), l = obj(r.limits);
  return {
    output: {
      quality: Math.round(num(o.quality, [60, 100, 95])),
      chromaSubsampling: o.chromaSubsampling === "4:2:0" ? "4:2:0" : "4:4:4",
    },
    backup: {
      enabled: b.enabled !== false,
      folder: typeof b.folder === "string" && b.folder.trim() ? b.folder.trim() : "_original",
    },
    skip: {
      pathContains: Array.isArray(sk.pathContains)
        ? sk.pathContains.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim())
        : [],
    },
    limits: {
      minEdge: Math.round(num(l.minEdge, [0, 20000, 400])),
      maxMs: Math.round(num(l.maxMs, [100, 60000, 2500])),
    },
  };
}

/* Ghi chú đi kèm file cấu hình. Không dấu, để mở bằng Notepad trên máy booth nào
   cũng đọc được. */
const CONFIG_DOC =
  "Bo loc Instax Wide - cau hinh v2 (cong thuc Capture One). Moi so = dung so tren thanh truot " +
  "(Contrast 12, Exposure 0.3 EV, Kelvin 5800...). strength = do dam cua ca look (0 = anh goc, 100 = du). " +
  "HDR: highlight AM = keo vung sang xuong (quy uoc Capture One moi). Levels: midtone -100..100, duong = sang len. " +
  "Chinh bang web/instax-tuner.html roi bam Luu, dat file nay canh instax.exe. LUT .cube dat trong thu muc " +
  "luts canh instax.exe. Thu tu: LUT > White Balance > Exposure > Color Balance Master > HDR > Color Editor > " +
  "Saturation > Contrast > Brightness > Levels > Curve > Color Balance 3 vung > Black & White > Clarity > " +
  "Vignetting > Film Grain.";

function fmtNum(v) {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? "0" : String(r);
}
function fmtValue(v, depth, indent) {
  if (Array.isArray(v)) return "[" + v.map((x) => fmtValue(x, depth + 1, indent)).join(", ") + "]";
  if (typeof v === "number") return fmtNum(v);
  if (v && typeof v === "object") {
    const keys = Object.keys(v);
    if (depth >= 2) return "{ " + keys.map((k) => JSON.stringify(k) + ": " + fmtValue(v[k], depth + 1, indent)).join(", ") + " }";
    const pad = indent + "  ";
    return "{\n" + keys.map((k) => pad + JSON.stringify(k) + ": " + fmtValue(v[k], depth + 1, pad)).join(",\n") + "\n" + indent + "}";
  }
  return JSON.stringify(v);
}

/**
 * Nội dung file instax.config.json cho một bộ số — trang chỉnh và bộ cài cùng
 * dùng. Vẫn ghi `version: 2`: định dạng chỉ thêm trường (levels.midtone, lát
 * purple), nơi đọc nào hiểu v2 cũng đọc được.
 */
export function configToJson(cfg) {
  const look = normalizeLook(cfg, neutralLook());
  const out = {
    _doc: CONFIG_DOC,
    version: 2,
    enabled: cfg.enabled !== false,
    ...look,
    ...normalizeFileOptions(cfg),
  };
  return fmtValue(out, 0, "") + "\n";
}

/* ═════════════════════════ toán màu cơ bản ═════════════════════════ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
/** Độ sáng Rec.601 trên giá trị sRGB đã mã hoá — chỉ dùng cho Black & White và đo vùng. */
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export function toLinear(v) {
  if (v <= 0) return 0;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function toSrgb(v) {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

/*
 * sRGB (D65) tuyến tính ↔ ProPhoto RGB (D50) tuyến tính, thích nghi Bradford.
 * Hàng Y của ProPhoto là đúng bộ trọng số độ sáng Capture One dùng cho Contrast,
 * Saturation, HDR (0.288047 / 0.711861 / 0.000092 trong ImgOpApplyExposure).
 */
const SRGB_TO_PP = [
  [0.5293459, 0.3300729, 0.1405813],
  [0.0983744, 0.8734609, 0.0281647],
  [0.0168832, 0.1176725, 0.8654443],
];
const PP_TO_SRGB = [
  [2.0340763, -0.7273345, -0.3067417],
  [-0.2288135, 1.2317304, -0.0029169],
  [-0.0085698, -0.1532866, 1.1618564],
];
const PP_Y = [0.288047, 0.711861, 0.000092];
const ppLum = (r, g, b) => PP_Y[0] * r + PP_Y[1] * g + PP_Y[2] * b;
function mul3(m, r, g, b) {
  return [
    m[0][0] * r + m[0][1] * g + m[0][2] * b,
    m[1][0] * r + m[1][1] * g + m[1][2] * b,
    m[2][0] * r + m[2][1] * g + m[2][2] * b,
  ];
}

/** Mã hoá gamma của Capture One cho bước tông (FUN_180994ae0, chế độ ProPhoto): x^(1/1.8). */
const GAMMA = 1.8;
const encG = (v) => (v <= 0 ? 0 : Math.pow(v, 1 / GAMMA));
const decG = (v) => (v <= 0 ? 0 : Math.pow(v, GAMMA));

/** Màu của nguồn sáng ở nhiệt độ K (xấp xỉ vật đen), tuyến tính. */
function kelvinRgb(k) {
  const t = k / 100;
  let r, g, b;
  if (t <= 66) {
    r = 255;
    g = 99.4708025861 * Math.log(t) - 161.1195681661;
    b = t <= 19 ? 0 : 138.5177312231 * Math.log(t - 10) - 305.0447927307;
  } else {
    r = 329.698727446 * Math.pow(t - 60, -0.1332047592);
    g = 288.1221695283 * Math.pow(t - 60, -0.0755148492);
    b = 255;
  }
  return [toLinear(clamp01(r / 255)), toLinear(clamp01(g / 255)), toLinear(clamp01(b / 255))];
}

/**
 * Hệ số nhân từng kênh (sRGB tuyến tính) cho White Balance. Kelvin cao hơn
 * 5500 thì ảnh ấm lên, thấp hơn thì lạnh đi. Tint dương ngả hồng (magenta),
 * âm ngả lục. Chuẩn hoá để độ sáng không đổi.
 *
 * Capture One cũng chỉ nhận một bộ hệ số RGB, nhưng đổi Kelvin/Tint sang RGB
 * theo hồ sơ của từng máy ảnh (IC_KelvinTintToRGB) — với JPEG không có hồ sơ
 * đó, nên đây vẫn là xấp xỉ vật đen.
 */
export function wbGains(kelvin, tint) {
  const ref = 5500;
  const a = kelvinRgb((ref * ref) / kelvin), z = kelvinRgb(ref);
  const g = [a[0] / z[0], a[1] / z[1], a[2] / z[2]];
  g[1] *= 1 - (tint / 50) * 0.12;
  const y = 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
  return [g[0] / y, g[1] / y, g[2] / y];
}

/** HSV với h tính bằng độ. */
function rgbToHsv(r, g, b) {
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d > 1e-9) {
    if (max === r) h = 60 * (((g - b) / d) % 6);
    else if (max === g) h = 60 * ((b - r) / d + 2);
    else h = 60 * ((r - g) / d + 4);
  }
  if (h < 0) h += 360;
  return [h, max <= 0 ? 0 : d / max, max];
}
function hsvToRgb(h, s, v) {
  h = ((h % 360) + 360) % 360;
  const c = v * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = v - c;
  let r, g, b;
  if (h < 60) { r = c; g = x; b = 0; }
  else if (h < 120) { r = x; g = c; b = 0; }
  else if (h < 180) { r = 0; g = c; b = x; }
  else if (h < 240) { r = 0; g = x; b = c; }
  else if (h < 300) { r = x; g = 0; b = c; }
  else { r = c; g = 0; b = x; }
  return [r + m, g + m, b + m];
}

/** Hướng màu của một sắc độ, độ sáng 0 — trang chỉnh dùng để vẽ bánh xe màu. */
export function tintVector(hue) {
  const c = hsvToRgb(hue, 1, 1);
  const y = luma(c[0], c[1], c[2]);
  return [c[0] - y, c[1] - y, c[2] - y];
}

/**
 * Trọng số của từng dải màu Black & White cho một sắc độ: nội suy tuyến tính
 * giữa hai tâm kề nhau (công cụ B&W vẫn là bản cũ — chưa dịch ngược).
 */
function bandWeights(h, centers) {
  const n = centers.length, w = new Array(n).fill(0);
  for (let i = 0; i < n; i++) {
    const a = centers[i], b = i + 1 < n ? centers[i + 1] : centers[0] + 360;
    let x = h;
    if (x < a) x += 360;
    if (x >= a && x <= b) {
      const t = (x - a) / (b - a);
      w[i] += 1 - t;
      w[(i + 1) % n] += t;
      return w;
    }
  }
  return w;
}

/* ═════════════════════════ công thức Capture One ═════════════════════════ */

/**
 * Midtone của Levels (FUN_1809b4c10), m ∈ [−1, 1]: trộn x với một đường bậc
 * bốn qua (0,0) và (1,1). m < 0 tối đi, m > 0 sáng lên (hàm ngược).
 */
const MID_K1 = 0.05, MID_K2 = 1.05;
const MID_A = Math.pow(MID_K1, 0.25), MID_B = Math.pow(MID_K2, 0.25);
function c1Midtone(x, m) {
  const a = Math.abs(m);
  if (a < 1e-4) return x;
  const w = 1 - (1 - a) * (1 - a);
  let g;
  if (m < 0) {
    g = x < 0 ? x * 4 * (MID_B - MID_A) * MID_A * MID_A * MID_A : Math.pow(x * (MID_B - MID_A) + MID_A, 4) - MID_K1;
  } else {
    g = x < 0 ? x / (4 * (MID_B - MID_A) * MID_A * MID_A * MID_A) : (Math.pow(x + MID_K1, 0.25) - MID_A) / (MID_B - MID_A);
  }
  return (1 - w) * x + w * g;
}
function isNeutralLevels(l) { return l.inBlack === 0 && l.inWhite === 255 && l.midtone === 0 && l.outBlack === 0 && l.outWhite === 255; }
/** Levels một kênh: điểm đen/trắng vào → midtone → điểm đen/trắng ra (FUN_1809b2280). */
function levelsFn(l) {
  const ib = l.inBlack / 255, iw = l.inWhite / 255, ob = l.outBlack / 255, ow = l.outWhite / 255, m = l.midtone / 100;
  return (x) => ob + (ow - ob) * c1Midtone((x - ib) / (iw - ib), m);
}

/**
 * Đường cong Contrast (FUN_18099c920), điểm tựa p = 0.33 trên ProPhoto gamma 1.8:
 * dưới p kéo xuống, trên p đẩy lên, giữ nguyên 0, p, 1.
 */
const CONTRAST_PIVOT = 0.33;
function contrastDelta(x) {
  const p = CONTRAST_PIVOT;
  if (x < p) return x * x * (x > 0 ? x : 0) * (0.75 / (p * p)) - x * 0.75;
  const y = 1 - x;
  return y * 0.75 - (0.75 / ((1 - p) * (1 - p))) * y * (y > 0 ? y : 0) * y;
}

/**
 * Giữ sắc độ sau một đường cong từng kênh (cùng một khuôn trong Contrast và
 * Brightness của Capture One): kênh lớn nhất giữ giá trị đã qua đường cong,
 * kênh nhỏ nhất / giữa đặt lại theo độ bão hoà S trộn giữa trước và sau.
 * `wNew` = phần của độ bão hoà mới (Contrast 0.5, Brightness 0.75).
 */
function keepHue(r, g, b, r1, g1, b1, wNew) {
  const eps = 1e-12;
  const M = Math.max(r, g, b), m = Math.min(r, g, b), mid = r + g + b - M - m;
  const M1 = Math.max(r1, g1, b1), m1 = Math.min(r1, g1, b1);
  const S = wNew * (1 - m1 / (M1 + eps)) + (1 - wNew) * (1 - m / (M + eps));
  const fMin = 1 - S;
  const fMid = M - m > eps ? 1 - ((M + eps - mid) / (M + eps - m)) * S : fMin;
  const pick = (c, c1) => (c === M ? c1 : (c === m ? fMin : fMid) * M1);
  return [pick(r, r1), pick(g, g1), pick(b, b1)];
}

/** Contrast (FUN_180993f80): c = contrast/50, phần giảm nhẹ hơn 3 lần; giữ hue và độ sáng. */
function c1Contrast(r, g, b, c) {
  const r1 = r + c * contrastDelta(r), g1 = g + c * contrastDelta(g), b1 = b + c * contrastDelta(b);
  const y1 = Math.max(1e-12, ppLum(r1, g1, b1));
  const o = keepHue(r, g, b, r1, g1, b1, 0.5);
  const k = y1 / Math.max(1e-12, ppLum(o[0], o[1], o[2]));
  return [o[0] * k, o[1] * k, o[2] * k];
}

/** Brightness (FUN_180992d20): k = 2^(brightness/50 · 1.8), đường phân thức giữ 0 và 1. */
function c1Brightness(r, g, b, k) {
  const f = (v) => (k * v) / ((k - 1) * (v < 1 ? v : 1) + 1);
  return keepHue(r, g, b, f(r), f(g), f(b), 0.75);
}

/**
 * Saturation (ColorManagement, FUN_180a22ef0), độ sáng theo trọng số ProPhoto.
 * Giảm: trộn về độ sáng. Tăng: nhân độ bão hoà HSV với a = 1 + 0.0064·s,
 * nén mềm từ ngưỡng 0.5/a để màu đã đậm không cháy.
 */
function c1Saturation(r, g, b, s) {
  if (s < 0) {
    const k = Math.min(1, -s / 100), y = ppLum(r, g, b);
    return [r + (y - r) * k, g + (y - g) * k, b + (y - b) * k];
  }
  const V = Math.max(r, g, b), mn = Math.min(r, g, b);
  if (V <= 0) return [r, g, b];
  const hsv = rgbToHsv(r, g, b);
  const S = (V - mn) / (V + 1e-20), a = 1 + s * 0.0064, t = 0.5 / a;
  let S2;
  if (S >= t) {
    const a2 = a * (1 - t), u = (S - t) / (1 - t);
    S2 = (a2 * u) / ((2 * a2 - 1) * u + 1) + 0.5;
  } else {
    S2 = S * a;
  }
  return hsvToRgb(hsv[0], Math.min(1, S2), V);
}

/**
 * Một vòng Color Balance → hệ số nhân RGB (P1.C1.Core ColorBalanceHelper):
 * HSV(hue, sat·0.3, 1), kênh lớn nhất = 1, rồi nhân hệ số sáng
 * exp(lerp(ln 0.75, ln 1.333, L)), L = 0.5 + lightness/200.
 */
function cbGains(hue, sat, lightness) {
  const c = hsvToRgb(hue, (sat / 100) * 0.3, 1);
  const L = clamp01(0.5 + (lightness || 0) / 200);
  const k = Math.exp(Math.log(0.75) + L * (Math.log(4 / 3) - Math.log(0.75)));
  return [c[0] * k, c[1] * k, c[2] * k];
}

/* ── L*a*b* D50 (Color Editor) ── */
const PP_TO_XYZ = [[0.7976749, 0.1351917, 0.0313534], [0.2880402, 0.7118741, 0.0000857], [0, 0, 0.82521]];
const XYZ_TO_PP = [[1.3459433, -0.2556075, -0.0511118], [-0.5445989, 1.5081673, 0.0205351], [0, 0, 1.2118128]];
const WX = 0.96422, WZ = 0.82521;
const LAB_E = 216 / 24389, LAB_K = 24389 / 27;
const labF = (t) => (t > LAB_E ? Math.cbrt(t) : (LAB_K * t + 16) / 116);
const labFi = (f) => (f * f * f > LAB_E ? f * f * f : (116 * f - 16) / LAB_K);
function ppToLch(r, g, b) {
  const x = mul3(PP_TO_XYZ, r, g, b);
  const fx = labF(x[0] / WX), fy = labF(x[1]), fz = labF(x[2] / WZ);
  const L = 116 * fy - 16, A = 500 * (fx - fy), B = 200 * (fy - fz);
  const C = Math.sqrt(A * A + B * B);
  let h = C > 1e-6 ? (Math.atan2(B, A) * 180) / Math.PI : 0;
  if (h < 0) h += 360;
  return [L, C, h];
}
function lchToPp(L, C, h) {
  const A = C * Math.cos((h * Math.PI) / 180), B = C * Math.sin((h * Math.PI) / 180);
  const fy = (L + 16) / 116, fx = fy + A / 500, fz = fy - B / 200;
  return mul3(XYZ_TO_PP, labFi(fx) * WX, labFi(fy), labFi(fz) * WZ);
}

/**
 * 8 lát mặc định của Capture One (OpenCoreDll ColorCorrection_GetPredefinedSlices):
 * tâm = hue L*C*h của màu RGB thiết bị (Adobe RGB 1998), lõi ± độ, độ mượt 15°.
 */
const EDITOR_SLICES = [
  { band: "red", center: 38.4, core: 10.196 },
  { band: "orange", center: 50.0, core: 6.017 },
  { band: "yellow", center: 84.5, core: 5.0 },
  { band: "green", center: 144.8, core: 39.386 },
  { band: "cyan", center: 188.0, core: 11.855 },
  { band: "blue", center: 294.7, core: 22.427 },
  { band: "purple", center: 317.3, core: 17.893 },
  { band: "magenta", center: 355.9, core: 7.115 },
];
const EDITOR_SMOOTH = 15;
/** Trọng số theo hue (ColorCorrection_GetSmoothHueDist): 1 trong lõi, smoothstep ra ngoài. */
function sliceWeight(h, s) {
  let d = Math.abs(h - s.center) % 360;
  if (d > 180) d = 360 - d;
  if (d <= s.core) return 1;
  const t = (EDITOR_SMOOTH - (d - s.core)) / EDITOR_SMOOTH;
  return t <= 0 ? 0 : (3 - 2 * t) * t * t;
}

/** Lát Color Editor của một màu sRGB 0..1 (cho ống hút); null nếu gần như xám. */
export function editorBandAt(r, g, b) {
  const p = mul3(SRGB_TO_PP, toLinear(r), toLinear(g), toLinear(b));
  const lch = ppToLch(p[0], p[1], p[2]);
  if (lch[1] < 6) return null;
  let best = null, bw = 0;
  EDITOR_SLICES.forEach((s) => { const w = sliceWeight(lch[2], s); if (w > bw) { bw = w; best = s.band; } });
  return best;
}

/* ═════════════════════════ Curve ═════════════════════════ */

/**
 * Spline bậc ba tự nhiên (đạo hàm bậc hai bằng 0 ở hai đầu) qua các điểm curve
 * — CSpline của Capture One —, lấy mẫu thành bảng 0..1.
 */
export function curveTable(points, size) {
  const pts = points.map((p) => [p[0] / 255, p[1] / 255]);
  const n = pts.length;
  const t = new Float32Array(size);
  const identity = n === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
  if (identity) {
    for (let i = 0; i < size; i++) t[i] = i / (size - 1);
    return t;
  }
  const h = [], m = new Array(n).fill(0);
  for (let i = 0; i < n - 1; i++) h.push(pts[i + 1][0] - pts[i][0]);
  if (n > 2) {
    // Hệ ba đường chéo cho đạo hàm bậc hai m[1..n-2], m[0] = m[n-1] = 0.
    const a = [], bb = [], c = [], d = [];
    for (let i = 1; i < n - 1; i++) {
      a.push(h[i - 1]); bb.push(2 * (h[i - 1] + h[i])); c.push(h[i]);
      d.push(6 * ((pts[i + 1][1] - pts[i][1]) / h[i] - (pts[i][1] - pts[i - 1][1]) / h[i - 1]));
    }
    for (let i = 1; i < bb.length; i++) {
      const w = a[i] / bb[i - 1];
      bb[i] -= w * c[i - 1]; d[i] -= w * d[i - 1];
    }
    for (let i = bb.length - 1; i >= 0; i--) m[i + 1] = (d[i] - (i + 1 < bb.length ? c[i] * m[i + 2] : 0)) / bb[i];
  }
  let seg = 0;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    if (x <= pts[0][0]) { t[i] = pts[0][1]; continue; }
    if (x >= pts[n - 1][0]) { t[i] = pts[n - 1][1]; continue; }
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
    const hh = h[seg], A = (pts[seg + 1][0] - x) / hh, B = 1 - A;
    t[i] = clamp01(A * pts[seg][1] + B * pts[seg + 1][1] + ((A * A * A - A) * m[seg] + (B * B * B - B) * m[seg + 1]) * hh * hh / 6);
  }
  return t;
}

/** Tra bảng 0..1 có nội suy. */
function lookup(t, x) {
  const n = t.length - 1;
  const f = clamp01(x) * n, i = f | 0;
  return i >= n ? t[n] : t[i] + (t[i + 1] - t[i]) * (f - i);
}

function isNeutralCurve(p) { return p.length === 2 && p[0][0] === 0 && p[0][1] === 0 && p[1][0] === 255 && p[1][1] === 255; }

/* ═════════════════════════ chuỗi màu (một điểm ảnh) ═════════════════════════ */

/**
 * Dựng hai nửa của chuỗi màu, tính trước mọi thứ không phụ thuộc điểm ảnh.
 *   pre(r, g, b)  : sRGB 0..1 → ProPhoto tuyến tính (sau WB, Exposure, CB Master)
 *   post(r, g, b) : ProPhoto tuyến tính → sRGB 0..1 (mọi bước còn lại)
 * HDR — công cụ theo vùng — chạy giữa hai nửa (renderLook).
 */
function colourStages(look, opts) {
  const L = look;
  const userLut = opts.userLut && L.lut.opacity > 0 ? opts.userLut : null;
  const lutMix = L.lut.opacity / 100;
  const forceBw = !!opts.bw || L.blackWhite.enabled;

  const wb = L.whiteBalance.kelvin !== 5500 || L.whiteBalance.tint !== 0 ? wbGains(L.whiteBalance.kelvin, L.whiteBalance.tint) : null;
  const ev = L.exposure.exposure !== 0 ? Math.pow(2, L.exposure.exposure) : 1;

  // Color Balance Master (FUN_180a1f340): chia cho kênh nhỏ nhất — kênh yếu giữ nguyên, các kênh còn lại tăng.
  const cbm = L.colorBalance.master;
  let master = null;
  if (cbm.saturation) {
    const g = cbGains(cbm.hue, cbm.saturation, 0), mn = Math.min(g[0], g[1], g[2]);
    master = [g[0] / mn, g[1] / mn, g[2] / mn];
  }

  const ce = EDITOR_SLICES.map((s) => ({ s, v: L.colorEditor[s.band] })).filter((x) => x.v && (x.v.hue || x.v.saturation || x.v.lightness));
  const sat = L.exposure.saturation;
  const kC = L.exposure.contrast / 50 * (L.exposure.contrast < 0 ? 1 / 3 : 1);
  const kB = L.exposure.brightness ? Math.pow(2, (L.exposure.brightness / 50) * 1.8) : 1;

  const lv = LEVEL_CHANNELS.map((c) => (isNeutralLevels(L.levels[c]) ? null : levelsFn(L.levels[c])));
  const cvSize = 1024;
  const cv = {};
  CURVE_CHANNELS.forEach((c) => { cv[c] = isNeutralCurve(L.curve[c]) ? null : curveTable(L.curve[c], cvSize); });

  // 3 vùng Color Balance: hệ số nhân, phần màu chuẩn hoá giữ độ sáng (trọng số vùng: xấp xỉ).
  const zones = ["shadow", "midtone", "highlight"].map((z) => {
    const c = L.colorBalance[z];
    if (!c.saturation && !c.lightness) return null;
    const hueOnly = cbGains(c.hue, c.saturation, 0), y = ppLum(hueOnly[0], hueOnly[1], hueOnly[2]);
    const light = cbGains(0, 0, c.lightness)[0];
    return [hueOnly[0] / y * light, hueOnly[1] / y * light, hueOnly[2] / y * light];
  });
  const zonesOn = zones.some(Boolean);

  const bw = L.blackWhite;
  const bwSens = BW_BANDS.map((b) => bw[b] / 100);
  const bwHi = bw.highlightSaturation ? tintVector(bw.highlightHue).map((v) => v * (bw.highlightSaturation / 100) * 0.25) : null;
  const bwSh = bw.shadowSaturation ? tintVector(bw.shadowHue).map((v) => v * (bw.shadowSaturation / 100) * 0.25) : null;

  function pre(r, g, b) {
    // ── LUT ngoài: nền look làm sẵn ở nơi khác ──
    if (userLut) {
      const o = sampleLut(userLut, r, g, b);
      r += (o[0] - r) * lutMix; g += (o[1] - g) * lutMix; b += (o[2] - b) * lutMix;
    }
    return preLin(toLinear(r), toLinear(g), toLinear(b));
  }

  /** Nửa trước khi đã có sRGB tuyến tính (không có LUT ngoài) — renderLook tra bảng cho nhanh. */
  function preLin(lr, lg, lb) {
    if (wb) { lr *= wb[0]; lg *= wb[1]; lb *= wb[2]; }
    const p = mul3(SRGB_TO_PP, lr, lg, lb);
    if (ev !== 1) { p[0] *= ev; p[1] *= ev; p[2] *= ev; }
    if (master) { p[0] *= master[0]; p[1] *= master[1]; p[2] *= master[2]; }
    return p;
  }

  function post(r, g, b) {
    r = clamp01(r); g = clamp01(g); b = clamp01(b);

    // ── Color Editor (ColorEditsImpl::ApplyColorCorrectionToPoint_v2017) ──
    if (ce.length) {
      const lch = ppToLch(r, g, b);
      let wSum = 0, dh = 0, ds = 0, dl = 0;
      for (let i = 0; i < ce.length; i++) {
        const w = sliceWeight(lch[2], ce[i].s);
        if (!w) continue;
        // Lightness: lõi nhân 0.1 · chroma, và giao diện Capture One chia số trên thanh trượt cho 10.
        wSum += w; dh += w * ce[i].v.hue; ds += w * ce[i].v.saturation; dl += w * ce[i].v.lightness * 0.01 * lch[1];
      }
      if (wSum > 0) {
        if (wSum > 1) { dh /= wSum; ds /= wSum; dl /= wSum; }
        const o = lchToPp(
          Math.min(100, Math.max(0, lch[0] + dl)),
          Math.min(181, Math.max(0, lch[1] * (1 + ds * 0.0125))),
          lch[2] + dh,
        );
        r = clamp01(o[0]); g = clamp01(o[1]); b = clamp01(o[2]);
      }
    }

    // ── Tông: ProPhoto gamma 1.8 ──
    r = encG(r); g = encG(g); b = encG(b);

    // ── Saturation — trên gamma 1.8: ảnh vào đã là ảnh hiển thị, làm trên tuyến tính thì quá gắt ──
    if (sat) { const o = c1Saturation(r, g, b, sat); r = o[0]; g = o[1]; b = o[2]; }
    if (kC) { const o = c1Contrast(r, g, b, kC); r = o[0]; g = o[1]; b = o[2]; }
    if (kB !== 1) { const o = c1Brightness(r, g, b, kB); r = o[0]; g = o[1]; b = o[2]; }

    // ── Levels: tổng rồi từng kênh ──
    if (lv[0]) { r = lv[0](r); g = lv[0](g); b = lv[0](b); }
    if (lv[1]) r = lv[1](r);
    if (lv[2]) g = lv[2](g);
    if (lv[3]) b = lv[3](b);

    // ── Curve: RGB, từng kênh, rồi Luma (chỉ đổi sáng) ──
    if (cv.rgb) { r = lookup(cv.rgb, r); g = lookup(cv.rgb, g); b = lookup(cv.rgb, b); }
    if (cv.r) r = lookup(cv.r, r);
    if (cv.g) g = lookup(cv.g, g);
    if (cv.b) b = lookup(cv.b, b);
    if (cv.luma) {
      const y = ppLum(r, g, b), d = lookup(cv.luma, y) - y;
      r += d; g += d; b += d;
    }

    // ── Color Balance 3 vùng: nhân, trọng số theo độ sáng ──
    if (zonesOn) {
      const y = clamp01(ppLum(r, g, b));
      const ws = (1 - y) * (1 - y), wh = y * y, zw = [ws, 1 - ws - wh, wh];
      for (let z = 0; z < 3; z++) {
        const k = zones[z];
        if (!k) continue;
        r *= 1 + zw[z] * (k[0] - 1); g *= 1 + zw[z] * (k[1] - 1); b *= 1 + zw[z] * (k[2] - 1);
      }
    }

    // ── về sRGB ──
    const s = mul3(PP_TO_SRGB, decG(r), decG(g), decG(b));
    r = toSrgb(s[0]); g = toSrgb(s[1]); b = toSrgb(s[2]);

    // ── Black & White: trộn kênh theo dải màu, rồi Split Tones (bản cũ) ──
    if (forceBw) {
      r = clamp01(r); g = clamp01(g); b = clamp01(b);
      const hsv = rgbToHsv(r, g, b);
      const chroma = Math.max(r, g, b) - Math.min(r, g, b);
      const w = bandWeights(hsv[0], BW_CENTERS);
      let y = luma(r, g, b), d = 0;
      for (let i = 0; i < 6; i++) d += w[i] * bwSens[i];
      y = clamp01(y + d * 0.5 * chroma);
      r = y; g = y; b = y;
      if (bwHi) { const k = y * y; r += bwHi[0] * k; g += bwHi[1] * k; b += bwHi[2] * k; }
      if (bwSh) { const k = (1 - y) * (1 - y); r += bwSh[0] * k; g += bwSh[1] * k; b += bwSh[2] * k; }
    }

    return [clamp01(r), clamp01(g), clamp01(b)];
  }

  return { pre, preLin: userLut ? null : preLin, post };
}

/** Cả chuỗi (không có HDR) cho một điểm ảnh: sRGB 0..1 → sRGB 0..1. */
function colourChain(look, opts) {
  const st = colourStages(look, opts);
  return (r, g, b) => { const p = st.pre(r, g, b); return st.post(p[0], p[1], p[2]); };
}

/* ═════════════════════════ LUT 3D ═════════════════════════ */

/** Tra một LUT 3D {size, data} (nội suy ba chiều), vào/ra 0..1. */
export function sampleLut(lut, r, g, b) {
  const n = lut.size - 1, d = lut.data;
  const fr = clamp01(r) * n, fg = clamp01(g) * n, fb = clamp01(b) * n;
  const r0 = Math.min(fr | 0, n - 1), g0 = Math.min(fg | 0, n - 1), b0 = Math.min(fb | 0, n - 1);
  const tr = fr - r0, tg = fg - g0, tb = fb - b0;
  const S = lut.size, S2 = S * S;
  const out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    // .cube: chỉ số chạy R nhanh nhất, rồi G, rồi B.
    const at = (ri, gi, bi) => d[(bi * S2 + gi * S + ri) * 3 + c];
    const c00 = at(r0, g0, b0) * (1 - tr) + at(r0 + 1, g0, b0) * tr;
    const c10 = at(r0, g0 + 1, b0) * (1 - tr) + at(r0 + 1, g0 + 1, b0) * tr;
    const c01 = at(r0, g0, b0 + 1) * (1 - tr) + at(r0 + 1, g0, b0 + 1) * tr;
    const c11 = at(r0, g0 + 1, b0 + 1) * (1 - tr) + at(r0 + 1, g0 + 1, b0 + 1) * tr;
    out[c] = (c00 * (1 - tg) + c10 * tg) * (1 - tb) + (c01 * (1 - tg) + c11 * tg) * tb;
  }
  return out;
}

/**
 * Đọc file .cube (định dạng LUT 3D thông dụng). Chỉ LUT 3D.
 * Ném lỗi kèm lý do khi file không đọc được — nơi gọi quyết định bỏ qua hay báo.
 */
export function parseCube(text) {
  let size = 0, min = [0, 0, 0], max = [1, 1, 1];
  const vals = [];
  const lines = String(text).split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line[0] === "#") continue;
    const parts = line.split(/\s+/);
    const key = parts[0].toUpperCase();
    if (key === "LUT_3D_SIZE") { size = parseInt(parts[1], 10); continue; }
    if (key === "LUT_1D_SIZE") throw new Error("LUT 1D không được hỗ trợ, cần LUT 3D");
    if (key === "DOMAIN_MIN") { min = parts.slice(1, 4).map(Number); continue; }
    if (key === "DOMAIN_MAX") { max = parts.slice(1, 4).map(Number); continue; }
    if (key === "TITLE" || /^[A-Z_]+$/.test(key)) continue;
    if (parts.length >= 3) vals.push(+parts[0], +parts[1], +parts[2]);
  }
  if (!(size >= 2 && size <= 256)) throw new Error("thiếu hoặc sai LUT_3D_SIZE");
  if (vals.length !== size * size * size * 3) {
    throw new Error(`cần ${size * size * size} dòng màu, file có ${vals.length / 3}`);
  }
  const data = new Float32Array(vals.length);
  for (let i = 0; i < vals.length; i++) {
    const c = i % 3;
    data[i] = clamp01((vals[i] - min[c]) / (max[c] - min[c] || 1));
  }
  return { size, data };
}

/**
 * Gộp mọi công cụ màu/tông (trừ HDR) thành một LUT 3D sRGB → sRGB, đã trộn
 * với ảnh gốc theo `strength`. Dựng một lần cho mỗi bộ số, rồi mỗi điểm ảnh
 * chỉ còn là một phép tra bảng — đủ nhanh để kéo thanh trượt mà ảnh chạy theo.
 */
export function buildLut(look, opts = {}, size = 33) {
  const f = colourChain(look, opts);
  const s = look.strength / 100;
  const data = new Float32Array(size * size * size * 3);
  const n = size - 1;
  let p = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const r = ri / n, g = gi / n, b = bi / n;
        const o = f(r, g, b);
        data[p++] = r + (o[0] - r) * s;
        data[p++] = g + (o[1] - g) * s;
        data[p++] = b + (o[2] - b) * s;
      }
    }
  }
  return { size, data };
}

/**
 * Bộ màu đang chỉnh → file .cube (LUT 3D sRGB → sRGB, R chạy nhanh nhất), để
 * mang sang Capture One / Photoshop / Lightroom / DaVinci. Lưới 65³ — mức cao
 * nhất các phần mềm đó đều nhận — và 6 chữ số thập phân, nên không bóp màu.
 * Gồm mọi công cụ tính theo từng điểm ảnh (như buildLut, đã trộn `strength`).
 * HDR, Clarity, Vignetting, Film Grain nhìn sang điểm bên cạnh hay theo vị trí
 * nên LUT không chứa được — `skipped` liệt kê những công cụ đó khi đang bật.
 * `opts.userLut`: LUT người dùng đã nạp (thiếu thì LUT xuất ra không có nó).
 */
export function lookToCube(look, opts = {}, title = "Filmong look", size = 65) {
  const lut = buildLut(look, opts, size);
  const h = look.hdr, skipped = [];
  if (h.highlight || h.shadow || h.white || h.black) skipped.push("HDR");
  if (look.clarity.clarity || look.clarity.structure) skipped.push("Clarity");
  if (look.vignetting.amount) skipped.push("Vignetting");
  if (look.grain.impact > 0) skipped.push("Film Grain");
  const lines = [
    `TITLE "${String(title).replace(/"/g, "'")}"`,
    "# Xuat tu look.js (cong thuc chinh mau Capture One) - sRGB vao, sRGB ra.",
    skipped.length ? `# KHONG co trong LUT (khong tinh theo tung diem anh): ${skipped.join(", ")}` : "# Day du moi cong cu dang bat.",
    `LUT_3D_SIZE ${size}`,
    "DOMAIN_MIN 0.0 0.0 0.0",
    "DOMAIN_MAX 1.0 1.0 1.0",
  ];
  const d = lut.data, f = (v) => clamp01(v).toFixed(6);
  for (let i = 0; i < d.length; i += 3) lines.push(`${f(d[i])} ${f(d[i + 1])} ${f(d[i + 2])}`);
  return { text: lines.join("\n") + "\n", skipped };
}

/**
 * LUT của nửa sau (dùng khi có HDR), đánh chỉ số theo sRGB: hệ số HDR là một
 * số vô hướng nên nhân trên sRGB tuyến tính hay ProPhoto như nhau, còn màu thật
 * của ảnh luôn nằm trong lưới — hàm cần nội suy gần như đồng nhất, không lệch
 * ở vùng tối hay ở mép dải màu.
 */
function buildPostLut(post, size = 33) {
  const data = new Float32Array(size * size * size * 3);
  const n = size - 1;
  let p = 0;
  for (let bi = 0; bi < size; bi++) {
    for (let gi = 0; gi < size; gi++) {
      for (let ri = 0; ri < size; ri++) {
        const q = mul3(SRGB_TO_PP, toLinear(ri / n), toLinear(gi / n), toLinear(bi / n));
        const o = post(q[0], q[1], q[2]);
        data[p++] = o[0]; data[p++] = o[1]; data[p++] = o[2];
      }
    }
  }
  return { size, data };
}

/* ═════════════════════════ công cụ theo vùng ═════════════════════════ */

/** Làm mờ hộp tách trục, chạy 3 lần ≈ Gauss. Trả về mảng mới. */
export function boxBlur(src, w, h, radius, passes = 3) {
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const r = Math.max(0, Math.round(radius));
  if (r < 1) return a;
  for (let p = 0; p < passes; p++) {
    for (let y = 0; y < h; y++) {
      const row = y * w;
      let acc = 0;
      for (let x = -r; x <= r; x++) acc += a[row + Math.min(w - 1, Math.max(0, x))];
      for (let x = 0; x < w; x++) {
        b[row + x] = acc / (2 * r + 1);
        acc += a[row + Math.min(w - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
      }
    }
    for (let x = 0; x < w; x++) {
      let acc = 0;
      for (let y = -r; y <= r; y++) acc += b[Math.min(h - 1, Math.max(0, y)) * w + x];
      for (let y = 0; y < h; y++) {
        a[y * w + x] = acc / (2 * r + 1);
        acc += b[Math.min(h - 1, y + r + 1) * w + x] - b[Math.max(0, y - r) * w + x];
      }
    }
  }
  return a;
}

/** Bộ lọc dẫn hướng (He et al.), ảnh tự dẫn: mờ vùng phẳng, giữ cạnh lớn hơn √eps. */
function guidedFilter(I, w, h, r, eps) {
  const n = w * h, II = new Float32Array(n);
  for (let i = 0; i < n; i++) II[i] = I[i] * I[i];
  const mI = boxBlur(I, w, h, r, 1), mII = boxBlur(II, w, h, r, 1);
  const A = new Float32Array(n), B = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const v = mII[i] - mI[i] * mI[i];
    A[i] = v / (v + eps); B[i] = mI[i] - A[i] * mI[i];
  }
  const mA = boxBlur(A, w, h, r, 1), mB = boxBlur(B, w, h, r, 1);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = mA[i] * I[i] + mB[i];
  return out;
}

/**
 * Hàm mềm của HDR (FUN_180a90820): xấp xỉ max(1.8x, ~0.5) rồi bão hoà về tối đa p.
 * Giới hạn mỗi thanh trượt: Shadow 2.1 EV, Highlight 3 EV, Black/White 4.2 EV.
 */
function hdrSoft(x, p) {
  x *= 1.8;
  const a = Math.abs(x) + 1;
  const t = ((a * x) / (x * x + a)) * 0.5 + 0.5;
  let u = x - t + 1;
  if (u <= t) u = t;
  u /= p + p;
  const u2 = u * u, w = (u2 * u2 + u) * (u + 1 + u2);
  return (w / (w + 1)) * p;
}
function hdrSoftU(x) {
  x *= 1.8;
  const a = Math.abs(x) + 1;
  const t = ((a * x) / (x * x + a)) * 0.5 + 0.5;
  const u = x - t + 1;
  return u <= t ? t : u;
}

/**
 * Hệ số HDR cho một điểm (CImgOpLocalToneMappingV8, FUN_180a93330).
 * o = log2 độ sáng gốc, f = log2 độ sáng đã lọc (nền). Quy ước Capture One mới:
 * Highlight âm / White âm kéo vùng sáng xuống; Shadow dương / Black dương nâng vùng tối.
 */
function hdrGain(o, f, H) {
  const aH = -H.highlight * 0.6 / 100, aS = H.shadow / 100, aW = -H.white / 100, aB = H.black / 100;
  const local = (o - f) * 0.3 + o, avg = 0.5 * f + 0.5 * o;
  let gS = 1, gH = 1, gB = 1, gW = 1;
  if (aS) {
    let e;
    if (aS >= 0) {
      const x = -local;
      e = hdrSoft(x, 2.1) + Math.max(0, x) * (f - o);
    } else {
      e = -hdrSoft(-avg, 2.1);
    }
    const k = Math.min(1, Math.abs(aS));
    gS = Math.pow(2, e) * k + 1 - k;
  }
  if (aH) {
    let e = hdrSoft(aH >= 0 ? local : avg, 3);
    if (aH < 0) e = -e;
    const k = Math.min(1, Math.abs(aH));
    gH = Math.pow(2, e) * k + 1 - k;
  }
  if (aB) {
    const z = aB >= 0 ? local : avg;
    const s1 = hdrSoft(-z, 4.2), s2 = hdrSoft(-z, 2.1);
    let e = s1 - s2 + hdrSoft(-(Math.log2(gS) + (s1 - s2) + z + 1.6667), 4.2 - 2.1);
    if (aB < 0) e *= -4;
    const k = Math.min(1, Math.abs(aB));
    gB = Math.pow(2, e) * k + 1 - k;
  }
  if (aW) {
    const z = aW >= 0 ? local : avg;
    let e = hdrSoftU((z - Math.log2(gH)) - 1.1111) * 0.5;
    if (aW < 0) e *= -4;
    const k = Math.min(1, Math.abs(aW));
    gW = Math.pow(2, e) * k + 1 - k;
  }
  return (gB * gS) / (gW * gH);
}

/** Độ sáng tham chiếu của bản đồ log (Capture One: giá trị film curve cho ra 0.25). */
const HDR_REF = 0.25;

/** Bảng tính trước cho đường truyền sRGB khi tra LUT nửa sau. */
const ENC_N = 16384;
const ENC_T = new Float32Array(ENC_N + 1);
for (let i = 0; i <= ENC_N; i++) ENC_T[i] = toSrgb(i / ENC_N);
function encFast(v) {
  if (v <= 0) return 0;
  if (v >= 1) return 1;
  const f = v * ENC_N, i = f | 0;
  return ENC_T[i] + (ENC_T[i + 1] - ENC_T[i]) * (f - i);
}

/** Tra LUT ba chiều trên mảng phẳng (dùng trong vòng lặp điểm ảnh). */
function lutAt(L, r, g, b, out) {
  const S = L.size, N = S - 1, S2 = S * S, D = L.data;
  const fr = r * N, fg = g * N, fb = b * N;
  const r0 = Math.min(fr | 0, N - 1), g0 = Math.min(fg | 0, N - 1), b0 = Math.min(fb | 0, N - 1);
  const tr = fr - r0, tg = fg - g0, tb = fb - b0;
  const base = (b0 * S2 + g0 * S + r0) * 3, oR = 3, oG = S * 3, oB = S2 * 3;
  for (let c = 0; c < 3; c++) {
    const q = base + c;
    const c00 = D[q] + (D[q + oR] - D[q]) * tr;
    const c10 = D[q + oG] + (D[q + oG + oR] - D[q + oG]) * tr;
    const c01 = D[q + oB] + (D[q + oB + oR] - D[q + oB]) * tr;
    const c11 = D[q + oB + oG] + (D[q + oB + oG + oR] - D[q + oB + oG]) * tr;
    out[c] = (c00 + (c10 - c00) * tg) * (1 - tb) + (c01 + (c11 - c01) * tg) * tb;
  }
}

/**
 * Chuỗi màu có HDR: nửa trước từng điểm → bản đồ độ sáng log ở độ phân giải
 * thấp → bộ lọc dẫn hướng (bán kính ≈ 3.2% cạnh dài, như 192 px trên ảnh 6000 px
 * của Capture One) → hệ số HDR → nhân → LUT nửa sau.
 */
function renderWithHdr(data, w, h, stride, look, opts) {
  const st = colourStages(look, opts);
  const post = buildPostLut(st.post);
  const s = look.strength / 100;
  const long = Math.max(w, h);
  const d = Math.max(1, Math.ceil(long / 1024));
  const mw = Math.ceil(w / d), mh = Math.ceil(h / d);
  const preAt = st.preLin
    ? (p) => st.preLin(TO_LIN[data[p]], TO_LIN[data[p + 1]], TO_LIN[data[p + 2]])
    : (p) => st.pre(data[p] / 255, data[p + 1] / 255, data[p + 2] / 255);

  // 1. Bản đồ log2 độ sáng (ProPhoto, sau Exposure) — trung bình từng ô d×d.
  const sum = new Float32Array(mw * mh), cnt = new Float32Array(mw * mh);
  for (let y = 0; y < h; y++) {
    const my = (y / d) | 0;
    for (let x = 0, p = y * w * stride; x < w; x++, p += stride) {
      const q = preAt(p);
      const k = my * mw + ((x / d) | 0);
      sum[k] += ppLum(q[0], q[1], q[2]); cnt[k]++;
    }
  }
  const O = new Float32Array(mw * mh);
  for (let i = 0; i < O.length; i++) O[i] = Math.log2(Math.max(1e-5, sum[i] / Math.max(1, cnt[i])) / HDR_REF);

  // 2. Nền: lọc dẫn hướng hai tầng (thô rồi mịn), ε theo Capture One (0.9 rồi 0.45 stop)².
  const r = Math.max(1, Math.round((0.032 * long) / d));
  let F = guidedFilter(O, mw, mh, r, 0.81);
  F = guidedFilter(F, mw, mh, Math.max(1, r >> 2), 0.2025);

  // 3. Hệ số từng ô.
  const G = new Float32Array(mw * mh);
  for (let i = 0; i < G.length; i++) G[i] = hdrGain(O[i], F[i], look.hdr);

  // 4. Nhân hệ số (nội suy song tuyến) rồi tra LUT nửa sau, trộn theo độ đậm.
  const out = [0, 0, 0];
  for (let y = 0; y < h; y++) {
    const gy = Math.min(mh - 1, Math.max(0, (y + 0.5) / d - 0.5)), y0 = Math.min(mh - 2, gy | 0) < 0 ? 0 : Math.min(mh - 2, gy | 0), ty = mh > 1 ? gy - y0 : 0;
    for (let x = 0, p = y * w * stride; x < w; x++, p += stride) {
      const gx = Math.min(mw - 1, Math.max(0, (x + 0.5) / d - 0.5)), x0 = Math.min(mw - 2, gx | 0) < 0 ? 0 : Math.min(mw - 2, gx | 0), tx = mw > 1 ? gx - x0 : 0;
      const i00 = y0 * mw + x0, x1 = mw > 1 ? 1 : 0, y1 = mh > 1 ? mw : 0;
      const gain = (G[i00] * (1 - tx) + G[i00 + x1] * tx) * (1 - ty) + (G[i00 + y1] * (1 - tx) + G[i00 + y1 + x1] * tx) * ty;
      const r0 = data[p] / 255, g0 = data[p + 1] / 255, b0 = data[p + 2] / 255;
      const q = preAt(p), lin = mul3(PP_TO_SRGB, q[0], q[1], q[2]);
      lutAt(post, encFast(lin[0] * gain), encFast(lin[1] * gain), encFast(lin[2] * gain), out);
      const v0 = r0 + (out[0] - r0) * s, v1 = g0 + (out[1] - g0) * s, v2 = b0 + (out[2] - b0) * s;
      data[p] = v0 <= 0 ? 0 : v0 >= 1 ? 255 : (v0 * 255 + 0.5) | 0;
      data[p + 1] = v1 <= 0 ? 0 : v1 >= 1 ? 255 : (v1 * 255 + 0.5) | 0;
      data[p + 2] = v2 <= 0 ? 0 : v2 >= 1 ? 255 : (v2 * 255 + 0.5) | 0;
    }
  }
}

/** Bộ sinh số giả ngẫu nhiên có hạt giống: cùng seed thì cùng hạt phim. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * Đặc tính của sáu kiểu hạt Film Grain: cỡ cụm, độ mềm
 * (số lần làm mờ), độ gắt, và "khối" (cubic: hạt vuông, lấy mẫu thưa).
 */
const GRAIN_PROFILE = {
  fine: { size: 0.8, passes: 1, gain: 1.0, block: 1 },
  silverRich: { size: 1.1, passes: 2, gain: 1.15, block: 1 },
  soft: { size: 1.6, passes: 3, gain: 0.85, block: 1 },
  cubic: { size: 1.0, passes: 1, gain: 1.2, block: 2 },
  tabular: { size: 0.9, passes: 2, gain: 0.95, block: 1 },
  harsh: { size: 1.3, passes: 0, gain: 1.6, block: 1 },
};

/** Lớp hạt chuẩn hoá (trung bình 0, độ lệch 1), cỡ cụm theo cạnh dài của ảnh. */
export function grainPlane(w, h, grain, seed) {
  const prof = GRAIN_PROFILE[grain.type] || GRAIN_PROFILE.fine;
  const long = Math.max(w, h);
  const sizePx = prof.size * (0.4 + (grain.granularity / 100) * 2.2) * (long / 1500);
  const block = Math.max(1, Math.round(prof.block * Math.max(1, sizePx * 0.6)));
  const rnd = mulberry32(seed || 1);
  const n = w * h;
  let p = new Float32Array(n);
  if (block > 1) {
    const bw = Math.ceil(w / block), bh = Math.ceil(h / block);
    const cells = new Float32Array(bw * bh);
    for (let i = 0; i < cells.length; i++) cells[i] = rnd() + rnd() - 1;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) p[y * w + x] = cells[((y / block) | 0) * bw + ((x / block) | 0)];
    }
  } else {
    for (let i = 0; i < n; i++) p[i] = rnd() + rnd() - 1;
  }
  if (prof.passes > 0 && sizePx >= 0.75) p = boxBlur(p, w, h, sizePx * 0.5, prof.passes);
  let s = 0, sq = 0;
  for (let i = 0; i < n; i++) { s += p[i]; sq += p[i] * p[i]; }
  const mean = s / n, sd = Math.sqrt(Math.max(1e-12, sq / n - mean * mean));
  const k = prof.gain / sd;
  for (let i = 0; i < n; i++) p[i] = (p[i] - mean) * k;
  return p;
}

/* ═════════════════════════ xử lý cả ảnh ═════════════════════════ */

const TO_LIN = new Float32Array(256);
for (let i = 0; i < 256; i++) TO_LIN[i] = toLinear(i / 255);
// Tuyến tính → byte sRGB qua bảng 16384 mức: sai lệch < 0.2 mức ở vùng tối, nhanh hơn pow nhiều lần.
const TO_BYTE_N = 16384;
const TO_BYTE = new Uint8Array(TO_BYTE_N + 1);
for (let i = 0; i <= TO_BYTE_N; i++) TO_BYTE[i] = (toSrgb(i / TO_BYTE_N) * 255 + 0.5) | 0;
const toByte = (v) => (v <= 0 ? 0 : v >= 1 ? 255 : TO_BYTE[(v * TO_BYTE_N + 0.5) | 0]);

/** Có công cụ HDR nào khác 0 không. */
function hdrOn(look) {
  const h = look.hdr;
  return !!(h.highlight || h.shadow || h.white || h.black);
}

/**
 * Áp look lên ảnh, sửa tại chỗ. `data` là mảng byte xen kênh, `stride` = 3
 * (RGB, từ sharp) hoặc 4 (RGBA, từ canvas — kênh alpha giữ nguyên).
 *
 * opts:
 *   bw        — lượt B&W: bật công cụ Black & White dù cấu hình đang tắt.
 *   userLut   — LUT .cube đã đọc (parseCube), dùng cho mục LUT.
 *   lut       — LUT 3D dựng sẵn (buildLut) để khỏi dựng lại khi chỉ đổi ảnh.
 *               Bị bỏ qua khi HDR bật (HDR chạy giữa hai nửa chuỗi màu).
 *   grain     — lớp hạt dựng sẵn (grainPlane) cùng cỡ ảnh, cho trang chỉnh.
 *   seed      — hạt giống cho hạt phim; 0/không có = ngẫu nhiên.
 */
export function renderLook(data, w, h, stride, look, opts = {}) {
  const n = w * h;
  const s = look.strength / 100;

  // ── 1. Màu / tông ──
  if (hdrOn(look) && s > 0) {
    renderWithHdr(data, w, h, stride, look, opts);
  } else {
    const lut = opts.lut || buildLut(look, opts);
    const S = lut.size, S2 = S * S, N = S - 1, D = lut.data;
    const idx = new Int32Array(256), frac = new Float32Array(256);
    for (let v = 0; v < 256; v++) {
      const f = (v / 255) * N;
      idx[v] = Math.min(f | 0, N - 1);
      frac[v] = f - idx[v];
    }
    for (let i = 0, p = 0; i < n; i++, p += stride) {
      const r0 = idx[data[p]], g0 = idx[data[p + 1]], b0 = idx[data[p + 2]];
      const tr = frac[data[p]], tg = frac[data[p + 1]], tb = frac[data[p + 2]];
      const base = (b0 * S2 + g0 * S + r0) * 3;
      const oR = 3, oG = S * 3, oB = S2 * 3;
      for (let c = 0; c < 3; c++) {
        const q = base + c;
        const c00 = D[q] + (D[q + oR] - D[q]) * tr;
        const c10 = D[q + oG] + (D[q + oG + oR] - D[q + oG]) * tr;
        const c01 = D[q + oB] + (D[q + oB + oR] - D[q + oB]) * tr;
        const c11 = D[q + oB + oG] + (D[q + oB + oG + oR] - D[q + oB + oG]) * tr;
        const v = (c00 + (c10 - c00) * tg) * (1 - tb) + (c01 + (c11 - c01) * tg) * tb;
        data[p + c] = v <= 0 ? 0 : v >= 1 ? 255 : (v * 255 + 0.5) | 0;
      }
    }
  }

  const long = Math.max(w, h);

  // ── 2. Clarity / Structure (CImgOpClarity2012): tương phản cục bộ trong miền √Y ──
  const cl = look.clarity;
  const kc = (cl.clarity / 100) * s, ks = (cl.structure / 100) * s;
  if (kc || ks) {
    const OFF = 16 / 65535;
    const Q = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += stride) {
      Q[i] = Math.sqrt(0.299 * TO_LIN[data[p]] + 0.587 * TO_LIN[data[p + 1]] + 0.114 * TO_LIN[data[p + 2]] + OFF);
    }
    const big = kc ? boxBlur(Q, w, h, long * 0.02) : null;
    const small = ks ? boxBlur(Q, w, h, long * 0.003) : null;
    const m = cl.method;
    // Punch: từng kênh (tăng cả bão hoà) — cần thêm ba lớp mờ.
    const chan = kc && m === "punch" ? [0, 1, 2].map((c) => {
      const C = new Float32Array(n);
      for (let i = 0, p = c; i < n; i++, p += stride) C[i] = Math.sqrt(TO_LIN[data[p]] + OFF);
      return { q: C, b: boxBlur(C, w, h, long * 0.02) };
    }) : null;
    for (let i = 0, p = 0; i < n; i++, p += stride) {
      const q = Q[i];
      let r = TO_LIN[data[p]], g = TO_LIN[data[p + 1]], b = TO_LIN[data[p + 2]];
      if (big) {
        if (chan) {
          // Punch: hệ số riêng từng kênh, chặn quầng bằng nén phân thức.
          const ch = [r, g, b];
          for (let c = 0; c < 3; c++) {
            const qc = chan[c].q[i];
            let dd = (qc - chan[c].b[i]) * kc;
            dd = (dd * qc) / Math.max(1e-6, qc + Math.abs(dd));
            const k = (dd / qc + 1); ch[c] *= k > 0 ? k * k : 0;
          }
          r = ch[0]; g = ch[1]; b = ch[2];
        } else if (m === "classic") {
          // Classic (CImgOpClarity cũ): cộng thẳng, không bảo vệ.
          const dd = (q - big[i]) * kc * 0.8 * 2 * q;
          r += dd; g += dd; b += dd;
        } else {
          // Neutral: nhân đều R, G, B (giữ màu). Natural: 70% nhân + 30% cộng theo độ sáng.
          let dd = (q - big[i]) * kc;
          dd = (dd * q) / Math.max(1e-6, q + Math.abs(dd));
          let k = dd / q + 1; k = k > 0 ? k * k : 0;
          if (m === "natural") {
            const y = q * q - OFF, add = (k - 1) * y * 0.3, mulK = 1 + (k - 1) * 0.7;
            r = r * mulK + add; g = g * mulK + add; b = b * mulK + add;
          } else {
            r *= k; g *= k; b *= k;
          }
        }
      }
      if (small) {
        // Structure2012: cùng khuôn Neutral ở bán kính nhỏ.
        const dd = (q - small[i]) * ks * 1.5;
        let k = dd / q + 1; k = k > 0 ? k * k : 0;
        r *= k; g *= k; b *= k;
      }
      data[p] = toByte(r); data[p + 1] = toByte(g); data[p + 2] = toByte(b);
    }
  }

  // ── 3. Vignetting (FUN_1809bb5c0): định luật cos⁴, góc ảnh lệch đúng `amount` EV ──
  const ev = look.vignetting.amount * s;
  if (ev) {
    const theta = Math.acos(Math.pow(Math.pow(2, -Math.abs(ev)), 0.25));
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const circ = look.vignetting.method === "circular";
    const halfDiag = Math.hypot(w / 2, h / 2);
    for (let y = 0, p = 0; y < h; y++) {
      const dy = y - cy;
      for (let x = 0; x < w; x++, p += stride) {
        const dx = x - cx;
        const rr = circ ? Math.hypot(dx, dy) / halfDiag : Math.hypot(dx / (w / 2), dy / (h / 2)) / Math.SQRT2;
        const c = Math.cos(theta * Math.min(rr, 1.0));
        let k = c * c * c * c;
        if (ev > 0) k = 1 / k;
        for (let ch = 0; ch < 3; ch++) data[p + ch] = toByte(TO_LIN[data[p + ch]] * k);
      }
    }
  }

  // ── 4. Film Grain: sau cùng, hạt xám, dày ở trung tông, mỏng ở vùng tối (bản cũ) ──
  const g = look.grain;
  const amt = (g.impact / 100) * 0.1 * s;
  if (amt > 0) {
    const seed = g.seed || opts.seed || ((Math.random() * 4294967295) >>> 0) || 1;
    const plane = opts.grain && opts.grain.length === n ? opts.grain : grainPlane(w, h, g, seed);
    for (let i = 0, p = 0; i < n; i++, p += stride) {
      const y = luma(data[p], data[p + 1], data[p + 2]) / 255;
      const wgt = smooth(0, 0.2, y) * (1 - 0.6 * smooth(0.8, 1, y));
      const d = plane[i] * amt * wgt * 255;
      if (!d) continue;
      for (let c = 0; c < 3; c++) {
        const v = data[p + c] + d;
        data[p + c] = v <= 0 ? 0 : v >= 255 ? 255 : (v + 0.5) | 0;
      }
    }
  }
}
