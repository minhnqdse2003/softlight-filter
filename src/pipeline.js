import sharp from 'sharp';
import { hexToRgb } from './config.js';

/**
 * HIỆU ỨNG SOFT LIGHT
 * ===================
 * Tầng chính là BLOOM CÓ MẶT NẠ DA — dựng lại đúng thuật toán của bản tham
 * chiếu `instagram-soft-light-1.html`:
 *
 *   Ảnh GỐC được giữ nguyên nét làm nền. Một bản sao được lọc chỉ còn pixel
 *   tông da (và bỏ luôn pixel quá sáng), làm mờ thật mạnh, tăng sáng rồi
 *   `screen` đè lên nền. Nhờ vậy da phát sáng mềm mại trong khi phông nền —
 *   chấm bi, hoa văn, chữ trên backdrop — vẫn sắc nét nguyên vẹn.
 *
 * Điểm khác cốt lõi so với cách làm cũ: quầng sáng KHÔNG còn cắt theo độ sáng
 * (cách cũ giữ lại đúng vùng sáng nhất, tức là chấm bi trắng của phông, nên
 * phông bị loè trước cả khuôn mặt). Bây giờ nó cắt theo MÀU DA, và loại bỏ
 * vùng sáng hơn `highlightCutoff` — nghĩa là ngược hẳn logic cũ.
 *
 * Các tầng còn lại là tuỳ chọn, mặc định tắt (amount = 0), giữ lại để người
 * vận hành nêm thêm khi cần:
 *
 *   1. Soft focus    — lớp mờ bán kính nhỏ pha vào toàn ảnh (mịn da, mềm tóc).
 *   2. Giảm clarity  — lớp mờ bán kính lớn, hạ tương phản dải tần trung.
 *   3. Bloom         — TẦNG CHÍNH, mô tả ở trên.
 *   4. Giảm contrast — biến đổi affine quanh điểm giữa, cộng lift nâng vùng đen.
 *   5. Tăng tông ấm  — gain lệch giữa các kênh, cộng lớp soft-light màu ấm.
 *
 * Toàn bộ chạy trong libvips, trừ phép ghép cuối của tầng bloom. Các lớp mờ
 * được tính ở độ phân giải rút gọn rồi phóng lại: sigma cỡ 150 pixel trên ảnh
 * 24MP, làm mờ thẳng ở full res sẽ chậm gấp bội mà kết quả không khác — lớp mờ
 * vốn chỉ chứa tần số thấp, thông tin đó sống sót qua phép rút gọn.
 */

/** Sigma mục tiêu sau khi rút gọn. Giữ quanh mức này để blur luôn rẻ. */
const TARGET_SIGMA = 12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/** Bậc rút gọn cho một sigma: làm mờ ở ảnh nhỏ rồi phóng lại. */
const shrinkFor = (sigmaPx) => clamp(Math.round(sigmaPx / TARGET_SIGMA), 1, 24);

/** Làm mờ một buffer raw ở độ phân giải rút gọn rồi trả về đúng kích thước cũ. */
function blurShrunk(src, raw, channels, sigmaPx, d) {
  const g = { width: raw.width, height: raw.height, channels };
  let p = sharp(src, { raw: g });
  if (d > 1) {
    p = p.resize(Math.max(2, Math.round(raw.width / d)), Math.max(2, Math.round(raw.height / d)), {
      kernel: 'cubic',
      fit: 'fill',
    });
  }
  p = p.blur(Math.max(0.3, sigmaPx / d));
  if (d > 1) p = p.resize(raw.width, raw.height, { kernel: 'cubic', fit: 'fill' });
  // Bắt buộc với ảnh 1 kênh: thiếu dòng này sharp nở nó thành 3 kênh khi xuất raw.
  if (channels === 1) p = p.toColourspace('b-w');
  return p.raw().toBuffer();
}

/**
 * Dựng một lớp mờ đã gắn sẵn alpha, sẵn sàng để composite (tầng 1 và 2).
 */
