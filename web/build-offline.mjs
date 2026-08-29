/**
 * web/tuner.html là nguồn duy nhất — nó được viết theo dạng Artifact nên không
 * có <!doctype>, <html>, <head>, <body>. Script này bọc lại thành một file HTML
 * đứng độc lập, mở bằng cách nhấp đúp ngay trên máy booth:
 *
 *   node web/build-offline.mjs
 *
 * Chạy lại mỗi khi sửa tuner.html.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, 'tuner.html'), 'utf8');

// Mọi thứ trước <div class="app"> là phần đầu trang (title, font, style).
const at = src.indexOf('\n<div class="app">');
if (at < 0) throw new Error('Không tìm thấy <div class="app"> trong tuner.html');

const out =
  '<!doctype html>\n<html lang="vi">\n<head>\n<meta charset="utf-8">\n' +
  '<meta name="viewport" content="width=device-width, initial-scale=1">\n' +
  src.slice(0, at).trim() + '\n</head>\n<body>\n' +
  src.slice(at).trim() + '\n</body>\n</html>\n';

const dest = join(here, 'softlight-tuner.html');
writeFileSync(dest, out);
console.log(`Đã tạo ${dest} (${out.length} byte)`);
