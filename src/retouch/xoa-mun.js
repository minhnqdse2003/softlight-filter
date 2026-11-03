import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

/**
 * XOÁ MỤN bằng model "Remove Blemishes" của Capture One (Phase One) — thay cho
 * bộ nhặt mụn tự viết trước đây (nhat-mun.js, 02/11/2026). Cách dùng model theo
 * gói thử blemish_pack (đọc từ ImgCoreDll.dll của Capture One 16.7.7):
 *
 *   mặt nạ  = skinMasking: da mặt (lớp 3) + da cổ / tay (lớp 2), trong vùng
 *             quanh mặt (rộng thêm 25% hai bên và phía trên, 15% dưới cằm —
 *             như tuỳ chọn --no-neck của gói thử: bỏ cổ cho đỡ một nửa thời gian)
 *   thu nhỏ = vùng da về tỉ lệ 450 / bề rộng khung mặt (chỉ thu nhỏ)
 *   sửa     = DnCNN(ảnh nhỏ) − ảnh nhỏ, phóng bicubic về cỡ gốc
 *   kết quả = ảnh + sửa × mặt nạ làm mềm
 *
 * Khác gói thử:
 *  - Khung mặt lấy từ YuNet (khuon-mat.js), khỏi nạp model tìm mặt 109 MB: đo
 *    trên 46 mặt, khung YuNet rộng bằng khung RetinaFace của Capture One (tỉ lệ
 *    1,015, tâm lệch dưới 2%).
 *  - Mọi mặt trong ảnh, không chỉ mặt rõ nhất. Mặt nạ da chạy trên vùng cắt
 *    quanh TỪNG mặt: thu cả ảnh nhóm 26MP về 512 thì mỗi mặt chỉ còn ~70 điểm.
 *    Chỗ vùng hai mặt chồng nhau thì điểm ảnh thuộc mặt gần hơn — không xoá hai
 *    lần.
 *  - DnCNN chạy theo ô cố định 576×576 (ra 512×512): RAM chặn ở mức vài trăm
 *    MB dù mặt to, ô không có da thì bỏ, và CoreML chỉ phải dịch model một lần.
 *    Mặt từ 450 điểm trở lên luôn thu về rộng ~450 nên vừa MỘT cột ô, cao hai.
 *
 * Model KHÔNG nằm trong git (của Phase One): đặt vào models/mun (dong-goi.bat
 * chép theo vào gói), hoặc trỏ MUN_MODEL_DIR. Thiếu thì retouch.js dùng bộ
 * nhặt mụn tự viết (nhat-mun.js).
 *
 * Chép từ máy phòng 1510 (selfbooth, apps/room-booth/server/src/lam-min).
 *
 * Chạy bằng onnxruntime-node chứ không phải WebAssembly như YuNet: DnCNN nặng,
 * bản WebAssembly chậm hơn ~3,5 lần. Lúc nạp, đo CPU (4 luồng — đúng số nhân
 * hiệu năng của M1) và từng GPU của máy (Mac: CoreML; Windows: DirectML) trong
 * một tiến trình con — thu-gpu.mjs — rồi dùng máy NHANH HƠN, miễn ra cùng kết
 * quả với CPU. Đo 02/11 trên máy dev: một ô DnCNN CPU 1,5 giây, GPU tích hợp
 * AMD 0,45 giây, GTX 1650 0,1 giây. Chạy CPU và GPU cùng lúc không lợi:
 * onnxruntime-node chạy hai phiên lần lượt chứ không song song. Vẫn TỪNG TẤM một như mọi bước hậu kỳ: nhiều luồng
 * ở đây là một phép tính chia cho nhiều nhân, RAM không tăng theo.
 */

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const MODEL_DIR = process.env.MUN_MODEL_DIR || path.join(HERE, '..', '..', 'models', 'mun');
export const MODEL_FILES = { skin: 'skinMasking.onnx', dn: 'blemishRemoval_dynamic.onnx' };

