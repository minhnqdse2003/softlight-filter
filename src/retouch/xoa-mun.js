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

/** `retouch.device` trong snow.config.json — xem chonCho. */
export const THIET_BI = ['auto', 'gpu', 'cpu'];

/** Đổi khi cách đo đổi: may.json cũ (chưa có thời gian tạo phiên) bị đo lại một lần. */
const KHOA_DO = 'do-v2';

/**
 * Đo CPU và mỗi GPU cho từng model (thời gian CHẠY và thời gian TẠO PHIÊN), trong
 * TIẾN TRÌNH CON: lỗi trong thư viện GPU làm chết cả tiến trình — chết ở đó thì
 * bộ lọc vẫn sống, và dùng CPU. Nhớ kết quả ở models/mun/may.json (theo máy, hệ
 * điều hành, cỡ model): lần đo đầu mất vài chục giây vì GPU dịch model; cài bản
 * mới thì thư mục app thay hẳn nên đo lại một lần.
 */
async function doMay() {
  const gpus = process.env.MUN_THU_GPU === '0' ? [] : gpuCuaMay();
  if (!gpus.length) return { gpus, kq: null, ghiChu: 'CPU (không có GPU để thử)' };
  const co = Object.values(MODEL_FILES).filter((f) => fs.existsSync(path.join(MODEL_DIR, f)));
  const khoa = [KHOA_DO, process.platform, process.arch, os.release(), gpus.join(','),
    ...co.map((f) => `${f}:${fs.statSync(path.join(MODEL_DIR, f)).size}`)].join('|');
  const fNho = path.join(MODEL_DIR, 'may.json');
  try {
    const nho = JSON.parse(fs.readFileSync(fNho, 'utf8'));
    if (nho.khoa === khoa && nho.kq) return { gpus, kq: nho.kq };
  } catch {
    // chưa đo lần nào
  }
  const kq = await new Promise((resolve) => {
    execFile(process.execPath, [path.join(HERE, 'thu-gpu.mjs'), gpus.join(',')], { timeout: 240_000, cwd: HERE }, (err, out) => {
      if (err) {
        resolve({ loi: `đo GPU hỏng: ${(err.message || '').split('\n')[0].slice(0, 160)}` });
        return;
      }
      try {
        resolve(JSON.parse(out.trim().split('\n').pop()));
      } catch (e) {
        resolve({ loi: `không đọc được kết quả đo GPU: ${e.message}` });
      }
    });
  });
  if (kq.loi) return { gpus, kq: null, ghiChu: `CPU (${kq.loi})` };
  try {
    fs.writeFileSync(fNho, JSON.stringify({ khoa, kq, at: new Date().toISOString() }));
  } catch {
    // thư mục chỉ đọc: lần sau đo lại, không sao
  }
  return { gpus, kq };
}

/** Số lần chạy mỗi model trong một tấm điển hình (2 mặt): mặt nạ da 1 lần / mặt, DnCNN ~2 ô / mặt. */
const LAN_MOT_TAM = { skin: 2, dn: 4 };

/** Tiến trình chỉ xử lý MỘT tấm rồi thoát (snow.exe — src/cli.js đặt MUN_CHE_DO=mot-tam). */
const motTam = () => process.env.MUN_CHE_DO === 'mot-tam';

/**
 * Chọn máy cho model `k` từ kết quả đo `r`:
 *   'cpu'  luôn CPU
 *   'gpu'  máy CHẠY nhanh nhất (cách trước 13/11/2026) — hợp tiến trình sống lâu
 *   'auto' tiến trình một tấm: máy có tổng (tạo phiên + chạy × số lần trong một
 *          tấm) nhỏ nhất. Phần lớn "tạo phiên" GPU là KHỞI TẠO CARD (~1,5–3 giây
 *          với DirectML), trả một lần cho mỗi card mỗi tiến trình: card `daCo` (model
 *          kia đã nằm trên đó) coi như không tốn tạo phiên. Máy dev 13/11: DnCNN chọn
 *          GTX 1650 rồi mặt nạ da theo luôn card đó; máy không có GPU tốt thì cả hai
 *          về CPU thay vì trả tiền khởi tạo card cho vài lần chạy. Tiến trình sống
 *          lâu (máy phòng Mac) thì như 'gpu', vì phiên chỉ tạo một lần.
 * Chỉ chọn GPU ra cùng kết quả với CPU (`dung`), nên đổi máy không đổi chất lượng.
 */
