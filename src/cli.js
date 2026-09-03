#!/usr/bin/env node
import {
  appendFileSync, closeSync, copyFileSync, existsSync, mkdirSync, openSync,
  readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync,
} from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { loadConfig, ROOT } from './config.js';

/**
 * ĐIỂM VÀO — vừa là đích của dslrBooth Triggers, vừa là công cụ dòng lệnh.
 *
 * dslrBooth gọi chương trình này NHIỀU LẦN mỗi phiên, với dạng:
 *     cli.js <EventType> <param1> <param2> ...
 * nên nhánh xử lý sự kiện phải thoát thật nhanh khi không liên quan. Vì lý do
 * đó sharp chỉ được nạp khi thực sự cần đụng vào ảnh — nạp libvips tốn hơn
 * 100ms, không đáng trả cho mỗi nhịp countdown.
 */

const LOG = join(ROOT, 'logs', 'softlight.log');
const JPEG_EXT = new Set(['.jpg', '.jpeg']);

function log(fields) {
  const line = JSON.stringify({ t: new Date().toISOString(), ...fields });
  try {
    mkdirSync(dirname(LOG), { recursive: true });
    appendFileSync(LOG, line + '\n');
  } catch {
    /* không bao giờ để việc ghi log làm hỏng một phiên chụp */
  }
  if (process.env.SOFTLIGHT_VERBOSE || !process.env.SOFTLIGHT_QUIET) console.log(line);
}

/* ═══════════════════════ xử lý một file ═══════════════════════ */

async function processFile(path, cfg, { force = false, via = 'cli' } = {}) {
  const started = Date.now();

  if (!existsSync(path)) return log({ ev: 'skip', reason: 'không tìm thấy file', path });
  if (!JPEG_EXT.has(extname(path).toLowerCase())) {
    return log({ ev: 'skip', reason: 'không phải JPEG', path });
  }

  // Chốt chặn phòng khi dslrBooth gọi cả trên file template đã ghép: làm mềm
  // cả tờ in sẽ nhoè luôn khung và logo. Xem log để biết dslrBooth thực sự đưa
  // vào những đường dẫn nào, rồi thêm mẫu vào skip.pathContains nếu cần.
  const lower = path.toLowerCase();
  const hit = cfg.skip.pathContains.find((k) => lower.includes(k.toLowerCase()));
  if (hit) return log({ ev: 'skip', reason: `khớp skip.pathContains "${hit}"`, path });

  const backupDir = join(dirname(path), cfg.backup.folder);
  const backupPath = join(backupDir, basename(path));

  // Sự tồn tại của bản backup chính là dấu hiệu "đã xử lý". dslrBooth có thể
  // bắn trigger lặp, và ảnh đã xử lý mà chạy lại lần nữa sẽ bị mờ chồng mờ.
  if (!force && cfg.backup.enabled && existsSync(backupPath)) {
    return log({ ev: 'skip', reason: 'đã xử lý trước đó', path });
  }

  // Chốt chống chạy song song. Bản backup ở trên không đủ: nếu cùng một ảnh
  // được gọi hai lần gần như đồng thời (ví dụ cấu hình cả Post-Processing lẫn
  // Triggers), cả hai tiến trình đều thấy chưa có backup và cùng xử lý — ảnh sẽ
  // bị mờ chồng mờ. Cờ 'wx' tạo file nguyên tử ở mức hệ điều hành nên chỉ đúng
  // một tiến trình giành được.
  const lockPath = path + '.softlight.lock';
  let lockFd;
  try {
    lockFd = openSync(lockPath, 'wx');
  } catch (err) {
    if (err.code !== 'EEXIST') throw err;
    // Khoá cũ còn sót lại do một lần chạy trước bị giết giữa chừng thì bỏ qua.
    const age = Date.now() - statSync(lockPath).mtimeMs;
    if (age < 120000) return log({ ev: 'skip', reason: 'đang được xử lý bởi tiến trình khác', path });
    try { unlinkSync(lockPath); } catch { /* tranh chấp, để lần sau */ }
    lockFd = openSync(lockPath, 'w');
  }

  try {
    await processLocked(path, cfg, { via, started, backupDir, backupPath });
  } finally {
    try { closeSync(lockFd); unlinkSync(lockPath); } catch { /* dọn dẹp */ }
  }
}

