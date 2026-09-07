import sharp from 'sharp';
// Cỗ máy hạt và bộ thước đo dùng chung với bộ lọc Soft Light — cùng một chất
// phim, cùng một cách đọc số, nên hai bộ lọc so sánh được với nhau.
import { addGrain, harmony, HARMONY, measureRaw } from '../../pipeline.js';

/**
 * BỘ LỌC INSTAX WIDE — chất phim lấy liền.
 *
 * Khác hẳn Soft Light về bản chất: Soft Light làm việc trên KHÔNG GIAN, dựng
 * các lớp mờ rồi ghép chồng. Bộ lọc này làm việc trên SẮC ĐỘ — mọi tầng đều là
 * phép biến đổi từng điểm ảnh, không điểm nào nhìn sang điểm bên cạnh. Vì vậy
 * cả năm tầng màu gộp được vào MỘT vòng quét duy nhất, và chỉ tầng hạt cuối
 * cùng mới cần đến libvips.
 *
 * Thứ tự các tầng bám đúng bản tham chiếu HTML, và thứ tự đó có lý do:
 *
 *   1. Phơi sáng      — dời cả biểu đồ trước, để các tầng sau đọc đúng vùng sáng.
 *   2. Vibrance       — đẩy rực màu CÓ CHỌN LỌC: màu nào đang nhạt mới được
 *                       đẩy mạnh, màu đã bão hoà thì gần như không đụng. Đây là
 *                       chỗ giữ cho tông da không cháy đỏ khi kéo màu áo lên.
 *   3. Tương phản     — neo ở điểm giữa 128.
 *   4. Nâng đáy đen   — matte: kéo vùng tối lên khỏi 0. Phải nằm SAU tương phản,
 *                       vì tương phản mới là thứ dìm vùng tối xuống.
 *   5. Tách tông      — lam-lục ở bóng đổ, kem ấm ở vùng sáng. Cân theo độ sáng
 *                       SAU tầng 4, nếu không thì vùng vừa được nâng lên vẫn bị
 *                       tính là bóng đổ.
 *   6. Hạt phim       — sau cùng, không ngoại lệ: hạt phải nằm trên mọi tầng
 *                       khác thì mới hàn chúng lại thành một mặt phẳng ảnh.
 *
 * Tất cả tính trên sRGB 8-bit chứ không phải tuyến tính, vì bản tham chiếu chạy
 * trên canvas. Đổi sang tuyến tính sẽ cho ảnh "đúng vật lý" hơn nhưng KHÁC ảnh
 * trong trang tuner, mà trang tuner mới là thứ người vận hành tin.
 */

/** Chuyển số chuẩn hoá của file cấu hình về đúng thang của bản tham chiếu. */
const UI = 100;

/**
 * Áp năm tầng sắc độ lên buffer RGB 8-bit, sửa tại chỗ.
 * Tách riêng khỏi renderInstax để --selftest đo được mà không phải qua đĩa.
 */