function chonCho(k, r, thietBi, daCo = null) {
  if (!r || thietBi === 'cpu' || !r.cpu || r.cpu.ms == null) return 'cpu';
  const tinhTao = thietBi !== 'gpu' && motTam();
  const gia = (m, g) => (tinhTao ? (g === daCo ? 0 : m.tao || 0) + LAN_MOT_TAM[k] * m.ms : m.ms);
  let chon = 'cpu';
  let tot = gia(r.cpu, 'cpu');
  for (const [g, m] of Object.entries(r)) {
    if (g === 'cpu' || !m || typeof m !== 'object' || m.ms == null) continue;
    // may.json đo trước khi có `dung`: dùng ngưỡng lệch như thu-gpu.mjs.
    const dung = m.dung ?? (m.lech != null && m.lech < (k === 'skin' ? 0.05 : 0.003));
    if (dung && gia(m, g) < tot) {
      tot = gia(m, g);
      chon = g;
    }
  }
  return chon;
}

/** Máy cho từng model + dòng ghi chú cho nhật ký / kiem-tra.bat. */
async function chonMay(thietBi = 'auto', khongEp = false, chiDa = false) {
  // Ép máy (để đo): MUN_MAY=cpu | coreml | dml:<card> — bỏ qua bước đo.
  const ep = khongEp ? null : process.env.MUN_MAY;
  if (ep && /^(cpu|coreml|dml(:\d+)?)$/.test(ep)) return { skin: ep, dn: ep, ghiChu: `${ep} (ép bằng MUN_MAY)` };
  // Ép riêng từng model (để đo tổ hợp): MUN_MAY_SKIN / MUN_MAY_DN.
  const es = process.env.MUN_MAY_SKIN, ed = process.env.MUN_MAY_DN, hop = /^(cpu|coreml|dml(:\d+)?)$/;
  if (!khongEp && ((es && hop.test(es)) || (ed && hop.test(ed)))) {
    const m = await chonMay(thietBi === 'cpu' ? 'cpu' : thietBi, true, chiDa);
    if (es && hop.test(es)) m.skin = es;
    if (ed && hop.test(ed)) m.dn = ed;
    m.ghiChu = `skin ${m.skin}, dn ${m.dn} (ép bằng MUN_MAY_SKIN / MUN_MAY_DN)`;
    return m;
  }
  if (thietBi === 'cpu') return { skin: 'cpu', dn: 'cpu', ghiChu: 'CPU (retouch.device = cpu)' };
  const d = await doMay();
  if (!d.kq) return { skin: 'cpu', dn: 'cpu', ghiChu: d.ghiChu };
  const m = {};
  const ghi = [];
  // DnCNN trước (nặng nhất), mặt nạ da sau — được ưu tiên ngồi chung card với nó.
  // `chiDa` (Retouch v2): không nạp DnCNN nên mặt nạ da tự trả tiền khởi tạo card.
  for (const k of ['dn', 'skin']) {
    const r = d.kq[k];
    if (k === 'dn' && chiDa) continue;
    m[k] = chonCho(k, r, thietBi, k === 'skin' && !chiDa && m.dn !== 'cpu' ? m.dn : null);
    if (!r) continue;
    const doDuoc = ['cpu', ...d.gpus].map((g) => (r[g]?.ms != null ? `${g} ${r[g].ms} ms${r[g].tao != null ? ` + tạo ${r[g].tao} ms` : ''}` : `${g} lỗi`)).join(', ');
    ghi.push(`${k} → ${m[k]} (${doDuoc})`);
  }
  const cheDo = thietBi === 'gpu' ? 'device gpu' : motTam() ? 'auto, một tấm / tiến trình' : 'auto, tiến trình sống lâu';
  m.ghiChu = `${ghi.join('; ')} [${cheDo}]`;
  return m;
}

const engines = new Map();

/** Nạp một lần mỗi tiến trình (theo khoá); hỏng thì lần sau thử lại. */
function napMotLan(khoa, nap) {
  if (!engines.has(khoa)) {
    const p = nap();
    engines.set(khoa, p);
    p.catch(() => engines.delete(khoa));
  }
  return engines.get(khoa);
}

/**
 * Nạp hai model Retouch v1 (mặt nạ da + DnCNN). KHÔNG chạy khởi động: trước
 * 13/11 mỗi lần nạp chạy DnCNN hai lần chỉ để ghi thời gian vào nhật ký — mỗi tấm
 * của snow.exe mất ~0,2 giây trên GPU, ~3,5 giây trên máy không có GPU. Đo thời
 * gian một ô: doMotO (kiem-tra.bat, và server máy phòng gọi lúc khởi động để làm nóng).
 */
