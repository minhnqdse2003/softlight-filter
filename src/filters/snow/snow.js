/**
 * BỘ LỌC TUYẾT — rắc tuyết nhiều lớp độ sâu lên ảnh booth.
 *
 * File này dùng CHUNG cho snow.exe (src/filters/snow/pipeline.js) và trang
 * chỉnh web/snow.html (build-offline.mjs dán nguyên văn vào trang, bỏ chữ
 * `export`). Không import gì, không đụng DOM hay Node — chỉ là toán trên một
 * mảng điểm ảnh 8-bit, 3 hoặc 4 kênh. Một công thức, hai nơi dùng.
 *
 * Mô hình là cảnh 2.5D, không phải 3D thật:
 *   - Mỗi hạt có vị trí trên khung (u, v), độ sâu Z (mét, tính từ máy ảnh),
 *     đường kính thật (mm), kiểu hạt, góc xoay, độ nghiêng.
 *   - Một ống kính ảo (tiêu cự, khoảng lấy nét, khẩu độ) quy Z ra hai con số
 *     theo công thức thấu kính mỏng: đường kính hạt trên ảnh D và đường kính
 *     vòng mờ C. Hạt sát ống kính thành đĩa bokeh to, hạt ở mặt phẳng nét sắc,
 *     hạt sau lưng mẫu mờ dần.
 *   - "Trước hay sau người" không phải một cờ riêng: hạt có Z lớn hơn khoảng
 *     lấy nét thì nằm sau người và bị vùng người che.
 *
 * Vì sao không dựng mesh 3D cho bông tuyết: ở khung bán thân, một bông 3–5mm
 * chỉ còn vài pixel, nhánh tinh thể nhỏ hơn một pixel. Thứ làm tuyết trông
 * thật là độ sâu, vòng mờ, ánh sáng và việc bị người che — tất cả nằm ở đây.
 *
 * Vị trí tính theo tỉ lệ khung, kích thước tính theo mm cảm biến, nên cùng một
 * cấu hình cho ra cùng một bức ảnh ở mọi độ phân giải: trang chỉnh xem ở
 * 1200px mà snow.exe chạy ở 6000px vẫn khớp.
 */

/* ═════════════════════════ miền giá trị ═════════════════════════ */

/** [min, max, mặc định] — dùng chung cho kẹp số, thanh trượt, reset. */
export const SNOW_RANGES = {
  amount: [0, 300, 100],       // % — nhân số hạt của mọi lớp, thanh chính của trang chỉnh
  focal: [18, 135, 35],        // mm, quy đổi full-frame
  focus: [0.8, 5, 1.8],        // m, máy ảnh → người
  backdrop: [1.2, 8, 2.6],     // m, máy ảnh → phông
  aperture: [1.2, 16, 2.8],    // khẩu độ ẢO, chỉ dùng để tính vòng mờ của tuyết
  blades: [0, 9, 0],           // 0 = bokeh tròn, 5…9 = đa giác theo số lá khẩu
  angle: [-60, 60, 10],        // độ lệch hướng rơi so với phương thẳng đứng
  trail: [0, 100, 15],         // vệt chuyển động
  brightness: [30, 120, 95],
  ambient: [0, 100, 30],       // hạt ăn màu của vùng ảnh phía sau
  backlight: [0, 100, 40],     // ngược sáng: hạt mờ vẫn sáng rõ
  glow: [0, 100, 30],
  weight: [0, 100, 0],
  sizeMm: [0.5, 40, 3],
  clumping: [0, 100, 40],
  count: [0, 4000, 0],
  sizePct: [25, 400, 100],
  opacity: [0, 100, 100],
  farDepth: [0.5, 30, 6],      // m, độ sâu ảo "trong phông" của lớp xa
  pct: [0, 100, 50],
  feather: [0, 50, 12],
  guard: [1, 30, 4],           // % cạnh dài
  seed: [0, 4294967295, 0],
  varyAmount: [0, 60, 20],     // ± % lượng tuyết giữa các ảnh
  varyWind: [0, 45, 8],        // ± độ hướng rơi
  varyBokeh: [0, 100, 50],     // ± % số đĩa bokeh sát ống kính
  varySize: [0, 50, 15],       // ± % cỡ hạt
  varyClump: [0, 50, 15],      // ± điểm độ tụ đám
  overlay: [0, 300, 100],      // % — lượng mảnh tuyết thật phủ phía trước
  overlayBlur: [0, 100, 35],   // độ trải sâu: 0 = mọi mảnh sắc, 100 = nhiều mảnh mờ
  settle: [0, 300, 100],       // % — lượng tuyết đọng trên người
  settleMm: [0.3, 20, 1],      // mm, cỡ mảnh tuyết đọng / lớp phủ
  crown: [0, 100, 60],         // tuyết dồn trên đỉnh đầu / vai
  scatter: [0, 100, 45],       // tuyết rải khắp tóc, áo
  frost: [0, 100, 35],         // tinh thể li ti như sương muối
};

/**
 * Retouch da chạy TRƯỚC tuyết (src/retouch). Không thuộc bộ dựng sẵn nào: đổi
 * cảnh hay màu trên trang chỉnh không đụng tới nó, như các mục file bên dưới.
 * Mặc định TẮT, để máy đang chạy bản cũ không tự dưng có retouch.
 */
/** capture-one = Retouch v1 (đúng Capture One), c1-mask = Retouch v2 (mặt nạ da C1 + chữa tự viết), builtin = dự phòng. */
export const RETOUCH_METHODS = ["capture-one", "c1-mask", "builtin"];
/** Máy chạy model Capture One — xem chonCho trong src/retouch/xoa-mun.js. */
export const RETOUCH_DEVICES = ["auto", "gpu", "cpu"];
export function defaultRetouch() {
  return { enabled: false, blemish: true, blemishMethod: "capture-one", blemishAmount: 100, smooth: 25, dodgeBurn: 30, contour: false, device: "auto" };
}
export function normalizeRetouch(raw) {
  const r = obj(raw), d = defaultRetouch();
  return {
    enabled: bool(r.enabled, d.enabled),
    blemish: bool(r.blemish, d.blemish),
    blemishMethod: RETOUCH_METHODS.indexOf(r.blemishMethod) >= 0 ? r.blemishMethod : d.blemishMethod,
    blemishAmount: Math.round(num(r.blemishAmount, [0, 100], d.blemishAmount)),
    smooth: Math.round(num(r.smooth, [0, 100], d.smooth)),
    dodgeBurn: Math.round(num(r.dodgeBurn, [0, 100], d.dodgeBurn)),
    contour: bool(r.contour, d.contour),
    device: RETOUCH_DEVICES.indexOf(r.device) >= 0 ? r.device : d.device,
  };
}

/** Năm lớp độ sâu, từ gần máy ảnh ra xa. Thứ tự này là thứ tự trong file cấu hình. */
export const SNOW_LAYERS = ["lens", "front", "focus", "behind", "far"];
/** Chế độ vùng người — xem chú thích ở phần "vùng người" bên dưới. */
/**
 * Hai bản tuyết để chuyển qua lại (trường `style` trong snow.config.json):
 *   v1 — bản đầu: đĩa bokeh sáng có quầng, hạt cục bông / mảnh giấy, viền đĩa gọn.
 *   v2 — tuyết thật: lớp phủ cụm tuyết sắc phía trước, đĩa mờ ít và mềm, không quầng.
 * Mỗi bản là một bộ dựng sẵn đầy đủ (snowV1 / defaultSnow); riêng cách vẽ đĩa mờ
 * khác nhau theo `style` (xem drawSnow).
 */
export const SNOW_STYLES = ["v1", "v2"];

export const SNOW_SUBJECT_MODES = ["auto", "ellipse", "off"];
/** Model tách người cho chế độ "auto" — xem src/filters/snow/matte.js. */
export const SNOW_SUBJECT_MODELS = ["modnet", "birefnet"];

export const SNOW_LAYER_NAMES = {
  lens: "Sát ống kính",
  front: "Trước mặt mẫu",
  focus: "Quanh mẫu",
  behind: "Sau lưng mẫu",
  far: "Xa, trong phông",
};

/**
 * Bộ "Giống mẫu" (ảnh mẫu studio tuyết 11/2026): tuyết thật cỡ vừa, đĩa mờ ít và
 * nhạt, không quầng, nhiều hạt li ti phía sau — và lớp phủ phía trước gồm các cụm
 * tuyết thật, sắc, không đều. Tuyết đọng trên đầu có sẵn nhưng TẮT (khách không
 * muốn tuyết bám lên đầu). Bản trước (tuyết giả cỡ to, đĩa sáng có quầng) trông như
 * đốm sáng dán lên ảnh.
 */
export function defaultSnow() {
  return {
    style: "v2",
    amount: 100,
    seed: 0,
    camera: { focal: 35, focus: 1.8, backdrop: 2.6, aperture: 2.8, blades: 0 },
    flakes: { minMm: 2, maxMm: 7, clump: 20, chip: 0, crystal: 0, real: 80, clumping: 40 },
    wind: { angle: 10, trail: 15 },
    vary: { amount: 20, wind: 8, bokeh: 50, size: 15, clumping: 15 },
    light: { brightness: 95, ambient: 30, backlight: 10, glow: 4 },
    layers: {
      lens: { enabled: true, count: 3, size: 100, opacity: 30 },
      front: { enabled: true, count: 40, size: 100, opacity: 55 },
      focus: { enabled: true, count: 160, size: 100, opacity: 85 },
      behind: { enabled: true, count: 260, size: 100, opacity: 90 },
      far: { enabled: true, count: 420, size: 100, opacity: 70, depth: 6 },
    },
    overlay: { enabled: true, amount: 100, minMm: 3.5, maxMm: 16, blur: 20 },
    settle: { enabled: false, amount: 100, minMm: 2, maxMm: 10, crown: 60, scatter: 45, frost: 35 },
    subject: { mode: "auto", model: "modnet", x: 50, y: 60, w: 70, h: 100, feather: 12 },
    faceGuard: { enabled: true, maxSize: 4 },
  };
}

/** Các bộ dựng sẵn cho trang chỉnh. Mỗi mục là một hàm, để không ai sửa nhầm bản gốc. */
/** Tuyết v1 — đúng bộ mặc định của bản đầu (trước 12/11/2026). */
export function snowV1() {
  const s = defaultSnow();
  s.style = "v1";
  s.flakes = { minMm: 2.5, maxMm: 14, clump: 60, chip: 40, crystal: 0, real: 0, clumping: 40 };
  s.light = { brightness: 95, ambient: 30, backlight: 40, glow: 30 };
  s.layers.lens = { enabled: true, count: 5, size: 100, opacity: 60 };
  s.layers.front = { enabled: true, count: 50, size: 100, opacity: 90 };
  s.layers.focus = { enabled: true, count: 160, size: 100, opacity: 95 };
  s.overlay.enabled = false;
  s.settle.enabled = false;
  return s;
}

export const SNOW_PRESETS = {
  v2: defaultSnow,
  v1: snowV1,
  mercies: defaultSnow,   // tên cũ của bộ mặc định — trạng thái trang chỉnh đã lưu vẫn mở được
  light() {
    const s = defaultSnow();
    s.layers.lens.count = 2;
    s.layers.front.count = 15;
    s.layers.focus.count = 50;
    s.layers.behind.count = 90;
    s.layers.far.count = 180;
    s.wind.trail = 8;
    return s;
  },
  blizzard() {
    const s = defaultSnow();
    s.layers.lens.count = 9;
    s.layers.front.count = 110;
    s.layers.focus.count = 320;
    s.layers.behind.count = 600;
    s.layers.far.count = 1400;
    s.wind = { angle: 28, trail: 55 };
    s.flakes.clumping = 55;
    return s;
  },
};

