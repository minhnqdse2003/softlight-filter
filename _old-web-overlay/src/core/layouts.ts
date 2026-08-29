import type { CanvasSpec, Cell } from './types';

export const CANVAS_PRESETS: CanvasSpec[] = [
  { label: '4×6 ngang — 1800×1200 @300dpi', w: 1800, h: 1200, dpi: 300 },
  { label: '4×6 dọc — 1200×1800 @300dpi', w: 1200, h: 1800, dpi: 300 },
  { label: '2×6 strip — 600×1800 @300dpi', w: 600, h: 1800, dpi: 300 },
  { label: '2×6 strip đôi — 1200×1800 @300dpi', w: 1200, h: 1800, dpi: 300 },
  { label: 'Digital dọc — 1080×1920', w: 1080, h: 1920, dpi: 96 },
  { label: 'Digital vuông — 1080×1080', w: 1080, h: 1080, dpi: 96 },
];

let cellSeq = 0;
export function makeCell(x: number, y: number, w: number, h: number): Cell {
  return { id: `c${++cellSeq}`, x, y, w, h };
}

export interface LayoutPreset {
  label: string;
  /** Tạo các ô ảnh theo tỷ lệ chuẩn hoá 0..1 của canvas. */
  build: () => Cell[];
}

/** Bố cục ô ảnh dựng sẵn, toạ độ chuẩn hoá nên dùng lại được ở mọi kích thước. */
export const LAYOUT_PRESETS: LayoutPreset[] = [
  {
    label: 'Toàn tờ (1 ô)',
    build: () => [makeCell(0, 0, 1, 1)],
  },
  {
    label: 'Strip dọc 3 ô',
    build: () => {
      const m = 0.045;
      const gap = 0.018;
      const top = 0.03;
      const bottom = 0.16;
      const hAll = 1 - top - bottom - gap * 2;
      const ch = hAll / 3;
      return [0, 1, 2].map((i) => makeCell(m, top + i * (ch + gap), 1 - m * 2, ch));
    },
  },
  {
    label: 'Strip dọc 4 ô',
    build: () => {
      const m = 0.045;
      const gap = 0.014;
      const top = 0.025;
      const bottom = 0.13;
      const hAll = 1 - top - bottom - gap * 3;
      const ch = hAll / 4;
      return [0, 1, 2, 3].map((i) => makeCell(m, top + i * (ch + gap), 1 - m * 2, ch));
    },
  },
  {
    label: 'Collage 2×2',
    build: () => {
      const m = 0.035;
      const gap = 0.02;
      const cw = (1 - m * 2 - gap) / 2;
      const ch = (1 - m * 2 - gap) / 2;
      const out: Cell[] = [];
      for (let r = 0; r < 2; r++)
        for (let c = 0; c < 2; c++) out.push(makeCell(m + c * (cw + gap), m + r * (ch + gap), cw, ch));
      return out;
    },
  },
  {
    label: 'Strip đôi cạnh nhau (2×3 ô)',
    build: () => {
      const gap = 0.016;
      const m = 0.03;
      const cw = (0.5 - m * 2);
      const top = 0.03;
      const bottom = 0.16;
      const hAll = 1 - top - bottom - gap * 2;
      const ch = hAll / 3;
      const out: Cell[] = [];
      for (let half = 0; half < 2; half++)
        for (let i = 0; i < 3; i++)
          out.push(makeCell(half * 0.5 + m, top + i * (ch + gap), cw, ch));
      return out;
    },
  },
];