export function openXoaMun({ thietBi = 'auto' } = {}) {
  return napMotLan(`v1|${thietBi}`, async () => {
    for (const f of Object.values(MODEL_FILES)) {
      if (!fs.existsSync(path.join(MODEL_DIR, f))) throw new Error(`thiếu model ${f} trong ${MODEL_DIR}`);
    }
    const ort = (await import('onnxruntime-node')).default;
    const may = await chonMay(thietBi);
    const [skin, dn] = await Promise.all(['skin', 'dn'].map((k) =>
      ort.InferenceSession.create(docModel(k), tuyChonPhien(may[k]))));
    return { ort, skin, dn, may };
  });
}

/**
 * Chỉ MẶT NẠ DA (Retouch v2: mặt nạ Capture One + bộ chữa tự viết) — không nạp
 * DnCNN (trước 13/11 nạp thừa cả nó, ~1,5 giây mỗi tấm). Máy chọn như v1.
 */
export function openMatNa({ thietBi = 'auto' } = {}) {
  return napMotLan(`v2|${thietBi}`, async () => {
    if (!fs.existsSync(path.join(MODEL_DIR, MODEL_FILES.skin))) throw new Error(`thiếu model ${MODEL_FILES.skin} trong ${MODEL_DIR}`);
    const ort = (await import('onnxruntime-node')).default;
    const may = await chonMay(thietBi, false, true);
    const skin = await ort.InferenceSession.create(docModel('skin'), tuyChonPhien(may.skin));
    return { ort, skin, dn: null, may: { skin: may.skin, ghiChu: may.ghiChu.split('; ').filter((s) => s.startsWith('skin') || s.startsWith('CPU') || s.includes('MUN_MAY')).join('; ') || may.ghiChu } };
  });
}

/** Thời gian một ô DnCNN (ms, lần chạy thứ hai — lần đầu GPU còn dịch). Cũng làm nóng phiên. */
export async function doMotO(e) {
  if (!e.dn) return null;
  const o = { [e.dn.inputNames[0]]: new e.ort.Tensor('float32', new Float32Array(3 * TILE * TILE).fill(0.6), [1, 3, TILE, TILE]) };
  await e.dn.run(o);
  const t = Date.now();
  await e.dn.run(o);
  return Date.now() - t;
}

/**
 * Bản đồ sửa bằng BỘ CHỮA TỰ VIẾT (nhat-mun.js) thay cho DnCNN — cùng chỗ trong
 * khung Capture One: chạy trên đúng ảnh nhỏ (mặt rộng ~450) mà DnCNN sẽ nhận,
 * sửa = ảnh đã chữa − ảnh nhỏ. Phần còn lại (phóng bicubic, trộn theo mặt nạ
 * da Capture One làm mềm, nhân thanh Mức) giữ nguyên như v1.
 * `f`: khung mặt YuNet (toạ độ ảnh gốc); `ox, oy`: góc ảnh nhỏ trên ảnh gốc.
 */
async function banDoTuViet(small, sw, sh, f, ox, oy, kx, ky) {
  const { nhatMun } = await import('./nhat-mun.js');
  const healed = Buffer.from(small);
  const fs2 = {
    ...f,
    x: (f.x - ox) * kx, y: (f.y - oy) * ky, w: f.w * kx, h: f.h * ky,
    lm: f.lm ? f.lm.map(([x, y]) => [(x - ox) * kx, (y - oy) * ky]) : f.lm,
  };
  const so = await nhatMun(healed, sw, sh, [fs2]);
  const corr = new Float32Array(sw * sh * 3);
  for (let i = 0; i < corr.length; i++) corr[i] = (healed[i] - small[i]) / 255;
  return { corr, so };
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
 * `chua`: 'dncnn' (Retouch v1 — đúng Capture One) | 'tu-viet' (Retouch v2 —
 * mặt nạ da Capture One, chữa bằng bộ tự viết; không cần model DnCNN).
 */
export async function xoaMun(rgb, width, height, faces, { amount = 100, onMat = null, chua = 'dncnn', thietBi = 'auto' } = {}) {
  if (!faces.length || amount <= 0) return 0;
  const tuViet = chua === 'tu-viet';
  const e = tuViet ? await openMatNa({ thietBi }) : await openXoaMun({ thietBi });
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
    const { corr } = tuViet
      ? await banDoTuViet(small, sw, sh, faces[i], x0 + c.left, y0 + c.top, sw / c.width, sh / c.height)
      : await banDoSua(e, small, sw, sh, coDa);
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
