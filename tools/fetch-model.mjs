/**
 * Tải model tách người cho bộ lọc Tuyết về models/:
 *
 *   npm run model                 MODNet (mặc định, ~26 MB, nhanh)
 *   npm run model -- birefnet     BiRefNet lite 512 (~192 MB, đẹp hơn, ~5 s/tấm)
 *   npm run model -- all          cả hai
 *
 * Không commit các file này vào git — chạy lệnh trên máy đóng gói, trước
 * dong-goi.bat. URL khoá theo revision và có kiểm tra SHA-256: file tải hỏng
 * hoặc bị thay thì không được dùng. Chọn model trong snow.config.json:
 * subject.model = "modnet" | "birefnet".
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODELS = {
  modnet: {
    file: 'modnet.onnx', mb: 26, licence: 'Apache-2.0',
    url: 'https://huggingface.co/Xenova/modnet/resolve/fa2fa546052fba4c08921230a26cc69a333fca12/onnx/model.onnx',
    sha256: '07c308cf0fc7e6e8b2065a12ed7fc07e1de8febb7dc7839d7b7f15dd66584df9',
  },
  birefnet: {
    file: 'birefnet-lite-512.onnx', mb: 192, licence: 'MIT',
    url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/962e67969ec6acec9c19fab76acee4f5e22e990c/onnx/model.onnx',
    sha256: '1cb0fb360dadd15af77c639085d77a9df67db0c64315560c3de005f676345ac2',
  },
};

const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'models');
const sha = (buf) => createHash('sha256').update(buf).digest('hex');
const arg = (process.argv[2] || 'modnet').toLowerCase();
const wanted = arg === 'all' ? Object.keys(MODELS) : [arg];

let failed = false;
for (const id of wanted) {
  const m = MODELS[id];
  if (!m) {
    console.error(`Không có model "${id}". Chọn: ${Object.keys(MODELS).join(', ')}, all`);
    process.exit(1);
  }
  const dest = join(dir, m.file);
  if (existsSync(dest) && sha(readFileSync(dest)) === m.sha256) {
    console.log(`Đã có ${dest} (đúng SHA-256), không tải lại.`);
    continue;
  }
  console.log(`Đang tải ${id} (~${m.mb} MB, ${m.licence}) từ Hugging Face…`);
  const res = await fetch(m.url);
  if (!res.ok) {
    console.error(`  tải thất bại: HTTP ${res.status}`);
    failed = true;
    continue;
  }
  const buf = Buffer.from(await res.arrayBuffer());
  const got = sha(buf);
  if (got !== m.sha256) {
    console.error(`  SHA-256 không khớp — bỏ file tải về.\n    cần: ${m.sha256}\n    nhận: ${got}`);
    failed = true;
    continue;
  }
  mkdirSync(dir, { recursive: true });
  writeFileSync(dest + '.part', buf);
  renameSync(dest + '.part', dest);
  console.log(`  đã lưu ${dest} (${(buf.length / 1e6).toFixed(1)} MB, SHA-256 khớp).`);
}
process.exit(failed ? 1 : 0);
