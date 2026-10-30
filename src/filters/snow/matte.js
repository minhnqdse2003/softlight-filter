import { existsSync } from 'node:fs';
import { join } from 'node:path';
import sharp from 'sharp';
import { ROOT } from '../../config.js';

/**
 * TÁCH NGƯỜI — matte cho bộ lọc Tuyết: hạt phía sau người bị che đúng theo
 * dáng người trong từng ảnh, thay cho elip đặt tay.
 *
 * Model: MODNet (tách chân dung, giấy phép Apache-2.0), bản ONNX fp32 của
 * Xenova/modnet, đặt ở models/modnet.onnx cạnh snow.exe. Chọn fp32 trên CPU
 * sau khi đo trên ảnh booth 3000×2000 (Ryzen 5 5600H):
 *   - fp32 CPU      : tạo session ~160ms, chạy ~310ms;
 *   - bản lượng tử  : chạy ~600ms — CPU không có lệnh int8 chuyên dụng nên chậm hơn;
 *   - DirectML (GPU tích hợp): lần chạy đầu ~2s để biên dịch shader, mà exe là
 *     tiến trình mới mỗi tấm nên lần nào cũng là lần đầu.
 *
 * Model chạy ở cạnh ngắn 512px (đúng cỡ MODNet được huấn luyện, làm tròn về bội
 * số của 32). Matte trả về ở đúng cỡ đó; snow.js nội suy lên cỡ ảnh khi dùng —
 * với hạt tuyết nhỏ và mờ, độ phân giải này thừa đủ.
 */
export const MODEL_PATH = join(ROOT, 'models', 'modnet.onnx');
const SHORT_EDGE = 512;

let sessionPromise = null;

/**
 * Mở session (một lần mỗi tiến trình). Gọi SỚM — trước khi giải mã ảnh — để
 * việc nạp model chạy song song với libvips. Ném lỗi có lời giải thích nếu thiếu
 * model hoặc thiếu onnxruntime-node; lớp gọi bắt lỗi và rơi về elip.
 */
export function openSession() {
  if (!sessionPromise) {
    sessionPromise = (async () => {
      if (!existsSync(MODEL_PATH)) throw new Error('thiếu models/modnet.onnx');
      let ort;
      try {
        ort = (await import('onnxruntime-node')).default;
      } catch (err) {
        throw new Error(`không nạp được onnxruntime-node (${err.message.split('\n')[0]}) — chạy: npm install`);
      }
      const session = await ort.InferenceSession.create(MODEL_PATH, {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      return { ort, session };
    })();
    // Lỗi vẫn được ném ra ở chỗ await; chỉ chặn cảnh báo "unhandled rejection"
    // khi lớp gọi mở session sớm rồi chưa kịp chờ.
    sessionPromise.catch(() => {});
  }
  return sessionPromise;
}

/**
 * Matte người cho một ảnh RGB 8-bit (3 kênh). Trả về
 * `{ data: Uint8Array (0…255, 255 = người), width, height, ms }` ở cỡ model.
 */
export async function personMatte(rgb, width, height) {
  const t0 = Date.now();
  const { ort, session } = await openSession();
  const s = SHORT_EDGE / Math.min(width, height);
  const W = Math.max(32, Math.floor((width * s) / 32) * 32);
  const H = Math.max(32, Math.floor((height * s) / 32) * 32);

  const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(W, H, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Chuẩn hoá về [-1, 1], xếp theo kênh (CHW) — đúng tiền xử lý của MODNet.
  const n = W * H, input = new Float32Array(3 * n);
  for (let i = 0, p = 0; i < n; i++, p += 3) {
    input[i] = small[p] / 127.5 - 1;
    input[n + i] = small[p + 1] / 127.5 - 1;
    input[2 * n + i] = small[p + 2] / 127.5 - 1;
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, 3, H, W]) });
  const a = out[session.outputNames[0]].data;

  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const v = a[i] * 255;
    data[i] = v <= 0 ? 0 : v >= 255 ? 255 : v + 0.5;
  }
  return { data, width: W, height: H, ms: Date.now() - t0 };
}

/** Ghi matte ra PNG xám — trang chỉnh nạp file này để xem trước đúng dáng người. */
export function mattePng(matte) {
  return sharp(Buffer.from(matte.data.buffer, matte.data.byteOffset, matte.data.length), {
    raw: { width: matte.width, height: matte.height, channels: 1 },
  })
    .png()
    .toBuffer();
}