/*
 * Preset MÀU cho bộ lọc Tuyết — chạy bằng engine của Instax (look.js), sau khi
 * đã rắc tuyết, nên hạt tuyết cũng ăn màu và ăn hạt phim như mọi thứ khác trong
 * khung. Ở đây chỉ là dữ liệu thô (khoá nào thiếu = trung tính); snow.exe và
 * trang chỉnh tự chuẩn hoá bằng normalizeLook(raw, neutralLook()) — file này
 * không import look.js để còn dán được vào trang chỉnh.
 *   neutral   : giữ màu gốc.
 *   mercies   : theo ảnh mẫu mercies — da sứ sáng và nhạt, trắng ngả kem không
 *               cháy, xanh dời về xanh thép, đen nâng nhẹ, mềm.
 *   frost     : sương giá — lạnh, trong, hợp mọi phông (kể cả phông ấm).
 *   community : bộ "chuẩn cộng đồng" của Instax (communityLook).
 */
export const SNOW_LOOKS = {
  neutral: { label: "Giữ màu gốc", raw: {} },
  mercies: {
    label: "Đông mercies — da sứ, trắng kem",
    raw: {
      whiteBalance: { kelvin: 5700, tint: 3 },
      exposure: { exposure: 0.2, contrast: -12, brightness: 6, saturation: -15 },
      hdr: { highlight: -35, shadow: 10, white: -15, black: 6 },
      curve: { rgb: [[0, 12], [64, 62], [192, 198], [255, 246]] },
      colorEditor: {
        red: { hue: 0, saturation: -10, lightness: 5 },
        orange: { hue: -4, saturation: -22, lightness: 12 },
        yellow: { hue: -6, saturation: -30, lightness: 5 },
        green: { hue: 0, saturation: -60, lightness: 0 },
        cyan: { hue: 12, saturation: -15, lightness: 0 },
        blue: { hue: -8, saturation: -25, lightness: 6 },
        magenta: { hue: 0, saturation: -20, lightness: 0 },
      },
      colorBalance: {
        shadow: { hue: 30, saturation: 4, lightness: 0 },
        midtone: { hue: 205, saturation: 5, lightness: 0 },
        highlight: { hue: 40, saturation: 10, lightness: 0 },
      },
      clarity: { method: "natural", clarity: -15, structure: -5 },
      grain: { type: "fine", impact: 10, granularity: 40, seed: 0 },
    },
  },
  frost: {
    label: "Sương giá — lạnh, trong",
    raw: {
      whiteBalance: { kelvin: 4900, tint: 4 },
      exposure: { exposure: 0.15, contrast: -10, brightness: 4, saturation: -18 },
      hdr: { highlight: -30, shadow: 12, white: -10, black: 4 },
      curve: { rgb: [[0, 14], [64, 64], [192, 196], [255, 248]] },
      colorEditor: {
        orange: { hue: -3, saturation: -10, lightness: 8 },
        green: { hue: 0, saturation: -40, lightness: 0 },
        blue: { hue: -6, saturation: -10, lightness: 5 },
      },
      colorBalance: {
        shadow: { hue: 210, saturation: 10, lightness: 0 },
        highlight: { hue: 195, saturation: 4, lightness: 0 },
      },
      clarity: { method: "natural", clarity: -12, structure: 0 },
      grain: { type: "fine", impact: 8, granularity: 40, seed: 0 },
    },
  },
  community: { label: "Instax chuẩn cộng đồng", raw: null },
};

/* ═════════════════════════ chuẩn hoá cấu hình ═════════════════════════ */

function num(v, range, dflt) {
  const d = dflt === undefined ? range[2] : dflt;
  const n = typeof v === "number" && Number.isFinite(v) ? v : d;
  return Math.min(range[1], Math.max(range[0], n));
}
function obj(v) { return v && typeof v === "object" && !Array.isArray(v) ? v : {}; }
function bool(v, d) { return typeof v === "boolean" ? v : d; }

/**
 * Kẹp mọi số về miền an toàn, khoá nào thiếu thì lấy từ `base` (mặc định là
 * bộ "Giống mẫu"). Cùng nguyên tắc với các bộ lọc khác: file do người vận hành
 * sửa tay, số sai phải bị kẹp im lặng chứ không làm gián đoạn phiên chụp.
 */
export function normalizeSnow(raw, base) {
  const r = obj(raw);
  // File cấu hình của bản trước khi có Tuyết v1 / v2 (không có `style` mà có
  // thông số tuyết) là tuyết v1: nâng bộ lọc trên máy booth không được làm đổi
  // ảnh của khách — khoá nào thiếu lấy theo v1 (không lớp phủ, không cụm tuyết thật).
  const legacy = r.style === undefined && (r.flakes !== undefined || r.layers !== undefined);
  const d = base || (legacy ? snowV1() : defaultSnow());
  const R = SNOW_RANGES;
  const cam = obj(r.camera), fl = obj(r.flakes), wi = obj(r.wind), li = obj(r.light);
  const ly = obj(r.layers), su = obj(r.subject), fg = obj(r.faceGuard);

  const o = {
    style: SNOW_STYLES.indexOf(r.style) >= 0 ? r.style : d.style || "v2",
    amount: num(r.amount, R.amount, d.amount),
    seed: Math.round(num(r.seed, R.seed, d.seed)),
  };

  o.camera = {
    focal: num(cam.focal, R.focal, d.camera.focal),
    focus: num(cam.focus, R.focus, d.camera.focus),
    backdrop: num(cam.backdrop, R.backdrop, d.camera.backdrop),
    aperture: num(cam.aperture, R.aperture, d.camera.aperture),
    blades: Math.round(num(cam.blades, R.blades, d.camera.blades)),
  };
  // Phông phải nằm sau người; 1–4 lá khẩu không tạo ra đa giác nào nhận ra được.
  o.camera.backdrop = Math.max(o.camera.backdrop, Math.min(R.backdrop[1], o.camera.focus + 0.3));
  if (o.camera.blades > 0 && o.camera.blades < 5) o.camera.blades = 5;

  o.flakes = {
    minMm: num(fl.minMm, R.sizeMm, d.flakes.minMm),
    maxMm: num(fl.maxMm, R.sizeMm, d.flakes.maxMm),
    clump: num(fl.clump, R.weight, d.flakes.clump),
    chip: num(fl.chip, R.weight, d.flakes.chip),
    crystal: num(fl.crystal, R.weight, d.flakes.crystal),
    real: num(fl.real, R.weight, d.flakes.real || 0),
    clumping: num(fl.clumping, R.clumping, d.flakes.clumping),
  };
  if (o.flakes.maxMm < o.flakes.minMm) o.flakes.maxMm = o.flakes.minMm;
  if (o.flakes.clump + o.flakes.chip + o.flakes.crystal + o.flakes.real <= 0) o.flakes.real = 100;

  o.wind = { angle: num(wi.angle, R.angle, d.wind.angle), trail: num(wi.trail, R.trail, d.wind.trail) };
  const va = obj(r.vary), dv = Object.assign({ amount: 0, wind: 0, bokeh: 0, size: 0, clumping: 0 }, d.vary);
  o.vary = {
    amount: num(va.amount, R.varyAmount, dv.amount),
    wind: num(va.wind, R.varyWind, dv.wind),
    bokeh: num(va.bokeh, R.varyBokeh, dv.bokeh),
    size: num(va.size, R.varySize, dv.size),
    clumping: num(va.clumping, R.varyClump, dv.clumping),
  };
  o.light = {
    brightness: num(li.brightness, R.brightness, d.light.brightness),
    ambient: num(li.ambient, R.ambient, d.light.ambient),
    backlight: num(li.backlight, R.backlight, d.light.backlight),
    glow: num(li.glow, R.glow, d.light.glow),
  };

  o.layers = {};
  SNOW_LAYERS.forEach((k) => {
    const s = obj(ly[k]), dd = d.layers[k];
    o.layers[k] = {
      enabled: bool(s.enabled, dd.enabled),
      count: Math.round(num(s.count, R.count, dd.count)),
      size: num(s.size, R.sizePct, dd.size),
      opacity: num(s.opacity, R.opacity, dd.opacity),
    };
  });
  o.layers.far.depth = num(obj(ly.far).depth, R.farDepth, d.layers.far.depth);

  // File của bản đầu dùng `enabled` thay cho `mode`: false = tắt, true = elip.
  let mode = SNOW_SUBJECT_MODES.indexOf(su.mode) >= 0 ? su.mode : d.subject.mode;
  if (su.mode === undefined && typeof su.enabled === "boolean") mode = su.enabled ? "ellipse" : "off";
  o.subject = {
    mode,
    model: SNOW_SUBJECT_MODELS.indexOf(su.model) >= 0 ? su.model : d.subject.model || "modnet",
    x: num(su.x, R.pct, d.subject.x),
    y: num(su.y, R.pct, d.subject.y),
    w: num(su.w, R.pct, d.subject.w),
    h: num(su.h, R.pct, d.subject.h),
    feather: num(su.feather, R.feather, d.subject.feather),
  };
  o.faceGuard = { enabled: bool(fg.enabled, d.faceGuard.enabled), maxSize: num(fg.maxSize, R.guard, d.faceGuard.maxSize) };
  const ov = obj(r.overlay), dov = d.overlay || defaultSnow().overlay;
  o.overlay = {
    enabled: bool(ov.enabled, dov.enabled),
    amount: num(ov.amount, R.overlay, dov.amount),
    minMm: num(ov.minMm, R.settleMm, dov.minMm),
    maxMm: num(ov.maxMm, R.settleMm, dov.maxMm),
    blur: num(ov.blur, R.overlayBlur, dov.blur),
  };
  if (o.overlay.maxMm < o.overlay.minMm) o.overlay.maxMm = o.overlay.minMm;
  const se = obj(r.settle), ds = d.settle || defaultSnow().settle;
  o.settle = {
    enabled: bool(se.enabled, ds.enabled),
    amount: num(se.amount, R.settle, ds.amount),
    minMm: num(se.minMm, R.settleMm, ds.minMm),
    maxMm: num(se.maxMm, R.settleMm, ds.maxMm),
    crown: num(se.crown, R.crown, ds.crown),
    scatter: num(se.scatter, R.scatter, ds.scatter),
    frost: num(se.frost, R.frost, ds.frost),
  };
  if (o.settle.maxMm < o.settle.minMm) o.settle.maxMm = o.settle.minMm;
  return o;
}