export function applyTone(base, raw, cfg) {
  const n = raw.width * raw.height;

  const exp = cfg.colour.exposure * UI * 1.4;
  const vib = cfg.colour.vibrance;
  const contrast = cfg.colour.contrast * UI;
  const fade = cfg.film.matte * UI;
  const warmth = cfg.film.warmHighlight * UI;
  const cyan = cfg.film.shadowCyan * UI;

  // Công thức tương phản kinh điển của xử lý ảnh 8-bit, neo ở 128.
  const k = (259 * (contrast + 255)) / (255 * (259 - contrast));

  for (let i = 0, p = 0; i < n; i++, p += 3) {
    let r = base[p] + exp;
    let g = base[p + 1] + exp;
    let b = base[p + 2] + exp;

    // ── 2. Vibrance ────────────────────────────────────────────────
    if (vib !== 0) {
      const max = r > g ? (r > b ? r : b) : g > b ? g : b;
      const min = r < g ? (r < b ? r : b) : g < b ? g : b;
      let sat = max <= 0 ? 0 : (max - min) / max;
      if (sat > 1) sat = 1;
      const luma = 0.299 * r + 0.587 * g + 0.114 * b;
      // Trọng số (1 − sat): màu đã rực thì gần như miễn nhiễm, nên tông da —
      // vốn đã bão hoà sẵn — không bị đẩy thành đỏ gắt.
      const dyn = vib * (1 - sat) * 1.5;
      r += (r - luma) * dyn;
      g += (g - luma) * dyn;
      b += (b - luma) * dyn;
    }

    // ── 3. Tương phản ──────────────────────────────────────────────
    // Kẹp về 0…255 NGAY tại đây, không để giá trị âm chạy tiếp. Bản tham chiếu
    // HTML giữ số thực suốt chuỗi, và điều đó nuốt mất tầng matte ở đúng chỗ
    // matte tồn tại để phục vụ: tương phản 25 đẩy mức 0 xuống −27, rồi matte
    // cộng +18 vào đó vẫn ra số âm, nên đen kịt vẫn là đen kịt — trái hẳn với
    // lời hứa của thanh trượt "nâng đáy tối", và bết đen thì in ra rất xấu.
    // Mọi phép tương phản 8-bit thật đều kẹp ở từng tầng; đây là chỗ duy nhất
    // bộ lọc này cố ý lệch khỏi bản tham chiếu, và trang tuner lệch y hệt.
    r = k * (r - 128) + 128;
    g = k * (g - 128) + 128;
    b = k * (b - 128) + 128;
    r = r < 0 ? 0 : r > 255 ? 255 : r;
    g = g < 0 ? 0 : g > 255 ? 255 : g;
    b = b < 0 ? 0 : b > 255 ? 255 : b;

    // ── 4. Nâng đáy đen ────────────────────────────────────────────
    // Trọng số (1 − v/255): đen kịt được nâng trọn vẹn, trắng gần như không đổi.
    if (fade !== 0) {
      r += fade * (1 - r / 255);
      g += fade * (1 - g / 255);
      b += fade * (1 - b / 255);
    }

    // ── 5. Tách tông ───────────────────────────────────────────────
    if (cyan !== 0 || warmth !== 0) {
      const lum = 0.299 * r + 0.587 * g + 0.114 * b;
      if (cyan !== 0 && lum < 128) {
        const w = (128 - lum) / 128;
        g += cyan * 0.4 * w;
        b += cyan * 1.1 * w;
      }
      if (warmth !== 0 && lum > 128) {
        const w = (lum - 128) / 128;
        r += warmth * 1.2 * w;
        g += warmth * 0.6 * w;
      }
    }

    base[p] = r <= 0 ? 0 : r >= 254.5 ? 255 : (r + 0.5) | 0;
    base[p + 1] = g <= 0 ? 0 : g >= 254.5 ? 255 : (g + 0.5) | 0;
    base[p + 2] = b <= 0 ? 0 : b >= 254.5 ? 255 : (b + 0.5) | 0;
  }
}

/**
 * Áp hiệu ứng lên một ảnh, trả về buffer JPEG đã mã hoá.
 * Không đụng tới đĩa — việc ghi file do lớp gọi quyết định.
 */
