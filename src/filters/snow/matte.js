import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../../config.js';

/**
 * TÁCH NGƯỜI — matte cho bộ lọc Tuyết: hạt phía sau người bị che đúng theo
 * dáng người trong từng ảnh, thay cho elip đặt tay.
 *
 * Hai model, chọn bằng cfg.subject.model; cả hai đều đi qua solidify() bên dưới.
 * Đo trên ảnh booth 3000×2000, CPU Ryzen 5 5600H, mỗi tấm là một tiến trình mới:
 *
 *   modnet   — MODNet (Apache-2.0), tách chân dung kiểu matting, cạnh ngắn 512.
 *              Tạo session ~160ms + chạy ~310ms. Viền tóc đẹp, nhưng lõi hay có
 *              lỗ / mảng bán trong suốt — solidify() sửa phần đó. MẶC ĐỊNH.
 *   birefnet — BiRefNet lite 512×512 (MIT). Dáng người đặc và sạch hơn, bắt cả
 *              đồ cầm tay, nhưng tạo session ~2.3s + chạy ~2.5s: gần 5s mỗi tấm.
 *              Chỉ dùng khi booth chấp nhận chờ lâu.
 *
 * Đã thử và loại: bản lượng tử của MODNet (CPU không có lệnh int8 chuyên dụng
 * nên CHẬM gấp đôi); DirectML trên GPU tích hợp (lần chạy đầu ~2s với MODNet,
 * ~7.6s với BiRefNet để biên dịch shader — mà mỗi tấm là một tiến trình mới);
 * BiRefNet lite 1024 (~23s mỗi tấm).
 */
export const MATTE_MODELS = {
  modnet: { file: 'modnet.onnx', size: 'short', mean: [0.5, 0.5, 0.5], std: [0.5, 0.5, 0.5], logits: false },
  birefnet: { file: 'birefnet-lite-512.onnx', size: 'square', mean: [0.485, 0.456, 0.406], std: [0.229, 0.224, 0.225], logits: true },
};
export const modelPath = (id) => join(ROOT, 'models', (MATTE_MODELS[id] || MATTE_MODELS.modnet).file);
const EDGE = 512;

const sessions = {};

/**
 * Mở session của một model (một lần mỗi tiến trình). Gọi SỚM — trước khi giải
 * mã ảnh — để việc nạp model chạy song song với libvips. Ném lỗi có lời giải
 * thích nếu thiếu model hoặc thiếu onnxruntime-node; lớp gọi bắt lỗi.
 */
export function openSession(id = 'modnet') {
  const key = MATTE_MODELS[id] ? id : 'modnet';
  if (!sessions[key]) {
    sessions[key] = (async () => {
      const path = modelPath(key);
      if (!existsSync(path)) throw new Error(`thiếu models/${MATTE_MODELS[key].file}`);
      let ort;
      try {
        ort = (await import('onnxruntime-node')).default;
      } catch (err) {
        throw new Error(`không nạp được onnxruntime-node (${err.message.split('\n')[0]}) — chạy: npm install`);
      }
      const session = await ort.InferenceSession.create(path, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      return { ort, session };
    })();
    // Lỗi vẫn được ném ra ở chỗ await; chỉ chặn cảnh báo "unhandled rejection"
    // khi lớp gọi mở session sớm rồi chưa kịp chờ.
    sessions[key].catch(() => {});
  }
  return sessions[key];
}

/**
 * Matte người cho một ảnh RGB 8-bit (3 kênh), đã làm đặc. Trả về
 * `{ data: Uint8Array (0…255, 255 = người), width, height, ms, model }`, cạnh
 * ngắn 512 và đúng tỉ lệ ảnh (model vuông thì kéo lại về đúng tỉ lệ).
 */
export async function personMatte(rgb, width, height, id = 'modnet') {
  const t0 = Date.now();
  const key = MATTE_MODELS[id] ? id : 'modnet', M = MATTE_MODELS[key];
  const { ort, session } = await openSession(key);
  const s = EDGE / Math.min(width, height);
  const W = M.size === 'square' ? EDGE : Math.max(32, Math.floor((width * s) / 32) * 32);
  const H = M.size === 'square' ? EDGE : Math.max(32, Math.floor((height * s) / 32) * 32);

  const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Chuẩn hoá theo đúng tiền xử lý của từng model, xếp theo kênh (CHW).
  const n = W * H, input = new Float32Array(3 * n);
  for (let c = 0; c < 3; c++) {
    const k = 1 / (255 * M.std[c]), b = M.mean[c] / M.std[c];
    for (let i = 0, p = c; i < n; i++, p += 3) input[c * n + i] = small[p] * k - b;
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) });
  const a = out[session.outputNames[session.outputNames.length - 1]].data;

  let data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = (M.logits ? 1 / (1 + Math.exp(-a[i])) : a[i]) * 255;
    data[i] = v <= 0 ? 0 : v >= 255 ? 255 : v + 0.5;
  }
  let mw = W, mh = H;
  if (M.size === 'square') {
    mh = EDGE; mw = Math.round((EDGE * width) / height);
    if (width < height) { mw = EDGE; mh = Math.round((EDGE * height) / width); }
    data = new Uint8Array(await sharp(Buffer.from(data.buffer), { raw: { width: W, height: H, channels: 1 } })
      .resize(mw, mh, { fit: 'fill' }).raw().toBuffer());
  }
  return { ...solidify({ data, width: mw, height: mh }), ms: Date.now() - t0, model: key };
}