async function blurLayer(buf, raw, sigmaPx, alpha) {
  const d = shrinkFor(sigmaPx);
  const blurred = await blurShrunk(buf, raw, 3, sigmaPx, d);
  return sharp(blurred, { raw }).ensureAlpha(alpha).raw().toBuffer();
}

/** Ghép một lớp RGBA lên buffer RGB, trả lại buffer RGB. */
async function compose(buf, raw, layer, blend) {
  return sharp(buf, { raw })
    .composite([{ input: layer, raw: { ...raw, channels: 4 }, blend }])
    .removeAlpha()
    .raw()
    .toBuffer();
}

/**
 * Nhận diện tông da, đúng ngưỡng của bản HTML tham chiếu: đỏ trội hơn lục một
 * khoảng rõ rệt và trội hơn lam. Bắt được cả da người châu Á lẫn ánh tóc nâu đỏ,
 * và bỏ qua gần như toàn bộ phông xanh / trắng / xám của booth.
 */
export const isSkin = (r, g, b) => r > 80 && g > 35 && b > 20 && r - g > 10 && r > b;

/**
 * Tách vùng da rồi làm mờ nó cùng mặt nạ alpha của chính nó.
 *
 * Màu được lưu ở dạng ĐÃ NHÂN ALPHA trước khi làm mờ — giống hệt cách canvas
 * của trình duyệt làm. Nếu làm mờ màu thô rồi mới nhân mặt nạ, viền vùng da sẽ
 * kéo theo màu phông vào trong quầng sáng.
 *
 * Trả về `null` khi ảnh không có pixel da nào — lúc đó tầng này không làm gì cả.
 */
async function bloomLayer(base, raw, cfg) {
  const n = raw.width * raw.height;
  const pm = Buffer.alloc(n * 3); // màu đã nhân alpha, ngoài mặt nạ là 0
  const mk = Buffer.alloc(n); // mặt nạ 0 / 255
  const cut = cfg.highlightCutoff * 255;
  let kept = 0;

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const r = base[k];
    const g = base[k + 1];
    const b = base[k + 2];
    if (cfg.skinOnly && !isSkin(r, g, b)) continue;
    // Loại vùng quá sáng: chấm bi trắng, đèn, mảng cháy sáng. Chúng mà lọt vào
    // lớp mờ thì phông nền sẽ loè lên trước cả khuôn mặt.
    if (0.299 * r + 0.587 * g + 0.114 * b > cut) continue;
    pm[k] = r;
    pm[k + 1] = g;
    pm[k + 2] = b;
    mk[i] = 255;
    kept++;
  }
  if (!kept) return null;

  // Bán kính tính theo CHIỀU NGANG ảnh, có sàn tuyệt đối — ảnh nhỏ vẫn đủ loang.
  const sigma = Math.max(cfg.minRadiusPx, (cfg.radiusPct / 100) * raw.width);
  const d = shrinkFor(sigma);
  const [colour, mask] = await Promise.all([
    blurShrunk(pm, raw, 3, sigma, d),
    blurShrunk(mk, raw, 1, sigma, d),
  ]);
  return { colour, mask };
}

/**
 * Screen lớp bloom lên ảnh nền, sửa `base` tại chỗ.
 *
 * Làm tay thay vì nhờ libvips vì hai lý do. Một: cần bỏ nhân alpha trước khi
 * áp brightness/contrast, đúng thứ tự mà chuỗi filter của canvas thực hiện.
 * Hai: với mọi blend khác `over`, libvips đưa màu ĐÃ nhân alpha vào hàm blend
 * rồi mới pha lại theo alpha, thành ra cường độ thật là amount² chứ không phải
 * amount. Công thức dưới đây khớp canvas từng pixel:
 *
 *     out = base + (mask · amount) · layer · (1 − base)
 */