async function processLocked(path, cfg, { via, started, backupDir, backupPath }) {
  const { renderSoftLight } = await import('./pipeline.js');
  const sharp = (await import('sharp')).default;

  const meta = await sharp(path).metadata();
  const minEdge = Math.min(meta.width || 0, meta.height || 0);
  if (minEdge < cfg.limits.minEdge) {
    return log({ ev: 'skip', reason: `ảnh nhỏ (${meta.width}x${meta.height})`, path });
  }

  if (cfg.backup.enabled) {
    mkdirSync(backupDir, { recursive: true });
    copyFileSync(path, backupPath);
  }

  // Ghi ra file tạm cùng ổ đĩa rồi đổi tên đè lên: thao tác đổi tên là nguyên
  // tử, nên dslrBooth không bao giờ đọc phải một file JPEG viết dở.
  const tmp = path + '.softlight.tmp';
  try {
    const { jpeg, width, height } = await renderSoftLight(path, cfg);
    writeFileSync(tmp, jpeg);
    renameSync(tmp, path);
    const ms = Date.now() - started;
    log({
      ev: 'done',
      via,
      path,
      size: `${width}x${height}`,
      ms,
      ...(ms > cfg.limits.maxMs ? { warn: `chậm hơn ngưỡng ${cfg.limits.maxMs}ms` } : {}),
    });
  } catch (err) {
    try { if (existsSync(tmp)) unlinkSync(tmp); } catch { /* dọn dẹp, bỏ qua lỗi */ }
    log({ ev: 'error', path, ms: Date.now() - started, error: String(err && err.message ? err.message : err) });
  }
}

/* ═══════════════════════ các chế độ thủ công ═══════════════════════ */

async function cmdPreview(path, cfg) {
  const { renderComparison, renderSoftLight } = await import('./pipeline.js');
  const out = path.replace(/\.(jpe?g)$/i, '') + '.SO-SANH.jpg';
  const started = Date.now();
  writeFileSync(out, await renderComparison(path, cfg));
  console.log(`Đã ghi ảnh so sánh trái=gốc / phải=đã xử lý (${Date.now() - started}ms):\n  ${out}`);
  console.log('Ảnh gốc KHÔNG bị đụng tới. Sửa softlight.config.json rồi chạy lại để so.');

  // Bảng hài hoà đo trên ẢNH THẬT có ý nghĩa hơn hẳn so với đo trên ảnh kiểm
  // tổng hợp của --selftest, vốn cố tình chứa cả mảng đen kịt lẫn đốm cháy sáng.
  const { jpeg } = await renderSoftLight(path, cfg);
  await reportHarmony(jpeg);
}

async function cmdDir(dir, cfg, force) {
  if (!existsSync(dir)) throw new Error(`Không tìm thấy thư mục: ${dir}`);
  const files = readdirSync(dir)
    .filter((f) => JPEG_EXT.has(extname(f).toLowerCase()))
    .map((f) => join(dir, f))
    .filter((f) => statSync(f).isFile());
  console.log(`Xử lý ${files.length} ảnh trong ${dir}`);
  const t0 = Date.now();
  for (const f of files) await processFile(f, cfg, { force });
  console.log(`Xong ${files.length} ảnh trong ${((Date.now() - t0) / 1000).toFixed(1)}s`);
}

/** Trả ảnh gốc từ thư mục backup về chỗ cũ. Lối thoát khi chỉnh tham số hỏng. */
function cmdRestore(dir, cfg) {
  const backupDir = join(dir, cfg.backup.folder);
  if (!existsSync(backupDir)) throw new Error(`Không có thư mục backup: ${backupDir}`);
  let n = 0;
  for (const f of readdirSync(backupDir)) {
    if (!JPEG_EXT.has(extname(f).toLowerCase())) continue;
    copyFileSync(join(backupDir, f), join(dir, f));
    n++;
  }
  console.log(`Đã trả ${n} ảnh gốc về ${dir}`);
  console.log(`Thư mục ${cfg.backup.folder} vẫn còn — xoá nó nếu muốn xử lý lại từ đầu.`);
}

