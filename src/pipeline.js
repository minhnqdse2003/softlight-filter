import sharp from 'sharp';
import { hexToRgb } from './config.js';

/**
 * HIỆU ỨNG SOFT LIGHT
 * ===================
 * Năm tầng, chạy theo đúng thứ tự này:
 *
 *   1. Soft focus    — pha một lớp mờ BÁN KÍNH NHỎ vào ảnh. Đây là tầng làm
 *                      giảm độ nét thật sự: da mịn, lỗ chân lông và sợi tóc
 *                      mềm đi. Không có tầng này thì ảnh chỉ bị "nhạt" chứ
 *                      không "mềm".
 *   2. Giảm clarity  — lớp mờ BÁN KÍNH LỚN. Hạ tương phản ở dải tần trung:
 *                      ảnh bớt gắt, bớt "đục", nhưng bố cục vẫn nguyên.
 *   3. Soft glow     — lớp mờ thứ ba được CẮT NGƯỠNG chỉ giữ vùng sáng, rồi
 *                      screen lên ảnh. Vì ngưỡng đọc từ chính ảnh nên quầng
 *                      sáng nở ra đúng chỗ bắt sáng của từng khuôn mặt — đây
 *                      là thứ tạo cảm giác "bong bóng", và cũng chính là thứ
 *                      một overlay PNG tĩnh không bao giờ làm được.
 *   4. Giảm contrast — biến đổi affine quanh điểm giữa, cộng lift nâng vùng
 *                      đen. Cho cảm giác bạc màu, ethereal.
 *   5. Tăng tông ấm  — gain lệch giữa các kênh, cộng một lớp soft-light màu ấm
 *                      phủ lên vùng sáng.
 *
 * Ba tầng mờ dùng ba bán kính khác hẳn nhau, và đó là chủ ý: mỗi tầng ăn vào
 * một dải tần số khác nhau. Gộp chúng làm một sẽ mất đúng đặc trưng soft focus.
 *
 * Toàn bộ chạy trong libvips. Các lớp mờ được tính ở độ phân giải rút gọn rồi
 * phóng lại: sigma của tầng clarity cỡ 100+ pixel trên ảnh 24MP, làm mờ thẳng ở
 * full res sẽ chậm gấp bội mà kết quả không khác — lớp mờ vốn chỉ chứa tần số
 * thấp, thông tin đó sống sót qua phép rút gọn.
 */

/** Sigma mục tiêu sau khi rút gọn. Giữ quanh mức này để blur luôn rẻ. */
const TARGET_SIGMA = 12;

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

/**
 * Dựng một lớp mờ đã gắn sẵn alpha, sẵn sàng để composite.
 * `threshold` > 0 sẽ cắt bỏ vùng tối trước khi phóng lại, để lớp này chỉ còn
 * mang vùng sáng — nền tảng của quầng glow.
 */
async function blurLayer(buf, raw, sigmaPx, { alpha, threshold = 0 }) {
  const d = clamp(Math.round(sigmaPx / TARGET_SIGMA), 1, 24);
  const sw = Math.max(2, Math.round(raw.width / d));
  const sh = Math.max(2, Math.round(raw.height / d));

  let p = sharp(buf, { raw });
  if (d > 1) p = p.resize(sw, sh, { kernel: 'cubic', fit: 'fill' });
  p = p.blur(Math.max(0.3, sigmaPx / d));

  if (threshold > 0) {
    // Kéo giãn tuyến tính sao cho mức `threshold` về 0 và mức 1 giữ nguyên 1.
    // Giá trị dưới ngưỡng thành âm và bị kẹp về 0 khi ép lại 8-bit — chính là
    // phép cắt ngưỡng mềm ta cần, làm bằng một phép tính duy nhất.
    const a = 1 / (1 - threshold);
    p = p.linear(a, -255 * threshold * a);
  }

  if (d > 1) p = p.resize(raw.width, raw.height, { kernel: 'cubic', fit: 'fill' });
  return p.ensureAlpha(alpha).raw().toBuffer();
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

  // ── 1–3. Ba lớp mờ, ghép trong MỘT lượt ───────────────────────────
  // Cả ba lớp đều dựng từ ảnh gốc chứ không nối tiếp nhau. Về lý thuyết khác
  // với việc chạy tuần tự, nhưng mỗi lớp đều là ảnh đã làm mờ mạnh, mà phép
  // làm mờ thì xoá sạch đúng những tần số mà tầng trước vừa đổi — nên sai lệch
  // nằm dưới ngưỡng nhận biết, đổi lại tiết kiệm được vài lượt quét toàn ảnh
  // trên buffer 72MB. --selftest xác nhận các chỉ số gần như không đổi.
  const layers = [];
  if (cfg.softFocus.amount > 0.001) {
    layers.push({
      name: 'soft focus',
      blend: 'over',
      buf: await blurLayer(cur, raw, (cfg.softFocus.radiusPct / 100) * longEdge, {
        alpha: cfg.softFocus.amount,
      }),
    });
  }
  if (cfg.clarity.amount > 0.001) {
    layers.push({
      name: 'clarity',
      blend: 'over',
      buf: await blurLayer(cur, raw, (cfg.clarity.radiusPct / 100) * longEdge, {
        alpha: cfg.clarity.amount,
      }),
    });
  }
  if (cfg.glow.amount > 0.001) {
    layers.push({
      name: 'glow',
      blend: 'screen',
      buf: await blurLayer(cur, raw, (cfg.glow.radiusPct / 100) * longEdge, {
        alpha: cfg.glow.amount,
        threshold: cfg.glow.threshold,
      }),
    });
  }

  if (layers.length) {
    if (trace) {
      // Chế độ đo: ghép từng lớp một để thấy diễn biến, chấp nhận chậm hơn.
      for (const l of layers) {
        cur = await compose(cur, raw, l.buf, l.blend);
        await mark(l.name);
      }
    } else {
      cur = await sharp(cur, { raw })
        .composite(layers.map((l) => ({ input: l.buf, raw: { ...raw, channels: 4 }, blend: l.blend })))
        .removeAlpha()
        .raw()
        .toBuffer();
    }
  }

  // ── 4 + 5. Contrast, lift và tông ấm, gộp thành một phép affine ───
  const gain = 1 + cfg.tone.contrast;
  // Neo điểm giữa 0.5 khi đổi contrast, rồi cộng lift nâng vùng đen.
  const offset = 255 * (0.5 * (1 - gain) + cfg.tone.lift);
  const t = cfg.warm.temp;
  const ti = cfg.warm.tint;
  cur = await sharp(cur, { raw })
    .linear(
      [gain * (1 + t * 0.5), gain * (1 + ti * 0.5), gain * (1 - t * 0.5)],
      [offset, offset, offset],
    )
    .raw()
    .toBuffer();
  await mark('tone + ấm');

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

export async function measure(encoded) {
  const { data, info } = await sharp(encoded)
    .toColourspace('srgb')
    .raw()
    .toBuffer({ resolveWithObject: true });
  return measureRaw(data, { width: info.width, height: info.height, channels: info.channels });
}