function screenBloom(base, raw, layer, cfg) {
  const n = raw.width * raw.height;
  const { colour, mask } = layer;
  const br = cfg.brightness;
  const ct = cfg.contrast;
  const ctOff = 255 * 0.5 * (1 - ct); // contrast neo quanh điểm giữa

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const m = mask[i];
    if (m === 0) continue;
    const a = (m / 255) * cfg.amount;
    const unpre = 255 / m;
    for (let c = 0; c < 3; c++) {
      let s = colour[k + c] * unpre;
      if (s > 255) s = 255;
      s = s * br; // brightness()
      s = s * ct + ctOff; // contrast()
      s = s < 0 ? 0 : s > 255 ? 255 : s;
      const b = base[k + c];
      const v = b + a * s * (1 - b / 255);
      base[k + c] = v > 254.5 ? 255 : (v + 0.5) | 0;
    }
  }
}

/* ═══════════════════ nhiễu hạt (film grain) ═══════════════════ */

/**
 * Hạt phim khác nhiễu cảm biến ở ba chỗ, và cả ba đều nằm trong đoạn dưới đây:
 *
 *  1. Hạt có KÍCH THƯỚC. Tinh thể muối bạc kết tụ thành cụm rồi còn bị nhoè
 *     thêm qua quang học, nên hạt thật không bao giờ là nhiễu trắng từng pixel
 *     một. Ta dựng bằng nhiễu trắng rồi làm mờ — đúng cách một cụm hình thành.
 *  2. Hạt PHỤ THUỘC SẮC ĐỘ. Phản ứng hoá học bão hoà ở vùng cháy sáng và chưa
 *     kịp xảy ra ở vùng đen kịt, nên hạt rõ nhất ở trung gian rồi cuộn mượt về
 *     0 ở cả hai đầu. Rải đều hạt lên toàn dải là dấu hiệu rõ nhất của hạt giả.
 *  3. Ba lớp thuốc nhuộm ĐỘC LẬP và KHÔNG cùng cỡ. Lớp lam nằm trên cùng nên
 *     hạt to và thô hơn hẳn; lớp đỏ mịn nhất. Tỉ lệ dưới đây lấy theo thông số
 *     regrain quen dùng trong compositing (R 0.8 / G 1.0 / B 1.4 về kích
 *     thước, 0.015 / 0.020 / 0.035 về cường độ). Lưu ý: những con số đó dành
 *     cho không gian tuyến tính dải rộng; đổ nguyên vào sRGB 8-bit thì phần
 *     lệch kênh đọc ra thành đốm màu kiểu nhiễu cảm biến chứ không ra chất
 *     phim. Vì vậy `chroma` pha tỉ lệ đó về 1 — mặc định chỉ lấy một nửa.
 *
 * Hạt được cộng SAU CÙNG, ngay trước khi mã hoá JPEG — quy tắc "khử trước,
 * thêm hạt sau" của khâu hậu kỳ: hạt phải nằm trên tất cả các tầng khác thì
 * mới hàn được chúng lại thành một mặt phẳng ảnh duy nhất. Nó cũng đóng luôn
 * vai trò dither, phá vệt đứt dải trên nền chuyển sắc mượt.
 */
const GRAIN_SIZE = [0.8, 1.0, 1.4]; // R, G, B — cỡ cụm tương đối
const GRAIN_AMT = [0.75, 1.0, 1.75]; // R, G, B — cường độ tương đối
/** Cạnh dài quy chiếu của `grain.sizePx`. Ảnh to hơn thì cụm hạt to lên theo. */
const GRAIN_REF_EDGE = 4000;

/**
 * Nhiễu trắng 8-bit. xorshift32 rồi trộn thêm một lượt nhân, ghi thẳng cả từ
 * 32-bit một lần — bốn điểm ảnh mỗi vòng lặp. Trên ảnh 24MP thì đây là khác
 * biệt giữa 170ms và 90ms, nên đáng để ghi qua Uint32Array thay vì từng byte.
 */