/** Retouch, chất lượng JPEG, backup, bỏ qua, giới hạn — phần không thuộc bộ dựng sẵn nào. */
export function snowFileOptions(raw) {
  const r = obj(raw);
  const o = obj(r.output), b = obj(r.backup), sk = obj(r.skip), l = obj(r.limits);
  return {
    retouch: normalizeRetouch(r.retouch),
    output: {
      // Mặc định 100: ảnh tuyết đi in và đi chia sẻ, giữ chất lượng tốt nhất.
      quality: Math.round(num(o.quality, [60, 100, 100])),
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

/* Ghi chú đi kèm file cấu hình. Không dấu, để Notepad trên máy booth nào cũng đọc được. */
const SNOW_DOC =
  "Bo loc Tuyet - cau hinh v1. Chinh bang web/snow-tuner.html roi bam Luu, dat file nay canh snow.exe. " +
  "style = kieu tuyet: v1 = ban dau (dia bokeh sang, co quang), v2 = tuyet that (lop phu cum tuyet sac phia truoc); doi kieu tren trang chinh se nap bo thong so cua kieu do. " +
  "amount = luong tuyet (%, nhan so hat moi lop). vary = bien thien giua cac anh (+/- luong tuyet %, huong gio do, so bokeh %, co hat %, do tu dam). seed 0 = moi anh mot bo hat rieng (theo ten file). camera: ong kinh AO de tinh do mo cua tuyet (met, mm). " +
  "layers: lens = sat ong kinh, front = truoc mat mau, focus = quanh mau, behind = sau lung mau (bi nguoi che), " +
  "far = xa trong phong. flakes.real = ty le cum tuyet that. overlay = lop phu phia truoc: cum tuyet that sac, rai khap khung (amount %, minMm/maxMm, blur 0-100 = do trai sau). settle = tuyet dong tren nguoi (mac dinh tat) (can subject.mode auto): amount %, minMm/maxMm = co manh (mm), " +
  "crown = don tren dinh dau/vai, scatter = rai tren toc/ao, frost = tinh the li ti; da mat khong dinh tuyet. subject.mode: auto = tach nguoi tu dong; subject.model: modnet (nhanh, ~0.5 s) hoac birefnet (dep hon, ~5 s/tam, " +
  "tai bang: npm run model -- birefnet), " +
  "neu khong chay duoc thi dung elip x/y/w/h (%); ellipse = luon dung elip; off = khong che. " +
  "look: chinh mau SAU khi rac tuyet, cung bo cong cu voi Instax (enabled = bat/tat, strength = do dam); " +
  "LUT .cube dat trong thu muc luts canh snow.exe. " +
  "retouch: nhat mun + lam min da, chay TRUOC tuyet (enabled = bat/tat; blemish = nhat mun; blemishMethod: capture-one = Retouch v1, model " +
  "Remove Blemishes cua Capture One trong models/mun; c1-mask = Retouch v2, mat na da Capture One + bo chua mun tu viet (chi can skinMasking.onnx); " +
  "thieu model thi tu dung builtin = bo tu viet; blemishAmount 0-100; " +
  "smooth = do min 0-100, 0 = khong lam min, nhe 30 / vua 60 / manh 90; " +
  "dodgeBurn = to sang / toi kieu neutral gray 0-100 (lam deu da, quang tham mat, ranh mui-mieng), 0 = tat, mac dinh 30, " +
  "can models/facemesh-v2.onnx (npm run model -- facemesh); contour = tao khoi theo cung muc dodgeBurn; device = may chay model Capture One: auto (mac dinh, snow.exe tinh ca thoi gian nap GPU - thuong chay mat na da tren CPU, nhanh hon ~1 s/tam), gpu (cach cu: may chay nhanh nhat), cpu).";

/**
 * File cấu hình dạng dễ đọc: nhóm nào toàn số thì nằm trên một dòng. Mục `look`
 * được ghi nguyên như lớp gọi đưa vào — chuẩn hoá nó là việc của look.js.
 */
export function snowConfigToJson(cfg) {
  const n = normalizeSnow(cfg);
  const out = Object.assign(
    { _doc: SNOW_DOC, version: 1, enabled: cfg.enabled !== false },
    n,
    cfg.look ? { look: cfg.look } : {},
    snowFileOptions(cfg),
  );
  return fmtValue(out, "") + "\n";
}

function fmtValue(v, ind) {
  if (v === null || typeof v !== "object") return JSON.stringify(v);
  if (Array.isArray(v)) return "[" + v.map((x) => fmtValue(x, ind)).join(", ") + "]";
  const keys = Object.keys(v);
  if (keys.every((k) => v[k] === null || typeof v[k] !== "object")) {
    return "{ " + keys.map((k) => JSON.stringify(k) + ": " + JSON.stringify(v[k])).join(", ") + " }";
  }
  const ni = ind + "  ";
  return "{\n" + keys.map((k) => ni + JSON.stringify(k) + ": " + fmtValue(v[k], ni)).join(",\n") + "\n" + ind + "}";
}

/* ═════════════════════════ ngẫu nhiên có seed ═════════════════════════ */

/** mulberry32: nhanh, đủ đều, và cho đúng cùng một dãy trên Node lẫn trình duyệt. */
function rngOf(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Seed theo tên file (FNV-1a): mỗi tấm một bộ hạt, chạy lại vẫn ra y hệt. */
export function seedFromName(name) {
  let h = 0x811c9dc5;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0 || 1;
}

/** Nhiễu giá trị 2D, nội suy mượt — dùng cho độ tụ đám và cho viền xù của hạt. */
function noise2(salt) {
  const H = (ix, iy) => {
    let h = Math.imul(ix, 374761393) ^ Math.imul(iy, 668265263) ^ salt;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  return (x, y) => {
    const ix = Math.floor(x), iy = Math.floor(y);
    let fx = x - ix, fy = y - iy;
    fx = fx * fx * (3 - 2 * fx);
    fy = fy * fy * (3 - 2 * fy);
    const a = H(ix, iy), b = H(ix + 1, iy), c = H(ix, iy + 1), d = H(ix + 1, iy + 1);
    return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
  };
}

function smooth(e0, e1, x) {
  let t = (x - e0) / (e1 - e0);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  return t * t * (3 - 2 * t);
}

/* ═════════════════════════ ống kính ảo ═════════════════════════ */

/**
 * Khoảng độ sâu (m) của từng lớp, suy ra từ khoảng lấy nét S và khoảng phông B.
 * Lớp "xa" nằm SAU phông — vật lý thì không thể, nhưng trên phông in cảnh tuyết
 * nó đọc thành hạt rơi trong cảnh, và đó chính là chiều sâu ta cần.
 */
export function layerDepths(cfg) {
  const c = cfg.camera, S = c.focus, B = Math.max(c.backdrop, S + 0.3);
  const near = Math.max(0.12, (2 * c.focal) / 1000);  // gần hơn 2f thì công thức thấu kính mỏng vô nghĩa
  const half = Math.min(0.3, (B - S) * 0.4);          // nửa bề dày vùng nét quanh người
  const lensEnd = Math.max(near + 0.05, Math.min(0.45, S * 0.4));
  const frontEnd = Math.max(lensEnd + 0.05, S - half);
  const behindEnd = Math.max(S + half + 0.02, B - 0.03);
  return {
    lens: [near, lensEnd],
    front: [lensEnd, frontEnd],
    focus: [S - half, S + half],
    behind: [S + half, behindEnd],
    far: [B, B + cfg.layers.far.depth],
  };
}

/**
 * Hai phép quy đổi của thấu kính mỏng, ra pixel của ảnh đang vẽ. Cạnh dài của
 * ảnh ứng với 36mm cảm biến full-frame — nên D và C tự co giãn theo độ phân giải.
 *   size(d, Z) : vật đường kính d (mm) ở khoảng cách Z (m) → đường kính trên ảnh
 *   blur(Z)    : đường kính vòng mờ của một điểm ở khoảng cách Z
 */
export function optics(cfg, longPx) {
  const c = cfg.camera, f = c.focal, S = c.focus * 1000;
  const pxPerMm = longPx / 36;
  const A = f / c.aperture, k = f / (S - f);
  return {
    size: (dMm, Zm) => ((dMm * f) / Math.max(Zm * 1000 - f, 1)) * pxPerMm,
    blur: (Zm) => {
      const Z = Zm * 1000;
      return ((A * Math.abs(Z - S)) / Z) * k * pxPerMm;
    },
  };
}

/** Cỡ hạt điển hình và độ mờ ở giữa mỗi lớp — cho sơ đồ trong trang chỉnh. */
export function describeLayers(cfg, longPx) {
  const d = layerDepths(cfg), op = optics(cfg, longPx || 3000), fl = cfg.flakes;
  const dm = Math.sqrt(fl.minMm * fl.maxMm);
  return SNOW_LAYERS.map((k) => {
    const [z0, z1] = d[k], zm = (z0 + z1) / 2;
    return { key: k, z0, z1, size: op.size((dm * cfg.layers[k].size) / 100, zm), blur: op.blur(zm) };
  });
}

/* ═════════════════════════ vùng người ═════════════════════════ */

/*
 * Ba chế độ của cfg.subject.mode:
 *   "auto"    — matte tách người (snow.exe tính bằng model, trang chỉnh nạp file
 *               PNG). Không có matte thì dùng elip bên dưới thay thế.
 *   "ellipse" — luôn dùng elip đặt tay (đơn vị %, viền mềm theo `feather`).
 *   "off"     — không che gì, không chặn mặt.
 * Hạt phía sau người bị che; hạt to phía trước tránh dải mặt.
 */
function useMatte(cfg, matte) {
  return cfg.subject.mode === "auto" && !!(matte && matte.data);
}

function subjectZone(cfg, w, h) {
  const s = cfg.subject;
  if (s.mode === "off") return null;
  return {
    cx: (s.x / 100) * w, cy: (s.y / 100) * h,
    rx: Math.max(1, (s.w / 200) * w), ry: Math.max(1, (s.h / 200) * h),
    f: s.feather / 100,
  };
}

function zoneCover(z, x, y) {
  const dx = (x - z.cx) / z.rx, dy = (y - z.cy) / z.ry;
  const r = Math.sqrt(dx * dx + dy * dy);
  if (z.f < 0.001) return r < 1 ? 1 : 0;
  return 1 - smooth(1 - z.f, 1 + z.f, r);
}

function inFaceBand(z, x, y) {
  const dx = (x - z.cx) / z.rx, dy = (y - z.cy) / z.ry;
  return dx * dx + dy * dy < 1 && y < z.cy - 0.1 * z.ry;
}

/**
 * Hàm che cho hạt phía sau: `any` loại nhanh theo khung bao, `at` cho độ che
 * 0…1 tại một điểm ảnh. Matte (cỡ model, ~512px cạnh ngắn) được nội suy song
 * tuyến lên cỡ ảnh — lấy điểm gần nhất thì viền người thành bậc thang khi hạt
 * sau lưng nằm vắt ngang mép.
 */
function coverFor(cfg, w, h, matte) {
  if (useMatte(cfg, matte)) {
    const mw = matte.width, mh = matte.height, md = matte.data, sx = mw / w, sy = mh / h;
    return {
      any: () => true,
      at: (x, y) => {
        const fx0 = Math.min(mw - 1, Math.max(0, (x + 0.5) * sx - 0.5));
        const fy0 = Math.min(mh - 1, Math.max(0, (y + 0.5) * sy - 0.5));
        const ix = fx0 | 0, iy = fy0 | 0, fx = fx0 - ix, fy = fy0 - iy;
        const o = iy * mw + ix, dx = ix < mw - 1 ? 1 : 0, dy = iy < mh - 1 ? mw : 0;
        const top = md[o] + (md[o + dx] - md[o]) * fx;
        const bot = md[o + dy] + (md[o + dy + dx] - md[o + dy]) * fx;
        return (top + (bot - top) * fy) / 255;
      },
    };
  }
  const z = subjectZone(cfg, w, h);
  if (!z) return null;
  const ex = z.rx * (1 + z.f), ey = z.ry * (1 + z.f);
  return {
    any: (x0, y0, x1, y1) => !(x1 < z.cx - ex || x0 > z.cx + ex || y1 < z.cy - ey || y0 > z.cy + ey),
    at: (x, y) => zoneCover(z, x + 0.5, y + 0.5),
  };
}

/**
 * Hàm thử "điểm (x, y) có nằm trong dải mặt không" — null nếu không chặn.
 *
 * Có matte: dải mặt của từng cột ảnh là từ đỉnh dáng người ở cột đó xuống thêm
 * 25% chiều cao khung. Đi theo từng cột nên nhóm nhiều người đứng cao thấp khác
 * nhau vẫn đúng mặt từng người — một elip chung không làm được điều đó. Cột có
 * tay giơ lên thì dải nằm ở tay; hạt to tránh luôn chỗ đó, không hại gì.
 */
function faceTest(cfg, w, h, matte) {
  if (!cfg.faceGuard.enabled) return null;
  if (useMatte(cfg, matte)) {
    const mw = matte.width, mh = matte.height, md = matte.data;
    const top = new Int32Array(mw).fill(-1);
    for (let x = 0; x < mw; x++) {
      for (let y = 0; y < mh; y++) {
        if (md[y * mw + x] >= 128) { top[x] = y; break; }
      }
    }
    const band = 0.25 * mh, lead = 0.02 * mh;
    return (x, y) => {
      const mx = Math.min(mw - 1, Math.max(0, ((x * mw) / w) | 0)), t = top[mx];
      if (t < 0) return false;
      const my = (y * mh) / h;
      return my >= t - lead && my <= t + band;
    };
  }
  const z = subjectZone(cfg, w, h);
  return z ? (x, y) => inFaceBand(z, x, y) : null;
}

/**
 * Chặn theo KHUÔN MẶT THẬT (khung YuNet do snow.exe tìm, `[{ x, y, w, h }]`).
 * Dải mặt theo matte ở trên chỉ đoán mặt nằm trong 25 % chiều cao khung tính
 * từ đỉnh đầu: ảnh dọc, người đội mũ / vương miện, hay mặt to sát máy là mặt
 * lọt ra ngoài dải — đĩa bokeh rơi trúng mũi, má (ảnh booth 02/11/2026). Ở đây
 * mỗi mặt là một elip phủ trán tới cằm, và ngưỡng cỡ hạt tính theo CỠ MẶT (4 %
 * bề ngang mặt) chứ không theo khung ảnh: hạt li ti vẫn được rơi qua mặt cho
 * tự nhiên, còn đĩa đủ to để thành một đốm sáng trên da thì không.
 * Trang chỉnh không có model tìm mặt nên không có phần này.
 */
function faceBoxTest(cfg, faces) {
  if (!cfg.faceGuard.enabled || !faces || !faces.length) return null;
  const el = faces.map((f) => ({
    cx: f.x + f.w / 2, cy: f.y + 0.45 * f.h, rx: 0.7 * f.w, ry: 0.78 * f.h, min: 0.04 * f.w,
  }));
  return (x, y, E) => {
    for (const b of el) {
      if (E <= b.min) continue;
      const dx = (x - b.cx) / (b.rx + E / 2), dy = (y - b.cy) / (b.ry + E / 2);
      if (dx * dx + dy * dy < 1) return true;
    }
    return false;
  };
}

/** Hạt có đường kính E đặt ở (x, y) có lấn vào dải mặt không: thử tâm và bốn điểm quanh tâm. */
function hitsFace(test, x, y, E) {
  const r = E * 0.35;
  return test(x, y) || test(x - r, y) || test(x + r, y) || test(x, y - r) || test(x, y + r);
}

/* ═════════════════════════ dựng cảnh ═════════════════════════ */

/**
 * Biến thể của MỘT ảnh: lượng tuyết, hướng gió và số đĩa bokeh sát ống kính lệch
 * ngẫu nhiên quanh giá trị đặt, rút từ chính seed của ảnh. Không có bước này thì
 * bốn tấm trong một phiên chỉ khác vị trí hạt — mật độ, hướng rơi y hệt nhau,
 * nhìn ra ngay là cùng một khuôn. Cùng seed → cùng biến thể, nên chạy lại vẫn y hệt.
 */
export function variedSnow(cfg, seed) {
  const v = cfg.vary;
  if (!v || (!v.amount && !v.wind && !v.bokeh && !v.size && !v.clumping)) return cfg;
  const rng = rngOf((seed ^ 0x51ed270b) >>> 0);
  const a = rng() * 2 - 1, b = rng() * 2 - 1, c = rng() * 2 - 1, d = rng() * 2 - 1, e = rng() * 2 - 1;
  const lens = cfg.layers.lens, fs = 1 + (d * (v.size || 0)) / 100;
  return Object.assign({}, cfg, {
    amount: Math.max(0, cfg.amount * (1 + (a * v.amount) / 100)),
    wind: Object.assign({}, cfg.wind, { angle: Math.max(-60, Math.min(60, cfg.wind.angle + b * v.wind)) }),
    flakes: Object.assign({}, cfg.flakes, {
      minMm: cfg.flakes.minMm * fs,
      maxMm: cfg.flakes.maxMm * fs,
      clumping: Math.max(0, Math.min(100, cfg.flakes.clumping + e * (v.clumping || 0))),
    }),
    layers: Object.assign({}, cfg.layers, {
      lens: Object.assign({}, lens, { count: Math.max(0, Math.round(lens.count * (1 + (c * v.bokeh) / 100))) }),
    }),
  });
}

/** Trường mật độ tần thấp: tuyết thật rơi thành chùm, không rải đều như lưới. */
function densityField(seed) {
  const n = noise2(seed);
  return (u, v) => smooth(0.25, 0.8, n(u * 4.5, v * 3.5));
}

const SPRITE_COUNT = [6, 6, 3, 10, 8];  // clump, chip, crystal, mảnh tuyết đọng, cụm tuyết thật đang rơi
const SETTLE_FEATHER = 6;             // 6 sprite tuyết đọng đầu là mảnh xơ, còn lại mảnh gọn

/**
 * Sinh toàn bộ hạt của một ảnh, đã xếp từ xa đến gần (thứ tự vẽ).
 *
 * Mỗi hạt rút ĐÚNG bảy số ngẫu nhiên theo thứ tự cố định, còn vị trí lấy từ một
 * dãy riêng của chính hạt đó. Nhờ vậy kéo một thanh trượt (độ tụ đám, chặn mặt)
 * chỉ dời những hạt bị ảnh hưởng, không xáo trộn cả cảnh — so trước/sau mới có
 * nghĩa.
 *
 * `matte` (tuỳ chọn) chỉ dùng để chặn mặt; việc che hạt phía sau làm lúc vẽ.
 * `faces` (tuỳ chọn): khung mặt thật, xem faceBoxTest.
 */
export function buildScene(w, h, cfg, seed, matte, faces) {
  const longPx = Math.max(w, h);
  const op = optics(cfg, longPx);
  const depths = layerDepths(cfg);
  const face = faceTest(cfg, w, h, matte);
  const faceBox = faceBoxTest(cfg, faces);
  const fl = cfg.flakes;
  const wsum = fl.clump + fl.chip + fl.crystal + (fl.real || 0) || 1;
  const guardPx = face ? (cfg.faceGuard.maxSize / 100) * longPx : Infinity;
  const S = cfg.camera.focus;
  const dens = densityField((seed ^ 0x9e3779b9) >>> 0);
  const kc = fl.clumping / 100;
  const particles = [];
  const stats = { guarded: 0 };

  SNOW_LAYERS.forEach((name, li) => {
    const L = cfg.layers[name];
    stats[name] = 0;
    // Thêm lượng tuyết chỉ thêm hạt vào cuối dãy, không xáo lại hạt đã có.
    const n = Math.round((L.count * cfg.amount) / 100);
    if (!L.enabled || !n) return;
    const rng = rngOf((seed + Math.imul(li + 1, 0x85ebca6b)) >>> 0);
    const [z0, z1] = depths[name];
    for (let i = 0; i < n; i++) {
      const rz = rng(), rd = rng(), rk = rng(), rs = rng(), rr = rng(), rt = rng(), rb = rng();
      const Z = z0 + (z1 - z0) * rz;
      // Lệch về phía hạt nhỏ: nhiều hạt li ti, ít hạt to — như tuyết thật.
      const dMm = fl.minMm * Math.pow(fl.maxMm / fl.minMm, Math.pow(rd, 2.2)) * (L.size / 100);
      const D = op.size(dMm, Z), C = op.blur(Z), E = D + C;
      const kind = rk * wsum < fl.clump ? 0 : rk * wsum < fl.clump + fl.chip ? 1 : rk * wsum < fl.clump + fl.chip + fl.crystal ? 2 : 4;

      const pr = rngOf((Math.imul(seed ^ (li * 7919), 2654435761) + Math.imul(i + 1, 40503)) >>> 0);
      const mu = E / 2 / w, mv = E / 2 / h;
      let u = 0, v = 0, ok = false, hit = false;
      for (let t = 0; t < 12 && !ok; t++) {
        u = -mu + pr() * (1 + 2 * mu);
        v = -mv + pr() * (1 + 2 * mv);
        if (kc > 0 && pr() > 1 - kc + kc * dens(u, v)) continue;
        // Hạt to phía trước không được đè lên mặt khách.
        if (Z < S && ((E > guardPx && hitsFace(face, u * w, v * h, E)) || (faceBox && faceBox(u * w, v * h, E)))) {
          hit = true;
          continue;
        }
        ok = true;
      }
      if (!ok) {
        if (hit) stats.guarded++;
        continue;
      }
      particles.push({
        layer: li, Z, D, C, x: u * w, y: v * h, kind,
        // Kiểu 4 = cụm tuyết thật (cùng hình với lớp phủ phía trước).
        sprite: Math.floor(rs * SPRITE_COUNT[kind]),
        rot: rr * Math.PI * 2,
        tilt: kind === 0 ? 0.75 + 0.25 * rt : kind === 4 ? 0.55 + 0.45 * rt : 0.3 + 0.7 * rt,
        bright: 0.7 + 0.35 * rb,
        alpha: L.opacity / 100,
        behind: Z > S,
      });
      stats[name]++;
    }
  });

  particles.sort((a, b) => b.Z - a.Z);
  return { particles, stats };
}

/* ═════════════════════════ tuyết đọng trên người ═════════════════════════ */

/*
 * Thứ làm ảnh tuyết studio trông THẬT không phải hạt đang rơi mà là tuyết đã
 * đọng lại (ảnh mẫu studio 11/2026):
 *   - DỒN THÀNH ĐỐNG ở chỗ cao nhất của đỉnh đầu, loang ra rồi thưa dần xuống
 *     tóc mái — không phải một dải đều dọc viền tóc;
 *   - mảnh DÀI, XƠ như lông vũ, nằm XUÔI THEO SỢI TÓC; mảnh to xen mảnh nhỏ,
 *     có mảnh xám trong, có mảnh trắng sáng, chỗ dày thì chồng lên nhau;
 *   - vài mảnh lạc trên áo, và một lớp tinh thể li ti lấp lánh trên tóc, len.
 *
 * Cần matte (vùng người thật). Từ matte lấy đường đỉnh của từng cột:
 *   - độ phẳng: mặt càng nằm ngang (độ dốc đường đỉnh nhỏ) càng giữ tuyết —
 *     sườn đầu dốc thì tuyết trượt đi;
 *   - độ "đỉnh": cột càng gần chỗ cao nhất trong vùng lân cận càng dày — đó là
 *     đống tuyết trên xoáy tóc;
 *   - theo chiều dọc: thưa dần theo khoảng cách từ đường đỉnh xuống.
 * Hướng sợi tóc lấy từ tensor cấu trúc của chính ảnh quanh vị trí mảnh.
 * Da (mặt, tay) gần như không giữ tuyết: hạt rơi trúng là tan — dò da bằng
 * YCbCr ngay trên điểm ảnh, cộng khung mặt thật nếu snow.exe có.
 */
const SETTLE_CROWN = 420000, SETTLE_SCATTER = 2400, SETTLE_FROST = 14000;

/** Hai bản đồ cỡ matte: `crown` (đống trên đỉnh) và `fall` (thưa dần từ đỉnh xuống). */
function exposureMap(matte) {
  const mw = matte.width, mh = matte.height, md = matte.data;
  const top = new Float32Array(mw).fill(-1);
  for (let x = 0; x < mw; x++) {
    for (let y = 0; y < mh; y++) if (md[y * mw + x] >= 128) { top[x] = y; break; }
  }
  // Đường đỉnh làm mượt (bỏ sợi tóc dựng), rồi độ dốc và độ "đỉnh" theo cột.
  const sr = Math.max(1, Math.round(0.008 * mw)), sm = new Float32Array(mw).fill(-1);
  for (let x = 0; x < mw; x++) {
    if (top[x] < 0) continue;
    let a = 0, n = 0;
    for (let k = -sr; k <= sr; k++) {
      const t = top[Math.min(mw - 1, Math.max(0, x + k))];
      if (t >= 0) { a += t; n++; }
    }
    sm[x] = a / n;
  }
  const d = Math.max(1, Math.round(0.012 * mw)), win = Math.max(2, Math.round(0.07 * mw));
  const apexK = 1 / Math.max(1, 0.09 * mh), wcol = new Float32Array(mw);
  for (let x = 0; x < mw; x++) {
    if (sm[x] < 0) continue;
    const l = sm[Math.max(0, x - d)], r = sm[Math.min(mw - 1, x + d)];
    const s = l >= 0 && r >= 0 ? (r - l) / (2 * d) : 2;
    const flat = 1 / (1 + 1.5 * s * s);
    let lo = sm[x];
    for (let k = -win; k <= win; k++) {
      const t = sm[Math.min(mw - 1, Math.max(0, x + k))];
      if (t >= 0 && t < lo) lo = t;
    }
    const apex = Math.exp(-(sm[x] - lo) * apexK);
    wcol[x] = flat * (0.2 + 0.8 * apex);
  }
  const lc = 1 / Math.max(2, 0.06 * mh), lf = 1 / Math.max(2, 0.11 * mh);
  const crown = new Float32Array(mw * mh), fall = new Float32Array(mw * mh);
  for (let x = 0; x < mw; x++) {
    let run = -1;
    for (let y = 0; y < mh; y++) {
      const o = y * mw + x;
      if (md[o] < 128) { run = -1; continue; }
      run++;
      crown[o] = wcol[x] * Math.exp(-run * lc);
      fall[o] = Math.exp(-run * lf);
    }
  }
  return { crown, fall };
}

function isSkin(data, i) {
  const r = data[i], g = data[i + 1], b = data[i + 2];
  const y = 0.299 * r + 0.587 * g + 0.114 * b;
  const cb = 128 - 0.168736 * r - 0.331264 * g + 0.5 * b;
  const cr = 128 + 0.5 * r - 0.418688 * g - 0.081312 * b;
  return y > 50 && cr > 133 && cr < 178 && cb > 75 && cb < 130 && r > b;
}

/**
 * Hướng sợi tóc / thớ vải quanh (x, y): tensor cấu trúc của kênh xanh lá trong
 * cửa sổ bán kính r. Trả về góc (rad) DỌC theo thớ, hoặc null nếu vùng đó không
 * có hướng rõ (da, vải trơn) — khi đó mảnh xoay ngẫu nhiên.
 */
function strandAngle(data, w, h, ch, x, y, r) {
  r = Math.max(2, Math.min(14, Math.round(r)));
  const st = Math.max(1, Math.round(r / 5));
  let jxx = 0, jxy = 0, jyy = 0;
  const x0 = Math.max(1, (x | 0) - r), x1 = Math.min(w - 2, (x | 0) + r);
  const y0 = Math.max(1, (y | 0) - r), y1 = Math.min(h - 2, (y | 0) + r);
  for (let yy = y0; yy <= y1; yy += st) {
    for (let xx = x0; xx <= x1; xx += st) {
      const i = (yy * w + xx) * ch + 1;
      const gx = data[i + ch] - data[i - ch], gy = data[i + w * ch] - data[i - w * ch];
      jxx += gx * gx; jxy += gx * gy; jyy += gy * gy;
    }
  }
  const tr = jxx + jyy;
  if (tr < 1) return null;
  const coh = Math.sqrt((jxx - jyy) * (jxx - jyy) + 4 * jxy * jxy) / tr;
  if (coh < 0.2) return null;
  return 0.5 * Math.atan2(2 * jxy, jxx - jyy) + Math.PI / 2;
}

/** Các mảnh tuyết đọng của một ảnh — rỗng nếu tắt hoặc không có matte. */
export function settledFlakes(w, h, cfg, seed, matte, faces, data, ch) {
  const st = cfg.settle;
  if (!st || !st.enabled || !st.amount || cfg.subject.mode !== "auto" || !matte || !matte.data) return [];
  const mw = matte.width, mh = matte.height, md = matte.data;
  const ex = exposureMap(matte);
  const op = optics(cfg, Math.max(w, h)), S = cfg.camera.focus;
  const patch = noise2((seed ^ 0x2c1b3c6d) >>> 0);
  const fbox = (faces || []).map((f) => ({ cx: f.x + f.w / 2, cy: f.y + 0.58 * f.h, rx: 0.48 * f.w, ry: 0.5 * f.h }));
  const inFace = (x, y) => fbox.some((b) => {
    const dx = (x - b.cx) / b.rx, dy = (y - b.cy) / b.ry;
    return dx * dx + dy * dy < 1;
  });
  const mo = (x, y) => Math.min(mh - 1, Math.max(0, ((y * mh) / h) | 0)) * mw + Math.min(mw - 1, Math.max(0, ((x * mw) / w) | 0));
  const pix = (x, y) => (Math.min(h - 1, Math.max(0, y | 0)) * w + Math.min(w - 1, Math.max(0, x | 0))) * ch;
  const out = [];
  const k = st.amount / 100;
  const nFeather = SETTLE_FEATHER;   // sprite đầu = mảnh xơ (lông vũ), còn lại = mảnh gọn

  const push = (g, x, y, dMm, rs, rr, rt, rb) => {
    const D = op.size(dMm, S);
    // Chỉ mảnh xơ: mảnh gọn ở cỡ vài pixel đọc thành chấm tròn, giống bokeh hơn tuyết.
    const feather = g !== 2;
    const sp = feather ? Math.floor(rs * nFeather) : nFeather + Math.floor(rs * (SPRITE_COUNT[3] - nFeather));
    const ang = g === 2 ? null : strandAngle(data, w, h, ch, x, y, Math.max(3, D * 1.2));
    out.push({
      settled: true, group: g, Z: S, C: 0.18 * D, D, x, y, kind: 3,
      sprite: Math.min(SPRITE_COUNT[3] - 1, Math.max(0, sp)),
      // Mảnh dài nằm xuôi theo sợi tóc (lệch ±20°); không thấy thớ thì xoay ngẫu nhiên.
      rot: ang === null ? rr * Math.PI * 2 : ang + (rr - 0.5) * 0.7,
      tilt: feather ? 0.75 + 0.25 * rt : 0.6 + 0.4 * rt,
      // Tuyết trên tóc không trắng đều: mảnh mỏng trong, ngả xám; mảnh dày trắng sáng.
      bright: g === 2 ? 0.75 + 0.3 * rb : 0.66 + 0.32 * rb,
      alpha: g === 2 ? 0.35 + 0.4 * rb : 0.7 + 0.3 * Math.max(rb, rt),
      behind: false,
    });
  };

  // g: 0 = đống trên đỉnh, 1 = rải, 2 = sương muối li ti
  const groups = [
    [Math.round(k * (st.crown / 100) * SETTLE_CROWN), 0],
    [Math.round(k * (st.scatter / 100) * SETTLE_SCATTER), 1],
    [Math.round(k * (st.frost / 100) * SETTLE_FROST), 2],
  ];
  groups.forEach(([n, g]) => {
    const rng = rngOf((seed + Math.imul(g + 11, 0x27d4eb2f)) >>> 0);
    for (let i = 0; i < n; i++) {
      const u = rng(), v = rng(), ra = rng(), rd = rng(), rs = rng(), rr = rng(), rt = rng(), rb = rng(), rc = rng();
      const x = u * w, y = v * h, o = mo(x, y);
      if (md[o] < 153) continue;
      // Tuyết đọng thành mảng: nhiễu tần thấp làm chỗ dày chỗ thưa.
      const pz = 0.3 + 0.7 * smooth(0.2, 0.75, patch(u * 9, v * 9));
      const c = ex.crown[o], f = ex.fall[o];
      const p = g === 0 ? c * c * pz : g === 1 ? pz * (0.25 + 0.75 * f) : Math.min(1, 0.2 + 0.5 * f + 1.5 * c);
      if (ra >= p) continue;
      if (fbox.length && inFace(x, y)) continue;
      if (isSkin(data, pix(x, y)) && rb > (g === 2 ? 0 : 0.04)) continue;
      const dMm = g === 2
        ? 0.4 + 0.6 * rd
        : st.minMm * Math.pow(st.maxMm / st.minMm, Math.pow(rd, g === 0 ? 1.2 : 2.4));
      push(g, x, y, dMm, rs, rr, rt, rb);
      // Trên đống: mảnh rơi sau đè lên mảnh trước — vài mảnh nhỏ dính sát quanh.
      if (g === 0 && rc < 0.8 * c) {
        const D = op.size(dMm, S), m = 1 + Math.floor(c * 9 * rng());
        for (let j = 0; j < m; j++) {
          const a = rng() * Math.PI * 2, dd = (0.5 + rng()) * D;
          const cx = x + Math.cos(a) * dd, cy = y + Math.sin(a) * dd * 0.7;
          if (md[mo(cx, cy)] < 153 || (fbox.length && inFace(cx, cy))) continue;
          push(0, cx, cy, Math.max(st.minMm * 0.7, dMm * (0.35 + 0.5 * rng())), rng(), rng(), rng(), rng());
        }
      }
    }
  });
  return out;
}

/*
 * LỚP PHỦ PHÍA TRƯỚC — mảnh tuyết thật (cùng hình mảnh xơ như tuyết đọng trên
 * tóc trong ảnh mẫu) đang lơ lửng ngay trước người, quanh mặt phẳng nét. Không
 * bám vào đầu, không phụ thuộc matte: rải khắp khung, tụ thành chùm theo nhiễu
 * tần thấp, mảnh sắc xen mảnh hơi mờ cho có chiều sâu. Mảnh to không đè lên
 * mắt / mũi / miệng; mảnh li ti thì vẫn được bay qua mặt cho tự nhiên.
 */
const OVERLAY_COUNT = 1100;

export function overlayFlakes(w, h, cfg, seed, matte, faces) {
  const o = cfg.overlay;
  if (!o || !o.enabled || !o.amount) return [];
  const longPx = Math.max(w, h), op = optics(cfg, longPx), S = cfg.camera.focus;
  const n = Math.round((o.amount / 100) * OVERLAY_COUNT);
  const patch = noise2((seed ^ 0x3c6ef372) >>> 0);
  const kc = cfg.flakes.clumping / 100, blurK = o.blur / 100;
  // Mặt: khung mặt thật (snow.exe) — chặn mảnh to hơn 1.5 % bề ngang mặt;
  // không có khung (trang chỉnh) thì dùng dải mặt theo matte / elip.
  const fb = cfg.faceGuard.enabled && faces && faces.length
    ? faces.map((f) => ({ cx: f.x + f.w / 2, cy: f.y + 0.5 * f.h, rx: 0.55 * f.w, ry: 0.62 * f.h, min: 0.015 * f.w }))
    : null;
  const band = fb ? null : faceTest(cfg, w, h, matte), bandMin = 0.004 * longPx;
  const onFace = (x, y, E) => {
    if (fb) {
      return fb.some((b) => {
        if (E <= b.min) return false;
        const dx = (x - b.cx) / (b.rx + E / 2), dy = (y - b.cy) / (b.ry + E / 2);
        return dx * dx + dy * dy < 1;
      });
    }
    return !!band && E > bandMin && hitsFace(band, x, y, E);
  };
  const rng = rngOf((seed ^ 0x7f4a7c15) >>> 0);
  const out = [];
  for (let i = 0; i < n; i++) {
    const rd = rng(), rz = rng(), rs = rng(), rr = rng(), rt = rng(), rb = rng(), ra = rng();
    const dMm = o.minMm * Math.pow(o.maxMm / o.minMm, Math.pow(rd, 1.3));
    const Z = S * (0.82 + 0.16 * rz);   // ngay trước người
    const D = op.size(dMm, Z);
    // Một phần mảnh hơi lệch nét: vòng mờ tới 0.8 cỡ mảnh (vẫn đọc ra hình mảnh).
    const C = D * (0.03 + 0.6 * blurK * (1 - rz) * (1 - rz));
    let x = 0, y = 0, ok = false;
    for (let t = 0; t < 10 && !ok; t++) {
      const u = rng(), v = rng(), q = rng();
      if (kc > 0 && q > 1 - kc + kc * smooth(0.25, 0.8, patch(u * 4.5, v * 3.5))) continue;
      x = u * w; y = v * h;
      if (onFace(x, y, D + C)) continue;
      ok = true;
    }
    if (!ok) continue;
    out.push({
      settled: true, overlay: true, group: 1, Z, C, D, x, y, kind: 4,
      sprite: Math.floor(rs * SPRITE_COUNT[4]),
      rot: rr * Math.PI * 2,
      tilt: 0.55 + 0.45 * rt,
      // Mảnh trước người hứng thẳng đèn flash: trắng sáng, không xám.
      bright: 1 + 0.12 * rb,
      alpha: (0.9 + 0.1 * ra) * (1 - 0.3 * (C / Math.max(D, 1))),
      aa: 18,   // chống răng cưa nhẹ hơn hạt thường: mảnh trước người phải sắc
      behind: false,
    });
  }
  return out;
}

/* ═════════════════════════ sprite hạt ═════════════════════════ */

/*
 * Mỗi sprite là một mặt nạ alpha 128×128, hình nằm trong vòng tròn bán kính 32
 * ở giữa (chừa viền cho bản làm mờ). Mỗi sprite có năm bản làm mờ sẵn; lúc vẽ,
 * độ mờ cần dùng (vòng mờ của ống kính, cộng phần lọc chống răng cưa khi thu
 * nhỏ) được nội suy giữa hai bản gần nhất. Bản mờ nhất ứng với vòng mờ ≈ 0.85
 * lần cỡ hạt — mờ hơn nữa thì hình hạt không còn, drawSnow chuyển sang đĩa.
 */
const SP_N = 128, SP_C = 64, SP_R = 32;
const SP_SIGMA = [0, 2, 4.5, 8, 13];
const SPRITES = new Map();

/**
 * Sprite của một kiểu hạt cho MỘT ảnh: hình từng hạt sinh theo seed của ảnh đó,
 * nên không có hai khách nào chung một bộ hình hạt — không chỉ vị trí mà cả
 * "texture" tuyết đều riêng. snow.exe là tiến trình mới mỗi tấm nên vẫn chỉ sinh
 * một lần như trước; kiểu nào không có hạt nào đủ nét để dùng sprite (tinh thể
 * ở bộ mặc định) thì không tốn thời gian sinh. Trang chỉnh giữ vài bộ gần nhất.
 */
function spritesOf(kind, seed) {
  const key = kind + ":" + seed;
  let set = SPRITES.get(key);
  if (!set) {
    if (SPRITES.size >= 9) SPRITES.clear();
    const rng = rngOf((0x5eed5 + kind * 7919 + Math.imul(seed, 2654435761)) >>> 0);
    const shape = [clumpShape, chipShape, crystalShape, settledShape, aggregateShape][kind];
    set = [];
    for (let i = 0; i < SPRITE_COUNT[kind]; i++) {
      const sh = kind === 3 && i < SETTLE_FEATHER ? featherShape : shape;
      set.push(variants(rasterize(sh(rng))));
    }
    SPRITES.set(key, set);
  }
  return set;
}

function rasterize(fn) {
  const a = new Float32Array(SP_N * SP_N);
  for (let py = 0; py < SP_N; py++) {
    for (let px = 0; px < SP_N; px++) {
      let s = 0;
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          s += fn((px + 0.25 + sx * 0.5 - SP_C) / SP_R, (py + 0.25 + sy * 0.5 - SP_C) / SP_R);
        }
      }
      a[py * SP_N + px] = s / 4;
    }
  }
  return a;
}

function variants(a) {
  return SP_SIGMA.map((s) => {
    if (!s) return a;
    const b = Math.max(1, Math.round((-1 + Math.sqrt(1 + 4 * s * s)) / 2));
    return boxBlur3(a, SP_N, SP_N, b);
  });
}

/** Ba lượt box blur ngang + dọc ≈ Gauss. */
function boxBlur3(src, w, h, r) {
  let a = Float32Array.from(src), t = new Float32Array(src.length);
  const pass = (from, to, horiz) => {
    const n = horiz ? w : h, m = horiz ? h : w, st = horiz ? 1 : w, ln = horiz ? w : 1;
    for (let j = 0; j < m; j++) {
      const o = j * ln;
      let acc = 0;
      for (let k = -r; k <= r; k++) acc += from[o + Math.min(n - 1, Math.max(0, k)) * st];
      for (let i = 0; i < n; i++) {
        to[o + i * st] = acc / (2 * r + 1);
        acc += from[o + Math.min(n - 1, i + r + 1) * st] - from[o + Math.max(0, i - r) * st];
      }
    }
  };
  for (let p = 0; p < 3; p++) {
    pass(a, t, true);
    pass(t, a, false);
  }
  return a;
}

/** Cục bông: vài đốm tròn dính nhau, viền xù, ruột trong mờ không đều. */
function clumpShape(rng) {
  const n = 6 + Math.floor(rng() * 8), b = [];
  let ext = 0;
  for (let i = 0; i < n; i++) {
    const a = rng() * Math.PI * 2, d = Math.sqrt(rng()) * 0.5, r = 0.22 + rng() * 0.3;
    b.push([Math.cos(a) * d, Math.sin(a) * d, r]);
    ext = Math.max(ext, d + r);
  }
  const s = 0.92 / ext;
  b.forEach((q) => { q[0] *= s; q[1] *= s; q[2] *= s; });
  const nz = noise2((rng() * 4294967296) >>> 0);
  return (x, y) => {
    const fuzz = (nz(x * 5, y * 5) - 0.5) * 0.35;
    let best = 0;
    for (let i = 0; i < b.length; i++) {
      const dx = x - b[i][0], dy = y - b[i][1];
      const v = 1 - smooth(0.7, 1.05, Math.sqrt(dx * dx + dy * dy) / b[i][2] + fuzz);
      if (v > best) best = v;
    }
    return best * (0.72 + 0.28 * nz(x * 9 + 7, y * 9 + 3));
  };
}

/** Mảnh tuyết giả (giấy, bọt): đa giác méo, phẳng, một mép bắt sáng hơn. */
function chipShape(rng) {
  const n = 5 + Math.floor(rng() * 4), pts = [];
  const off = rng() * Math.PI * 2;
  for (let i = 0; i < n; i++) {
    const a = off + ((i + (rng() - 0.5) * 0.6) * Math.PI * 2) / n, r = 0.6 + rng() * 0.38;
    pts.push([Math.cos(a) * r, Math.sin(a) * r]);
  }
  const gx = Math.cos(off * 1.7), gy = Math.sin(off * 1.7);
  return (x, y) => (insidePoly(pts, x, y) ? 0.82 + 0.18 * (0.5 + 0.5 * (x * gx + y * gy)) : 0);
}

/**
 * Mảnh tuyết đọng: một đến ba mảnh tinh thể vỡ dính nhau, viền răng cưa (đỉnh
 * đa giác lệch bán kính mạnh), ruột sáng không đều — như tuyết thật rơi trên tóc
 * nhìn gần: không tròn, không phải cục bông.
 */
/**
 * Mảnh tuyết đọng dạng XƠ: tinh thể nhánh cây bị gãy, nằm bẹp trên tóc — một
 * sống dài hơi cong, vài nhánh ngắn chĩa hai bên, nhánh mỏng trong hơn sống,
 * thêm vụn nhỏ ở đầu mút. Trục dài là trục x của sprite: settledFlakes xoay nó
 * xuôi theo sợi tóc.
 */
/**
 * Cụm tuyết đang rơi: vài tinh thể vỡ dính nhau thành một bông xốp — nhánh DÀY
 * chĩa nhiều hướng từ gần tâm, thêm vài cục nhỏ, ruột sáng không đều. Ở cỡ vài
 * pixel vẫn đọc ra là một bông tuyết (mảnh xơ nhánh mảnh thì thành sợi xơ vải).
 */
function aggregateShape(rng) {
  // Các mảnh vỡ đặt LỆCH nhau, mỗi mảnh một hướng — không tỏa đều từ một tâm
  // (tỏa đều thì thành dấu sao, trông như hình vẽ).
  const segs = [], n = 3 + Math.floor(rng() * 4);
  for (let i = 0; i < n; i++) {
    const ca = rng() * Math.PI * 2, cd = (i ? 0.2 + 0.3 * rng() : 0.1 * rng());
    const cx = Math.cos(ca) * cd, cy = Math.sin(ca) * cd;
    const a = rng() * Math.PI, len = 0.25 + 0.4 * rng(), wd = 0.16 + 0.12 * rng();
    const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
    segs.push([cx - dx, cy - dy, cx + dx * (0.4 + 0.6 * rng()), cy + dy * (0.4 + 0.6 * rng()), wd, 0.7 + 0.3 * rng()]);
    const nb = Math.floor(rng() * 3);
    for (let j = 0; j < nb; j++) {
      const t = rng() * 2 - 1, bx = cx + dx * t * 0.8, by = cy + dy * t * 0.8;
      const ba = a + (rng() < 0.5 ? -1 : 1) * (0.6 + 0.6 * rng()), bl = 0.12 + 0.2 * rng();
      segs.push([bx, by, bx + Math.cos(ba) * bl, by + Math.sin(ba) * bl, wd * (0.5 + 0.3 * rng()), 0.55 + 0.35 * rng()]);
    }
  }
  // Lõi: các mảnh dính vào một khối ở giữa — thiếu lõi thì bông rời ra như nét chữ.
  segs.push([0, 0, (rng() - 0.5) * 0.2, (rng() - 0.5) * 0.2, 0.24 + 0.1 * rng(), 0.95]);
  const nb = Math.floor(rng() * 3);
  for (let i = 0; i < nb; i++) {
    const a = rng() * Math.PI * 2, d = 0.15 + 0.45 * rng();
    segs.push([Math.cos(a) * d, Math.sin(a) * d, Math.cos(a) * d, Math.sin(a) * d, 0.08 + 0.12 * rng(), 0.75]);
  }
  let ext = 0;
  segs.forEach((g) => { ext = Math.max(ext, Math.hypot(g[0], g[1]) + g[4], Math.hypot(g[2], g[3]) + g[4]); });
  const sc = 0.95 / ext;
  segs.forEach((g) => { for (let q = 0; q < 5; q++) g[q] *= sc; });
  const nz = noise2((rng() * 4294967296) >>> 0);
  return (x, y) => {
    let v = 0;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      const d = segDist(x, y, g[0], g[1], g[2], g[3] + (g[0] === g[2] && g[1] === g[3] ? 1e-6 : 0));
      if (d < g[4]) {
        const a = g[5] * (1 - smooth(g[4] * 0.45, g[4], d));
        v = v + a - v * a;   // chồng mảnh: chỗ dính nhau dày, sáng hơn
      }
    }
    return Math.min(1, v) * (0.86 + 0.14 * nz(x * 6 + 4, y * 6 + 9));
  };
}

function featherShape(rng) {
  const segs = [];
  const L = 0.8 + rng() * 0.15, w0 = 0.12 + rng() * 0.08, bend = (rng() - 0.5) * 0.35;
  const spine = (t) => [t * L, bend * (1 - t * t) * L];
  for (let i = 0; i < 6; i++) {
    const t0 = -1 + i / 3, t1 = -1 + (i + 1) / 3, a = spine(t0), b = spine(t1);
    segs.push([a[0], a[1], b[0], b[1], w0 * (1 - 0.45 * Math.abs((t0 + t1) / 2)), 0.85 + 0.15 * rng()]);
  }
  const nb = 6 + Math.floor(rng() * 8);
  for (let i = 0; i < nb; i++) {
    const t = -0.85 + 1.7 * rng(), base = spine(t);
    const ang = (rng() < 0.5 ? -1 : 1) * (0.4 + rng() * 0.7), flip = rng() < 0.5 ? -1 : 1;
    const len = (0.3 + 0.5 * rng()) * (1 - 0.35 * Math.abs(t));
    segs.push([base[0], base[1], base[0] + flip * Math.cos(ang) * len, base[1] + Math.sin(ang) * len, w0 * (0.55 + 0.45 * rng()), 0.7 + 0.3 * rng()]);
  }
  const nf = Math.floor(rng() * 3);
  for (let i = 0; i < nf; i++) {
    const t = rng() < 0.5 ? -1.05 : 1.05, p = spine(t), j = (rng() - 0.5) * 0.25;
    segs.push([p[0] + j, p[1] + j, p[0] + j, p[1] + j, w0 * (0.6 + 0.5 * rng()), 0.6 + 0.4 * rng()]);
  }
  let ext = 0;
  segs.forEach((g) => { ext = Math.max(ext, Math.hypot(g[0], g[1]) + g[4], Math.hypot(g[2], g[3]) + g[4]); });
  const s = 0.95 / ext;
  segs.forEach((g) => { for (let q = 0; q < 5; q++) g[q] *= s; });
  const nz = noise2((rng() * 4294967296) >>> 0);
  return (x, y) => {
    let v = 0;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      const d = segDist(x, y, g[0], g[1], g[2], g[3] + (g[0] === g[2] && g[1] === g[3] ? 1e-6 : 0));
      if (d < g[4]) {
        const a = g[5] * (1 - smooth(g[4] * 0.5, g[4], d));
        if (a > v) v = a;
      }
    }
    return v * (0.72 + 0.28 * nz(x * 7 + 2, y * 7 + 5));
  };
}

function settledShape(rng) {
  const parts = [], n = 1 + Math.floor(rng() * 4);
  let ext = 0;
  for (let p = 0; p < n; p++) {
    const ca = rng() * Math.PI * 2, cd = p ? 0.25 + rng() * 0.35 : 0;
    const cx = Math.cos(ca) * cd, cy = Math.sin(ca) * cd;
    const r0 = p ? 0.2 + rng() * 0.25 : 0.45 + rng() * 0.3;
    const m = 7 + Math.floor(rng() * 7), off = rng() * Math.PI * 2, pts = [];
    for (let i = 0; i < m; i++) {
      const a = off + ((i + (rng() - 0.5) * 0.7) * Math.PI * 2) / m;
      const r = r0 * (0.55 + 0.5 * rng());
      pts.push([cx + Math.cos(a) * r, cy + Math.sin(a) * r]);
      ext = Math.max(ext, Math.hypot(cx + Math.cos(a) * r, cy + Math.sin(a) * r));
    }
    parts.push(pts);
  }
  const s = 0.95 / ext;
  parts.forEach((pts) => pts.forEach((q) => { q[0] *= s; q[1] *= s; }));
  const nz = noise2((rng() * 4294967296) >>> 0);
  return (x, y) => {
    for (let i = 0; i < parts.length; i++) {
      if (insidePoly(parts[i], x, y)) return 0.78 + 0.22 * nz(x * 6 + 3, y * 6 + 1);
    }
    return 0;
  };
}

function insidePoly(pts, x, y) {
  let c = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) c = !c;
  }
  return c;
}

