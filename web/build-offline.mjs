/**
 * Các trang trong thư mục này được viết theo dạng Artifact nên không có
 * <!doctype>, <html>, <head>, <body>. Script này bọc lại thành file HTML đứng
 * độc lập, mở bằng cách nhấp đúp ngay trên máy booth:
 *
 *   node web/build-offline.mjs
 *
 * Chạy lại mỗi khi sửa một trang nguồn.
 *
 * Thêm trang mới thì thêm một dòng vào PAGES bên dưới. `mark` là phần tử mở
 * đầu phần thân — mọi thứ TRƯỚC nó (title, font, style) đi vào <head>.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

const PAGES = [
  // Trang hub build thành index.html: bấm đúp thư mục web/ là vào thẳng đây.
  { src: 'hub.html', out: 'index.html', mark: '<div class="wrap">' },
  { src: 'tuner.html', out: 'softlight-tuner.html', mark: '<div class="app">' },
  { src: 'instax.html', out: 'instax-tuner.html', mark: '<div class="app">' },
];

/*
 * Trang Instax dùng ĐÚNG file src/filters/instax/look.js mà instax.exe chạy:
 * chỗ đánh dấu bên dưới được thay bằng nguyên văn file đó, bỏ chữ `export` ở
 * đầu dòng để chạy được như script thường. Một công thức, hai nơi dùng — ảnh
 * xem trước và bản digital không thể lệch nhau.
 *
 * Các trang chỉnh dùng chung một bộ giao diện, web/ui.css, dán vào chỗ đánh dấu
 * UI_CSS — sửa một chỗ là cả hai trang đổi theo.
 */
const INLINE = {
  '/*@@LOOK_JS@@*/': () =>
    readFileSync(join(here, '..', 'src', 'filters', 'instax', 'look.js'), 'utf8')
      .replace(/^export (?=(?:async )?function|const|let|class)/gm, ''),
  '/*@@UI_CSS@@*/': () => readFileSync(join(here, 'ui.css'), 'utf8'),
};

for (const page of PAGES) {
  let src = readFileSync(join(here, page.src), 'utf8');
  for (const [mark, body] of Object.entries(INLINE)) {
    if (src.includes(mark)) src = src.replace(mark, () => body());
  }
  if (/^export /m.test(src)) throw new Error(`${page.src}: còn chữ export sau khi dán module`);

  const at = src.indexOf('\n' + page.mark);
  if (at < 0) throw new Error(`Không tìm thấy ${page.mark} trong ${page.src}`);

  const out =
    '<!doctype html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
    src.slice(0, at).trim() + '\n</head>\n<body>\n' +
    src.slice(at).trim() + '\n</body>\n</html>\n';

  const dest = join(here, page.out);
  writeFileSync(dest, out);
  console.log(`Đã tạo ${dest} (${out.length} byte)`);
}