export async function renderInstax(inputPath, cfg, { trace = false } = {}) {
  const src = sharp(inputPath, { failOn: 'none' }).rotate().toColourspace('srgb');
  const { data, info } = await src.raw().toBuffer({ resolveWithObject: true });
  const raw = { width: info.width, height: info.height, channels: info.channels };

  if (raw.channels !== 3) {
    throw new Error(`Ảnh có ${raw.channels} kênh màu, chỉ hỗ trợ RGB 3 kênh.`);
  }

  const stages = [];
  // Buffer từ libvips có thể đang được chia sẻ, nên sao ra trước khi sửa tại chỗ.
  const cur = Buffer.from(data);
  if (trace) stages.push({ name: 'gốc', ...(await measureRaw(cur, raw)) });

  applyTone(cur, raw, cfg);
  if (trace) stages.push({ name: 'sắc độ', ...(await measureRaw(cur, raw)) });

  if (cfg.grain.amount > 0.0005) {
    await addGrain(cur, raw, cfg.grain);
    if (trace) stages.push({ name: 'hạt', ...(await measureRaw(cur, raw)) });
  }

  const jpeg = await sharp(cur, { raw })
    .jpeg({
      quality: cfg.output.quality,
      chromaSubsampling: cfg.output.chromaSubsampling,
      progressive: false,
    })
    .withMetadata()
    .toBuffer();

  return { jpeg, width: raw.width, height: raw.height, stages };
}

/** Ảnh so sánh trước / sau, ghép cạnh nhau — cùng khuôn với bộ lọc Soft Light. */
export async function renderComparison(inputPath, cfg, maxWidth = 2200) {
  const before = await sharp(inputPath, { failOn: 'none' })
    .rotate()
    .toColourspace('srgb')
    .jpeg({ quality: 95 })
    .toBuffer();
  const { jpeg: after } = await renderInstax(inputPath, cfg);

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

/* ═══════════════════════ kiểm chứng bằng số ═══════════════════════ */

/** Ba ô màu của ảnh kiểm. `pale` và `vivid` cùng sắc lam, chỉ khác độ bão hoà. */
const PATCH = {
  pale: [140, 165, 184], // bão hoà ≈ 24%
  vivid: [12, 108, 210], // bão hoà ≈ 94%
  black: [0, 0, 0],
};

/** Toạ độ các ô, dùng chung giữa lúc vẽ ảnh kiểm và lúc đo. */
const BOX = {
  pale: [60, 60, 360, 300],
  vivid: [420, 60, 720, 300],
  black: [60, 360, 360, 600],
  skin: [780, 60, 950, 300],
  shadow: [0, 700, 300, 950], // đầu tối của dải chuyển sắc
  highlight: [1300, 700, 1600, 950], // đầu sáng
};

/**
 * Ảnh kiểm. Các mảng được chọn để chạm đúng từng tầng:
 *   - ô màu NHẠT (bão hoà thấp) : vibrance phải đẩy mạnh mảng này;
 *   - ô màu RỰC  (bão hoà cao)  : vibrance gần như không được đụng vào — đây
 *                                 mới là điểm phân biệt vibrance với saturation;
 *   - mảng đen kịt              : matte phải nâng nó lên khỏi 0;
 *   - dải xám chuyển sắc làm nền: chỗ đọc tương phản, tách tông và hạt.
 * Cộng thêm một dải ô tông da, vì tông da là thứ hỏng đầu tiên khi kéo màu.
 */
function makeTestImage(w = 1600, h = 1000) {
  const buf = Buffer.alloc(w * h * 3);
  const put = ([x0, y0, x1, y1], [r, g, b]) => {
    for (let y = y0; y < y1; y++) {
      for (let x = x0, p = (y * w + x0) * 3; x < x1; x++, p += 3) {
        buf[p] = r; buf[p + 1] = g; buf[p + 2] = b;
      }
    }
  };

  // Nền: dải xám chuyển sắc trái → phải, để đọc tương phản trên đủ dải sáng.
  for (let y = 0; y < h; y++) {
    for (let x = 0, p = y * w * 3; x < w; x++, p += 3) {
      const v = Math.round((x / (w - 1)) * 255);
      buf[p] = v; buf[p + 1] = v; buf[p + 2] = v;
    }
  }

  put(BOX.pale, PATCH.pale);
  put(BOX.vivid, PATCH.vivid);
  put(BOX.black, PATCH.black);

  const skin = [[243, 211, 189], [224, 176, 144], [201, 142, 106], [141, 90, 60]];
  skin.forEach((c, i) => put([780 + i * 190, 60, 950 + i * 190, 300], c));

  return { data: buf, raw: { width: w, height: h, channels: 3 } };
}

/** Trung bình ba kênh, độ bão hoà HSV và độ sáng của một ô. */
function patchStat(buf, raw, [x0, y0, x1, y1]) {
  let r = 0, g = 0, b = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0, p = (y * raw.width + x0) * 3; x < x1; x++, p += 3) {
      r += buf[p]; g += buf[p + 1]; b += buf[p + 2]; n++;
    }
  }
  r /= n; g /= n; b /= n;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  return {
    r, g, b,
    sat: max === 0 ? 0 : (max - min) / max,
    lum: 0.299 * r + 0.587 * g + 0.114 * b,
  };
}