/**
 * Làm đặc matte, sửa tại chỗ. MODNet là model tách CHÂN DUNG kiểu matting: viền
 * tóc đẹp, nhưng bên trong dáng người hay có lỗ (khe giữa tay và mặt) và mảng
 * bán trong suốt (chỗ hai người đứng sát nhau). Với bộ lọc tuyết, đó chính là
 * chỗ hạt phía sau lọt mờ mờ qua người. Ba bước:
 *   1. loang từ mép ảnh qua các ô "nền" (alpha < 128) — đó là nền thật;
 *   2. ô nền KHÔNG nối được ra mép là lỗ kín: lỗ nhỏ (dưới 1.5% khung) thì lấp —
 *      lỗ to giữ nguyên, vì đó thường là khoảng phông thật giữa tay và người;
 *   3. lõi (vùng người co vào 3 ô) đặt đặc hẳn; viền giữ alpha mềm như cũ.
 */
export function solidify(m) {
  const { data, width: w, height: h } = m, n = w * h;
  const bg = new Uint8Array(n), queue = new Int32Array(n);
  let qh = 0, qt = 0;
  const seed = (i) => { if (!bg[i] && data[i] < 128) { bg[i] = 1; queue[qt++] = i; } };
  for (let x = 0; x < w; x++) { seed(x); seed((h - 1) * w + x); }
  for (let y = 0; y < h; y++) { seed(y * w); seed(y * w + w - 1); }
  while (qh < qt) {
    const i = queue[qh++], x = i % w;
    if (x > 0) seed(i - 1);
    if (x < w - 1) seed(i + 1);
    if (i >= w) seed(i - w);
    if (i < n - w) seed(i + w);
  }

  // Lỗ kín: gom từng mảng, lấp mảng nhỏ.
  const seen = new Uint8Array(n), maxHole = 0.015 * n;
  for (let s = 0; s < n; s++) {
    if (bg[s] || seen[s] || data[s] >= 128) continue;
    qh = 0; qt = 0; queue[qt++] = s; seen[s] = 1;
    while (qh < qt) {
      const i = queue[qh++], x = i % w;
      const nb = [x > 0 ? i - 1 : -1, x < w - 1 ? i + 1 : -1, i >= w ? i - w : -1, i < n - w ? i + w : -1];
      for (const j of nb) if (j >= 0 && !seen[j] && !bg[j] && data[j] < 128) { seen[j] = 1; queue[qt++] = j; }
    }
    if (qt <= maxHole) for (let k = 0; k < qt; k++) data[queue[k]] = 255;
    else for (let k = 0; k < qt; k++) bg[queue[k]] = 1;   // lỗ to: coi như nền
  }

  // Lõi: co vùng người vào R ô (min tách trục), đặt đặc.
  const R = 3, inside = new Uint8Array(n), tmp = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = bg[i] ? 0 : 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let d = -R; d <= R && v; d++) { const xx = x + d; if (xx < 0 || xx >= w || !inside[y * w + xx]) v = 0; }
      tmp[y * w + x] = v;
    }
  }
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let v = 1;
      for (let d = -R; d <= R && v; d++) { const yy = y + d; if (yy < 0 || yy >= h || !tmp[yy * w + x]) v = 0; }
      if (v) data[y * w + x] = 255;
    }
  }
  return m;
}

/** Ghi matte ra PNG xám — trang chỉnh nạp file này để xem trước đúng dáng người. */
export function mattePng(matte) {
  return sharp(Buffer.from(matte.data.buffer, matte.data.byteOffset, matte.data.length), {
    raw: { width: matte.width, height: matte.height, channels: 1 },
  })
    .png()
    .toBuffer();
}