function whiteNoise(n, seed) {
  const words = (n + 3) >> 2;
  const u32 = new Uint32Array(words);
  // Giữ `s` ở nguyên int32 suốt vòng lặp: không chèn `s >>>= 0`, vì phép đó
  // cho ra giá trị vượt 2³¹ nên số rơi khỏi dạng số nguyên của JIT. `>>> 17`
  // thì an toàn — dịch phải ít nhất một bit nên kết quả luôn dưới 2³¹.
  let s = seed | 0 || 0x9e3779b9 | 0;
  for (let i = 0; i < words; i++) {
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    u32[i] = Math.imul(s, 0x2545f491);
  }
  return Buffer.from(u32.buffer, 0, n);
}

/** Cạnh của mảnh cắt dùng để đo thống kê lớp hạt. */
const GRAIN_SAMPLE = 640;

/**
 * Một lớp hạt: nhiễu trắng làm mờ để kết cụm, kèm trung bình và độ lệch chuẩn.
 *
 * Phải ĐO chứ không suy ra bằng công thức: làm mờ hạ phương sai rất mạnh và
 * mức hạ còn phụ thuộc việc ép lại về 8-bit. Nhưng chỉ cần đo trên một mảnh
 * nhỏ — nhiễu là dừng (stationary), mảnh 640² đã cho ước lượng sai dưới 0,5%
 * mà rẻ hơn quét cả 24 triệu điểm ảnh năm lần.
 */
async function grainPlane(raw, sigma, seed) {
  const n = raw.width * raw.height;
  const g1 = { width: raw.width, height: raw.height, channels: 1 };
  let data = whiteNoise(n, seed);
  if (sigma >= 0.3) {
    data = await sharp(data, { raw: g1 }).blur(sigma).toColourspace('b-w').raw().toBuffer();
  }

  const side = Math.min(GRAIN_SAMPLE, raw.width, Math.floor(n / raw.width));
  const st = (
    await sharp(data.subarray(0, side * side), {
      raw: { width: side, height: side, channels: 1 },
    }).stats()
  ).channels[0];
  return { data, mean: st.mean, stdev: st.stdev || 1 };
}

/** Cuộn mượt về 0 ở hai đầu dải sáng: `smoothstep` lên rồi xuống. */
function grainResponse(lum, lo, hi) {
  let t;
  if (lum <= 0) return 0;
  if (lum < lo) t = lum / lo;
  else if (lum > hi) t = (255 - lum) / (255 - hi);
  else return 1;
  if (t <= 0) return 0;
  return t * t * (3 - 2 * t);
}

/** Cộng hạt vào buffer RGB, sửa tại chỗ. */
async function addGrain(base, raw, cfg) {
  const n = raw.width * raw.height;
  const scale = Math.max(raw.width, raw.height) / GRAIN_REF_EDGE;
  const seed = cfg.seed || ((Math.random() * 0xffffffff) >>> 0);

  // `chroma` pha tỉ lệ lệch kênh về 1: 0 = ba kênh giống hệt nhau, 1 = đủ độ
  // lệch của ba lớp thuốc nhuộm.
  const mix = (tbl, c) => 1 + cfg.chroma * (tbl[c] - 1);

  // mono: một lớp duy nhất dùng chung cho cả ba kênh — hạt xám, không lệch màu.
  const planes = [];
  if (cfg.mono) {
    const p = await grainPlane(raw, cfg.sizePx * scale, seed);
    planes.push(p, p, p);
  } else {
    for (let c = 0; c < 3; c++) {
      planes.push(
        await grainPlane(raw, cfg.sizePx * scale * mix(GRAIN_SIZE, c), seed + c * 0x6d2b79f5),
      );
    }
  }

  const rel = cfg.mono ? [1, 1, 1] : [0, 1, 2].map((c) => mix(GRAIN_AMT, c));
  const [kr, kg, kb] = [0, 1, 2].map((c) => (cfg.amount * rel[c] * 255) / planes[c].stdev);
  const lo = cfg.shadowRolloff * 255;
  const hi = cfg.highlightRolloff * 255;

  // Đường cong đáp ứng chỉ phụ thuộc độ sáng, mà độ sáng thì chỉ có 256 mức —
  // tra bảng thay vì tính lại smoothstep cho từng điểm ảnh.
  const wOf = new Float64Array(256);
  for (let l = 0; l < 256; l++) wOf[l] = grainResponse(l, lo, hi);

  const [pr, pg, pb] = planes.map((x) => x.data);
  const [mr, mg, mb] = planes.map((x) => x.mean);

  for (let i = 0, p = 0; i < n; i++, p += 3) {
    const r = base[p];
    const g = base[p + 1];
    const b = base[p + 2];
    const w = wOf[(r * 77 + g * 150 + b * 29) >> 8];
    if (w === 0) continue;
    let v = r + w * kr * (pr[i] - mr);
    base[p] = v <= 0 ? 0 : v >= 254.5 ? 255 : (v + 0.5) | 0;
    v = g + w * kg * (pg[i] - mg);
    base[p + 1] = v <= 0 ? 0 : v >= 254.5 ? 255 : (v + 0.5) | 0;
    v = b + w * kb * (pb[i] - mb);
    base[p + 2] = v <= 0 ? 0 : v >= 254.5 ? 255 : (v + 0.5) | 0;
  }
}

