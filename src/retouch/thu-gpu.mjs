// Chạy trong TIẾN TRÌNH CON (xoa-mun.js gọi lúc nạp model): đo từng model xoá
// mụn trên CPU và trên mỗi GPU của máy (Mac: CoreML; Windows: DirectML, từng
// card), trên một ô ảnh giả. In một dòng JSON:
//   { skin: { cpu: { ms }, coreml: { ms, lech } | { loi }, ..., chon: 'coreml' }, dn: { ... } }
// `chon` = máy NHANH NHẤT trong số máy ra cùng kết quả với CPU (lệch trung bình nhỏ).
//
//   node thu-gpu.mjs <máy GPU, cách nhau dấu phẩy>   vd: coreml   hoặc   dml:0,dml:1
//   (model: như xoa-mun.js — MUN_MODEL_DIR hoặc models/mun)

import ort from 'onnxruntime-node';
import { MODEL_FILES, TILE, docModel, tuyChonPhien } from './xoa-mun.js';

const gpus = (process.argv[2] || '').split(',').filter(Boolean);

/** Ô ảnh giả có màu da, vân nhiễu và vài chấm sẫm — đủ để hai máy tính khác nhau lộ ra. */
function oGia(n, nhwc) {
  const x = new Float32Array(3 * n * n);
  let s = 12345;
  const rnd = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const nen = [0.86, 0.68, 0.58];
  for (let y = 0; y < n; y++) {
    for (let xx = 0; xx < n; xx++) {
      const cham = ((xx % 97) - 48) ** 2 + ((y % 89) - 44) ** 2 < 36 ? 0.12 : 0;
      for (let c = 0; c < 3; c++) {
        const v = Math.min(1, Math.max(0, nen[c] - cham * (c === 0 ? 0.5 : 1) + (rnd() - 0.5) * 0.04));
        x[nhwc ? (y * n + xx) * 3 + c : c * n * n + y * n + xx] = v;
      }
    }
  }
  return x;
}

/** Lần đầu bỏ (GPU còn dịch model), lấy trung vị ba lần sau. */
async function do1(phien, feeds) {
  await phien.run(feeds);
  const ts = [];
  let out;
  for (let i = 0; i < 3; i++) {
    const t = Date.now();
    out = await phien.run(feeds);
    ts.push(Date.now() - t);
  }
  ts.sort((a, b) => a - b);
  return { ms: ts[1], data: out[phien.outputNames[0]].data };
}

const kq = {};
for (const k of Object.keys(MODEL_FILES)) {
  const r = { chon: 'cpu' };
  kq[k] = r;
  const model = docModel(k);
  const shape = k === 'skin' ? [1, 512, 512, 3] : [1, 3, TILE, TILE];
  const x = oGia(k === 'skin' ? 512 : TILE, k === 'skin');
  let goc;
  try {
    const cpu = await ort.InferenceSession.create(model, tuyChonPhien('cpu'));
    const a = await do1(cpu, { [cpu.inputNames[0]]: new ort.Tensor('float32', x, shape) });
    r.cpu = { ms: a.ms };
    goc = a.data;
    await cpu.release?.();
  } catch (err) {
    r.cpu = { loi: String(err.message || err).split('\n')[0].slice(0, 160) };
    continue;
  }
  let nhanh = r.cpu.ms;
  for (const g of gpus) {
    try {
      const s = await ort.InferenceSession.create(model, tuyChonPhien(g));
      const b = await do1(s, { [s.inputNames[0]]: new ort.Tensor('float32', x, shape) });
      let tong = 0;
      for (let i = 0; i < goc.length; i++) tong += Math.abs(goc[i] - b.data[i]);
      // skinMasking ra logit (thang ~±10), DnCNN ra ảnh 0–1.
      const lech = +(tong / goc.length).toFixed(5);
      r[g] = { ms: b.ms, lech };
      if (lech < (k === 'skin' ? 0.05 : 0.003) && b.ms < nhanh) {
        nhanh = b.ms;
        r.chon = g;
      }
      await s.release?.();
    } catch (err) {
      r[g] = { loi: String(err.message || err).split('\n')[0].slice(0, 160) };
    }
  }
}
console.log(JSON.stringify(kq));