/** Độ lệch chuẩn kênh lục trong một ô — dùng để tách phần đóng góp của hạt. */
function flatStdev(buf, raw, [x0, y0, x1, y1]) {
  let s = 0, sq = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0, p = (y * raw.width + x0) * 3 + 1; x < x1; x++, p += 3) {
      s += buf[p]; sq += buf[p] * buf[p]; n++;
    }
  }
  const m = s / n;
  return Math.sqrt(Math.max(0, sq / n - m * m));
}

const pct = (v) => `${(v * 100).toFixed(1)}%`;

/**
 * Chấm bảng hài hoà theo ĐÚNG ngưỡng dùng chung (HARMONY của src/pipeline.js),
 * để hai bộ lọc so được với nhau — nhưng lời khuyên phải trỏ về khoá của
 * instax.config.json. Nói "tăng tone.lift" ở đây thì người vận hành đi tìm một
 * khoá không tồn tại trong file cấu hình của bộ lọc này.
 *
 * Trả về đúng hình dạng của harmonyVerdicts: `{ crushed, blown, subject,
 * warmth, tint }`, mỗi mục là `{ ok, note }`.
 */
export function verdicts(m) {
  const H = HARMONY;
  const out = {};

  out.crushed = m.crushedPct <= H.crushedPct.max
    ? { ok: true, note: 'giữ được chi tiết vùng tối' }
    : { ok: false, note: 'bết đen — tăng film.matte hoặc giảm colour.contrast' };

  out.blown = m.blownPct <= H.blownPct.max
    ? { ok: true, note: 'vùng sáng còn mượt' }
    : { ok: false, note: 'cháy sáng — giảm colour.exposure hoặc colour.contrast' };

  // Bộ lọc này không có tầng nào tách riêng chủ thể khỏi phông, nên chỉ báo
  // chứ không quy trách nhiệm cho một tham số nào cả.
  if (m.skinShare < 0.5) {
    out.subject = { ok: true, note: 'ảnh gần như không có vùng da để so' };
  } else if (m.skinMean >= m.bgMean) {
    out.subject = { ok: true, note: 'chủ thể sáng hơn phông, mắt bị hút vào mặt' };
  } else {
    out.subject = { ok: false, note: 'phông đang sáng hơn da — chỉnh ánh sáng buồng chụp' };
  }

  if (m.warmth < H.warmth.cold) {
    out.warmth = { ok: false, note: 'lạnh / nhợt — tăng film.warmHighlight hoặc giảm film.shadowCyan' };
  } else if (m.warmth > H.warmth.hot) {
    out.warmth = { ok: false, note: 'quá đỏ, da ngả gạch nung — giảm film.warmHighlight' };
  } else if (m.warmth < H.warmth.min || m.warmth > H.warmth.max) {
    out.warmth = { ok: true, note: 'chấp nhận được, khoảng đẹp cho chân dung là 10…35' };
  } else {
    out.warmth = { ok: true, note: 'đúng khoảng ấm của da chân dung' };
  }

  if (m.skinShare < 0.5) out.tint = { ok: true, note: 'không đủ vùng da để đo' };
  else if (m.skinTint > H.skinTint.green) out.tint = { ok: false, note: 'da ám lục — giảm film.shadowCyan' };
  else if (m.skinTint < H.skinTint.magenta) out.tint = { ok: false, note: 'da ám tím — giảm colour.vibrance' };
  else if (m.skinTint > H.skinTint.max || m.skinTint < H.skinTint.min) {
    out.tint = { ok: true, note: 'hơi lệch nhưng còn trong ngưỡng' };
  } else out.tint = { ok: true, note: 'màu da tinh khiết' };

  return out;
}

