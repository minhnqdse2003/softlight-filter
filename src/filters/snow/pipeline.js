import { closeSync, existsSync, fstatSync, mkdirSync, mkdtempSync, openSync, readSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import sharp from 'sharp';
import { HARMONY } from '../../pipeline.js';
import { renderLook } from '../instax/look.js';
import { loadUserLut } from '../instax/pipeline.js';
import { loadConfig, lookPreset } from './config.js';
import { MATTE_MODELS, modelPath, mattePng, openSession, personMatte } from './matte.js';
import { buildScene, drawSnow, normalizeSnow, seedFromName } from './snow.js';

/**
 * BỘ LỌC TUYẾT — phần chạy trên máy booth.
 *
 * Toàn bộ toán nằm ở snow.js (dùng chung với trang chỉnh). File này đọc ảnh,
 * tách người (matte.js), chọn seed, gọi drawSnow, mã hoá JPEG.
 *
 * Seed: `cfg.seed` khác 0 thì mọi ảnh dùng chung một bộ hạt (tiện để so khi
 * chỉnh); bằng 0 thì lấy theo tên VÀ NỘI DUNG file (seedFromFile) — mỗi tấm
 * khách chụp một bộ tuyết riêng, mà chạy lại trên cùng tấm vẫn ra y hệt. Hai ô
 * cùng một ảnh trong template dĩ nhiên có cùng tuyết, vì dslrBooth ghép cùng một file.
 *
 * Không bao giờ thu nhỏ ảnh: cờ --max-edge (FilmongBooth) bị bỏ qua ở bộ lọc
 * này — ảnh tuyết luôn giữ đủ độ phân giải gốc.
 *
 * Tách người hỏng vì bất cứ lý do gì (thiếu model, thiếu onnxruntime-node,
 * model lỗi) thì rơi về elip của cfg.subject và ghi cảnh báo vào log — không
 * bao giờ làm hỏng phiên chụp.
 */
export async function renderSnow(inputPath, cfg, { trace = false, seed = 0 } = {}) {
  // Mở model TRƯỚC khi giải mã, để hai việc chạy song song.
  const auto = cfg.subject.mode === 'auto', model = cfg.subject.model;
  if (auto) openSession(model).catch(() => {});

  const s = seed || cfg.seed || seedFromFile(inputPath);
  const { data, info } = await sharp(inputPath, { failOn: 'none' }).rotate().toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  if (info.channels !== 3) {
    throw new Error(`Ảnh có ${info.channels} kênh màu, chỉ hỗ trợ RGB 3 kênh.`);
  }

  // Buffer từ libvips có thể đang được chia sẻ, nên sao ra trước khi sửa tại chỗ.
  const cur = Buffer.from(data);
  let matte = null, warn;
  if (auto) {
    try {
      matte = await personMatte(cur, info.width, info.height, model);
    } catch (err) {
      // Model "đẹp" hỏng / thiếu thì thử MODNet trước khi rơi về elip.
      if (model !== 'modnet') {
        try {
          matte = await personMatte(cur, info.width, info.height, 'modnet');
          warn = `không chạy được ${model} (${err.message}) — dùng MODNet`;
        } catch { /* rơi xuống elip bên dưới */ }
      }
      if (!matte) warn = `không tách được người (${err.message}) — dùng elip vùng người`;
    }
  }

  const t0 = Date.now();
  const stats = drawSnow(cur, info.width, info.height, 3, cfg, { seed: s, matte });
  const stages = trace
    ? [{ name: 'tuyết', ms: Date.now() - t0, matteMs: matte ? matte.ms : null, seed: s, ...stats }]
    : [];

  // Màu chỉnh SAU tuyết: cả khung ăn cùng một look, hạt phim rơi cả lên hạt tuyết.
  // Hạt phim lấy cùng seed với tuyết nên chạy lại trên một tấm vẫn ra y hệt.
  if (cfg.look && cfg.look.enabled) {
    const t1 = Date.now();
    const { lut, warn: lutWarn } = loadUserLut(cfg.look);
    renderLook(cur, info.width, info.height, 3, cfg.look, { userLut: lut, seed: s });
    if (lutWarn) warn = warn ? `${warn}; ${lutWarn}` : lutWarn;
    if (trace) stages.push({ name: 'màu', ms: Date.now() - t1 });
  }

  return { jpeg: await encode(cur, info, cfg), width: info.width, height: info.height, stages, warn };
}

/**
 * Seed riêng cho một tấm ảnh: tên file + cỡ file + 64KB đầu và 64KB cuối của
 * chính file JPEG gốc. Hai lần chụp khác nhau không bao giờ có cùng dữ liệu
 * (giờ chụp trong EXIF, nhiễu cảm biến), nên kể cả khi máy ảnh đếm lại
 * IMG_0001 ở sự kiện sau, hay hai booth đặt trùng tên, tuyết vẫn không đụng
 * hàng. Cùng một file thì cùng seed — chạy lại vẫn ra y hệt.
 */
export function seedFromFile(path) {
  let h = seedFromName(basename(path));
  const mix = (buf, n) => { for (let i = 0; i < n; i++) { h ^= buf[i]; h = Math.imul(h, 0x01000193); } };
  let fd;
  try {
    fd = openSync(path, 'r');
    const size = fstatSync(fd).size, buf = Buffer.alloc(Math.min(65536, size));
    mix(buf, readSync(fd, buf, 0, buf.length, 0));
    if (size > buf.length) mix(buf, readSync(fd, buf, 0, buf.length, size - buf.length));
    h ^= size; h = Math.imul(h, 0x01000193);
  } catch { /* không đọc được thì giữ seed theo tên */ } finally {
    if (fd !== undefined) closeSync(fd);
  }
  return h >>> 0 || 1;
}

/**
 * `--matte anh.jpg`: ghi matte tách người ra anh.MATTE.png cạnh ảnh. Trang chỉnh
 * nạp file này (tab Người) để xem trước đúng như snow.exe sẽ che.
 */
export async function writeMatte(inputPath, cfg = loadConfig()) {
  const { data, info } = await sharp(inputPath, { failOn: 'none' }).rotate().toColourspace('srgb').raw()
    .toBuffer({ resolveWithObject: true });
  const matte = await personMatte(Buffer.from(data), info.width, info.height, cfg.subject.model);
  const out = inputPath.replace(/\.(jpe?g|png)$/i, '') + '.MATTE.png';
  writeFileSync(out, await mattePng(matte));
  console.log(`Đã ghi matte ${matte.width}×${matte.height} (${matte.ms} ms):\n  ${out}`);
  console.log('Mở trang chỉnh Tuyết → tab Người → "Nạp matte" để xem trước đúng dáng người.');
}

/** Dòng kiểm tra riêng của bộ lọc cho `--doctor`: model có mặt và chạy được. */
export async function doctor() {
  const model = loadConfig().subject.model, file = MATTE_MODELS[model].file;
  if (!existsSync(modelPath(model))) {
    return [[false, `models/${file}`, `THIẾU — tách người sẽ rơi về ${model === 'modnet' ? 'elip' : 'MODNet'}. Chạy: npm run model -- ${model}`]];
  }
  try {
    const t0 = Date.now();
    const m = await personMatte(Buffer.alloc(1500 * 1000 * 3, 128), 1500, 1000, model);
    return [[true, `Tách người (${model})`, `chạy được, ${Date.now() - t0} ms kể cả nạp model (matte ${m.width}×${m.height})`]];
  } catch (err) {
    return [[false, `Tách người (${model})`, `LỖI: ${err.message} — tách người sẽ rơi về elip`]];
  }
}

function encode(cur, info, cfg) {
  return sharp(cur, { raw: { width: info.width, height: info.height, channels: 3 } })
    .jpeg({
      quality: cfg.output.quality,
      chromaSubsampling: cfg.output.chromaSubsampling,
      progressive: false,
    })
    .withMetadata()
    .toBuffer();
}

/** Ảnh so sánh trước / sau, ghép cạnh nhau — cùng khuôn với các bộ lọc khác. */
export async function renderComparison(inputPath, cfg, maxWidth = 2200, opts = {}) {
  const before = await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .jpeg({ quality: 95 })
    .toBuffer();
  const { jpeg: after } = await renderSnow(inputPath, cfg, opts);

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

/**
 * Bảng hài hoà của `--preview` đo trên ảnh ra. Bộ lọc này không đổi sắc độ, nên
 * phần lớn chỉ số thuộc về ảnh gốc và ánh sáng booth — nói rõ như vậy, thay vì
 * đổ cho một khoá cấu hình không liên quan.
 */
export function verdicts(m) {
  const H = HARMONY;
  const na = { ok: true, note: 'không áp dụng — bộ lọc Tuyết không đổi màu ảnh' };
  return {
    crushed: m.crushedPct <= H.crushedPct.max
      ? { ok: true, note: 'giữ được chi tiết vùng tối' }
      : { ok: false, note: 'bết đen — thuộc ảnh gốc / ánh sáng booth' },
    blown: m.blownPct <= H.blownPct.max
      ? { ok: true, note: 'vùng sáng còn mượt' }
      : { ok: false, note: 'cháy sáng — giảm light.brightness hoặc light.glow, hoặc bớt phơi sáng ở booth' },
    subject: na,
    warmth: na,
    tint: na,
  };
}

/* ═══════════════════════ kiểm chứng bằng số ═══════════════════════ */

/** Nền xám chuyển sắc nhẹ, không hoạ tiết: mọi thay đổi trên đó là do tuyết. */
function grayImage(w, h) {
  const buf = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w * 3; x < w; x++, p += 3) {
      const v = Math.round(70 + (60 * x) / w);
      buf[p] = v + 6; buf[p + 1] = v; buf[p + 2] = v - 6;
    }
  }
  return buf;
}

