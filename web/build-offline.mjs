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

for (const page of PAGES) {
  const src = readFileSync(join(here, page.src), 'utf8');

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