/**
 * Kiểm chứng bằng số đo thay vì bằng mắt. Trả về true nếu mọi mệnh đề đều đúng.
 *
 * Điểm cần chứng minh, theo thứ tự quan trọng:
 *   1. Vibrance CÓ CHỌN LỌC — ô nhạt phải tăng bão hoà nhiều hơn hẳn ô đã rực.
 *      Nếu hai con số xấp xỉ nhau thì thứ đang chạy là saturation chứ không
 *      phải vibrance, và tông da sẽ cháy đỏ trên ảnh thật.
 *   2. Matte thật sự nâng đáy đen.
 *   3. Tách tông đúng hướng: bóng đổ ngả lam, vùng sáng ngả ấm.
 *   4. Hạt có mặt và nằm trong khoảng hợp lý.
 *   5. Tông da chưa vượt ngưỡng cháy đỏ.
 */
export async function selftest(cfg) {
  const { data, raw } = makeTestImage();

  /**
   * Chạy cả chuỗi với MỘT tham số bị tắt, để trừ ra phần đóng góp của riêng
   * tầng đó. So thẳng ảnh gốc với ảnh cuối thì không kết luận được gì: tương
   * phản cũng làm tăng bão hoà, nên "màu rực lên" không chứng minh vibrance
   * chạy đúng.
   */
  const variant = (patch) => {
    const buf = Buffer.from(data);
    applyTone(buf, raw, patch ? { ...cfg, ...patch } : cfg);
    return buf;
  };

  const t0 = Date.now();
  const full = variant(null);
  const toneMs = Date.now() - t0;

  const noVib = variant({ colour: { ...cfg.colour, vibrance: 0 } });
  const noMatte = variant({ film: { ...cfg.film, matte: 0 } });
  const noCyan = variant({ film: { ...cfg.film, shadowCyan: 0 } });
  const noWarm = variant({ film: { ...cfg.film, warmHighlight: 0 } });

  const read = (buf, box) => patchStat(buf, raw, box);
  const skin = [read(data, BOX.skin), read(full, BOX.skin)];

  // Vibrance: bao nhiêu phần bão hoà là do RIÊNG nó, trên ô nhạt và ô đã rực.
  const dPale = read(full, BOX.pale).sat - read(noVib, BOX.pale).sat;
  const dVivid = read(full, BOX.vivid).sat - read(noVib, BOX.vivid).sat;

  const dMatte = read(full, BOX.shadow).lum - read(noMatte, BOX.shadow).lum;
  const sCyan = read(full, BOX.shadow);
  const sCyan0 = read(noCyan, BOX.shadow);
  const hWarm = read(full, BOX.highlight);
  const hWarm0 = read(noWarm, BOX.highlight);

  // Hạt: so độ lệch chuẩn của một mảng đáng lẽ phẳng lì, trước và sau khi rải.
  const grained = Buffer.from(full);
  if (cfg.grain.amount > 0.0005) await addGrain(grained, raw, cfg.grain);
  const flat = flatStdev(full, raw, BOX.pale);
  const noisy = flatStdev(grained, raw, BOX.pale);
  const grainSigma = Math.sqrt(Math.max(0, noisy * noisy - flat * flat));

  const checks = [
    {
      ok: cfg.colour.vibrance <= 0 || dPale > dVivid + 0.02,
      label: 'Vibrance có chọn lọc',
      detail: `riêng vibrance: ô nhạt +${pct(dPale)} bão hoà · ô đã rực +${pct(dVivid)} — chênh lệch này giữ tông da không cháy đỏ`,
    },
    {
      ok: cfg.film.matte <= 0 || dMatte > 4,
      label: 'Matte nâng đáy tối',
      detail: `riêng matte nâng vùng tối +${dMatte.toFixed(1)} / 255`,
    },
    {
      ok: cfg.film.shadowCyan <= 0 || sCyan.b - sCyan.r > sCyan0.b - sCyan0.r + 1,
      label: 'Bóng đổ ngả lam',
      detail: `B−R ở vùng tối ${(sCyan0.b - sCyan0.r).toFixed(1)} → ${(sCyan.b - sCyan.r).toFixed(1)}`,
    },
    {
      ok: cfg.film.warmHighlight <= 0
        || hWarm.r - hWarm.b > hWarm0.r - hWarm0.b + 0.5,
      label: 'Vùng sáng ngả ấm',
      detail: `R−B ở vùng sáng ${(hWarm0.r - hWarm0.b).toFixed(1)} → ${(hWarm.r - hWarm.b).toFixed(1)}`,
    },
    {
      ok: cfg.grain.amount <= 0.0005 || (grainSigma > 0.4 && grainSigma < 40),
      label: 'Hạt phim có mặt',
      detail: `σ ≈ ${grainSigma.toFixed(2)} / 255 trên mảng phẳng`,
    },
    {
      ok: skin[1].sat < 0.72,
      label: 'Tông da còn ngưỡng',
      detail: `bão hoà da ${pct(skin[0].sat)} → ${pct(skin[1].sat)} (ngưỡng cháy đỏ: 72%)`,
    },
  ];

  const rule = '  ' + '─'.repeat(78);
  console.log('');
  console.log('  KIỂM CHỨNG BỘ LỌC INSTAX WIDE');
  console.log(rule);
  for (const c of checks) {
    console.log(`  [${c.ok ? ' OK ' : 'LỖI'}]  ${c.label.padEnd(22)} ${c.detail}`);
  }

  // Đường cong sắc độ: hai đầu dải là thứ quyết định ảnh in ra có bết đen /
  // cháy trắng hay không, và mắt không đọc được nó từ ảnh xem trước.
  console.log(rule);
  console.log('  ĐƯỜNG CONG SẮC ĐỘ (mức xám vào → ra, R/G/B)');
  for (const v of [0, 32, 64, 128, 192, 255]) {
    const one = Buffer.from([v, v, v]);
    applyTone(one, { width: 1, height: 1, channels: 3 }, cfg);
    console.log(`    ${String(v).padStart(3)} →  ${String(one[0]).padStart(3)} ${String(one[1]).padStart(3)} ${String(one[2]).padStart(3)}`);
  }
  console.log(`  Điểm đen phải rời khỏi 0 (matte), điểm trắng nên còn ở 255.`);

  console.log(rule);
  console.log(`  Năm tầng sắc độ trên ảnh 1600×1000: ${toneMs}ms`);
  console.log('  (ảnh 24MP nặng hơn khoảng 15 lần, cộng ~460ms khởi động Node + sharp)');
  console.log('  Bảng hài hoà chỉ có nghĩa trên ẢNH THẬT — chạy --preview <anh.jpg>,');
  console.log('  vì ảnh kiểm này cố tình chứa cả mảng đen kịt lẫn dải cháy trắng.');
  console.log('');

  const bad = checks.filter((c) => !c.ok).length;
  if (bad) console.log(`  Còn ${bad} mệnh đề chưa đạt — xem lại instax.config.json.\n`);
  return bad === 0;
}