/**
 * Chẩn đoán môi trường trên máy đích.
 *
 * Lý do tồn tại: softlight.exe chạy ở chế độ winexe nên khi thiếu thứ gì nó
 * không có cửa sổ nào để báo. Lệnh này kiểm tra từng mắt xích theo đúng thứ tự
 * mà launcher đi qua, và nói rõ phải làm gì để sửa.
 */
async function cmdDoctor() {
  const ok = [];
  const bad = [];
  const line = (good, label, detail) => (good ? ok : bad).push([label, detail]);

  line(true, 'Thư mục cài đặt', ROOT);
  line(process.versions.node.split('.')[0] >= 18, `Node.js ${process.version}`,
    process.versions.node.split('.')[0] >= 18 ? 'đạt yêu cầu (>=18)' : 'CẦN Node.js 18 trở lên');
  line(existsSync(join(ROOT, 'src', 'cli.js')), 'src/cli.js', 'bộ xử lý');
  line(existsSync(join(ROOT, 'node_modules')), 'node_modules/',
    existsSync(join(ROOT, 'node_modules')) ? 'có' : 'THIẾU — chạy: npm install');
  line(existsSync(join(ROOT, 'softlight.config.json')), 'softlight.config.json',
    existsSync(join(ROOT, 'softlight.config.json')) ? 'có' : 'THIẾU — dùng giá trị mặc định');
  line(existsSync(join(ROOT, 'softlight.exe')), 'softlight.exe',
    existsSync(join(ROOT, 'softlight.exe')) ? 'có' : 'THIẾU — chạy: build-exe.bat');

  const npf = join(ROOT, 'node-path.txt');
  if (existsSync(npf)) {
    const p = readFileSync(npf, 'utf8').trim();
    line(existsSync(p), 'node-path.txt', existsSync(p) ? p : `TRỎ SAI CHỖ: ${p} — xoá file này hoặc sửa lại`);
  }
  const bundled = join(ROOT, 'node', 'node.exe');
  if (existsSync(bundled)) line(true, 'Node xách tay đi kèm', bundled);

  // Quyền ghi: nếu thư mục chỉ đọc thì cả log lẫn ảnh đều ghi hỏng trong im lặng.
  let writable = true;
  try {
    mkdirSync(join(ROOT, 'logs'), { recursive: true });
    const probe = join(ROOT, 'logs', '_probe.tmp');
    writeFileSync(probe, 'x');
    unlinkSync(probe);
  } catch (err) {
    writable = false;
    line(false, 'Quyền ghi', `KHÔNG ghi được vào ${ROOT} (${err.code}) — chuyển ra ngoài Program Files`);
  }
  if (writable) line(true, 'Quyền ghi', 'ghi được vào thư mục cài đặt');

  // sharp là mắt xích hay hỏng nhất khi chép node_modules giữa hai máy.
  try {
    const sharp = (await import('sharp')).default;
    const px = await sharp({ create: { width: 8, height: 8, channels: 3, background: '#888' } })
      .jpeg().toBuffer();
    line(px.length > 0, `sharp (libvips ${sharp.versions.vips})`, 'nạp và mã hoá JPEG được');
  } catch (err) {
    line(false, 'sharp', `KHÔNG nạp được: ${err.message} — chạy lại: npm install`);
  }

  const cfg = loadConfig();
  line(cfg.enabled, 'Cấu hình', cfg.enabled ? 'đang bật' : 'ĐANG TẮT (enabled: false)');

  const rule = '  ' + '─'.repeat(72);
  console.log('');
  console.log('  KIỂM TRA MÔI TRƯỜNG');
  console.log(rule);
  for (const [l, d] of ok) console.log(`  [ OK ]  ${l.padEnd(28)} ${d}`);
  for (const [l, d] of bad) console.log(`  [LỖI]   ${l.padEnd(28)} ${d}`);
  console.log(rule);
  if (bad.length === 0) {
    console.log('  Mọi thứ sẵn sàng. Trỏ dslrBooth Post-Processing tới:');
    console.log('  ' + join(ROOT, 'softlight.exe'));
  } else {
    console.log(`  Còn ${bad.length} vấn đề phải sửa trước khi cắm vào dslrBooth.`);
  }
  console.log('');
}

