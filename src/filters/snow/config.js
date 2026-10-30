import { readFileSync } from "node:fs";
import { join } from "node:path";
// ROOT là thư mục cài đặt, tính một lần ở src/config.js — mượn lại để mọi bộ
// lọc cùng trỏ về một gốc.
import { ROOT } from "../../config.js";
import { communityLook, neutralLook, normalizeLook } from "../instax/look.js";
import { normalizeSnow, snowFileOptions, SNOW_LOOKS } from "./snow.js";

const CONFIG_PATH = join(ROOT, "snow.config.json");

/** Bộ số màu của một preset trong SNOW_LOOKS, đã chuẩn hoá. Tên lạ = giữ màu gốc. */
export function lookPreset(name) {
  if (name === "community") return communityLook();
  const p = SNOW_LOOKS[name];
  return normalizeLook(p && p.raw ? p.raw : {}, neutralLook());
}

/**
 * Mục `look` của cấu hình: `enabled` + đủ bộ công cụ của look.js. Khoá nào
 * thiếu là TRUNG TÍNH (khác Instax, nơi khoá thiếu lấy bộ cộng đồng): bộ lọc
 * Tuyết mặc định không đổi màu ảnh.
 */
export function normalizeSnowLook(raw) {
  const r = raw && typeof raw === "object" ? raw : {};
  return { enabled: r.enabled === true, ...normalizeLook(r, neutralLook()) };
}

/**
 * Đọc và kẹp cấu hình bộ lọc Tuyết. Miền kẹp của phần tuyết nằm ở snow.js, của
 * phần màu ở look.js, để trang chỉnh dùng đúng cùng một bộ — file này chỉ lo
 * phần đĩa.
 *
 * File thiếu thì chạy bộ mặc định ("Giống mẫu", không chỉnh màu); file hỏng cú
 * pháp thì báo lỗi, vì im lặng chạy mặc định sẽ khiến người vận hành tưởng
 * chỉnh sửa đã ăn.
 */
export function loadConfig(path = CONFIG_PATH) {
  let raw = {};
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") {
      throw new Error(`Cấu hình hỏng (${path}): ${err.message}`);
    }
  }
  return {
    version: 1,
    enabled: raw.enabled !== false,
    ...normalizeSnow(raw),
    look: normalizeSnowLook(raw.look),
    ...snowFileOptions(raw),
  };
}
