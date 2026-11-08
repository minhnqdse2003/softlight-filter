import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * LƯỚI MẶT 478 điểm — Face Mesh V2 của Google MediaPipe (Apache-2.0), bản ONNX
 * fernandotonon/QtMeshEditor-facemesh-onnx (4,9 MB, tải bằng
 * `npm run model -- facemesh`, nằm ở models/facemesh-v2.onnx).
 *
 * Dùng cho bước tô sáng / tối (to-sang-toi.js): 5 điểm mốc của YuNet không đủ
 * để biết quầng mắt, rãnh mũi–miệng, gò má, đường hàm nằm ở đâu.
 *
 * Như MediaPipe: cắt một ô VUÔNG quanh mặt, xoay cho hai mắt nằm ngang, rộng
 * 1,5 lần khung mặt, thu về 256×256; model trả toạ độ trong ô đó, đổi ngược ra
 * ảnh gốc. Chạy hai lượt — lượt hai cắt lại theo chính lưới của lượt một, nên
 * ô cắt ôm mặt đúng như lúc model được huấn luyện (khung YuNet hơi khác khung
 * BlazeFace mà MediaPipe dùng).
 */

const MODEL = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'models', 'facemesh-v2.onnx');
const SIZE = 256;

let engine = null;

export const coLuoiMat = () => fs.existsSync(MODEL);

/** Nạp model một lần cho cả tiến trình. Hỏng thì lần sau thử lại. */
export function openLuoiMat() {
  if (!engine) {
    engine = (async () => {
      if (!fs.existsSync(MODEL)) throw new Error('thiếu models/facemesh-v2.onnx — chạy: npm run model -- facemesh');
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
 * Một lượt: ô vuông tâm (cx, cy), cạnh `side`, xoay `ang` (radian, hướng trục x
 * của ô trong ảnh). Trả `{ pts, score }` — pts là 478 điểm [x, y] ảnh gốc.
 */
async function motLuot(rgb, width, height, cx, cy, side, ang) {
  const { ort, session } = await openLuoiMat();
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  // Khung thẳng bao ô xoay, thu nhỏ bằng sharp (lọc chống răng cưa tốt) sao cho
  // cạnh ô còn ~256 px, rồi lấy mẫu song tuyến theo góc xoay ở ảnh nhỏ đó.
  const half = (side / 2) * (Math.abs(cos) + Math.abs(sin));
  const left = Math.max(0, Math.floor(cx - half));
  const top = Math.max(0, Math.floor(cy - half));
  const right = Math.min(width, Math.ceil(cx + half));
  const bottom = Math.min(height, Math.ceil(cy + half));
  if (right - left < 8 || bottom - top < 8) return null;
  const k = Math.min(1, SIZE / side);
  const sw = Math.max(1, Math.round((right - left) * k));
  const sh = Math.max(1, Math.round((bottom - top) * k));
  const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .extract({ left, top, width: right - left, height: bottom - top })
    .resize(sw, sh, { fit: 'fill', kernel: 'lanczos3' })
    .raw()
    .toBuffer();
  const kx = sw / (right - left);
  const ky = sh / (bottom - top);

  // Điểm (u, v) của ô 256 → ảnh gốc.
  const s = side / SIZE;
  const toImg = (u, v) => {
    const a = (u - SIZE / 2) * s;
    const b = (v - SIZE / 2) * s;
    return [cx + a * cos - b * sin, cy + a * sin + b * cos];
  };

  const input = new Float32Array(SIZE * SIZE * 3);
  for (let v = 0; v < SIZE; v++) {
    for (let u = 0; u < SIZE; u++) {
      const [x, y] = toImg(u + 0.5, v + 0.5);
      const fx = (x - left) * kx - 0.5;
      const fy = (y - top) * ky - 0.5;
      const o = (v * SIZE + u) * 3;
      if (fx < -0.5 || fy < -0.5 || fx > sw - 0.5 || fy > sh - 0.5) continue; // ngoài ảnh: đen
      const x0 = Math.max(0, Math.min(sw - 1, Math.floor(fx)));
      const y0 = Math.max(0, Math.min(sh - 1, Math.floor(fy)));
      const x1 = Math.min(sw - 1, x0 + 1);
      const y1 = Math.min(sh - 1, y0 + 1);
      const tx = Math.max(0, Math.min(1, fx - x0));
      const ty = Math.max(0, Math.min(1, fy - y0));
      for (let c = 0; c < 3; c++) {
        const p00 = small[(y0 * sw + x0) * 3 + c];
        const p01 = small[(y0 * sw + x1) * 3 + c];
        const p10 = small[(y1 * sw + x0) * 3 + c];
        const p11 = small[(y1 * sw + x1) * 3 + c];
        input[o + c] = ((p00 * (1 - tx) + p01 * tx) * (1 - ty) + (p10 * (1 - tx) + p11 * tx) * ty) / 255;
      }
    }
  }
  const out = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, [1, SIZE, SIZE, 3]) });
  const lm = out[session.outputNames[0]].data;
  const logit = out[session.outputNames[1]].data[0];
  const pts = [];
  for (let i = 0; i < 478; i++) pts.push(toImg(lm[i * 3], lm[i * 3 + 1]));
  return { pts, score: 1 / (1 + Math.exp(-logit)) };
}

/** Ô cắt cho lượt sau, dựng từ lưới: tâm khung bao, xoay theo hai mắt, rộng 1,5 lần. */
function oTuLuoi(pts) {
  const [r, l] = [pts[33], pts[263]]; // khoé ngoài mắt phải / trái (của người trong ảnh)
  const ang = Math.atan2(l[1] - r[1], l[0] - r[0]);
  const cos = Math.cos(ang);
  const sin = Math.sin(ang);
  let u0 = Infinity;
  let u1 = -Infinity;
  let v0 = Infinity;
  let v1 = -Infinity;
  for (const [x, y] of pts) {
    const u = x * cos + y * sin;
    const v = -x * sin + y * cos;
    u0 = Math.min(u0, u);
    u1 = Math.max(u1, u);
    v0 = Math.min(v0, v);
    v1 = Math.max(v1, v);
  }
  const uc = (u0 + u1) / 2;
  const vc = (v0 + v1) / 2;
  return { cx: uc * cos - vc * sin, cy: uc * sin + vc * cos, side: 1.5 * Math.max(u1 - u0, v1 - v0), ang };
}

/**
 * Lưới 478 điểm cho một mặt YuNet `f` ({ x, y, w, h, lm }). null = model không
 * chắc đây là mặt (bị che, nghiêng quá). Trả `{ pts, score }`.
 */
export async function luoiMat(rgb, width, height, f, { scoreMin = 0.5 } = {}) {
  const [e0, e1] = f.lm;
  const ang0 = Math.atan2(e1[1] - e0[1], e1[0] - e0[0]);
  let r = await motLuot(rgb, width, height, f.x + f.w / 2, f.y + f.h / 2, 1.5 * Math.max(f.w, f.h), ang0);
  if (!r) return null;
  const o = oTuLuoi(r.pts);
  const r2 = await motLuot(rgb, width, height, o.cx, o.cy, o.side, o.ang);
  if (r2 && r2.score >= r.score * 0.9) r = r2;
  return r.score >= scoreMin ? r : null;
}