/** Tinh thể sáu nhánh — kiểu cách điệu, chỉ nhận ra được khi hạt to sát ống kính. */
function crystalShape(rng) {
  const segs = [], w0 = 0.055 + rng() * 0.03;
  const at = [0.3 + rng() * 0.1, 0.52 + rng() * 0.1, 0.74 + rng() * 0.08];
  for (let k = 0; k < 6; k++) {
    const a = (k * Math.PI) / 3, dx = Math.cos(a), dy = Math.sin(a);
    segs.push([0, 0, dx * 0.96, dy * 0.96, w0]);
    for (const t of at) {
      const L = (1 - t) * 0.6, px = dx * t * 0.96, py = dy * t * 0.96;
      for (const s of [-1, 1]) {
        const b = a + (s * Math.PI) / 3;
        segs.push([px, py, px + Math.cos(b) * L, py + Math.sin(b) * L, w0 * 0.75]);
      }
    }
  }
  const plate = 0.16 + rng() * 0.08;
  return (x, y) => {
    if (x * x + y * y < plate * plate) return 0.95;
    for (let i = 0; i < segs.length; i++) {
      const g = segs[i];
      if (segDist(x, y, g[0], g[1], g[2], g[3]) < g[4]) return 0.9;
    }
    return 0;
  };
}