/**
 * Matte tổng hợp: hai "người" (đầu tròn + thân) đứng cao thấp khác nhau, ở cỡ
 * model (768×512) như matte thật — để thử che và chặn mặt theo từng người.
 */
function twoPeopleMatte(W, H) {
  const mw = 768, mh = Math.round((768 * H) / W), data = new Uint8Array(mw * mh);
  const people = [[0.36, 0.22], [0.64, 0.34]];   // [tâm ngang, đỉnh đầu] theo tỉ lệ khung
  for (let y = 0; y < mh; y++) {
    for (let x = 0; x < mw; x++) {
      const u = x / mw, v = y / mh;
      const on = people.some(([cx, top]) => {
        const head = Math.hypot((u - cx) / 0.06, (v - (top + 0.09)) / 0.09) < 1;
        const body = v > top + 0.16 && Math.abs(u - cx) < 0.12;
        return head || body;
      });
      data[y * mw + x] = on ? 255 : 0;
    }
  }
  return { data, width: mw, height: mh };
}

function columnTops(m) {
  const top = new Int32Array(m.width).fill(-1);
  for (let x = 0; x < m.width; x++) {
    for (let y = 0; y < m.height; y++) if (m.data[y * m.width + x] >= 128) { top[x] = y; break; }
  }
  return top;
}