const FACE_REF = 450; // hằng số trong CalculateBlemishCorrectionMap của Capture One
const K_RONG = 1.015; // khung YuNet -> khung RetinaFace
const K_CAO = 1.034;
const SKIN = 512; // skinMasking nhận đúng 512×512
const PAD = 32; // DnCNN cắt bỏ 32 điểm mỗi cạnh của đầu ra
export const TILE = 576;
const STEP = TILE - 2 * PAD;
export const LUONG = 4;

let engine = null;

/**
 * Đọc model thành Buffer. DnCNN khai đầu vào [1, 3, "H", "W"] (cỡ động): đổi
 * hai chiều tên H, W thành đúng cỡ ô — CoreML dịch model một lần cho cỡ cố
 * định thay vì mỗi lần một cỡ (onnxruntime-node không nhận
 * freeDimensionOverrides). Trong protobuf, chiều có tên là `12 01 <chữ>` và
 * chiều có số là `08 <varint>` — 576 là `08 c0 04`: cùng ba byte nên không phải
 * sửa độ dài nào.
 */
export function docModel(k) {
  const buf = fs.readFileSync(path.join(MODEL_DIR, MODEL_FILES[k]));
  if (k !== 'dn') return buf;
  const ten = Buffer.from('input.1');
  const i = buf.lastIndexOf(ten);
  for (const chu of ['H', 'W']) {
    const j = buf.indexOf(Buffer.from([0x12, 0x01, chu.charCodeAt(0)]), i);
    if (i < 0 || j < 0 || j - i > 64) throw new Error(`${MODEL_FILES[k]}: không thấy chiều ${chu} của đầu vào — model khác bản đã thử`);
    buf.set([0x08, TILE & 0x7f | 0x80, TILE >> 7], j);
  }
  return buf;
}

/**
 * Tuỳ chọn phiên onnxruntime cho từng model, theo máy chạy: 'cpu' | 'coreml'
 * (Mac) | 'dml:<card>' (GPU Windows qua DirectML; 'dml' = card 0).
 */
export function tuyChonPhien(may) {
  const opt = { graphOptimizationLevel: 'all', intraOpNumThreads: LUONG, executionProviders: ['cpu'] };
  // 0x010 = COREML_FLAG_CREATE_MLPROGRAM (định dạng mới, chạy được cả GPU).
  if (may === 'coreml') opt.executionProviders = [{ name: 'coreml', coreMlFlags: 0x010 }, 'cpu'];
  if (may.startsWith('dml')) {
    opt.executionProviders = [{ name: 'dml', deviceId: Number(may.split(':')[1]) || 0 }, 'cpu'];
    // DirectML không chạy được với hai tuỳ chọn mặc định này.
    opt.enableMemPattern = false;
    opt.executionMode = 'sequential';
  }
  return opt;
}

/** GPU có thể thử trên máy này. */
function gpuCuaMay() {
  if (process.platform === 'darwin') return ['coreml'];
  if (process.platform === 'win32') return ['dml:0', 'dml:1'];
  return [];
}

/**
 * Chọn máy tính cho từng model: đo CPU và mỗi GPU, lấy cái nhanh hơn. Đo trong
 * TIẾN TRÌNH CON: lỗi trong thư viện GPU làm chết cả tiến trình — chết ở đó thì
 * bộ lọc vẫn sống, và dùng CPU. Nhớ kết quả ở models/mun/may.json (theo máy,
 * hệ điều hành, cỡ model): lần đo đầu mất vài chục giây vì CoreML dịch model;
 * cài bản mới thì thư mục app thay hẳn nên đo lại một lần.
 */