/**
 * Ảnh tổng hợp để đo hiệu ứng. Thành phần được chọn có chủ ý:
 *  - ba lưới sin ở ba tần số khác nhau, để tách được tầng soft focus (tần cao)
 *    khỏi tầng clarity (tần trung);
 *  - một vùng cực sáng, đóng vai chấm bi phông booth: `bloom.highlightCutoff`
 *    phải loại được nó ra khỏi lớp mờ;
 *  - một dải ô tông da, để mặt nạ của tầng bloom có chỗ bám;
 *  - nền chuyển sắc hồng và các ô tông da, giống điều kiện phông booth.
 * Mã hoá ở chất lượng 100 / 4:4:4 để nhiễu nén JPEG không lẫn vào dải tần cao.
 */
async function makeTestImage(w = 3000, h = 2000) {
  const sharp = (await import('sharp')).default;
  const buf = Buffer.alloc(w * h * 3);
  const skin = [[243, 211, 189], [224, 176, 144], [201, 142, 106], [141, 90, 60]];

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const k = (y * w + x) * 3;
      const gx = x / w;
      const gy = y / h;

      const spot = Math.exp(-(((gx - 0.74) ** 2 + (gy - 0.28) ** 2) / 0.010));
      const fine = 16 * Math.sin((x / 2.5) * Math.PI) * Math.sin((y / 2.5) * Math.PI);
      const mid = 20 * Math.sin((x / 26) * Math.PI) * Math.sin((y / 26) * Math.PI);
      const coarse = 18 * Math.sin((x / 180) * Math.PI);

      let r, g, b;
      const band = Math.floor(gy * 5);
      if (band === 3 && gx < 0.8) {
        // Dải ô tông da, giữ nguyên hoa văn tần cao để đo độ mịn trên da.
        const c = skin[Math.min(skin.length - 1, Math.floor(gx * 5))];
        [r, g, b] = [c[0] + fine, c[1] + fine, c[2] + fine];
      } else if (band === 4 && gx < 0.25) {
        // Mảng đen kịt, để đo được đầu dưới của đường cong đáp ứng hạt.
        const v = 14 * (gx / 0.25) + fine * 0.2;
        [r, g, b] = [v, v, v];
      } else {
        const base = 70 + 105 * gx + 35 * gy + 160 * spot + fine + mid + coarse;
        [r, g, b] = [base + 28, base - 3, base - 18];
      }
      buf[k] = Math.max(0, Math.min(255, r));
      buf[k + 1] = Math.max(0, Math.min(255, g));
      buf[k + 2] = Math.max(0, Math.min(255, b));
    }
  }
  return sharp(buf, { raw: { width: w, height: h, channels: 3 } })
    .jpeg({ quality: 100, chromaSubsampling: '4:4:4' })
    .toBuffer();
}

/**
 * Kiểm chứng đặc trưng cốt lõi của tầng bloom: DA sáng lên, PHÔNG gần như
 * không đổi. Đây là thứ phân biệt cách làm hiện tại với cách cắt ngưỡng theo
 * độ sáng cũ — cách cũ đánh mạnh nhất đúng vào chỗ sáng nhất của phông.
 *
 * Vùng ngay sát da vẫn đổi chút ít vì quầng sáng loang ra, nên tiêu chí là tỉ
 * lệ chứ không phải bằng 0 tuyệt đối.
 */