function segDist(x, y, x0, y0, x1, y1) {
  const vx = x1 - x0, vy = y1 - y0;
  let t = ((x - x0) * vx + (y - y0) * vy) / (vx * vx + vy * vy);
  t = t < 0 ? 0 : t > 1 ? 1 : t;
  const dx = x - x0 - t * vx, dy = y - y0 - t * vy;
  return Math.sqrt(dx * dx + dy * dy);
}

/* ═════════════════════════ màu nền ═════════════════════════ */

/** Bản thu nhỏ rất thô của ảnh (rộng 48 ô): hạt lấy màu môi trường từ đây. */
function ambientGrid(data, w, h, ch) {
  const GW = 48, GH = Math.max(1, Math.round((48 * h) / w));
  const acc = new Float32Array(GW * GH * 3), cnt = new Float32Array(GW * GH);
  const step = Math.max(1, Math.floor(Math.min(w, h) / 300));
  for (let y = 0; y < h; y += step) {
    const gy = Math.min(GH - 1, ((y * GH) / h) | 0);
    for (let x = 0; x < w; x += step) {
      const g = gy * GW + Math.min(GW - 1, ((x * GW) / w) | 0), i = (y * w + x) * ch;
      acc[g * 3] += data[i]; acc[g * 3 + 1] += data[i + 1]; acc[g * 3 + 2] += data[i + 2];
      cnt[g]++;
    }
  }
  for (let g = 0; g < GW * GH; g++) {
    const n = cnt[g] || 1;
    acc[g * 3] /= n; acc[g * 3 + 1] /= n; acc[g * 3 + 2] /= n;
  }
  const out = new Float32Array(acc.length);
  for (let y = 0; y < GH; y++) {
    for (let x = 0; x < GW; x++) {
      let r = 0, gg = 0, b = 0, n = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) {
          const xx = x + i, yy = y + j;
          if (xx < 0 || yy < 0 || xx >= GW || yy >= GH) continue;
          const q = (yy * GW + xx) * 3;
          r += acc[q]; gg += acc[q + 1]; b += acc[q + 2]; n++;
        }
      }
      const q = (y * GW + x) * 3;
      out[q] = r / n; out[q + 1] = gg / n; out[q + 2] = b / n;
    }
  }
  return { GW, GH, a: out };
}