async function chonMay() {
  const cpu = { skin: 'cpu', dn: 'cpu', ghiChu: 'CPU' };
  // Ép máy (để đo): MUN_MAY=cpu | coreml | dml:<card> — bỏ qua bước đo.
  const ep = process.env.MUN_MAY;
  if (ep && /^(cpu|coreml|dml(:\d+)?)$/.test(ep)) return { skin: ep, dn: ep, ghiChu: `${ep} (ép bằng MUN_MAY)` };
  const gpus = process.env.MUN_THU_GPU === '0' ? [] : gpuCuaMay();
  if (!gpus.length) return cpu;
  const khoa = [process.platform, process.arch, os.release(), gpus.join(','),
    ...Object.values(MODEL_FILES).map((f) => fs.statSync(path.join(MODEL_DIR, f)).size)].join('|');
  const fNho = path.join(MODEL_DIR, 'may.json');
  try {
    const nho = JSON.parse(fs.readFileSync(fNho, 'utf8'));
    if (nho.khoa === khoa) return nho.may;
  } catch {
    // chưa đo lần nào
  }
  const may = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, 'thu-gpu.mjs'), gpus.join(',')], { timeout: 240_000, cwd: HERE }, (err, out) => {
      if (err) {
        resolve({ ...cpu, ghiChu: `CPU (đo GPU hỏng: ${(err.message || '').split('\n')[0].slice(0, 160)})` });
        return;
      }
      try {
        const kq = JSON.parse(out.trim().split('\n').pop());
        const m = {};
        const ghi = [];
        for (const k of Object.keys(MODEL_FILES)) {
          const r = kq[k] || {};
          m[k] = r.chon || 'cpu';
          const doDuoc = ['cpu', ...gpus].map((g) => `${g} ${r[g]?.ms != null ? `${r[g].ms} ms` : 'lỗi'}`).join(', ');
          ghi.push(`${k} → ${m[k]} (${doDuoc})`);
        }
        m.ghiChu = ghi.join('; ');
        resolve(m);
      } catch (e) {
        resolve({ ...cpu, ghiChu: `CPU (không đọc được kết quả đo GPU: ${e.message})` });
      }
    });
  });
  try {
    fs.writeFileSync(fNho, JSON.stringify({ khoa, may, at: new Date().toISOString() }));
  } catch {
    // thư mục chỉ đọc: lần sau đo lại, không sao
  }
  return may;
}

/**
 * Nạp model một lần cho cả tiến trình. Hỏng thì lần sau thử lại. Trả về kèm
 * `msO`: thời gian một ô DnCNN trên máy đã chọn (đo lần chạy thứ hai — lần đầu
 * GPU còn dịch model) để ghi nhật ký.
 */
export function openXoaMun() {
  if (!engine) {
    engine = (async () => {
      for (const f of Object.values(MODEL_FILES)) {
        if (!fs.existsSync(path.join(MODEL_DIR, f))) throw new Error(`thiếu model ${f} trong ${MODEL_DIR}`);
      }
      const ort = (await import('onnxruntime-node')).default;
      const may = await chonMay();
      const [skin, dn] = await Promise.all(['skin', 'dn'].map((k) =>
        ort.InferenceSession.create(docModel(k), tuyChonPhien(may[k]))));
      const o = { [dn.inputNames[0]]: new ort.Tensor('float32', new Float32Array(3 * TILE * TILE).fill(0.6), [1, 3, TILE, TILE]) };
      await dn.run(o);
      const t = Date.now();
      await dn.run(o);
      return { ort, skin, dn, may, msO: Date.now() - t };
    })();
    engine.catch(() => {
      engine = null;
    });
  }
  return engine;
}

/** Chỉ số phản xạ kiểu numpy 'reflect' (không lặp điểm biên). */
function phanXa(v, n) {
  if (n === 1) return 0;
  const chu = 2 * (n - 1);
  v %= chu;
  if (v < 0) v += chu;
  return v < n ? v : chu - v;
}

/** Trọng số bicubic a = −0,5 (như PIL / Catmull-Rom). */
function cubic(t) {
  const x = Math.abs(t);
  if (x <= 1) return (1.5 * x - 2.5) * x * x + 1;
  if (x < 2) return ((-0.5 * x + 2.5) * x - 4) * x + 2;
  return 0;
}