/**
 * Áp hiệu ứng lên một ảnh, trả về buffer JPEG đã mã hoá.
 * Không đụng tới đĩa — việc ghi file do lớp gọi quyết định.
 *
 * `trace: true` đo ảnh sau từng tầng; chỉ dùng cho --selftest vì mỗi phép đo
 * tốn thêm một lượt quét toàn ảnh.
 */
export async function renderSoftLight(inputPath, cfg, { trace = false } = {}) {
  const src = sharp(inputPath, { failOn: 'none' }).rotate().toColourspace('srgb');
  const { data, info } = await src.raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };

  if (raw.channels !== 3) {
    throw new Error(`Ảnh có ${raw.channels} kênh màu, chỉ hỗ trợ RGB 3 kênh.`);
  }

  const longEdge = Math.max(raw.width, raw.height);
  const stages = [];
  let cur = data;
  const mark = async (name) => {
    if (trace) stages.push({ name, ...(await measureRaw(cur, raw)) });
  };
  await mark('gốc');

  // ── 1–2. Soft focus và clarity ────────────────────────────────────
  // Mặc định cả hai đều tắt: bản tham chiếu giữ ảnh nền sắc nét 100%, mọi độ
  // mềm đều đến từ tầng bloom. Bật lên khi muốn làm mịn cả khung hình.
  //
  // Cả hai lớp đều dựng từ ảnh gốc chứ không nối tiếp nhau. Về lý thuyết khác
  // với việc chạy tuần tự, nhưng mỗi lớp đều là ảnh đã làm mờ mạnh, mà phép
  // làm mờ thì xoá sạch đúng những tần số mà tầng trước vừa đổi — nên sai lệch
  // nằm dưới ngưỡng nhận biết, đổi lại tiết kiệm được vài lượt quét toàn ảnh.
  const layers = [];
  if (cfg.softFocus.amount > 0.001) {
    layers.push({
      name: 'soft focus',
      buf: await blurLayer(data, raw, (cfg.softFocus.radiusPct / 100) * longEdge, cfg.softFocus.amount),
    });
  }
  if (cfg.clarity.amount > 0.001) {
    layers.push({
      name: 'clarity',
      buf: await blurLayer(data, raw, (cfg.clarity.radiusPct / 100) * longEdge, cfg.clarity.amount),
    });
  }

  if (layers.length) {
    if (trace) {
      // Chế độ đo: ghép từng lớp một để thấy diễn biến, chấp nhận chậm hơn.
      for (const l of layers) {
        cur = await compose(cur, raw, l.buf, 'over');
        await mark(l.name);
      }
    } else {
      cur = await sharp(cur, { raw })
        .composite(layers.map((l) => ({ input: l.buf, raw: { ...raw, channels: 4 }, blend: 'over' })))
        .removeAlpha()
        .raw()
        .toBuffer();
    }
  }

  // ── 3. Bloom trên vùng da ─────────────────────────────────────────
  // Mặt nạ đọc từ ảnh GỐC, không phải từ `cur`: các tầng trên có thể đã làm
  // mờ ranh giới da / phông, mà mặt nạ thì cần đúng ranh giới ban đầu.
  if (cfg.bloom.amount > 0.001) {
    const layer = await bloomLayer(data, raw, cfg.bloom);
    if (layer) {
      // Buffer từ libvips có thể đang được chia sẻ, nên sao ra trước khi sửa tại chỗ.
      cur = Buffer.from(cur);
      screenBloom(cur, raw, layer, cfg.bloom);
      await mark('bloom');
    }
  }

  // ── 4 + 5. Contrast, lift và tông ấm, gộp thành một phép affine ───
  const gain = 1 + cfg.tone.contrast;
  // Neo điểm giữa 0.5 khi đổi contrast, rồi cộng lift nâng vùng đen.
  const offset = 255 * (0.5 * (1 - gain) + cfg.tone.lift);
  const t = cfg.warm.temp;
  const ti = cfg.warm.tint;
  if (gain !== 1 || offset !== 0 || t !== 0 || ti !== 0) {
    cur = await sharp(cur, { raw })
      .linear(
        [gain * (1 + t * 0.5), gain * (1 + ti * 0.5), gain * (1 - t * 0.5)],
        [offset, offset, offset],
      )
      .raw()
      .toBuffer();
    await mark('tone + ấm');
  }

  // ── 5b. Ấm thêm ở vùng sáng ───────────────────────────────────────
  // soft-light đẩy trung gian và vùng sáng về phía màu phủ nhưng gần như không
  // đụng vùng tối, nên cho ra kiểu split-tone ấm mà không làm đục bóng đổ.
  if (cfg.warm.highlightWarmth > 0.001) {
    const { r, g, b } = hexToRgb(cfg.warm.highlightColor);
    const tile = await sharp({
      create: {
        width: 64,
        height: 64,
        channels: 4,
        background: { r, g, b, alpha: cfg.warm.highlightWarmth },
      },
    })
      .png()
      .toBuffer();
    cur = await sharp(cur, { raw })
      .composite([{ input: tile, tile: true, blend: 'soft-light' }])
      .removeAlpha()
      .raw()
      .toBuffer();
    await mark('ấm vùng sáng');
  }

  // ── 6. Nhiễu hạt ──────────────────────────────────────────────────
  // Sau cùng, không có ngoại lệ: hạt phải nằm trên mọi tầng khác.
  if (cfg.grain.amount > 0.0005) {
    cur = Buffer.from(cur);
    await addGrain(cur, raw, cfg.grain);
    await mark('hạt');
  }

  const jpeg = await sharp(cur, { raw })
    .jpeg({
      quality: cfg.output.quality,
      chromaSubsampling: cfg.output.chromaSubsampling,
      progressive: false,
    })
    .withMetadata()
    .toBuffer();

  return { jpeg, width: raw.width, height: raw.height, stages };
}
/**
 * Ảnh so sánh trước / sau, ghép cạnh nhau kèm vạch chia — dùng để chỉnh tham số
 * mà không phải ghi đè ảnh thật.
 */
