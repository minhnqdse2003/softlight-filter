import { join } from 'node:path';
import { loadConfig as loadSoftLight, ROOT } from '../config.js';
import { loadConfig as loadInstax } from './instax/config.js';

/**
 * SỔ ĐĂNG KÝ BỘ LỌC.
 *
 * Một bộ lọc = một cách xử lý ảnh + một file cấu hình + một file exe + một
 * trang tuner. Mọi thứ khác — bắt trigger của dslrBooth, backup, khoá chống
 * chạy song song, ghi file nguyên tử, log — đều dùng chung, nằm ở src/cli.js.
 * Thêm bộ lọc mới nghĩa là thêm MỘT mục ở đây, không sửa gì trong cli.js.
 *
 * Vì sao id lại quan trọng đến vậy: nó đặt tên cho CẢ BỐN thứ đi kèm —
 * <id>.exe, <id>.config.json, logs/<id>.log, và đuôi file tạm/khoá
 * .<id>.tmp / .<id>.lock. Nhờ vậy hai bộ lọc chạy trên cùng một thư mục ảnh
 * không bao giờ giẫm chân nhau, và launcher chỉ cần đọc tên file exe của chính
 * nó là biết phải chạy bộ lọc nào.
 *
 * Cấu hình được nạp NGAY (rẻ, chỉ đọc JSON) nhưng pipeline thì nạp lười:
 * dslrBooth gọi chương trình này nhiều lần mỗi phiên cho những sự kiện không
 * đụng đến ảnh, mà nạp sharp/libvips tốn hơn 100ms mỗi lần.
 */
export const FILTERS = {
  softlight: {
    id: 'softlight',
    title: 'Soft Light',
    blurb: 'Làm mềm da bằng bloom trên vùng tông da, giữ phông nền sắc nét.',
    configFile: 'softlight.config.json',
    exeFile: 'softlight.exe',
    tunerFile: 'softlight-tuner.html',
    loadConfig: (path) => loadSoftLight(path),
    render: async (input, cfg, opts) =>
      (await import('../pipeline.js')).renderSoftLight(input, cfg, opts),
    renderComparison: async (input, cfg, maxWidth) =>
      (await import('../pipeline.js')).renderComparison(input, cfg, maxWidth),
    // selftest: không khai báo — dùng bản dựng sẵn trong cli.js, vốn viết riêng
    // cho các tầng không gian của bộ lọc này.
  },

  instax: {
    id: 'instax',
    title: 'Instax Wide',
    blurb: 'Chất phim lấy liền: vibrance chọn lọc, matte black, tách tông lam/kem, hạt phim.',
    configFile: 'instax.config.json',
    exeFile: 'instax.exe',
    tunerFile: 'instax-tuner.html',
    loadConfig: (path) => loadInstax(path),
    render: async (input, cfg, opts) =>
      (await import('./instax/pipeline.js')).renderInstax(input, cfg, opts),
    renderComparison: async (input, cfg, maxWidth) =>
      (await import('./instax/pipeline.js')).renderComparison(input, cfg, maxWidth),
    selftest: async (cfg) => (await import('./instax/pipeline.js')).selftest(cfg),
    verdicts: async (m) => (await import('./instax/pipeline.js')).verdicts(m),
  },
};

export const DEFAULT_FILTER = 'softlight';

/** Đường dẫn tuyệt đối tới file cấu hình của một bộ lọc. */
export const configPathOf = (f) => join(ROOT, f.configFile);

/**
 * Chọn bộ lọc từ danh sách tham số, trả về `{ filter, args }` với `args` đã bỏ
 * cờ `--filter`.
 *
 * Ba nguồn, theo thứ tự ưu tiên:
 *   1. `--filter <id>` hoặc `--filter=<id>`  — launcher và dòng lệnh dùng lối này
 *   2. biến môi trường FILTER_ID             — tiện khi chạy hàng loạt
 *   3. softlight                             — mặc định, giữ nguyên hành vi cũ
 *
 * Id lạ thì rơi về mặc định thay vì ném lỗi: một tham số gõ sai không được
 * phép làm hỏng phiên chụp, và log 'done' vẫn ghi rõ bộ lọc nào đã chạy.
 */
export function pickFilter(argv) {
  const args = [];
  let id = process.env.FILTER_ID || DEFAULT_FILTER;

  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--filter') {
      if (argv[i + 1]) id = argv[++i];
      continue;
    }
    if (a.startsWith('--filter=')) {
      id = a.slice('--filter='.length);
      continue;
    }
    args.push(a);
  }

  const key = String(id).toLowerCase();
  return { filter: FILTERS[key] || FILTERS[DEFAULT_FILTER], requested: key, args };
}