/** Bảng 4 chỉ số + 4 trọng số cho mỗi điểm đích khi phóng `n` -> `m`. */
function bangCubic(n, m) {
  const idx = new Int32Array(4 * m);
  const wt = new Float32Array(4 * m);
  const k = n / m;
  for (let i = 0; i < m; i++) {
    const s = (i + 0.5) * k - 0.5;
    const s0 = Math.floor(s);
    let tong = 0;
    for (let j = 0; j < 4; j++) {
      const p = s0 - 1 + j;
      idx[4 * i + j] = Math.min(n - 1, Math.max(0, p));
      wt[4 * i + j] = cubic(s - p);
      tong += wt[4 * i + j];
    }
    for (let j = 0; j < 4; j++) wt[4 * i + j] /= tong;
  }
  return { idx, wt };
}

/** Mặt nạ da (0–255) của cả vùng `vung` quanh một mặt: P(da mặt) + P(da cổ/tay). */
async function matNaDa(e, rgb, width, height, vung) {
  // Vùng cắt VUÔNG chứa `vung` (model thấy người đúng tỉ lệ), co lại khi chạm mép.
  const canh = Math.min(Math.max(vung.w, vung.h), width, height);
  const cx = vung.x + vung.w / 2;
  const cy = vung.y + vung.h / 2;
  const sq = {
    left: Math.round(Math.min(Math.max(cx - canh / 2, 0), width - canh)),
    top: Math.round(Math.min(Math.max(cy - canh / 2, 0), height - canh)),
    width: Math.round(canh),
    height: Math.round(canh),
  };
  sq.left = Math.max(0, Math.min(sq.left, vung.x));
  sq.top = Math.max(0, Math.min(sq.top, vung.y));
  sq.width = Math.min(width - sq.left, Math.max(sq.width, vung.x + vung.w - sq.left));
  sq.height = Math.min(height - sq.top, Math.max(sq.height, vung.y + vung.h - sq.top));

  const nho = await sharp(rgb, { raw: { width, height, channels: 3 } })
    .extract(sq)
    .resize(SKIN, SKIN, { fit: 'fill' })
    .raw()
    .toBuffer();
  const x = new Float32Array(SKIN * SKIN * 3);
  for (let i = 0; i < x.length; i++) x[i] = nho[i] / 255;
  const out = await e.skin.run({ [e.skin.inputNames[0]]: new e.ort.Tensor('float32', x, [1, SKIN, SKIN, 3]) });
  const lg = out[e.skin.outputNames[0]].data;
  const p = Buffer.alloc(SKIN * SKIN);
  for (let i = 0; i < SKIN * SKIN; i++) {
    const o = i * 6;
    let mx = lg[o];
    for (let c = 1; c < 6; c++) if (lg[o + c] > mx) mx = lg[o + c];
    let tong = 0;
    for (let c = 0; c < 6; c++) tong += Math.exp(lg[o + c] - mx);
    p[i] = Math.round((Math.min(1, (Math.exp(lg[o + 2] - mx) + Math.exp(lg[o + 3] - mx)) / tong)) * 255);
  }
  return sharp(p, { raw: { width: SKIN, height: SKIN, channels: 1 } })
    .resize(sq.width, sq.height, { fit: 'fill' })
    .extract({ left: vung.x - sq.left, top: vung.y - sq.top, width: vung.w, height: vung.h })
    .extractChannel(0)
    .raw()
    .toBuffer();
}