function ambientAt(amb, u, v) {
  const x = Math.min(amb.GW - 1, Math.max(0, u * amb.GW - 0.5));
  const y = Math.min(amb.GH - 1, Math.max(0, v * amb.GH - 0.5));
  const x0 = x | 0, y0 = y | 0, x1 = Math.min(amb.GW - 1, x0 + 1), y1 = Math.min(amb.GH - 1, y0 + 1);
  const fx = x - x0, fy = y - y0, a = amb.a, out = [0, 0, 0];
  for (let c = 0; c < 3; c++) {
    const p = a[(y0 * amb.GW + x0) * 3 + c], q = a[(y0 * amb.GW + x1) * 3 + c];
    const r = a[(y1 * amb.GW + x0) * 3 + c], s = a[(y1 * amb.GW + x1) * 3 + c];
    out[c] = (p + (q - p) * fx) * (1 - fy) + (r + (s - r) * fx) * fy;
  }
  return out;
}

/* ═════════════════════════ vẽ ═════════════════════════ */

/**
 * Rắc tuyết lên `data` (Uint8Array, 3 hoặc 4 kênh), sửa tại chỗ.
 *
 * opts.seed   : bộ hạt (bắt buộc khác 0 để ổn định; pipeline lấy theo tên file)
 * opts.matte  : { data: Uint8Array w×h 0…255, width, height } — vùng người thật,
 *               thay cho elip tạm thời của cfg.subject
 * opts.only   : mảng tên lớp — chỉ vẽ các lớp này (trang chỉnh dùng để xem riêng)
 *
 * Trả về số hạt đã vẽ theo từng lớp và số hạt bị chặn khỏi vùng mặt.
 *
 * Mảng phải là Uint8Array, KHÔNG phải Uint8ClampedArray: phép làm tròn bên dưới
 * dựa vào việc gán số thực thì bị cắt phần lẻ. Trang chỉnh bọc ImageData lại
 * thành Uint8Array cho đúng cách làm tròn của snow.exe.
 */