export async function renderComparison(inputPath, cfg, maxWidth = 2200) {
  const before = await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .jpeg({ quality: 95 })
    .toBuffer();
  const { jpeg: after } = await renderSoftLight(inputPath, cfg);

  const half = Math.floor(maxWidth / 2);
  const [a, b] = await Promise.all(
    [before, after].map((buf) =>
      sharp(buf)
        .resize({ width: half, withoutEnlargement: true })
        .raw()
        .toBuffer({ resolveWithObject: true }),
    ),
  );
  const h = Math.max(a.info.height, b.info.height);
  const w = a.info.width + b.info.width + 4;

  return sharp({ create: { width: w, height: h, channels: 3, background: '#ffffff' } })
    .composite([
      { input: a.data, raw: a.info, left: 0, top: 0 },
      { input: b.data, raw: b.info, left: a.info.width + 4, top: 0 },
    ])
    .jpeg({ quality: 92 })
    .toBuffer();
}

/* ═══════════════════════ đo đạc ═══════════════════════ */

/**
 * Các chỉ số dùng để kiểm chứng hiệu ứng bằng số thay vì bằng mắt.
 *
 * Điểm mấu chốt: tương phản phải đo ở HAI dải tần riêng, vì soft focus và
 * clarity tác động vào hai dải khác nhau. Gộp lại một con số sẽ che mất việc
 * tầng soft focus có hoạt động hay không.
 *
 *  - mean      : độ sáng trung bình (lift phải nâng lên)
 *  - fine      : tương phản dải tần cao, sigma 2px — chính là "độ nét"
 *  - mid       : tương phản dải tần trung, sigma 25px — chính là "clarity"
 *  - global    : tương phản tổng thể
 *  - warmth    : trung bình kênh đỏ trừ kênh lam
 */
