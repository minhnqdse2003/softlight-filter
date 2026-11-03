import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * TÌM KHUÔN MẶT cho bước nhặt mụn + làm mịn da — YuNet (OpenCV Zoo, giấy phép
 * MIT), file face_detection_yunet_2023mar.onnx nằm ngay cạnh file này (227 KB).
 *
 * Chép từ máy phòng 1510 (selfbooth, apps/room-booth/server/src/lam-min). Ở đó
 * chạy bằng onnxruntime-web vì bản node đòi macOS 14; bộ lọc này đã dùng
 * onnxruntime-node cho tách người nên dùng luôn bản node — cùng kết quả.
 *
 * Model nhận ĐÚNG 640×640 (đầu vào cố định): ảnh thu cạnh dài về 640, đệm 0 phần
 * còn lại. Ảnh 26MP (6240×4160) thì mặt nhóm 6 người còn ~70 px ở đó — YuNet
 * bắt tốt từ ~20 px.
 */

const MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), 'face_detection_yunet_2023mar.onnx');
const SIZE = 640;
const STRIDES = [8, 16, 32];

let engine = null;

/** Nạp model một lần cho cả tiến trình. Hỏng thì lần sau thử lại. */
export function openDetector() {
  if (!engine) {
    engine = (async () => {
      const ort = (await import('onnxruntime-node')).default;
      const session = await ort.InferenceSession.create(fs.readFileSync(MODEL), {
        executionProviders: ['cpu'],
        graphOptimizationLevel: 'all',
      });
      return { ort, session };
    })();
    engine.catch(() => {
      engine = null;
    });
  }
  return engine;
}

/**
 * Tìm mặt trên ảnh RGB 8 bit (Buffer, 3 kênh). Trả về
 * `[{ x, y, w, h, score, lm }]` theo toạ độ ảnh gốc, `lm` là 5 điểm mốc:
 * hai mắt, chóp mũi, hai khoé miệng.
 */
export async function detectFaces(rgb, width, height, { scoreMin = 0.6, nmsIou = 0.3 } = {}) {
  const { ort, session } = await openDetector();
  const s = SIZE / Math.max(width, height);
  const w = Math.round(width * s);
  const h = Math.round(height * s);
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .resize(w, h, { fit: 'fill' })
    .raw()
    .toBuffer();

  // Như blobFromImage của OpenCV: thứ tự BGR, giá trị 0–255, không chuẩn hoá.
  const plane = SIZE * SIZE;
  const input = new Float32Array(3 * plane);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 3;
      const o = y * SIZE + x;
      input[o] = small[i + 2];
      input[plane + o] = small[i + 1];
      input[2 * plane + o] = small[i];
    }
  }
  const out = await session.run({ input: new ort.Tensor('float32', input, [1, 3, SIZE, SIZE]) });

  // Giải mã như FaceDetectorYN (opencv/modules/objdetect/src/face_detect.cpp).
  const found = [];
  const clamp01 = (v) => Math.min(1, Math.max(0, v));
  for (const st of STRIDES) {
    const cols = SIZE / st;
    const cls = out[`cls_${st}`].data;
    const obj = out[`obj_${st}`].data;
    const box = out[`bbox_${st}`].data;
    const kps = out[`kps_${st}`].data;
    for (let i = 0; i < cls.length; i++) {
      const score = Math.sqrt(clamp01(cls[i]) * clamp01(obj[i]));
      if (score < scoreMin) continue;
      const r = Math.floor(i / cols);
      const c = i % cols;
      const cx = (c + box[i * 4]) * st;
      const cy = (r + box[i * 4 + 1]) * st;
      const bw = Math.exp(box[i * 4 + 2]) * st;
      const bh = Math.exp(box[i * 4 + 3]) * st;
      const lm = [];
      for (let k = 0; k < 5; k++) {
        lm.push([((kps[i * 10 + 2 * k] + c) * st) / s, ((kps[i * 10 + 2 * k + 1] + r) * st) / s]);
      }
      found.push({ x: (cx - bw / 2) / s, y: (cy - bh / 2) / s, w: bw / s, h: bh / s, score, lm });
    }
  }
  found.sort((a, b) => b.score - a.score);
  const keep = [];
  for (const f of found) if (keep.every((k) => iou(k, f) < nmsIou)) keep.push(f);
  return keep;
}

function iou(a, b) {
  const x1 = Math.max(a.x, b.x);
  const y1 = Math.max(a.y, b.y);
  const x2 = Math.min(a.x + a.w, b.x + b.w);
  const y2 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x2 - x1) * Math.max(0, y2 - y1);
  return inter / (a.w * a.h + b.w * b.h - inter);
}