export function drawSnow(data, w, h, ch, cfg0, opts = {}) {
  const seed = opts.seed >>> 0 || 1;
  const cfg = variedSnow(cfg0, seed);
  const scene = buildScene(w, h, cfg, seed, opts.matte, opts.faces);
  const only = opts.only ? new Set(opts.only) : null;
  const amb = ambientGrid(data, w, h, ch);
  const cover = coverFor(cfg, w, h, opts.matte);
  // Tuyết đọng nằm trên người: vẽ sau hạt sau lưng, trước hạt phía trước (Z = S).
  // Dò da trên ảnh gốc, trước khi có hạt nào được vẽ.
  const settled = settledFlakes(w, h, cfg, seed, opts.matte, opts.faces, data, ch)
    .concat(overlayFlakes(w, h, cfg, seed, opts.matte, opts.faces));
  scene.stats.settled = settled.filter((p) => !p.overlay).length;
  scene.stats.overlay = settled.length - scene.stats.settled;
  if (settled.length) {
    scene.particles = scene.particles.concat(settled);
    scene.particles.sort((a, b) => b.Z - a.Z || (a.settled ? -1 : 0) - (b.settled ? -1 : 0));
  }

  const li = cfg.light;
  const backK = (0.6 * li.backlight) / 100;
  const glowK = li.glow / 100;
  const ambK = li.ambient / 100;
  const bright = li.brightness / 100;
  const ang = (cfg.wind.angle * Math.PI) / 180, mx = Math.sin(ang), my = Math.cos(ang);
  const trailK = cfg.wind.trail / 100;
  const blades = cfg.camera.blades;
  const S = cfg.camera.focus;
  const col = [0, 0, 0], gcol = [0, 0, 0];
  const mottle = noise2((seed ^ 0x6a09e667) >>> 0);
  const v1 = cfg.style === "v1";

  for (const p of scene.particles) {
    if (p.settled) {
      if (!only || only.has("settle")) drawSettled(data, w, h, ch, p, seed, amb, li);
      continue;
    }
    if (only && !only.has(SNOW_LAYERS[p.layer])) continue;
    const E = Math.max(1.2, p.D + p.C);
    const sharp = Math.min(1, Math.max(p.D, 0.7) / E);
    const useSprite = p.D >= 4 && p.C < 0.85 * p.D;
    // Độ che: hạt còn nét che đúng bằng độ đậm (sprite tự trải mờ). Hạt đã mờ
    // hẳn thì lượng che trải ra cả vòng mờ, nên càng mờ càng trong.
    const cov = p.alpha * (useSprite ? 1 : sharp);
    if (cov < 0.004) continue;

    // Độ sáng: flash đặt gần máy ảnh, nên hạt sát ống kính nhận nhiều sáng hơn
    // người và hơi cháy — vì thế bokeh tuyết sáng lên chứ không phải một lớp
    // xám đục. Chặn ở 1.6: mạnh hơn nữa thì đĩa mờ thành hình dán trắng đặc.
    // Hạt sau lưng tối đi, có sàn vì phông thường được chiếu riêng. Ngược sáng
    // làm hạt mờ tán xạ mạnh hơn hạt nét.
    const fz = S / p.Z;
    const L = bright * p.bright * (fz > 1.6 ? 1.6 : fz < 0.8 ? 0.8 : fz) * (1 + backK * (1 - sharp));
    const c = ambientAt(amb, p.x / w, p.y / h);
    const cm = Math.max(c[0], c[1], c[2], 1);
    // Tuyết trắng dưới cùng nguồn sáng luôn sáng hơn bề mặt phía sau nó. Thiếu
    // sàn này, hạt sau lưng trên phông màu ra tối hơn kênh mạnh nhất của phông
    // và trông như bụi xám chứ không phải tuyết.
    const lv = Math.max(L * 255, cm * 1.12 * p.bright);
    for (let k = 0; k < 3; k++) {
      col[k] = lv * (1 - ambK + (ambK * c[k]) / cm);     // có thể vượt 255: cháy sáng là có chủ ý
      gcol[k] = col[k] > 255 ? 255 : col[k];
    }

    const R = E / 2 + 1;
    const mask = p.behind && cover && cover.any(p.x - R * 2, p.y - R * 2, p.x + R * 2, p.y + R * 2) ? cover : null;

    if (glowK > 0) glow(data, w, h, ch, p.x, p.y, E * 1.6 + 2, glowK * 0.22 * cov * Math.min(2, L), gcol, mask);

    if (trailK > 0 && p.C < p.D) {
      // Flash đóng băng hạt; ánh sáng môi trường để lại vệt mờ phía trên đầu hạt.
      const T = trailK * 4 * p.D, n = Math.min(8, Math.ceil(T / Math.max(1, p.D * 0.5)));
      for (let s = 1; s <= n; s++) {
        const t = s / n;
        disc(data, w, h, ch, p.x - mx * T * t, p.y - my * T * t, E * 0.8, cov * 0.3 * (1 - t), col, 0.6, 0, 0, 0, mask);
      }
    }

    if (useSprite) {
      sprite(data, w, h, ch, p, spritesOf(p.kind, seed)[p.sprite], cov, col, mask);
    } else {
      // Tuyết là vật mờ, đang rơi, không phải nguồn sáng điểm: bokeh của nó
      // mềm viền hơn hẳn bokeh đèn, ruột loang không đều (hạt thật không phải
      // đĩa đặc). Viền cứng + ruột phẳng là thứ làm tuyết trông như hình dán.
      // Mép sáng chỉ còn ở hạt cực mờ sát ống kính.
      // v1 giữ nguyên cách vẽ của bản đầu (viền gọn hơn, mép sáng sớm hơn, ruột phẳng).
      const soft = v1
        ? Math.min(1, Math.max(0.3, 0.3 + 0.5 * sharp + 1.2 / (E / 2)))
        : Math.min(1, Math.max(0.65, 0.55 + 0.4 * sharp + 1.2 / (E / 2)));
      const rim = p.C > (v1 ? 3 : 6) * p.D ? 1 : 0;
      disc(data, w, h, ch, p.x, p.y, E, cov, col, soft, rim, blades, p.rot, mask, v1 ? null : mottle);
    }
  }
  return scene.stats;
}