/** Ô matte quanh điểm ảnh (x, y) — mọi ô trong bán kính r (đơn vị ô matte) đều là người / đều là nền. */
function matteBox(m, x, y, W, H, r, want) {
  const cx = Math.floor((x * m.width) / W), cy = Math.floor((y * m.height) / H);
  for (let j = -r; j <= r; j++) {
    for (let i = -r; i <= r; i++) {
      const xx = Math.min(m.width - 1, Math.max(0, cx + i)), yy = Math.min(m.height - 1, Math.max(0, cy + j));
      if ((m.data[yy * m.width + xx] === 255) !== want) return false;
    }
  }
  return true;
}
const insideMatte = (m, x, y, W, H, r) => matteBox(m, x, y, W, H, r, true);
const nearMatte = (m, x, y, W, H, r) => !matteBox(m, x, y, W, H, r, false);

/** Đếm điểm ảnh đổi màu theo nhãn mà `classify(x, y)` gán ('in' / 'out' / null = bỏ qua). */
function countChanges(after, before, W, H, classify) {
  const n = { in: 0, out: 0 };
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const p = (y * W + x) * 3;
      if (after[p] === before[p] && after[p + 1] === before[p + 1] && after[p + 2] === before[p + 2]) continue;
      const k = classify(x, y);
      if (k) n[k]++;
    }
  }
  return n;
}

