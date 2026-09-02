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