export async function measureRaw(buf, raw) {
  const n = raw.width * raw.height;
  const gray = Buffer.alloc(n);
  let sr = 0;
  let sb = 0;
  for (let i = 0, k = 0; i < n; i++, k += 3) {
    sr += buf[k];
    sb += buf[k + 2];
    gray[i] = (buf[k] * 77 + buf[k + 1] * 150 + buf[k + 2] * 29) >> 8;
  }

  const g1 = { raw: { width: raw.width, height: raw.height, channels: 1 } };
  const stats = await sharp(gray, g1).stats();

  const band = async (sigma) => {
    // toColourspace('b-w') là bắt buộc: nếu thiếu, sharp nở ảnh xám 1 kênh
    // thành 3 kênh khi xuất raw, và phép trừ dưới đây sẽ đọc lệch kênh.
    const soft = await sharp(gray, g1).blur(sigma).toColourspace('b-w').raw().toBuffer();
    if (soft.length !== n) throw new Error(`Lớp mờ có ${soft.length / n} kênh, cần đúng 1.`);
    let sq = 0;
    for (let i = 0; i < n; i++) sq += (gray[i] - soft[i]) ** 2;
    return Math.sqrt(sq / n);
  };

  return {
    mean: stats.channels[0].mean,
    global: stats.channels[0].stdev,
    fine: await band(2),
    mid: await band(25),
    warmth: (sr - sb) / n,
  };
}

/* ═══════════════════ thước đo độ hài hoà ═══════════════════ */

/**
 * Ngưỡng đánh giá. Khác với các chỉ số ở trên — vốn chỉ mô tả ảnh đổi thế nào —
 * nhóm này chấm ảnh ĐẦU RA có nằm trong khoảng chấp nhận được của một tấm chân
 * dung hay không, nên mỗi ngưỡng đi kèm luôn cách sửa.
 */
export const HARMONY = {
  crushedPct: { max: 1.0, fix: 'tăng tone.lift hoặc giảm tone.contrast' },
  blownPct: { max: 0.8, fix: 'hạ bloom.brightness, bloom.amount hoặc bloom.highlightCutoff' },
  warmth: { min: 10, max: 35, cold: 5, hot: 45 },
  skinTint: { min: -10, max: 5, green: 8, magenta: -15 },
};

/**
 * Đo trên ảnh ĐẦU RA, không so với ảnh gốc:
 *
 *  - crushedPct : % điểm ảnh tối hơn 4/255 — vùng đen bị dồn cục, mất chi tiết.
 *  - blownPct   : % điểm ảnh sáng hơn 251/255 — vùng sáng bị cháy.
 *  - skinMean / bgMean : độ sáng trung bình của vùng da so với phần còn lại.
 *    Da phải sáng bằng hoặc hơn phông, nếu không thì mắt người xem bị phông
 *    hút mất khỏi khuôn mặt.
 *  - warmth     : trung bình (đỏ − lam) trên toàn ảnh.
 *  - skinTint   : trung bình (lục − trung bình đỏ/lam) CHỈ trên vùng da. Dương
 *    là ám lục, âm là ám tím. Đo riêng trên da vì phông xanh hay backdrop màu
 *    sẽ kéo lệch hẳn con số nếu tính cả khung.
 */
