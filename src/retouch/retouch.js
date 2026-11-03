import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectFaces } from './khuon-mat.js';
import { smoothFaces } from './lam-min.js';
import { nhatMun } from './nhat-mun.js';
import { MODEL_DIR, MODEL_FILES, openXoaMun, xoaMun } from './xoa-mun.js';

/**
 * RETOUCH DA — nhặt mụn rồi làm mịn da trên mọi khuôn mặt, chạy TRƯỚC tuyết và
 * màu (xem src/filters/snow/pipeline.js). Cùng thuật toán máy phòng 1510 dùng
 * thay Retouch của Capture One.
 *
 * `cfg` = mục `retouch` của snow.config.json (đã chuẩn hoá ở snow.js):
 *   enabled        bật / tắt cả bước
 *   blemish        nhặt mụn
 *   blemishMethod  'capture-one' = model Remove Blemishes của Capture One
 *                  (models/mun, chọn CPU / GPU nhanh hơn); thiếu model hay nạp
 *                  hỏng thì tự lùi về 'builtin'
 *                  'builtin'     = bộ nhặt mụn tự viết (nhat-mun.js), ~0,5 giây
 *   blemishAmount  0–100, như thanh Remove Blemishes (chỉ cách 'capture-one')
 *   smooth         độ mịn 0–100: 0 = không làm mịn; Nhẹ 30, Vừa 60, Mạnh 90
 *
 * `rgb`: Buffer RGB 8 bit, SỬA TẠI CHỖ. Không có mặt nào thì không đụng gì.
 * Trả về `{ faces, blemish, method, smoothed, warn }` cho log.
 */
export async function retouch(rgb, width, height, cfg) {
  const out = { faces: 0, blemish: 0, method: null, smoothed: 0, warn: null };
  if (!cfg || !cfg.enabled || (!cfg.blemish && cfg.smooth <= 0)) return out;

  const faces = await detectFaces(rgb, width, height);
  out.faces = faces.length;
  if (!faces.length) return out;

  // Nhặt mụn TRƯỚC: làm mịn sau đó còn làm đều chỗ vừa chữa với da quanh nó.
  if (cfg.blemish) {
    let method = cfg.blemishMethod;
    if (method === 'capture-one') {
      try {
        await openXoaMun();
      } catch (err) {
        out.warn = `không dùng được model xoá mụn Capture One (${err.message}) — dùng bộ nhặt mụn tự viết`;
        method = 'builtin';
      }
    }
    out.method = method;
    out.blemish = method === 'capture-one'
      ? await xoaMun(rgb, width, height, faces, { amount: cfg.blemishAmount })
      : await nhatMun(rgb, width, height, faces);
  }
  if (cfg.smooth > 0) out.smoothed = await smoothFaces(rgb, width, height, faces, cfg.smooth);
  return out;
}

/** Dòng kiểm tra cho `--doctor`: tìm mặt + model xoá mụn (lần đầu đo luôn CPU / GPU). */
export async function retouchDoctor() {
  const rows = [];
  try {
    const t0 = Date.now();
    await detectFaces(Buffer.alloc(640 * 480 * 3, 128), 640, 480);
    rows.push([true, 'Tìm mặt (YuNet)', `chạy được, ${Date.now() - t0} ms kể cả nạp model`]);
  } catch (err) {
    rows.push([false, 'Tìm mặt (YuNet)', `LỖI: ${err.message} — retouch sẽ bỏ qua, ảnh vẫn ra`]);
    return rows;
  }
  const missing = Object.values(MODEL_FILES).filter((f) => !existsSync(join(MODEL_DIR, f)));
  if (missing.length) {
    rows.push([false, 'Xoá mụn Capture One', `THIẾU ${missing.join(', ')} trong models/mun — nhặt mụn dùng bộ tự viết`]);
    return rows;
  }
  try {
    const t0 = Date.now();
    const e = await openXoaMun();
    rows.push([true, 'Xoá mụn Capture One', `${e.may.ghiChu}; một ô ${e.msO} ms (nạp + đo ${Date.now() - t0} ms)`]);
  } catch (err) {
    rows.push([false, 'Xoá mụn Capture One', `LỖI: ${err.message} — nhặt mụn dùng bộ tự viết`]);
  }
  return rows;
}