/** Độ bão hoà HSV trung bình (lấy mẫu thưa). */
function meanSat(buf) {
  let s = 0, n = 0;
  for (let p = 0; p < buf.length; p += 3 * 7) {
    const mx = Math.max(buf[p], buf[p + 1], buf[p + 2]), mn = Math.min(buf[p], buf[p + 1], buf[p + 2]);
    s += mx ? (mx - mn) / mx : 0; n++;
  }
  return s / n;
}

/** Trung bình độ sáng được cộng thêm trên toàn ảnh — "lượng tuyết", không phụ thuộc độ phân giải. */
function addedLight(after, before) {
  let s = 0;
  for (let i = 0; i < after.length; i++) s += after[i] - before[i];
  return s / after.length;
}

/**
 * Kiểm chứng những lời hứa của bộ lọc bằng số đo:
 *   1. Cùng seed → cùng ảnh (chạy lại trên một tấm không đổi tuyết).
 *   2. Khác seed → khác bộ hạt.
 *   3. Không phụ thuộc độ phân giải — trang chỉnh xem ở ~1200px phải khớp
 *      snow.exe ở độ phân giải gốc: lượng tuyết hai cỡ lệch không quá 20%.
 *   4. Hạt phía sau bị vùng người che — cả elip lẫn matte: lõi vùng người
 *      không đổi một điểm ảnh nào.
 *   5. Chặn mặt: không hạt to phía trước nào có tâm trong dải mặt — với matte,
 *      dải mặt phải theo đúng đỉnh đầu của từng người.
 *   6. Thời gian ở cỡ ảnh booth 3000×2000.
 *   7. Model tách người có mặt và chạy được.
 */