/**
 * Một mảnh tuyết đọng: nằm đúng mặt phẳng nét nên không có vòng mờ, không quầng,
 * không vệt. Sáng gần trắng, chỉ nhuốm nhẹ màu môi trường (nửa mức "ăn màu nền").
 */
function drawSettled(data, w, h, ch, p, seed, amb, li) {
  const c = ambientAt(amb, p.x / w, p.y / h), cm = Math.max(c[0], c[1], c[2], 1);
  const ambK = (0.5 * li.ambient) / 100, lv = Math.min(1.08, li.brightness / 100 + 0.1) * p.bright * 255;
  const col = [0, 0, 0];
  // Tuyết đọng ngả lạnh nhẹ (phản sáng trời / phông), không trắng tinh như giấy.
  const cool = p.overlay ? [0.98, 0.99, 1] : [0.95, 0.975, 1];
  for (let k = 0; k < 3; k++) col[k] = lv * cool[k] * (1 - ambK + (ambK * c[k]) / cm);
  if (p.D >= 2.5) sprite(data, w, h, ch, p, spritesOf(p.kind, seed)[p.sprite], p.alpha, col, null);
  else disc(data, w, h, ch, p.x, p.y, Math.max(0.9, p.D), p.alpha, col, 1, 0, 0, 0, null);
}

function blend(data, i, a, col) {
  const ia = 1 - a;
  let v = data[i] * ia + col[0] * a;
  data[i] = v >= 254.5 ? 255 : v + 0.5;
  v = data[i + 1] * ia + col[1] * a;
  data[i + 1] = v >= 254.5 ? 255 : v + 0.5;
  v = data[i + 2] * ia + col[2] * a;
  data[i + 2] = v >= 254.5 ? 255 : v + 0.5;
}

/**
 * Đĩa mềm: hạt đã mờ hẳn (vòng mờ lớn hơn nửa cỡ hạt) thì hình dạng hạt không
 * còn — thứ còn lại là hình của khẩu độ. `rim` làm sáng mép như bokeh thật;
 * `blades` ≥ 5 cho đĩa đa giác. Đĩa nhỏ hơn 4px thì vẽ thành chấm Gauss để
 * không răng cưa.
 */
function disc(data, w, h, ch, cx, cy, E, peak, col, soft, rim, blades, rot, mask, nz) {
  const R = E / 2;
  if (R < 2) {
    // Cùng "lượng sáng" với đĩa bán kính R: p·πR² = pk·2πσ².
    const sg = Math.max(0.5, R * 0.6), pk = Math.min(1, (peak * R * R) / (2 * sg * sg));
    const ext = sg * 3;
    const x0 = Math.max(0, Math.floor(cx - ext)), x1 = Math.min(w - 1, Math.ceil(cx + ext));
    const y0 = Math.max(0, Math.floor(cy - ext)), y1 = Math.min(h - 1, Math.ceil(cy + ext));
    const k = 1 / (2 * sg * sg);
    for (let y = y0; y <= y1; y++) {
      const dy = y + 0.5 - cy;
      for (let x = x0; x <= x1; x++) {
        const dx = x + 0.5 - cx;
        let a = pk * Math.exp(-(dx * dx + dy * dy) * k);
        if (mask) a *= 1 - mask.at(x, y);
        if (a > 0.003) blend(data, (y * w + x) * ch, a, col);
      }
    }
    return;
  }
  const x0 = Math.max(0, Math.floor(cx - R - 1)), x1 = Math.min(w - 1, Math.ceil(cx + R + 1));
  const y0 = Math.max(0, Math.floor(cy - R - 1)), y1 = Math.min(h - 1, Math.ceil(cy + R + 1));
  const inv = 1 / R, seg = blades ? (Math.PI * 2) / blades : 0, cosHalf = blades ? Math.cos(seg / 2) : 1;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx;
      let rho = Math.sqrt(dx * dx + dy * dy) * inv;
      if (blades && rho > 0) {
        let t = (Math.atan2(dy, dx) - rot) % seg;
        if (t < 0) t += seg;
        rho *= cosHalf / Math.cos(t - seg / 2);
      }
      if (rho >= 1) continue;
      let a = peak * (1 - smooth(1 - soft, 1, rho));
      if (nz) a *= 0.72 + 0.4 * nz(dx * inv * 1.4 + rot * 13, dy * inv * 1.4 + rot * 7);
      if (rim) a *= 0.85 + 0.25 * smooth(0.35, 0.8, rho);
      if (mask) a *= 1 - mask.at(x, y);
      if (a > 0.003) blend(data, (y * w + x) * ch, a > 1 ? 1 : a, col);
    }
  }
}

/** Hạt còn nét: lấy mẫu sprite đã xoay + nghiêng, độ mờ nội suy giữa hai bản làm mờ sẵn. */
function sprite(data, w, h, ch, p, sv, peak, col, mask) {
  const D = p.D;
  // Độ mờ cần trên lưới sprite: vòng mờ ống kính (σ ≈ C/4) hoặc chống răng cưa khi thu nhỏ.
  const need = Math.max((16 * p.C) / D, (p.aa || 25.6) / D);
  let j = 0;
  while (j < SP_SIGMA.length - 1 && SP_SIGMA[j + 1] <= need) j++;
  const A = sv[j], B = j < SP_SIGMA.length - 1 ? sv[j + 1] : null;
  const t = B ? (need - SP_SIGMA[j]) / (SP_SIGMA[j + 1] - SP_SIGMA[j]) : 0;

  const s = SP_R / (D / 2), cs = Math.cos(p.rot), sn = Math.sin(p.rot), it = 1 / p.tilt;
  const ext = (SP_C / SP_R) * (D / 2) + 1;
  const x0 = Math.max(0, Math.floor(p.x - ext)), x1 = Math.min(w - 1, Math.ceil(p.x + ext));
  const y0 = Math.max(0, Math.floor(p.y - ext)), y1 = Math.min(h - 1, Math.ceil(p.y + ext));
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - p.y;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - p.x;
      const qx = SP_C + (dx * cs + dy * sn) * s - 0.5;
      const qy = SP_C + (-dx * sn + dy * cs) * it * s - 0.5;
      if (qx < 0 || qy < 0 || qx >= SP_N - 1 || qy >= SP_N - 1) continue;
      const ix = qx | 0, iy = qy | 0, fx = qx - ix, fy = qy - iy, o = iy * SP_N + ix;
      let v = (A[o] * (1 - fx) + A[o + 1] * fx) * (1 - fy) + (A[o + SP_N] * (1 - fx) + A[o + SP_N + 1] * fx) * fy;
      if (B) {
        const v2 = (B[o] * (1 - fx) + B[o + 1] * fx) * (1 - fy) + (B[o + SP_N] * (1 - fx) + B[o + SP_N + 1] * fx) * fy;
        v += (v2 - v) * t;
      }
      let a = peak * v;
      if (mask) a *= 1 - mask.at(x, y);
      if (a > 0.003) blend(data, (y * w + x) * ch, a > 1 ? 1 : a, col);
    }
  }
}

/** Quầng sáng quanh hạt, hoà kiểu screen: chỉ làm sáng, không bao giờ làm tối. */
function glow(data, w, h, ch, cx, cy, R, k, col, mask) {
  if (k < 0.004) return;
  const x0 = Math.max(0, Math.floor(cx - R)), x1 = Math.min(w - 1, Math.ceil(cx + R));
  const y0 = Math.max(0, Math.floor(cy - R)), y1 = Math.min(h - 1, Math.ceil(cy + R));
  const inv = 1 / (R * R), c0 = col[0] / 255, c1 = col[1] / 255, c2 = col[2] / 255;
  for (let y = y0; y <= y1; y++) {
    const dy = y + 0.5 - cy;
    for (let x = x0; x <= x1; x++) {
      const dx = x + 0.5 - cx, q = (dx * dx + dy * dy) * inv;
      if (q >= 1) continue;
      let g = k * (1 - q) * (1 - q);
      if (mask) g *= 1 - mask.at(x, y);
      if (g < 0.002) continue;
      const i = (y * w + x) * ch;
      data[i] = 255 - (255 - data[i]) * (1 - g * c0) + 0.5;
      data[i + 1] = 255 - (255 - data[i + 1]) * (1 - g * c1) + 0.5;
      data[i + 2] = 255 - (255 - data[i + 2]) * (1 - g * c2) + 0.5;
    }
  }
}
