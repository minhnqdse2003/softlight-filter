import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { detectFaces } from './khuon-mat.js';
import { smoothFaces } from './lam-min.js';
import { coLuoiMat, openLuoiMat } from './luoi-mat.js';
import { toSangToi } from './to-sang-toi.js';
import { nhatMun } from './nhat-mun.js';
import { MODEL_DIR, MODEL_FILES, openMatNa, openXoaMun, xoaMun } from './xoa-mun.js';

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
 *                  = Retouch v1
 *                  'c1-mask'     = Retouch v2: cùng khung xử lý Capture One (thu mặt
 *                  về 450, bản đồ sửa, trộn theo mặt nạ da skinMasking của Capture
 *                  One, thanh Mức) nhưng phần CHỮA là bộ nhặt mụn tự viết — không
 *                  cần DnCNN; thiếu skinMasking thì lùi về 'builtin'
 *                  'builtin'     = bộ nhặt mụn tự viết (nhat-mun.js), ~0,5 giây
 *   blemishAmount  0–100, như thanh Remove Blemishes ('capture-one', 'c1-mask')
 *   smooth         độ mịn 0–100: 0 = không làm mịn; Nhẹ 30, Vừa 60, Mạnh 90
 *   dodgeBurn      tô sáng / tối 0–100 (to-sang-toi.js): 0 = tắt
 *   contour        tạo khối, chạy theo cùng mức dodgeBurn
 *
 * `rgb`: Buffer RGB 8 bit, SỬA TẠI CHỖ. Không có mặt nào thì không đụng gì.
 * Trả về `{ faces, blemish, method, smoothed, warn }` cho log.
 */
export async function retouch(rgb, width, height, cfg) {
  const out = { faces: 0, blemish: 0, method: null, dodgeBurn: 0, smoothed: 0, warn: null };
  if (!cfg || !cfg.enabled || (!cfg.blemish && cfg.smooth <= 0 && !(cfg.dodgeBurn > 0))) return out;

  const faces = await detectFaces(rgb, width, height);
  out.faces = faces.length;
  out.boxes = faces; // pipeline dùng lại để chặn hạt tuyết khỏi mặt
  if (!faces.length) return out;

  // Nhặt mụn TRƯỚC: làm mịn sau đó còn làm đều chỗ vừa chữa với da quanh nó.
  if (cfg.blemish) {
    let method = cfg.blemishMethod;
    if (method === 'capture-one' || method === 'c1-mask') {
      try {
        await (method === 'c1-mask' ? openMatNa() : openXoaMun());
      } catch (err) {
        const ten = method === 'c1-mask' ? 'mặt nạ da Capture One (Retouch v2)' : 'model xoá mụn Capture One (Retouch v1)';
        out.warn = `không dùng được ${ten} (${err.message}) — dùng bộ nhặt mụn tự viết`;
        method = 'builtin';
      }
    }
    out.method = method;
    out.blemish = method === 'builtin'
      ? await nhatMun(rgb, width, height, faces)
      : await xoaMun(rgb, width, height, faces, { amount: cfg.blemishAmount, chua: method === 'c1-mask' ? 'tu-viet' : 'dncnn' });
  }
  // Tô sáng / tối sau nhặt mụn (đốm đã chữa không bị tính là vết loang), trước
  // làm mịn. Thiếu model lưới mặt thì bỏ riêng bước này, các bước khác vẫn chạy.
  if (cfg.dodgeBurn > 0) {
    try {
      out.dodgeBurn = await toSangToi(rgb, width, height, faces, { muc: cfg.dodgeBurn, contour: cfg.contour });
    } catch (err) {
      out.warn = [out.warn, `bỏ qua tô sáng / tối (${err.message})`].filter(Boolean).join('; ');
    }
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
  if (!coLuoiMat()) {
    rows.push([false, 'Lưới mặt (tô sáng / tối)', 'THIẾU models/facemesh-v2.onnx — chỉ cần khi bật dodgeBurn; chạy: npm run model -- facemesh']);
  } else {
    try {
      const t0 = Date.now();
      await openLuoiMat();
      rows.push([true, 'Lưới mặt (tô sáng / tối)', `nạp được, ${Date.now() - t0} ms`]);
    } catch (err) {
      rows.push([false, 'Lưới mặt (tô sáng / tối)', `LỖI: ${err.message} — bước tô sáng / tối bỏ qua`]);
    }
  }
  // Retouch v2 chỉ cần mặt nạ da của Capture One.
  if (!existsSync(join(MODEL_DIR, MODEL_FILES.skin))) {
    rows.push([false, 'Retouch v2 (mặt nạ da C1)', `THIẾU ${MODEL_FILES.skin} trong models/mun — Retouch v2 dùng bộ tự viết`]);
  } else {
    try {
      const t0 = Date.now();
      const e = await openMatNa();
      rows.push([true, 'Retouch v2 (mặt nạ da C1)', `nạp được (${e.may.skin}), ${Date.now() - t0} ms`]);
    } catch (err) {
      rows.push([false, 'Retouch v2 (mặt nạ da C1)', `LỖI: ${err.message} — Retouch v2 dùng bộ tự viết`]);
    }
  }
  const missing = Object.values(MODEL_FILES).filter((f) => !existsSync(join(MODEL_DIR, f)));
  if (missing.length) {
    rows.push([false, 'Retouch v1 (Capture One)', `THIẾU ${missing.join(', ')} trong models/mun — nhặt mụn dùng bộ tự viết`]);
    return rows;
  }
  try {
    const t0 = Date.now();
    const e = await openXoaMun();
    rows.push([true, 'Retouch v1 (Capture One)', `${e.may.ghiChu}; một ô ${e.msO} ms (nạp + đo ${Date.now() - t0} ms)`]);
  } catch (err) {
    rows.push([false, 'Retouch v1 (Capture One)', `LỖI: ${err.message} — nhặt mụn dùng bộ tự viết`]);
  }
  return rows;
}