export async function selftest(cfg) {
  const rows = [];
  const row = (label, ok, detail) => rows.push({ label, ok, detail });
  const base = normalizeSnow(cfg);

  // 1–2
  const W = 1500, H = 1000, g = grayImage(W, H);
  const a = Buffer.from(g), b = Buffer.from(g), c = Buffer.from(g);
  drawSnow(a, W, H, 3, base, { seed: 1234 });
  drawSnow(b, W, H, 3, base, { seed: 1234 });
  drawSnow(c, W, H, 3, base, { seed: 4321 });
  row('Cùng seed → cùng ảnh', a.equals(b), a.equals(b) ? 'trùng từng byte' : 'LỆCH — kết quả không tất định');
  row('Khác seed → khác hạt', !a.equals(c), !a.equals(c) ? 'bộ hạt khác nhau' : 'GIỐNG HỆT — seed không có tác dụng');

  // 2b: mỗi khách một "texture" tuyết riêng — 16 ảnh, không cặp nào trùng
  const SW = 600, SH = 400, gs = grayImage(SW, SH), outs = [];
  for (let k = 0; k < 16; k++) {
    const b2 = Buffer.from(gs);
    drawSnow(b2, SW, SH, 3, base, { seed: 1000 + k * 7919 });
    outs.push(b2);
  }
  let minDiff = Infinity, twins = 0;
  for (let i = 0; i < outs.length; i++) {
    for (let j = i + 1; j < outs.length; j++) {
      let sum = 0;
      for (let p = 0; p < outs[i].length; p++) sum += Math.abs(outs[i][p] - outs[j][p]);
      const dd = sum / outs[i].length;
      if (dd === 0) twins++;
      minDiff = Math.min(minDiff, dd);
    }
  }
  row('Mỗi ảnh một texture riêng', twins === 0 && minDiff > 0.5,
    `16 ảnh · ${twins} cặp trùng · cặp giống nhau nhất vẫn lệch ${minDiff.toFixed(2)} mức / điểm ảnh`);

  // 2c: seed theo NỘI DUNG file — cùng tên (máy ảnh đếm lại IMG_0001) mà khác ảnh thì khác tuyết
  const tmp = mkdtempSync(join(tmpdir(), 'snow-'));
  mkdirSync(join(tmp, 'a')); mkdirSync(join(tmp, 'b'));
  writeFileSync(join(tmp, 'a', 'IMG_0001.JPG'), Buffer.from('ảnh của khách thứ nhất'));
  writeFileSync(join(tmp, 'b', 'IMG_0001.JPG'), Buffer.from('ảnh của khách thứ hai'));
  const sa = seedFromFile(join(tmp, 'a', 'IMG_0001.JPG')), sb = seedFromFile(join(tmp, 'b', 'IMG_0001.JPG'));
  const sa2 = seedFromFile(join(tmp, 'a', 'IMG_0001.JPG'));
  rmSync(tmp, { recursive: true, force: true });
  row('Trùng tên file vẫn khác tuyết', sa !== sb && sa === sa2,
    `IMG_0001 của hai khách: seed ${sa} / ${sb} · chạy lại cùng file: ${sa === sa2 ? 'y hệt' : 'LỆCH'}`);

  // 3
  const g2 = grayImage(W * 2, H * 2), d = Buffer.from(g2);
  drawSnow(d, W * 2, H * 2, 3, base, { seed: 1234 });
  const l1 = addedLight(a, g), l2 = addedLight(d, g2);
  const drift = l1 > 0 ? Math.abs(l2 - l1) / l1 : 1;
  row('Không phụ thuộc độ phân giải', drift <= 0.2,
    `lượng tuyết ${l1.toFixed(2)} ở ${W}px · ${l2.toFixed(2)} ở ${W * 2}px (lệch ${(drift * 100).toFixed(1)}%, ngưỡng 20%)`);

  // 4: chỉ lớp sau lưng + xa, vùng người (elip) ở giữa khung
  const layersBehind = { ...base.layers, lens: { ...base.layers.lens, enabled: false }, front: { ...base.layers.front, enabled: false }, focus: { ...base.layers.focus, enabled: false } };
  const behindOnly = normalizeSnow({ ...base, layers: layersBehind, subject: { mode: 'ellipse', x: 50, y: 50, w: 40, h: 60, feather: 10 } });
  const e = Buffer.from(g);
  drawSnow(e, W, H, 3, behindOnly, { seed: 99 });
  const rx = 0.2 * W, ry = 0.3 * H;
  const occ = countChanges(e, g, W, H, (x, y) => {
    const r = Math.hypot((x + 0.5 - W / 2) / rx, (y + 0.5 - H / 2) / ry);
    return r < 0.85 ? 'in' : r > 1.2 ? 'out' : null;
  });
  row('Hạt sau lưng bị elip che', occ.in === 0 && occ.out > 0,
    `lõi vùng người đổi ${occ.in} điểm ảnh (phải là 0) · ngoài vùng đổi ${occ.out}`);

  // 4b: cùng phép thử, vùng người là matte (hai người cao thấp khác nhau)
  const matte = twoPeopleMatte(W, H);
  const viaMatte = normalizeSnow({ ...base, layers: layersBehind, subject: { mode: 'auto' } });
  const f = Buffer.from(g);
  drawSnow(f, W, H, 3, viaMatte, { seed: 99, matte });
  const occM = countChanges(f, g, W, H, (x, y) => {
    const v = matte.data[Math.floor((y * matte.height) / H) * matte.width + Math.floor((x * matte.width) / W)];
    return v === 255 && insideMatte(matte, x, y, W, H, 6) ? 'in' : v === 0 && !nearMatte(matte, x, y, W, H, 6) ? 'out' : null;
  });
  row('Hạt sau lưng bị matte che', occM.in === 0 && occM.out > 0,
    `lõi dáng người đổi ${occM.in} điểm ảnh (phải là 0) · ngoài người đổi ${occM.out}`);

  // 5
  const guarded = normalizeSnow({
    ...base,
    layers: { ...base.layers, lens: { ...base.layers.lens, enabled: true, count: 60 } },
    subject: { mode: 'ellipse', x: 50, y: 60, w: 50, h: 100, feather: 10 },
    faceGuard: { enabled: true, maxSize: 4 },
  });
  const scene = buildScene(W, H, guarded, 7);
  const zx = W / 2, zy = 0.6 * H, zrx = 0.25 * W, zry = 0.5 * H, lim = 0.04 * W;
  const bad = scene.particles.filter((p) => {
    if (p.Z >= guarded.camera.focus || p.D + p.C <= lim) return false;
    const dx = (p.x - zx) / zrx, dy = (p.y - zy) / zry;
    return dx * dx + dy * dy < 1 && p.y < zy - 0.1 * zry;
  }).length;
  row('Chặn hạt to khỏi mặt (elip)', bad === 0, `${bad} hạt to trong dải mặt (phải là 0) · ${scene.stats.guarded} hạt bị bỏ vì không tìm được chỗ`);

  // 5b: chặn mặt theo matte — dải mặt đi theo đỉnh đầu của TỪNG người
  const guardedM = normalizeSnow({ ...guarded, subject: { mode: 'auto' } });
  const sceneM = buildScene(W, H, guardedM, 7, matte);
  const tops = columnTops(matte);
  const badM = sceneM.particles.filter((p) => {
    if (p.Z >= guardedM.camera.focus || p.D + p.C <= lim) return false;
    const t = tops[Math.min(matte.width - 1, Math.floor((p.x * matte.width) / W))];
    const my = (p.y * matte.height) / H;
    return t >= 0 && my >= t && my <= t + 0.25 * matte.height;
  }).length;
  row('Chặn hạt to khỏi mặt (matte)', badM === 0, `${badM} tâm hạt to trong dải mặt của hai người (phải là 0)`);

  // 6
  const BW = 3000, BH = 2000, big = grayImage(BW, BH);
  const t0 = Date.now();
  drawSnow(big, BW, BH, 3, base, { seed: 2024 });
  const ms = Date.now() - t0;
  row('Thời gian 3000×2000', ms < 1500, `${ms} ms cho riêng phần tuyết (ngưỡng 1500 ms)`);

  // 6b: màu chạy sau tuyết — preset mercies phải làm ảnh nhạt màu đi (giảm bão hoà)
  const snowOnly = Buffer.from(grayImage(W, H));
  for (let i = 0; i < snowOnly.length; i += 3) { snowOnly[i] = Math.min(255, snowOnly[i] + 40); }   // nền ấm, có màu để giảm
  drawSnow(snowOnly, W, H, 3, base, { seed: 5 });
  const graded = Buffer.from(snowOnly);
  const t2 = Date.now();
  renderLook(graded, W, H, 3, { enabled: true, ...lookPreset('mercies') }, { seed: 5 });
  const lms = Date.now() - t2;
  const s0 = meanSat(snowOnly), s1 = meanSat(graded);
  row('Màu mercies sau tuyết', s1 < s0 * 0.9,
    `bão hoà TB ${(s0 * 100).toFixed(1)}% → ${(s1 * 100).toFixed(1)}% (phải giảm ≥10%) · ${lms} ms ở ${W}×${H}`);

  // 7: model tách người có mặt và chạy được trên cỡ ảnh booth
  const model = cfg.subject ? cfg.subject.model : 'modnet';
  if (!existsSync(modelPath(model))) {
    row('Model tách người', false, `THIẾU models/${MATTE_MODELS[model].file} — chạy: npm run model -- ${model}`);
  } else {
    try {
      const t1 = Date.now();
      const m = await personMatte(grayImage(BW, BH), BW, BH, model);
      const mms = Date.now() - t1, limit = model === 'modnet' ? 2000 : 8000;
      row(`Model tách người (${model})`, m.width === 768 && m.height === 512 && mms < limit,
        `matte ${m.width}×${m.height} · ${mms} ms kể cả nạp model (ngưỡng ${limit} ms, đo lại trên máy booth)`);
    } catch (err) {
      row('Model tách người', false, `LỖI: ${err.message}`);
    }
  }

  const rule = '  ' + '─'.repeat(96);
  console.log('\n  KIỂM CHỨNG BỘ LỌC TUYẾT');
  console.log(rule);
  for (const r of rows) console.log(`  ${(r.ok ? '[ ĐẠT ]' : '[ LỖI ]')}  ${r.label.padEnd(30)} ${r.detail}`);
  console.log(rule);
  const all = rows.every((r) => r.ok);
  console.log(all ? '  Mọi mệnh đề đều đúng.\n' : `  ${rows.filter((r) => !r.ok).length} mệnh đề sai.\n`);
  return all;
}