export function harmony(buf, raw) {
  const n = raw.width * raw.height;
  let crushed = 0;
  let blown = 0;
  let sumRB = 0;
  let skinY = 0;
  let skinN = 0;
  let bgY = 0;
  let tint = 0;

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const r = buf[k];
    const g = buf[k + 1];
    const b = buf[k + 2];
    const y = (r * 77 + g * 150 + b * 29) >> 8;
    if (y < 4) crushed++;
    else if (y > 251) blown++;
    sumRB += r - b;
    if (isSkin(r, g, b)) {
      skinY += y;
      skinN++;
      tint += g - (r + b) / 2;
    } else {
      bgY += y;
    }
  }

  const bgN = n - skinN;
  return {
    crushedPct: (crushed / n) * 100,
    blownPct: (blown / n) * 100,
    skinMean: skinN ? skinY / skinN : 0,
    bgMean: bgN ? bgY / bgN : 0,
    skinShare: (skinN / n) * 100,
    warmth: sumRB / n,
    skinTint: skinN ? tint / skinN : 0,
  };
}

/**
 * Chấm từng chỉ số: `{ ok, note }`. Dùng chung một chỗ để bảng trong tuner và
 * bảng của --selftest không bao giờ nói hai điều khác nhau.
 */
export function harmonyVerdicts(m) {
  const H = HARMONY;
  const out = {};

  out.crushed = m.crushedPct <= H.crushedPct.max
    ? { ok: true, note: 'giữ được chi tiết vùng tối' }
    : { ok: false, note: 'bết đen — ' + H.crushedPct.fix };

  out.blown = m.blownPct <= H.blownPct.max
    ? { ok: true, note: 'vùng sáng còn mượt' }
    : { ok: false, note: 'cháy sáng — ' + H.blownPct.fix };

  if (m.skinShare < 0.5) {
    out.subject = { ok: true, note: 'ảnh gần như không có vùng da để so' };
  } else if (m.skinMean >= m.bgMean) {
    out.subject = { ok: true, note: 'chủ thể sáng hơn phông, mắt bị hút vào mặt' };
  } else {
    out.subject = { ok: false, note: 'phông đang sáng hơn da — hạ sáng phông hoặc tăng bloom.amount' };
  }

  if (m.warmth < H.warmth.cold) out.warmth = { ok: false, note: 'lạnh / nhợt — tăng warm.temp' };
  else if (m.warmth > H.warmth.hot) out.warmth = { ok: false, note: 'quá đỏ, da ngả gạch nung — hạ warm.temp' };
  else if (m.warmth < H.warmth.min || m.warmth > H.warmth.max) {
    out.warmth = { ok: true, note: 'chấp nhận được, khoảng đẹp cho chân dung là 10…35' };
  } else out.warmth = { ok: true, note: 'đúng khoảng ấm của da chân dung' };

  if (m.skinShare < 0.5) out.tint = { ok: true, note: 'không đủ vùng da để đo' };
  else if (m.skinTint > H.skinTint.green) out.tint = { ok: false, note: 'da ám lục — giảm warm.tint' };
  else if (m.skinTint < H.skinTint.magenta) out.tint = { ok: false, note: 'da ám tím — tăng warm.tint' };
  else if (m.skinTint > H.skinTint.max || m.skinTint < H.skinTint.min) {
    out.tint = { ok: true, note: 'hơi lệch nhưng còn trong ngưỡng' };
  } else out.tint = { ok: true, note: 'màu da tinh khiết' };

  return out;
}

/** Đo độ hài hoà thẳng trên một buffer đã mã hoá. */
export async function harmonyOf(encoded) {
  const { data, info } = await sharp(encoded)
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return harmony(data, { width: info.width, height: info.height, channels: info.channels });
}

export async function measure(encoded) {
  const { data, info } = await sharp(encoded)
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return measureRaw(data, { width: info.width, height: info.height, channels: info.channels });
}