async function reportSkinSplit(beforeJpeg, afterJpeg) {
  const sharp = (await import('sharp')).default;
  const { isSkin } = await import('./pipeline.js');
  const [x, y] = await Promise.all(
    [beforeJpeg, afterJpeg].map((buf) =>
      sharp(buf).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true }),
    ),
  );
  const n = x.info.width * x.info.height;
  let skinSum = 0;
  let skinN = 0;
  let bgSum = 0;
  let bgN = 0;

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const d =
      (Math.abs(y.data[k] - x.data[k]) +
        Math.abs(y.data[k + 1] - x.data[k + 1]) +
        Math.abs(y.data[k + 2] - x.data[k + 2])) /
      3;
    if (isSkin(x.data[k], x.data[k + 1], x.data[k + 2])) {
      skinSum += d;
      skinN++;
    } else {
      bgSum += d;
      bgN++;
    }
  }

  const skin = skinN ? skinSum / skinN : 0;
  const bg = bgN ? bgSum / bgN : 0;
  const ratio = bg > 0.01 ? skin / bg : Infinity;

  console.log(
    `\n  Mức thay đổi trên vùng DA ${skin.toFixed(1)}/255 · trên PHÔNG ${bg.toFixed(1)}/255` +
      `  (gấp ${Number.isFinite(ratio) ? ratio.toFixed(1) : '∞'} lần)`,
  );
  console.log(
    ratio >= 3
      ? '  → Đúng đặc trưng: hiệu ứng ăn vào da, phông nền giữ nguyên nét.'
      : '  → CẢNH BÁO: phông nền bị ảnh hưởng gần bằng da. Kiểm tra bloom.skinOnly và bloom.highlightCutoff.',
  );
}

/**
 * Kiểm chứng đường cong đáp ứng của tầng hạt. Dựng lại chính ảnh đó với
 * `grain.amount = 0` rồi đo độ lệch chuẩn của phần chênh nhau, chia theo ba
 * dải sáng. Hạt giả rải đều cả ba dải; hạt phim phải đậm ở trung gian và tắt
 * hẳn ở đen kịt lẫn cháy sáng.
 */
async function reportGrain(testPath, cfg) {
  const sharp = (await import('sharp')).default;
  const { renderSoftLight } = await import('./pipeline.js');
  // Mã hoá không tổn hao cho phép đo: ở chất lượng thường, nhiễu lượng tử của
  // JPEG lấn át đúng cái ta muốn đo ở hai đầu dải, nơi hạt gần bằng 0.
  const lossless = (c) => ({ ...c, output: { quality: 100, chromaSubsampling: '4:4:4' } });
  const plain = JSON.parse(JSON.stringify(cfg));
  plain.grain.amount = 0;

  const [{ jpeg: withG }, { jpeg: noG }] = await Promise.all([
    renderSoftLight(testPath, lossless(cfg)),
    renderSoftLight(testPath, lossless(plain)),
  ]);
  const [x, y] = await Promise.all(
    [noG, withG].map((b) => sharp(b).toColourspace('srgb').raw().toBuffer({ resolveWithObject: true })),
  );

  // Chỉ lấy ba dải HẸP ở nơi đường cong đáp ứng nói rõ phải bằng 0, bằng 1 rồi
  // lại bằng 0 — dải rộng sẽ trộn lẫn phần chuyển tiếp và làm nhoè kết luận.
  const sq = [0, 0, 0];
  const cnt = [0, 0, 0];
  const n = x.info.width * x.info.height;

  for (let i = 0, k = 0; i < n; i++, k += 3) {
    const lum = (x.data[k] * 77 + x.data[k + 1] * 150 + x.data[k + 2] * 29) >> 8;
    let band = -1;
    if (lum <= 3) band = 0;
    else if (lum >= 60 && lum <= 180) band = 1;
    else if (lum >= 250) band = 2;
    if (band < 0) continue;
    for (let c = 0; c < 3; c++) sq[band] += (y.data[k + c] - x.data[k + c]) ** 2;
    cnt[band] += 3;
  }

  const sd = sq.map((s, i) => (cnt[i] ? Math.sqrt(s / cnt[i]) : 0));
  const name = ['đen kịt (≤3)', 'trung gian', 'cháy sáng (≥250)'];
  console.log('\n  Biên độ hạt theo dải sáng (độ lệch chuẩn so với bản không hạt):');
  for (let i = 0; i < 3; i++) {
    console.log(
      `    ${name[i].padEnd(18)}${sd[i].toFixed(2).padStart(6)}/255` +
        (cnt[i] ? '' : '   (ảnh kiểm không có dải này)'),
    );
  }
  const ok = sd[1] > 0.5 && sd[1] > sd[0] * 2 && sd[1] > sd[2] * 2;
  console.log(
    ok
      ? '  → Đúng đặc trưng hạt phim: đậm ở trung gian, cuộn về 0 ở hai đầu dải.'
      : '  → CẢNH BÁO: hạt rải gần như đều khắp dải sáng, sẽ đọc ra như nhiễu số.\n' +
          '    Kiểm tra grain.shadowRolloff và grain.highlightRolloff.',
  );
}