/** DnCNN theo ô cố định trên ảnh nhỏ (RGB 8 bit) — trả bản đồ sửa (float, HWC). Bỏ ô không có da. */
async function banDoSua(e, small, sw, sh, coDa) {
  const corr = new Float32Array(sw * sh * 3);
  const xs = [];
  const ys = [];
  for (let x = 0; ; x += STEP) { xs.push(Math.max(0, Math.min(x, sw - STEP))); if (x + STEP >= sw) break; }
  for (let y = 0; ; y += STEP) { ys.push(Math.max(0, Math.min(y, sh - STEP))); if (y + STEP >= sh) break; }
  const plane = TILE * TILE;
  const inp = new Float32Array(3 * plane);
  let so = 0;
  for (const ty of ys) {
    for (const tx of xs) {
      const yEnd = Math.min(sh, ty + STEP);
      const xEnd = Math.min(sw, tx + STEP);
      let can = false;
      for (let y = ty; y < yEnd && !can; y++) for (let x = tx; x < xEnd; x++) if (coDa[y * sw + x]) { can = true; break; }
      if (!can) continue;
      for (let v = 0; v < TILE; v++) {
        const sy = phanXa(ty + v - PAD, sh);
        for (let u = 0; u < TILE; u++) {
          const s = (sy * sw + phanXa(tx + u - PAD, sw)) * 3;
          const o = v * TILE + u;
          inp[o] = small[s] / 255;
          inp[plane + o] = small[s + 1] / 255;
          inp[2 * plane + o] = small[s + 2] / 255;
        }
      }
      const out = await e.dn.run({ [e.dn.inputNames[0]]: new e.ort.Tensor('float32', inp, [1, 3, TILE, TILE]) });
      const od = out[e.dn.outputNames[0]].data;
      const ow = out[e.dn.outputNames[0]].dims[3];
      const op = out[e.dn.outputNames[0]].dims[2] * ow;
      for (let y = ty; y < yEnd; y++) {
        for (let x = tx; x < xEnd; x++) {
          const o = (y - ty) * ow + (x - tx);
          const d = (y * sw + x) * 3;
          corr[d] = od[o] - small[d] / 255;
          corr[d + 1] = od[op + o] - small[d + 1] / 255;
          corr[d + 2] = od[2 * op + o] - small[d + 2] / 255;
        }
      }
      so++;
    }
  }
  return { corr, so };
}

/**
 * Xoá mụn trên mọi mặt trong `faces` (`rgb`: Buffer RGB 8 bit, SỬA TẠI CHỖ).
 * Trả về số mặt đã xử lý. `amount`: 0–100 như thanh Remove Blemishes (100 =
 * đủ mức model). `onMat` (chỉ để thử): nhận { vung, mask, ra } của mỗi mặt.
 */
