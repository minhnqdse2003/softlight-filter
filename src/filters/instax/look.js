/**
 * INSTAX LOOK v2 — các công cụ chỉnh màu / tông của bộ lọc Instax Wide.
 *
 * Một file, hai nơi chạy: bộ lọc Node (src/filters/instax/pipeline.js) import
 * thẳng, còn trang chỉnh web/instax.html được build-offline.mjs dán nguyên văn
 * file này vào (bỏ chữ `export`). Vì vậy ở đây chỉ được dùng JavaScript thuần —
 * không fs, không sharp, không DOM — và chỉ `export function` / `export const`
 * ở đầu dòng. Ảnh xem trước và ảnh exe ghi ra là MỘT phép tính, không phải hai
 * bản viết tay giữ cho khớp nhau.
 *
 * Số trong cấu hình là đúng số trên thanh trượt (Contrast +12, Exposure 0.3 EV,
 * Kelvin 5800…), không chia 100.
 *
 * Thứ tự xử lý:
 *   LUT ngoài (.cube) → White Balance → Exposure (EV) → High Dynamic Range →
 *   Contrast → Brightness → Levels → Curve → Saturation → Color Editor →
 *   Color Balance → Black & White      (tất cả gộp vào MỘT LUT 3D)
 *   → Clarity / Structure → Vignetting → Film Grain     (theo vùng, chạy sau)
 *
 * `strength` (0–100) là thanh "độ đậm" duy nhất người vận hành cần chạm: nó
 * trộn cả look với ảnh gốc.
 *
 * Look làm sẵn ở nơi khác thì mang sang bằng LUT .cube (mục LUT), chạy trước
 * mọi công cụ còn lại.
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
  gamma: [0.1, 9.99, 1],
  hue: [0, 359, 0],
  hueShift: [-30, 30, 0],
  amount100: [-100, 100, 0],
  sat100: [0, 100, 0],
  vignette: [-4, 4, 0],
  impact: [0, 100, 0],
  granularity: [0, 100, 50],
};

export const COLOR_EDITOR_BANDS = ["red", "orange", "yellow", "green", "cyan", "blue", "magenta"];
const EDITOR_CENTERS = [0, 30, 60, 120, 180, 240, 300];
export const BW_BANDS = ["red", "yellow", "green", "cyan", "blue", "magenta"];
const BW_CENTERS = [0, 60, 120, 180, 240, 300];
export const CURVE_CHANNELS = ["rgb", "luma", "r", "g", "b"];
export const LEVEL_CHANNELS = ["rgb", "r", "g", "b"];
export const CLARITY_METHODS = ["natural", "punch", "neutral", "classic"];
export const VIGNETTE_METHODS = ["elliptic", "circular"];
export const GRAIN_TYPES = ["fine", "silverRich", "soft", "cubic", "tabular", "harsh"];

/* ═════════════════════════ bộ số ═════════════════════════ */