/**
 * Bảng chấm độ hài hoà của ảnh ĐẦU RA. Khác với bảng chỉ số ở trên — vốn chỉ
 * nói ảnh đổi thế nào — bảng này nói ảnh có dùng được hay không, và sai thì
 * xoay tham số nào.
 */
async function reportHarmony(jpeg) {
  const { harmonyOf, harmonyVerdicts, HARMONY } = await import('./pipeline.js');
  const m = await harmonyOf(jpeg);
  const v = harmonyVerdicts(m);
  const H = HARMONY;

  const row = (label, value, target, verdict) => {
    console.log(
      `  ${label.padEnd(24)}${value.padStart(11)}   ${target.padEnd(15)}` +
        `${(verdict.ok ? 'ĐẠT' : 'CẢNH BÁO').padEnd(11)}${verdict.note}`,
    );
  };

  console.log('\n  ĐỘ HÀI HOÀ CỦA ẢNH ĐẦU RA');
  console.log('  chỉ số                       giá trị   ngưỡng         kết quả');
  console.log('  ' + '─'.repeat(94));
  row('Bết đen (Y < 4)', m.crushedPct.toFixed(2) + '%', `≤ ${H.crushedPct.max}%`, v.crushed);
  row('Cháy sáng (Y > 251)', m.blownPct.toFixed(2) + '%', `≤ ${H.blownPct.max}%`, v.blown);
  row(
    'Da so với phông',
    `${m.skinMean.toFixed(0)} / ${m.bgMean.toFixed(0)}`,
    'da ≥ phông',
    v.subject,
  );
  row('Độ ấm (R − B)', m.warmth.toFixed(1), `${H.warmth.min}…${H.warmth.max}`, v.warmth);
  row('Sắc da G−(R+B)/2', m.skinTint.toFixed(1), `${H.skinTint.min}…+${H.skinTint.max}`, v.tint);
  console.log(`\n  Vùng da chiếm ${m.skinShare.toFixed(1)}% khung hình.`);
  return m;
}