export async function xoaMun(rgb, width, height, faces, { amount = 100, onMat = null } = {}) {
  if (!faces.length || amount <= 0) return 0;
  const e = await openXoaMun();
  // Khung Capture One của từng mặt, và tâm + cỡ để chia điểm ảnh cho mặt gần nhất.
  const khung = faces.map((f) => {
    const w = f.w * K_RONG;
    const h = f.h * K_CAO;
    return { x0: f.x + f.w / 2 - w / 2, y0: f.y + f.h / 2 - h / 2, w, h, cx: f.x + f.w / 2, cy: f.y + f.h / 2 };
  });
  const k = amount / 100;
  let so = 0;
  for (const [i, b] of khung.entries()) {
    const x0 = Math.trunc(Math.max(b.x0 - 0.25 * b.w, 0));
    const y0 = Math.trunc(Math.max(b.y0 - 0.25 * b.h, 0));
    const x1 = Math.trunc(Math.min(b.x0 + 1.25 * b.w, width));
    const y1 = Math.trunc(Math.min(b.y0 + 1.15 * b.h, height));
    if (x1 - x0 < 16 || y1 - y0 < 16) continue;
    const vung = { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
    const mask = await matNaDa(e, rgb, width, height, vung);

    // Điểm ảnh gần mặt khác hơn (khoảng cách chia bề rộng mặt) thì để mặt đó lo.
    const khac = khung.filter((_, j) => j !== i);
    let ya = vung.h;
    let yb = -1;
    let xa = vung.w;
    let xb = -1;
    for (let y = 0; y < vung.h; y++) {
      for (let x = 0; x < vung.w; x++) {
        const m = y * vung.w + x;
        if (!mask[m]) continue;
        if (khac.length) {
          const gx = x + x0;
          const gy = y + y0;
          const d = Math.hypot(gx - b.cx, gy - b.cy) / b.w;
          if (khac.some((c) => Math.hypot(gx - c.cx, gy - c.cy) / c.w < d)) {
            mask[m] = 0;
            continue;
          }
        }
        if (mask[m] > 25) {
          if (y < ya) ya = y;
          if (y > yb) yb = y;
          if (x < xa) xa = x;
          if (x > xb) xb = x;
        }
      }
    }
    if (yb < 0) continue;

    // Khung da + lề (như gói thử: 1/80 cạnh dài của ảnh), trong vùng.
    const le = Math.floor(Math.max(width, height) / 80);
    const c = {
      left: Math.max(xa - le, 0),
      top: Math.max(ya - le, 0),
    };
    c.width = Math.min(xb + le, vung.w) - c.left;
    c.height = Math.min(yb + le, vung.h) - c.top;
    const scale = Math.min(FACE_REF / Math.max(b.w, 1), 1);
    const sw = Math.max(Math.round(c.width * scale), 8);
    const sh = Math.max(Math.round(c.height * scale), 8);
    const small = await sharp(rgb, { raw: { width, height, channels: 3 } })
      .extract({ left: x0 + c.left, top: y0 + c.top, width: c.width, height: c.height })
      .resize(sw, sh, { fit: 'fill', kernel: 'lanczos3' })
      .raw()
      .toBuffer();
    const maskVung = await sharp(mask, { raw: { width: vung.w, height: vung.h, channels: 1 } })
      .extract(c)
      .extractChannel(0)
      .raw()
      .toBuffer();
    const coDa = await sharp(maskVung, { raw: { width: c.width, height: c.height, channels: 1 } })
      .resize(sw, sh, { fit: 'fill' })
      .extractChannel(0)
      .raw()
      .toBuffer();
    for (let j = 0; j < coDa.length; j++) coDa[j] = coDa[j] > 25 ? 1 : 0;
    const { corr } = await banDoSua(e, small, sw, sh, coDa);
    const mem = await sharp(maskVung, { raw: { width: c.width, height: c.height, channels: 1 } })
      .blur(3)
      .extractChannel(0)
      .raw()
      .toBuffer();

    // Phóng bản đồ sửa (bicubic, hai lượt) và cộng vào ảnh theo từng hàng.
    const bx = bangCubic(sw, c.width);
    const by = bangCubic(sh, c.height);
    const ngang = new Float32Array(sh * c.width * 3);
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < c.width; x++) {
        const d = (y * c.width + x) * 3;
        for (let j = 0; j < 4; j++) {
          const s = (y * sw + bx.idx[4 * x + j]) * 3;
          const w = bx.wt[4 * x + j];
          ngang[d] += corr[s] * w;
          ngang[d + 1] += corr[s + 1] * w;
          ngang[d + 2] += corr[s + 2] * w;
        }
      }
    }
    for (let y = 0; y < c.height; y++) {
      const r0 = by.idx[4 * y] * c.width;
      const r1 = by.idx[4 * y + 1] * c.width;
      const r2 = by.idx[4 * y + 2] * c.width;
      const r3 = by.idx[4 * y + 3] * c.width;
      const [w0, w1, w2, w3] = by.wt.subarray(4 * y, 4 * y + 4);
      for (let x = 0; x < c.width; x++) {
        const a = (mem[y * c.width + x] / 255) * k;
        if (a < 0.002) continue;
        const o = ((y0 + c.top + y) * width + x0 + c.left + x) * 3;
        for (let ch = 0; ch < 3; ch++) {
          const v = ngang[(r0 + x) * 3 + ch] * w0 + ngang[(r1 + x) * 3 + ch] * w1 + ngang[(r2 + x) * 3 + ch] * w2 + ngang[(r3 + x) * 3 + ch] * w3;
          const val = rgb[o + ch] + v * a * 255 + 0.5;
          rgb[o + ch] = val <= 0 ? 0 : val >= 255 ? 255 : val | 0;
        }
      }
    }
    if (onMat) onMat({ vung, c, mask, sw, sh });
    so++;
  }
  return so;
}