function neutralLevels() {
  return { inBlack: 0, inWhite: 255, gamma: 1, outBlack: 0, outWhite: 255 };
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
 */
export function communityLook() {
  const l = neutralLook();
  l.whiteBalance = { kelvin: 5800, tint: 2 };
  l.exposure = { exposure: 0.1, contrast: -10, brightness: 5, saturation: -8 };
  l.hdr = { highlight: 30, shadow: 15, white: -12, black: 0 };
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
    const s = obj(lv[c]), dd = d.levels[c];
    const inBlack = Math.min(254, num(s.inBlack, R.level, dd.inBlack));
    const inWhite = Math.max(inBlack + 1, num(s.inWhite, R.level, dd.inWhite));
    o.levels[c] = {
      inBlack, inWhite,
      gamma: num(s.gamma, R.gamma, dd.gamma),
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
    const s = obj(ce[b]), dd = d.colorEditor[b];
    o.colorEditor[b] = {
      hue: num(s.hue, R.hueShift, dd.hue),
      saturation: num(s.saturation, R.amount100, dd.saturation),
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
  "Bo loc Instax Wide - cau hinh v2. Moi so = dung so tren thanh truot " +
  "(Contrast 12, Exposure 0.3 EV, Kelvin 5800...). strength = do dam cua ca look (0 = anh goc, 100 = du). " +
  "Chinh bang web/instax-tuner.html roi bam Luu, dat file nay canh instax.exe. LUT .cube dat trong thu muc " +
  "luts canh instax.exe. Thu tu: LUT > White Balance > Exposure > HDR > Contrast > Brightness > Levels > " +
  "Curve > Saturation > Color Editor > Color Balance > Black & White > Clarity > Vignetting > Film Grain.";

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

/** Nội dung file instax.config.json (v2) cho một bộ số — trang chỉnh và bộ cài cùng dùng. */
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

/* ═════════════════════════ toán màu ═════════════════════════ */

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
function smooth(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}
/** Độ sáng cảm nhận trên giá trị sRGB đã mã hoá (Rec.601) — đủ cho chỉnh tông. */
const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

export function toLinear(v) {
  if (v <= 0) return 0;
  return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
}
export function toSrgb(v) {
  if (v <= 0) return 0;
  return v <= 0.0031308 ? v * 12.92 : 1.055 * Math.pow(v, 1 / 2.4) - 0.055;
}

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
 * Hệ số nhân từng kênh (tuyến tính) cho White Balance. Kelvin cao hơn 5500 thì
 * ảnh ấm lên, thấp hơn thì lạnh đi.
 * Tint dương ngả hồng (magenta), âm ngả lục. Chuẩn hoá để độ sáng không đổi.
 */
function wbGains(kelvin, tint) {
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

/** Hướng màu của một sắc độ, độ sáng 0: cộng vào ảnh là nhuộm mà không đổi sáng. */
export function tintVector(hue) {
  const c = hsvToRgb(hue, 1, 1);
  const y = luma(c[0], c[1], c[2]);
  return [c[0] - y, c[1] - y, c[2] - y];
}

/**
 * Trọng số của từng dải màu cho một sắc độ: nội suy tuyến tính giữa hai tâm
 * kề nhau, nên mọi sắc độ đều có tổng trọng số = 1 và không có vết gãy màu.
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

/** Spline đơn điệu (Fritsch–Carlson) qua các điểm curve, lấy mẫu thành bảng 0..1. */
export function curveTable(points, size) {
  const pts = points.map((p) => [p[0] / 255, p[1] / 255]);
  const n = pts.length;
  const t = new Float32Array(size);
  const identity = n === 2 && pts[0][0] === 0 && pts[0][1] === 0 && pts[1][0] === 1 && pts[1][1] === 1;
  if (identity) {
    for (let i = 0; i < size; i++) t[i] = i / (size - 1);
    return t;
  }
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx.push(pts[i + 1][0] - pts[i][0]);
    dy.push((pts[i + 1][1] - pts[i][1]) / dx[i]);
  }
  m.push(dy[0]);
  for (let i = 1; i < n - 1; i++) m.push(dy[i - 1] * dy[i] <= 0 ? 0 : (dy[i - 1] + dy[i]) / 2);
  m.push(dy[n - 2]);
  for (let i = 0; i < n - 1; i++) {
    if (dy[i] === 0) { m[i] = 0; m[i + 1] = 0; continue; }
    const a = m[i] / dy[i], b = m[i + 1] / dy[i], s = a * a + b * b;
    if (s > 9) { const k = 3 / Math.sqrt(s); m[i] = k * a * dy[i]; m[i + 1] = k * b * dy[i]; }
  }
  let seg = 0;
  for (let i = 0; i < size; i++) {
    const x = i / (size - 1);
    if (x <= pts[0][0]) { t[i] = pts[0][1]; continue; }
    if (x >= pts[n - 1][0]) { t[i] = pts[n - 1][1]; continue; }
    while (seg < n - 2 && x > pts[seg + 1][0]) seg++;
    const h = dx[seg], u = (x - pts[seg][0]) / h;
    const h00 = (1 + 2 * u) * (1 - u) * (1 - u), h10 = u * (1 - u) * (1 - u);
    const h01 = u * u * (3 - 2 * u), h11 = u * u * (u - 1);
    t[i] = clamp01(h00 * pts[seg][1] + h10 * h * m[seg] + h01 * pts[seg + 1][1] + h11 * h * m[seg + 1]);
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
function isNeutralLevels(l) { return l.inBlack === 0 && l.inWhite === 255 && l.gamma === 1 && l.outBlack === 0 && l.outWhite === 255; }
function levelsFn(l) {
  const ib = l.inBlack / 255, iw = l.inWhite / 255, ob = l.outBlack / 255, ow = l.outWhite / 255, ig = 1 / l.gamma;
  return (x) => ob + (ow - ob) * Math.pow(clamp01((x - ib) / (iw - ib)), ig);
}

/* ═════════════════════════ chuỗi màu (một điểm ảnh) ═════════════════════════ */

/**
 * Dựng hàm biến đổi màu từ bộ số, tính trước mọi thứ không phụ thuộc điểm ảnh.
 * Trả về f(r, g, b) -> [r, g, b], vào/ra sRGB 0..1.
 */
function colourChain(look, opts) {
  const L = look;
  const userLut = opts.userLut && L.lut.opacity > 0 ? opts.userLut : null;
  const lutMix = L.lut.opacity / 100;
  const forceBw = !!opts.bw || L.blackWhite.enabled;

  const wb = L.whiteBalance.kelvin !== 5500 || L.whiteBalance.tint !== 0 ? wbGains(L.whiteBalance.kelvin, L.whiteBalance.tint) : null;
  const ev = L.exposure.exposure !== 0 ? Math.pow(2, L.exposure.exposure) : 1;
  const linear = wb || ev !== 1;

  const h = L.hdr;
  const hdr = h.highlight || h.shadow || h.white || h.black;
  const kC = (L.exposure.contrast / 50) * 0.9;
  const gB = L.exposure.brightness ? Math.pow(2, -(L.exposure.brightness / 50) * 0.75) : 1;

  const lv = LEVEL_CHANNELS.map((c) => (isNeutralLevels(L.levels[c]) ? null : levelsFn(L.levels[c])));
  const cvSize = 1024;
  const cv = {};
  CURVE_CHANNELS.forEach((c) => { cv[c] = isNeutralCurve(L.curve[c]) ? null : curveTable(L.curve[c], cvSize); });

  const sat = 1 + L.exposure.saturation / 100;

  const ce = COLOR_EDITOR_BANDS.map((b) => L.colorEditor[b]);
  const ceOn = ce.some((b) => b.hue || b.saturation || b.lightness);

  const cb = L.colorBalance;
  const cbm = cb.master.saturation ? tintVector(cb.master.hue).map((v) => v * (cb.master.saturation / 100) * 0.2) : null;
  const zones = ["shadow", "midtone", "highlight"].map((z) => ({
    t: cb[z].saturation ? tintVector(cb[z].hue).map((v) => v * (cb[z].saturation / 100) * 0.2) : null,
    l: (cb[z].lightness / 100) * 0.25,
  }));
  const cbOn = cbm || zones.some((z) => z.t || z.l);

  const bw = L.blackWhite;
  const bwSens = BW_BANDS.map((b) => bw[b] / 100);
  const bwHi = bw.highlightSaturation ? tintVector(bw.highlightHue).map((v) => v * (bw.highlightSaturation / 100) * 0.25) : null;
  const bwSh = bw.shadowSaturation ? tintVector(bw.shadowHue).map((v) => v * (bw.shadowSaturation / 100) * 0.25) : null;

  return function (r, g, b) {
    // ── LUT ngoài: nền look làm sẵn ở nơi khác ──
    if (userLut) {
      const o = sampleLut(userLut, r, g, b);
      r += (o[0] - r) * lutMix; g += (o[1] - g) * lutMix; b += (o[2] - b) * lutMix;
    }

    // ── White Balance + Exposure: làm trên ánh sáng tuyến tính, như máy ảnh ──
    if (linear) {
      let lr = toLinear(r) * ev, lg = toLinear(g) * ev, lb = toLinear(b) * ev;
      if (wb) { lr *= wb[0]; lg *= wb[1]; lb *= wb[2]; }
      r = toSrgb(lr); g = toSrgb(lg); b = toSrgb(lb);
    }

    // ── High Dynamic Range: dời độ sáng theo vùng, giữ nguyên độ màu ──
    if (hdr) {
      const y = luma(r, g, b), x = y > 1 ? 1 : y;
      let d = 0;
      if (h.highlight) d -= (h.highlight / 100) * 0.3 * smooth(0.45, 0.85, x) * (1 - 0.6 * smooth(0.9, 1, x)) * (y > 1 ? y : 1);
      if (h.shadow) d += (h.shadow / 100) * 0.25 * smooth(0, 0.1, x) * (1 - smooth(0.1, 0.55, x));
      if (h.white) d += (h.white / 100) * 0.25 * smooth(0.5, 1, x);
      if (h.black) d += (h.black / 100) * 0.25 * (1 - smooth(0, 0.5, x));
      r += d; g += d; b += d;
    }
    r = clamp01(r); g = clamp01(g); b = clamp01(b);

    // ── Contrast: chữ S neo giữa, hai đầu đen/trắng đứng yên (không cắt cụt) ──
    if (kC) {
      r += kC * (r * r * (3 - 2 * r) - r);
      g += kC * (g * g * (3 - 2 * g) - g);
      b += kC * (b * b * (3 - 2 * b) - b);
    }
    // ── Brightness: dời trung tông, đen/trắng đứng yên ──
    if (gB !== 1) { r = Math.pow(r, gB); g = Math.pow(g, gB); b = Math.pow(b, gB); }

    // ── Levels: tổng rồi từng kênh ──
    if (lv[0]) { r = lv[0](r); g = lv[0](g); b = lv[0](b); }
    if (lv[1]) r = lv[1](r);
    if (lv[2]) g = lv[2](g);
    if (lv[3]) b = lv[3](b);

    // ── Curve: RGB, rồi từng kênh, rồi Luma (chỉ đổi sáng, không đổi màu) ──
    if (cv.rgb) { r = lookup(cv.rgb, r); g = lookup(cv.rgb, g); b = lookup(cv.rgb, b); }
    if (cv.r) r = lookup(cv.r, r);
    if (cv.g) g = lookup(cv.g, g);
    if (cv.b) b = lookup(cv.b, b);
    if (cv.luma) {
      const y = luma(r, g, b), d = lookup(cv.luma, y) - y;
      r += d; g += d; b += d;
    }

    // ── Saturation ──
    if (sat !== 1) {
      const y = luma(r, g, b);
      r = y + (r - y) * sat; g = y + (g - y) * sat; b = y + (b - y) * sat;
    }
    r = clamp01(r); g = clamp01(g); b = clamp01(b);

    // ── Color Editor: từng dải màu, xám thì không đụng ──
    if (ceOn) {
      const hsv = rgbToHsv(r, g, b);
      const k = smooth(0.02, 0.25, hsv[1]);
      if (k > 0) {
        const w = bandWeights(hsv[0], EDITOR_CENTERS);
        let dh = 0, ds = 0, dl = 0;
        for (let i = 0; i < 7; i++) {
          if (!w[i]) continue;
          dh += w[i] * ce[i].hue; ds += w[i] * ce[i].saturation; dl += w[i] * ce[i].lightness;
        }
        const s = clamp01(hsv[1] * (1 + (ds / 100) * k));
        const c = hsvToRgb(hsv[0] + dh * k, s, hsv[2]);
        const d = (dl / 100) * 0.25 * k;
        r = c[0] + d; g = c[1] + d; b = c[2] + d;
      }
    }

    // ── Color Balance: master + 3 vùng (bóng / trung / sáng) ──
    if (cbOn) {
      const y = clamp01(luma(r, g, b));
      const ws = (1 - y) * (1 - y), wh = y * y, wm = 1 - ws - wh;
      const zw = [ws, wm, wh];
      if (cbm) { r += cbm[0]; g += cbm[1]; b += cbm[2]; }
      for (let z = 0; z < 3; z++) {
        const zz = zones[z], w = zw[z];
        if (zz.t) { r += zz.t[0] * w; g += zz.t[1] * w; b += zz.t[2] * w; }
        if (zz.l) { r += zz.l * w; g += zz.l * w; b += zz.l * w; }
      }
    }

    // ── Black & White: trộn kênh theo dải màu, rồi Split Tones ──
    if (forceBw) {
      const hsv = rgbToHsv(clamp01(r), clamp01(g), clamp01(b));
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
  };
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
 * Gộp mọi công cụ màu/tông thành một LUT 3D, đã trộn với ảnh gốc theo
 * `strength`. Dựng một lần cho mỗi bộ số (vài chục ms), rồi mỗi điểm ảnh chỉ
 * còn là một phép tra bảng — đủ nhanh để kéo thanh trượt mà ảnh chạy theo.
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

/**
 * Áp look lên ảnh, sửa tại chỗ. `data` là mảng byte xen kênh, `stride` = 3
 * (RGB, từ sharp) hoặc 4 (RGBA, từ canvas — kênh alpha giữ nguyên).
 *
 * opts:
 *   bw        — lượt B&W: bật công cụ Black & White dù cấu hình đang tắt.
 *   userLut   — LUT .cube đã đọc (parseCube), dùng cho mục LUT.
 *   lut       — LUT 3D dựng sẵn (buildLut) để khỏi dựng lại khi chỉ đổi ảnh.
 *   grain     — lớp hạt dựng sẵn (grainPlane) cùng cỡ ảnh, cho trang chỉnh.
 *   seed      — hạt giống cho hạt phim; 0/không có = ngẫu nhiên.
 */
export function renderLook(data, w, h, stride, look, opts = {}) {
  const n = w * h;
  const s = look.strength / 100;
  const lut = opts.lut || buildLut(look, opts);

  // ── 1. LUT: mọi công cụ màu/tông trong một lần quét ──
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

  const long = Math.max(w, h);

  // ── 2. Clarity / Structure: tương phản cục bộ trên kênh sáng ──
  const cl = look.clarity;
  const kc = (cl.clarity / 100) * s, ks = (cl.structure / 100) * s;
  if (kc || ks) {
    const Y = new Float32Array(n);
    for (let i = 0, p = 0; i < n; i++, p += stride) Y[i] = luma(data[p], data[p + 1], data[p + 2]) / 255;
    const big = kc ? boxBlur(Y, w, h, long * 0.02) : null;
    const small = ks ? boxBlur(Y, w, h, long * 0.003) : null;
    const m = cl.method;
    const gainC = m === "punch" ? 0.9 : m === "classic" ? 0.8 : 0.6;
    const protect = m !== "classic";
    const satK = m === "punch" ? 0.25 * kc : 0;
    for (let i = 0, p = 0; i < n; i++, p += stride) {
      const y = Y[i];
      let d = 0;
      if (big) d += kc * gainC * (y - big[i]) * (protect ? 4 * y * (1 - y) : 1);
      if (small) d += ks * 1.2 * (y - small[i]);
      let r = data[p] / 255 + d, g = data[p + 1] / 255 + d, b = data[p + 2] / 255 + d;
      if (satK) {
        const yy = luma(r, g, b);
        r = yy + (r - yy) * (1 + satK); g = yy + (g - yy) * (1 + satK); b = yy + (b - yy) * (1 + satK);
      }
      data[p] = r <= 0 ? 0 : r >= 1 ? 255 : (r * 255 + 0.5) | 0;
      data[p + 1] = g <= 0 ? 0 : g >= 1 ? 255 : (g * 255 + 0.5) | 0;
      data[p + 2] = b <= 0 ? 0 : b >= 1 ? 255 : (b * 255 + 0.5) | 0;
    }
  }

  // ── 3. Vignetting: tối/sáng góc theo EV, trên ánh sáng tuyến tính ──
  const ev = look.vignetting.amount * s;
  if (ev) {
    const cx = (w - 1) / 2, cy = (h - 1) / 2;
    const ax = look.vignetting.method === "circular" ? Math.min(w, h) / 2 : w / 2;
    const ay = look.vignetting.method === "circular" ? Math.min(w, h) / 2 : h / 2;
    for (let y = 0, p = 0; y < h; y++) {
      const ny = (y - cy) / ay;
      for (let x = 0; x < w; x++, p += stride) {
        const nx = (x - cx) / ax;
        const rr = Math.sqrt(nx * nx + ny * ny) / Math.SQRT2;
        const fall = smooth(0.25, 1.15, rr);
        if (!fall) continue;
        const k = Math.pow(2, ev * fall);
        for (let c = 0; c < 3; c++) {
          const v = toSrgb(TO_LIN[data[p + c]] * k);
          data[p + c] = v >= 1 ? 255 : (v * 255 + 0.5) | 0;
        }
      }
    }
  }

  // ── 4. Film Grain: sau cùng, hạt xám, dày ở trung tông, mỏng ở vùng tối ──
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