async function cmdSelftest(cfg) {
  const { renderSoftLight, measure } = await import('./pipeline.js');
  const tmp = join(ROOT, 'logs', '_selftest.jpg');
  mkdirSync(dirname(tmp), { recursive: true });

  const original = await makeTestImage();
  writeFileSync(tmp, original);

  const t0 = Date.now();
  const { jpeg, width, height, stages } = await renderSoftLight(tmp, cfg, { trace: true });
  const ms = Date.now() - t0;

  const a = await measure(original);
  const b = await measure(jpeg);

  const pct = (x, y) => {
    const d = (y / x - 1) * 100;
    return (d >= 0 ? '+' : '') + d.toFixed(1) + '%';
  };
  const row = (name, x, y, want, note) => {
    // want = null: chỉ báo cáo, không chấm đạt / không đạt. Dùng cho những chỉ
    // số chỉ có nghĩa khi tầng tương ứng được bật trong cấu hình.
    const verdict = want === null ? '—' : (want === '+' ? y > x : y < x) ? 'ĐẠT' : 'KHÔNG ĐẠT';
    console.log(
      `  ${name.padEnd(22)}${x.toFixed(2).padStart(8)} →${y.toFixed(2).padStart(8)}${pct(x, y).padStart(9)}   ${verdict.padEnd(10)}${note}`,
    );
  };

  const soft = cfg.softFocus.amount > 0.001 || cfg.clarity.amount > 0.001;
  const warmer = cfg.warm.temp > 0 || cfg.warm.highlightWarmth > 0.001;

  console.log(`\nẢnh kiểm ${width}×${height} · xử lý ${ms}ms\n`);
  console.log('  chỉ số                  trước       sau   thay đổi   kết quả    kỳ vọng');
  console.log('  ' + '─'.repeat(78));
  row('Độ sáng trung bình', a.mean, b.mean, '+', 'bloom nâng sáng vùng da');
  row('Độ nét (tần cao)', a.fine, b.fine, soft ? '-' : null, soft ? 'soft focus làm mềm' : 'softFocus/clarity đang tắt');
  row('Clarity (tần trung)', a.mid, b.mid, soft ? '-' : null, soft ? 'bớt gắt' : 'softFocus/clarity đang tắt');
  row('Tương phản tổng thể', a.global, b.global, '-', 'dịu lại');
  row('Độ ấm (đỏ − lam)', a.warmth, b.warmth, warmer ? '+' : null, warmer ? 'ấm hơn' : 'tầng warm đang tắt');

  await reportSkinSplit(original, jpeg);
  if (cfg.grain.amount > 0.0005) await reportGrain(tmp, cfg);
  unlinkSync(tmp);
  await reportHarmony(jpeg);
  console.log(
    '  Lưu ý: ảnh kiểm cố tình có cả mảng đen kịt lẫn đốm cháy sáng để đo được\n' +
      '  hai đầu dải, nên hai dòng đầu bảng trên hầu như luôn cảnh báo. Chấm trên\n' +
      '  ảnh thật bằng: node src/cli.js --preview <ảnh.jpg>',
  );

  if (stages.length) {
    console.log('\n  Diễn biến qua từng tầng:');
    console.log('    tầng               sáng     nét    clarity   tổng thể   ấm');
    console.log('    ' + '─'.repeat(60));
    for (const s of stages) {
      console.log(
        `    ${s.name.padEnd(16)}${s.mean.toFixed(1).padStart(7)}${s.fine.toFixed(1).padStart(8)}${s.mid.toFixed(1).padStart(9)}${s.global.toFixed(1).padStart(11)}${s.warmth.toFixed(1).padStart(7)}`,
      );
    }
  }
  console.log('');
}

async function cmdBench(path, cfg) {
  const { renderSoftLight } = await import('./pipeline.js');
  const sharp = (await import('sharp')).default;
  const meta = await sharp(path).metadata();
  const runs = [];
  for (let i = 0; i < 5; i++) {
    const t = Date.now();
    await renderSoftLight(path, cfg);
    runs.push(Date.now() - t);
  }
  runs.sort((x, y) => x - y);
  console.log(`${meta.width}×${meta.height} (${(meta.width * meta.height / 1e6).toFixed(1)}MP)`);
  console.log(`  nhanh nhất ${runs[0]}ms · trung vị ${runs[2]}ms · chậm nhất ${runs[4]}ms`);
  console.log('  Cộng thêm ~460ms khởi động Node + sharp cho mỗi lần dslrBooth gọi.');
}

function usage() {
  console.log(`
filmong-softlight — hậu kỳ Soft Light cho dslrBooth

  Gọi từ dslrBooth Triggers (tự động):
    cli.js <EventType> <param1> ...        chỉ hành động với file_download

  Dùng tay:
    node src/cli.js --preview  <anh.jpg>   ghi ảnh so sánh trước/sau, KHÔNG ghi đè
    node src/cli.js --file     <anh.jpg>   xử lý một ảnh (ghi đè, có backup)
    node src/cli.js --dir      <thu-muc>   xử lý cả thư mục
    node src/cli.js --restore  <thu-muc>   trả ảnh gốc từ backup về chỗ cũ
    node src/cli.js --doctor               kiểm tra môi trường trên máy đích
    node src/cli.js --selftest             kiểm chứng hiệu ứng bằng số đo
    node src/cli.js --bench    <anh.jpg>   đo tốc độ trên ảnh thật
    thêm --force                           xử lý lại kể cả khi đã có backup
`);
}

/* ═══════════════════════ điều phối ═══════════════════════ */

