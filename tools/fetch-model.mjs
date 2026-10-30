/**
 * Tải model tách người cho bộ lọc Tuyết về models/modnet.onnx:
 *
 *   npm run model
 *
 * MODNet (Apache-2.0), bản ONNX fp32 của Xenova/modnet trên Hugging Face. Không
 * commit file 26MB vào git — chạy lệnh này một lần trên máy đóng gói. Có kiểm
 * tra SHA-256: file tải hỏng hoặc bị thay thì không được dùng.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const URL_ = 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx';
const SHA256 = '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9';
const dest = join(dirname(fileURLToPath(import.meta.url)), '..', 'models', 'modnet.onnx');

const sha = (buf) => createHash('sha256').update(buf).digest('hex');

if (existsSync(dest) && sha(readFileSync(dest)) === SHA256) {
  console.log(`Đã có ${dest} (đúng SHA-256), không tải lại.`);
  process.exit(0);
}

console.log(`Đang tải MODNet (~26 MB) từ Hugging Face…`);
const res = await fetch(URL_);
if (!res.ok) {
  console.error(`Tải thất bại: HTTP ${res.status}`);
  process.exit(1);
}
const buf = Buffer.from(await res.arrayBuffer());
const got = sha(buf);
if (got !== SHA256) {
  console.error(`SHA-256 không khớp — bỏ file tải về.\n  cần: ${SHA256}\n  nhận: ${got}`);
  process.exit(1);
}
mkdirSync(dirname(dest), { recursive: true });
writeFileSync(dest + '.part', buf);
renameSync(dest + '.part', dest);
console.log(`Đã lưu ${dest} (${(buf.length / 1e6).toFixed(1)} MB, SHA-256 khớp).`);