/**
 * dslrBooth gọi chương trình này theo HAI cách khác nhau, và chúng khác nhau ở
 * chỗ quan trọng nhất — tham số đầu tiên:
 *
 *   Post-Processing  →  softlight.exe "C:\...\IMG_0001.jpg"
 *                       Gọi thẳng với đường dẫn ảnh, KHÔNG có EventType.
 *                       Đây là đường chính: dslrBooth chờ chương trình xong
 *                       rồi mới dùng ảnh, nên hiệu ứng chắc chắn vào bản in.
 *
 *   Triggers         →  softlight.exe file_download "C:\...\IMG_0001.jpg"
 *                       Tham số đầu là tên sự kiện.
 *
 * Nhận diện bằng cách đối chiếu với danh sách sự kiện đã biết, không đoán theo
 * hình dạng chuỗi — một file tên "printing.jpg" sẽ không bị hiểu nhầm.
 */
const TRIGGER_EVENTS = new Set([
  'session_start', 'countdown_start', 'countdown', 'capture_start',
  'file_download', 'processing_start', 'sharing_screen', 'printing',
  'file_upload', 'session_end',
]);

/**
 * Xác định các file cần xử lý từ danh sách tham số.
 * Nếu dslrBooth không đặt dấu nháy quanh đường dẫn có dấu cách thì đường dẫn bị
 * tách thành nhiều tham số; thử ghép lại và chỉ chấp nhận khi file thật sự tồn
 * tại, nên không bao giờ đoán sai.
 */
function resolveTargets(parts) {
  if (!parts.length) return [];
  if (parts.length === 1) return [parts[0]];
  if (parts.every((p) => existsSync(p))) return parts;
  const joined = parts.join(' ');
  if (existsSync(joined)) return [joined];
  return [parts[0]];
}

async function main() {
  const argv = process.argv.slice(2);
  if (!argv.length) return usage();

  const force = argv.includes('--force');
  const args = argv.filter((a) => a !== '--force');
  const [first, ...rest] = args;
  const cfg = loadConfig();

  if (first.startsWith('--')) {
    if (!cfg.enabled && !['--selftest', '--doctor'].includes(first)) {
      console.log('Cấu hình đang tắt (enabled: false). Bật lại trong softlight.config.json.');
      return;
    }
    switch (first) {
      case '--preview': return cmdPreview(rest[0], cfg);
      case '--file': return processFile(rest[0], cfg, { force });
      case '--dir': return cmdDir(rest[0], cfg, force);
      case '--restore': return cmdRestore(rest[0], cfg);
      case '--selftest': return cmdSelftest(cfg);
      case '--doctor': return cmdDoctor();
      case '--bench': return cmdBench(rest[0], cfg);
      default: return usage();
    }
  }

  // ── dslrBooth gọi ──
  process.env.SOFTLIGHT_QUIET = '1';

  if (TRIGGER_EVENTS.has(first)) {
    if (first === 'file_download') {
      const targets = resolveTargets(rest);
      if (!cfg.enabled) return log({ ev: 'off', path: targets[0] });
      for (const p of targets) await processFile(p, cfg, { force, via: 'trigger' });
      return;
    }
    if (first === 'processing_start') {
      // Chỉ đóng dấu thời gian. So mốc này với mốc 'done' của từng ảnh là biết
      // chắc hiệu ứng có kịp vào bản in hay không — khỏi phải phỏng đoán
      // dslrBooth có chờ chương trình ngoài hay không.
      return log({ ev: 'processing_start' });
    }
    return; // các sự kiện còn lại: không làm gì
  }

  // ── Post-Processing: gọi thẳng với đường dẫn ảnh ──
  const targets = resolveTargets(args);
  if (!cfg.enabled) return log({ ev: 'off', path: targets[0] });
  for (const p of targets) await processFile(p, cfg, { force, via: 'post-processing' });
}

main().catch((err) => {
  log({ ev: 'fatal', error: String(err && err.message ? err.message : err) });
  // Luôn thoát 0: một trigger lỗi không được phép làm gián đoạn phiên chụp.
  process.exit(0);
});
