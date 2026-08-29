import './styles.css';
import type { Align, Cell, RenderSettings, SmoothModel } from './core/types';
import { IDENTITY_ALIGN } from './core/types';
import { loadBitmap, rasterize, toFloatRGB, luma, workSize } from './core/image';
import { autoAlign } from './core/align';
import { bake } from './core/bake';
import type { FullBake } from './core/bake';
import { evaluatorFromModel } from './core/model';
import { renderOverlay, compositeOver, errorHeatmap } from './core/render';
import type { Evaluator, GrainSpec } from './core/render';
import { CANVAS_PRESETS, LAYOUT_PRESETS, makeCell } from './core/layouts';
import { buildSoftPreset, buildBakedPreset, parsePreset, modelFromPreset } from './core/preset';
import { SOFT_LIGHT_PRESETS, softLightEvaluator } from './core/softlight';
import type { SoftLightParams } from './core/softlight';

/* ═════════════════════════ tiện ích ═════════════════════════ */
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const on = <K extends keyof HTMLElementEventMap>(
  el: HTMLElement,
  ev: K,
  fn: (e: HTMLElementEventMap[K]) => void,
) => el.addEventListener(ev, fn as EventListener);

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const nextFrame = () =>
  new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

async function busy<T>(text: string, fn: () => T | Promise<T>): Promise<T> {
  $('busyText').textContent = text;
  $('busy').classList.remove('hidden');
  await nextFrame();
  try {
    return await fn();
  } finally {
    $('busy').classList.add('hidden');
  }
}

const hex2rgb = (h: string): [number, number, number] => [
  parseInt(h.slice(1, 3), 16) / 255,
  parseInt(h.slice(3, 5), 16) / 255,
  parseInt(h.slice(5, 7), 16) / 255,
];
const rgb2hex = (c: [number, number, number]) =>
  '#' + c.map((v) => Math.round(clamp(v, 0, 1) * 255).toString(16).padStart(2, '0')).join('');

/* ═════════════════════════ trạng thái ═════════════════════════ */
interface UIPair {
  id: string;
  name: string;
  rawSrc: ImageBitmap;
  rawDst: ImageBitmap;
  align: Align;
  enabled: boolean;
  autoScore: number;
  baseScore: number;
}

interface TestImage {
  id: string;
  name: string;
  bmp: ImageBitmap;
  pairId: string | null;
}

/** Độ phân giải tham chiếu mà kích thước hạt của soft light được định nghĩa. */
const GRAIN_REF_DIM = 1800;
const PREVIEW_MAX = 720;

const state = {
  mode: 'soft' as 'soft' | 'bake',
  view: 'result',
  soft: { ...SOFT_LIGHT_PRESETS[0].params } as SoftLightParams,
  pairs: [] as UIPair[],
  work: { w: 0, h: 0 },
  result: null as FullBake | null,
  model: null as SmoothModel | null,
  tests: [] as TestImage[],
  testId: '',
  selCell: -1,
  settings: {
    strength: 1,
    degree: 4,
    radial: true,
    grainMode: 'procedural',
    grainAmount: 1,
    grainScale: 1,
    applyMode: 'sheet',
    canvas: { ...CANVAS_PRESETS[0] },
    cells: LAYOUT_PRESETS[0].build(),
  } as RenderSettings,
};

let seq = 0;
const uid = () => `p${++seq}`;

/* ═════════════════════════ nguồn overlay hiện hành ═════════════════════════ */

function workDim(): number {
  return Math.max(state.work.w, state.work.h) || 720;
}

/** Chế độ bake đã có mô hình chưa. */
const bakeReady = () => !!state.model && !!state.result;

/** Chế độ hiện tại có gì để render không. */
const ready = () => (state.mode === 'soft' ? true : bakeReady());

function currentEvaluator(): Evaluator {
  return state.mode === 'soft'
    ? softLightEvaluator(state.soft)
    : evaluatorFromModel(state.model!, state.settings.strength);
}

function currentGrain(): GrainSpec | null {
  if (state.mode === 'soft') {
    const p = state.soft;
    if (p.grainSigma <= 0) return null;
    // Hạt cũng phải theo cường độ, nếu không thì kéo cường độ về 0 vẫn còn nhiễu.
    return {
      sigma: p.grainSigma * Math.max(0, p.strength),
      size: p.grainSize,
      mono: p.grainMono,
      refDim: GRAIN_REF_DIM,
    };
  }
  const r = state.result;
  if (!r) return null;
  return {
    sigma: r.grain.sigmaC,
    size: r.grain.size,
    mono: r.grain.mono,
    refDim: workDim(),
    fixed: r.grainResult.fixed,
    fw: r.grainResult.w,
    fh: r.grainResult.h,
  };
}

/** Tham số render cho từng chế độ; soft light đã gộp hạt vào GrainSpec. */
function renderSettings(w: number, h: number): RenderSettings {
  const base = state.settings;
  return state.mode === 'soft'
    ? { ...base, grainMode: 'procedural', grainAmount: 1, grainScale: 1, canvas: { ...base.canvas, w, h } }
    : { ...base, canvas: { ...base.canvas, w, h } };
}

function makeOverlay(w: number, h: number, cells: boolean): ImageData {
  const s = renderSettings(w, h);
  if (!cells) s.applyMode = 'sheet';
  return renderOverlay(currentEvaluator(), currentGrain(), s).image;
}

/* ═════════════════════════ ảnh xem trước ═════════════════════════ */

/**
 * Bảng kiểm dựng sẵn: nền chuyển sắc + thang xám + ô màu da. Nhìn thang xám là
 * thấy ngay lớp phủ nâng vùng tối bao nhiêu — thứ khó nhận ra trên ảnh thường.
 */
function buildTestCard(): Promise<ImageBitmap> {
  const W = 900;
  const H = 600;
  const c = document.createElement('canvas');
  c.width = W;
  c.height = H;
  const g = c.getContext('2d')!;

  const bg = g.createLinearGradient(0, 0, W, H);
  bg.addColorStop(0, '#c9647f');
  bg.addColorStop(0.55, '#e8b7bd');
  bg.addColorStop(1, '#f6ece6');
  g.fillStyle = bg;
  g.fillRect(0, 0, W, H);

  // Thang xám 11 bậc.
  for (let i = 0; i < 11; i++) {
    const v = Math.round((i / 10) * 255);
    g.fillStyle = `rgb(${v},${v},${v})`;
    g.fillRect(60 + i * 68, 70, 68, 110);
  }
  // Ô màu da và màu tham chiếu.
  const swatches = ['#f3d3bd', '#e0b090', '#c98e6a', '#8d5a3c', '#3a2418', '#ffffff', '#101010'];
  swatches.forEach((s, i) => {
    g.fillStyle = s;
    g.fillRect(60 + i * 106, 400, 96, 130);
  });
  g.fillStyle = 'rgba(0,0,0,.45)';
  g.font = '600 22px Segoe UI, sans-serif';
  g.fillText('thang xám — xem lớp phủ nâng vùng tối bao nhiêu', 60, 218);
  g.fillText('tông da', 60, 380);
  return createImageBitmap(c);
}

function refreshTestSelect(): void {
  const sel = $<HTMLSelectElement>('testSel');
  sel.innerHTML = state.tests.map((t) => `<option value="${t.id}">${t.name}</option>`).join('');
  sel.value = state.testId;
}

function rebuildTests(): void {
  const keep = state.tests.filter((t) => t.pairId === null);
  const fromPairs = state.pairs.map<TestImage>((p, i) => ({
    id: `t-${p.id}`,
    name: `Cặp ${i + 1} — ảnh gốc`,
    bmp: p.rawSrc,
    pairId: p.id,
  }));
  state.tests = keep.concat(fromPairs);
  if (!state.tests.some((t) => t.id === state.testId)) state.testId = state.tests[0]?.id ?? '';
  refreshTestSelect();
}

function previewBase(): { img: ImageData; pair: UIPair | null } | null {
  const t = state.tests.find((x) => x.id === state.testId);
  if (!t) return null;
  const k = Math.min(1, PREVIEW_MAX / Math.max(t.bmp.width, t.bmp.height));
  const w = Math.max(2, Math.round(t.bmp.width * k));
  const h = Math.max(2, Math.round(t.bmp.height * k));
  return { img: rasterize(t.bmp, w, h), pair: state.pairs.find((p) => p.id === t.pairId) ?? null };
}

/* ═════════════════════════ vẽ khung xem trước ═════════════════════════ */
const view = $<HTMLCanvasElement>('view');

function paint(img: ImageData): void {
  view.width = img.width;
  view.height = img.height;
  view.getContext('2d')!.putImageData(img, 0, 0);
  view.style.display = 'block';
  $('empty').classList.add('hidden');
}

function showEmpty(msg: string): void {
  view.style.display = 'none';
  const e = $('empty');
  e.innerHTML = msg;
  e.classList.remove('hidden');
}

/** Nền ca-rô để nhìn rõ vùng trong suốt của overlay. */
function checkerBehind(img: ImageData): ImageData {
  const out = new ImageData(img.width, img.height);
  const S = 12;
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const k = (y * img.width + x) * 4;
      const bg = (((x / S) | 0) + ((y / S) | 0)) % 2 === 0 ? 214 : 176;
      const a = img.data[k + 3] / 255;
      out.data[k] = Math.round(img.data[k] * a + bg * (1 - a));
      out.data[k + 1] = Math.round(img.data[k + 1] * a + bg * (1 - a));
      out.data[k + 2] = Math.round(img.data[k + 2] * a + bg * (1 - a));
      out.data[k + 3] = 255;
    }
  }
  return out;
}

function sideBySide(a: ImageData, b: ImageData, t: number): ImageData {
  const out = new ImageData(a.width, a.height);
  const cut = Math.round(a.width * t);
  for (let y = 0; y < a.height; y++) {
    for (let x = 0; x < a.width; x++) {
      const k = (y * a.width + x) * 4;
      const onLine = Math.abs(x - cut) <= 1;
      const src = x < cut ? a : b;
      for (let c = 0; c < 3; c++) out.data[k + c] = onLine ? 255 : src.data[k + c];
      out.data[k + 3] = 255;
    }
  }
  return out;
}

function drawCanvasView(): void {
  const cv = state.settings.canvas;
  const k = Math.min(1, 900 / Math.max(cv.w, cv.h));
  const w = Math.max(2, Math.round(cv.w * k));
  const h = Math.max(2, Math.round(cv.h * k));
  paint(checkerBehind(makeOverlay(w, h, true)));
}

function draw(): void {
  if (!ready()) {
    showEmpty('Thêm ít nhất một cặp ảnh rồi bấm <b>Bake overlay</b>.');
    return;
  }
  view.classList.toggle('pickable', state.mode === 'soft');

  if (state.view === 'canvas') {
    drawCanvasView();
    return;
  }

  const base = previewBase();
  if (!base) {
    showEmpty('Chưa có ảnh xem trước. Bấm <b>+ Thêm ảnh</b> ở dưới, hoặc xem tab <b>Canvas xuất</b>.');
    return;
  }

  const ov = makeOverlay(base.img.width, base.img.height, false);
  const comp = compositeOver(base.img, ov);
  const t = +$<HTMLInputElement>('split').value / 100;

  if (state.view === 'result') paint(comp);
  else if (state.view === 'split') paint(sideBySide(base.img, comp, t));
  else if (state.view === 'alpha') paint(checkerBehind(ov));
  else if (state.view === 'target' || state.view === 'heat') {
    if (!base.pair) {
      paint(comp);
      return;
    }
    const target = rasterize(base.pair.rawDst, base.img.width, base.img.height, base.pair.align);
    paint(state.view === 'target' ? sideBySide(comp, target, t) : errorHeatmap(comp, target));
  }
}

/* ═════════════════════════ bảng điều khiển soft light ═════════════════════════ */
const posPad = $<HTMLCanvasElement>('posPad');

function drawPosPad(): void {
  const r = posPad.getBoundingClientRect();
  const W = Math.max(80, Math.round(r.width));
  const H = Math.max(53, Math.round(r.height || (W * 2) / 3));
  posPad.width = W;
  posPad.height = H;
  const g = posPad.getContext('2d')!;
  g.fillStyle = '#0a0c0f';
  g.fillRect(0, 0, W, H);

  // Bản đồ cường độ quầng sáng, để thấy nguồn sáng phủ tới đâu.
  const ev = new Float64Array(4);
  const f = softLightEvaluator(state.soft);
  const img = g.createImageData(W, H);
  let peak = 1e-6;
  const buf = new Float64Array(W * H);
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      f((x / (W - 1)) * 2 - 1, (y / (H - 1)) * 2 - 1, ev);
      buf[y * W + x] = ev[0];
      if (ev[0] > peak) peak = ev[0];
    }
  for (let i = 0; i < W * H; i++) {
    const v = Math.round((buf[i] / peak) * 255);
    img.data[i * 4] = v;
    img.data[i * 4 + 1] = Math.round(v * 0.93);
    img.data[i * 4 + 2] = Math.round(v * 0.88);
    img.data[i * 4 + 3] = 255;
  }
  g.putImageData(img, 0, 0);

  const px = ((state.soft.gx + 1) / 2) * W;
  const py = ((state.soft.gy + 1) / 2) * H;
  g.strokeStyle = '#4f7dff';
  g.lineWidth = 2;
  g.beginPath();
  g.arc(px, py, 7, 0, Math.PI * 2);
  g.stroke();
  g.fillStyle = '#4f7dff';
  g.beginPath();
  g.arc(px, py, 2.5, 0, Math.PI * 2);
  g.fill();
}

function setGlowPos(nx: number, ny: number): void {
  state.soft.gx = clamp(nx, -1.6, 1.6);
  state.soft.gy = clamp(ny, -1.6, 1.6);
  drawPosPad();
  draw();
}

let padDrag = false;
const padPoint = (e: PointerEvent) => {
  const r = posPad.getBoundingClientRect();
  setGlowPos(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
};
on(posPad, 'pointerdown', (e) => {
  padDrag = true;
  posPad.setPointerCapture(e.pointerId);
  padPoint(e);
});
on(posPad, 'pointermove', (e) => padDrag && padPoint(e));
on(posPad, 'pointerup', () => (padDrag = false));

// Bấm thẳng lên ảnh xem trước cũng đặt được vị trí nguồn sáng.
on(view, 'pointerdown', (e) => {
  if (state.mode !== 'soft' || state.view === 'canvas') return;
  const r = view.getBoundingClientRect();
  setGlowPos(((e.clientX - r.left) / r.width) * 2 - 1, ((e.clientY - r.top) / r.height) * 2 - 1);
});

/** Đẩy giá trị từ state.soft ra các control. */
function pushSoftToUI(): void {
  const p = state.soft;
  const set = (id: string, v: number) => ($<HTMLInputElement>(id).value = String(v));
  set('sl-strength', Math.round(p.strength * 100));
  set('haze', Math.round(p.haze * 1000) / 10);
  set('glow', Math.round(p.glow * 100));
  set('radius', Math.round(p.radius * 100));
  set('vignette', Math.round(p.vignette * 100));
  set('vignetteRadius', Math.round(p.vignetteRadius * 100));
  set('sl-grain', Math.round(p.grainSigma * 2550));
  set('sl-gsize', Math.round(p.grainSize * 10));
  $<HTMLInputElement>('hazeColor').value = rgb2hex(p.color);
  $<HTMLInputElement>('glowColor').value = rgb2hex(p.glowColor);
  syncSoftLabels();
}

function syncSoftLabels(): void {
  const p = state.soft;
  $('o-sl-strength').textContent = `${Math.round(p.strength * 100)}%`;
  $('o-haze').textContent = `${(p.haze * 100).toFixed(1)}%`;
  $('o-glow').textContent = `${p.glow.toFixed(2)}×`;
  $('o-radius').textContent = p.radius.toFixed(2);
  $('o-vig').textContent = `${Math.round(p.vignette * 100)}%`;
  $('o-vigr').textContent = p.vignetteRadius.toFixed(2);
  $('o-sl-grain').textContent = `${(p.grainSigma * 255).toFixed(2)}/255`;
  $('o-sl-gsize').textContent = `${p.grainSize.toFixed(1)}px`;
}

function initSoftPanel(): void {
  const sel = $<HTMLSelectElement>('slPreset');
  sel.innerHTML = SOFT_LIGHT_PRESETS.map((p, i) => `<option value="${i}">${p.label}</option>`).join('');
  on(sel, 'change', () => {
    const keep = state.soft.strength;
    state.soft = { ...SOFT_LIGHT_PRESETS[+sel.value].params, strength: keep };
    pushSoftToUI();
    drawPosPad();
    draw();
  });
  on($('slReset'), 'click', () => {
    state.soft = { ...SOFT_LIGHT_PRESETS[+sel.value].params };
    pushSoftToUI();
    drawPosPad();
    draw();
  });

  const bind = (id: string, apply: (v: number) => void) =>
    on($<HTMLInputElement>(id), 'input', () => {
      apply(+$<HTMLInputElement>(id).value);
      syncSoftLabels();
      drawPosPad();
      draw();
    });

  bind('sl-strength', (v) => (state.soft.strength = v / 100));
  bind('haze', (v) => (state.soft.haze = v / 100));
  bind('glow', (v) => (state.soft.glow = v / 100));
  bind('radius', (v) => (state.soft.radius = v / 100));
  bind('vignette', (v) => (state.soft.vignette = v / 100));
  bind('vignetteRadius', (v) => (state.soft.vignetteRadius = v / 100));
  bind('sl-grain', (v) => (state.soft.grainSigma = v / 2550));
  bind('sl-gsize', (v) => (state.soft.grainSize = v / 10));

  for (const [id, key] of [['hazeColor', 'color'], ['glowColor', 'glowColor']] as const) {
    on($<HTMLInputElement>(id), 'input', () => {
      state.soft[key] = hex2rgb($<HTMLInputElement>(id).value);
      drawPosPad();
      draw();
    });
  }

  pushSoftToUI();
}

/* ═════════════════════════ chế độ bake: cặp ảnh ═════════════════════════ */
function ensureWork(): void {
  state.work = state.pairs.length ? workSize(state.pairs[0].rawSrc) : { w: 0, h: 0 };
}

function runAutoAlign(p: UIPair): void {
  const { w, h } = state.work;
  const s = toFloatRGB(rasterize(p.rawSrc, w, h));
  const d = toFloatRGB(rasterize(p.rawDst, w, h));
  const r = autoAlign(luma(s, w * h), luma(d, w * h), w, h);
  p.align = r.align;
  p.autoScore = r.score;
  p.baseScore = r.baseScore;
}

async function addPairFiles(files: File[]): Promise<void> {
  if (!files.length) return;
  await busy('Đang nạp và căn ảnh…', async () => {
    const bmps: { name: string; bmp: ImageBitmap }[] = [];
    for (const f of files) bmps.push({ name: f.name, bmp: await loadBitmap(f) });
    for (let i = 0; i + 1 < bmps.length; i += 2) {
      const p: UIPair = {
        id: uid(),
        name: `${bmps[i].name} → ${bmps[i + 1].name}`,
        rawSrc: bmps[i].bmp,
        rawDst: bmps[i + 1].bmp,
        align: { ...IDENTITY_ALIGN },
        enabled: true,
        autoScore: 0,
        baseScore: 0,
      };
      state.pairs.push(p);
      ensureWork();
      runAutoAlign(p);
    }
    if (bmps.length % 2 === 1) {
      alert(`Thừa 1 file ("${bmps[bmps.length - 1].name}") — mỗi cặp cần đúng 2 ảnh: gốc và đã filter.`);
    }
    rebuildTests();
  });
  renderPairs();
  syncButtons();
}

function thumb(bmp: ImageBitmap, al?: Align): HTMLCanvasElement {
  const c = document.createElement('canvas');
  const k = Math.min(150 / bmp.width, 150 / bmp.height);
  c.width = Math.max(1, Math.round(bmp.width * k));
  c.height = Math.max(1, Math.round(bmp.height * k));
  c.getContext('2d')!.putImageData(rasterize(bmp, c.width, c.height, al), 0, 0);
  return c;
}

function renderPairs(): void {
  const box = $('pairs');
  box.innerHTML = '';
  state.pairs.forEach((p, idx) => {
    const el = document.createElement('div');
    el.className = 'pair';
    const badge =
      p.autoScore > 0.35
        ? '<span class="badge ok">căn tốt</span>'
        : p.autoScore > 0.18
          ? '<span class="badge warn">căn tạm</span>'
          : '<span class="badge bad">căn kém</span>';

    el.innerHTML = `
      <div class="hd">
        <input type="checkbox" ${p.enabled ? 'checked' : ''} data-act="toggle" title="Dùng cặp này" />
        <b title="${p.name}">Cặp ${idx + 1}</b>
        ${badge}
        <button class="ghost mini" data-act="swap">Đảo</button>
        <button class="ghost mini" data-act="del">Xoá</button>
      </div>
      <div class="thumbs"></div>
      <div class="align">
        Căn chỉnh · điểm khớp ${p.autoScore.toFixed(3)}
        <div class="g"><span>X</span><input type="range" data-act="dx" min="-40" max="40" step="0.5" value="${p.align.dx}"><span>${p.align.dx.toFixed(1)}</span></div>
        <div class="g"><span>Y</span><input type="range" data-act="dy" min="-40" max="40" step="0.5" value="${p.align.dy}"><span>${p.align.dy.toFixed(1)}</span></div>
        <div class="g"><span>Zoom</span><input type="range" data-act="sc" min="0.85" max="1.15" step="0.002" value="${p.align.scale}"><span>${p.align.scale.toFixed(3)}</span></div>
        <button class="ghost mini" data-act="auto" style="margin-top:6px">Căn lại tự động</button>
      </div>`;

    const th = el.querySelector('.thumbs')!;
    const left = document.createElement('div');
    left.append(thumb(p.rawSrc));
    left.insertAdjacentHTML('beforeend', '<div class="cap">gốc</div>');
    const right = document.createElement('div');
    right.append(thumb(p.rawDst, p.align));
    right.insertAdjacentHTML('beforeend', '<div class="cap">đã filter · đã căn</div>');
    th.append(left, right);

    el.addEventListener('input', (e) => {
      const t = e.target as HTMLInputElement;
      const act = t.dataset.act;
      if (act === 'toggle') {
        p.enabled = t.checked;
        syncButtons();
        return;
      }
      if (act === 'dx') p.align.dx = +t.value;
      else if (act === 'dy') p.align.dy = +t.value;
      else if (act === 'sc') p.align.scale = +t.value;
      else return;
      (t.nextElementSibling as HTMLElement).textContent =
        act === 'sc' ? p.align.scale.toFixed(3) : (+t.value).toFixed(1);
      right.replaceChild(thumb(p.rawDst, p.align), right.firstChild!);
    });

    el.addEventListener('click', async (e) => {
      const act = (e.target as HTMLElement).dataset.act;
      if (act === 'del') {
        state.pairs = state.pairs.filter((x) => x !== p);
        ensureWork();
        rebuildTests();
        renderPairs();
        syncButtons();
      } else if (act === 'swap') {
        [p.rawSrc, p.rawDst] = [p.rawDst, p.rawSrc];
        await busy('Đang căn lại…', () => {
          ensureWork();
          runAutoAlign(p);
        });
        rebuildTests();
        renderPairs();
      } else if (act === 'auto') {
        await busy('Đang căn lại…', () => runAutoAlign(p));
        renderPairs();
      }
    });

    box.append(el);
  });
}

async function doBake(): Promise<void> {
  const act = state.pairs.filter((p) => p.enabled);
  if (!act.length) return;
  const res = await busy('Đang giải nghiệm overlay…', () => {
    const srcs: Float32Array[] = [];
    const dsts: Float32Array[] = [];
    const { w, h } = state.work;
    for (const p of act) {
      srcs.push(toFloatRGB(rasterize(p.rawSrc, w, h)));
      dsts.push(toFloatRGB(rasterize(p.rawDst, w, h, p.align)));
    }
    return bake({ srcs, dsts, w, h, degree: state.settings.degree, radial: state.settings.radial });
  });
  state.result = res;
  state.model = res.model;
  showDiag();
  syncButtons();
  draw();
}

function showDiag(): void {
  const r = state.result;
  const box = $('diag');
  if (!r) {
    box.classList.add('hidden');
    return;
  }
  box.classList.remove('hidden');
  const d = r.diag;
  const cls = d.rmse255 < 3 ? 'ok' : d.rmse255 < 6 ? 'warn' : 'bad';
  const verdict = d.rmse255 < 3 ? 'Rất sát' : d.rmse255 < 6 ? 'Chấp nhận được' : 'Lệch nhiều';
  box.innerHTML = `
    <div class="m"><span>Độ khớp</span><span class="badge ${cls}">${verdict}</span></div>
    <div class="m"><span>Sai số tái tạo</span><span>${d.rmse255.toFixed(2)} / 255</span></div>
    <div class="m"><span>Pixel lệch dưới 3/255</span><span>${(d.within3 * 100).toFixed(1)}%</span></div>
    <div class="m"><span>Biến thiên giải thích được</span><span>${(d.explained * 100).toFixed(2)}%</span></div>
    <div class="m"><span>Hạt</span><span>${(r.grain.sigmaC * 255).toFixed(2)}/255 · cỡ ${r.grain.size.toFixed(1)}px</span></div>
    <div class="m"><span>Số cặp ảnh</span><span>${d.pairs}</span></div>
    ${d.warnings.map((w) => `<div class="w${d.rmse255 > 6 ? ' bad' : ''}">${w}</div>`).join('')}`;
}

/* ═════════════════════════ biên tập ô ảnh ═════════════════════════ */
const cellCanvas = $<HTMLCanvasElement>('cellCanvas');

function drawCells(): void {
  const s = state.settings;
  const W = 360;
  const H = clamp(Math.round((W * s.canvas.h) / s.canvas.w), 60, 520);
  cellCanvas.width = W;
  cellCanvas.height = H;
  const g = cellCanvas.getContext('2d')!;
  g.fillStyle = '#0a0c0f';
  g.fillRect(0, 0, W, H);
  s.cells.forEach((c, i) => {
    const x = c.x * W;
    const y = c.y * H;
    const w = c.w * W;
    const h = c.h * H;
    g.fillStyle = i === state.selCell ? 'rgba(79,125,255,.28)' : 'rgba(124,156,255,.13)';
    g.fillRect(x, y, w, h);
    g.strokeStyle = i === state.selCell ? '#7c9cff' : '#3d4658';
    g.lineWidth = i === state.selCell ? 2 : 1;
    g.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);
    g.fillStyle = '#7c9cff';
    g.fillRect(x + w - 9, y + h - 9, 8, 8);
    g.fillStyle = '#c8d2e6';
    g.font = '11px sans-serif';
    g.fillText(String(i + 1), x + 5, y + 14);
  });
}

let dragMode: 'move' | 'resize' | null = null;
let dragStart = { x: 0, y: 0, cell: null as Cell | null };

on(cellCanvas, 'pointerdown', (e) => {
  const r = cellCanvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  const cells = state.settings.cells;
  for (let i = cells.length - 1; i >= 0; i--) {
    const c = cells[i];
    if (px >= c.x && px <= c.x + c.w && py >= c.y && py <= c.y + c.h) {
      state.selCell = i;
      dragMode = px > c.x + c.w - 0.035 && py > c.y + c.h - 0.05 ? 'resize' : 'move';
      dragStart = { x: px, y: py, cell: { ...c } };
      cellCanvas.setPointerCapture(e.pointerId);
      $<HTMLButtonElement>('delCell').disabled = false;
      drawCells();
      return;
    }
  }
  state.selCell = -1;
  $<HTMLButtonElement>('delCell').disabled = true;
  drawCells();
});

on(cellCanvas, 'pointermove', (e) => {
  if (!dragMode || !dragStart.cell || state.selCell < 0) return;
  const r = cellCanvas.getBoundingClientRect();
  const px = (e.clientX - r.left) / r.width;
  const py = (e.clientY - r.top) / r.height;
  const c = state.settings.cells[state.selCell];
  const o = dragStart.cell;
  if (dragMode === 'move') {
    c.x = clamp(o.x + (px - dragStart.x), 0, 1 - o.w);
    c.y = clamp(o.y + (py - dragStart.y), 0, 1 - o.h);
  } else {
    c.w = clamp(o.w + (px - dragStart.x), 0.02, 1 - o.x);
    c.h = clamp(o.h + (py - dragStart.y), 0.02, 1 - o.y);
  }
  drawCells();
});

on(cellCanvas, 'pointerup', () => {
  dragMode = null;
  if (state.view === 'canvas') draw();
});

/* ═════════════════════════ xuất file ═════════════════════════ */
function download(blob: Blob, name: string): void {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

async function doExport(): Promise<void> {
  if (!ready()) {
    alert('Chế độ bake cần có mô hình trước. Thêm cặp ảnh rồi bấm "Bake overlay".');
    return;
  }
  const cv = state.settings.canvas;
  await busy(`Đang render ${cv.w}×${cv.h}…`, async () => {
    const s = renderSettings(cv.w, cv.h);
    const { image, report } = renderOverlay(currentEvaluator(), currentGrain(), s);
    const c = document.createElement('canvas');
    c.width = image.width;
    c.height = image.height;
    c.getContext('2d')!.putImageData(image, 0, 0);
    const blob = await new Promise<Blob | null>((r) => c.toBlob(r, 'image/png'));
    const tag = state.mode === 'soft' ? Math.round(state.soft.strength * 100) : Math.round(state.settings.strength * 100);
    if (blob) download(blob, `overlay_softlight_${cv.w}x${cv.h}_${tag}pct.png`);
    $('exportInfo').innerHTML =
      `Đã xuất <b>${cv.w}×${cv.h}px</b> · alpha trung bình ${(report.meanAlpha * 100).toFixed(1)}%` +
      (report.grainClipped > 0.02
        ? `<br><span style="color:var(--warn)">${(report.grainClipped * 100).toFixed(0)}% pixel bị cắt hạt vì alpha không đủ chỗ chứa — giảm độ mạnh hạt hoặc tăng cường độ.</span>`
        : '');
  });
}

/* ═════════════════════════ nối dây ═════════════════════════ */
function syncButtons(): void {
  $<HTMLButtonElement>('bake').disabled = !state.pairs.some((p) => p.enabled);
  $<HTMLButtonElement>('export').disabled = !ready();
  $<HTMLButtonElement>('savePreset').disabled = !ready();
}

function applyMode(): void {
  const soft = state.mode === 'soft';
  $('pane-soft').classList.toggle('hidden', !soft);
  $('pane-bake').classList.toggle('hidden', soft);
  // Hai tab đối chiếu chỉ có nghĩa khi có ảnh đích để so.
  const bakeOnly = [...document.querySelectorAll<HTMLElement>('#tabs button[data-bakeonly]')];
  const onHiddenTab = soft && bakeOnly.some((b) => b.classList.contains('active'));
  bakeOnly.forEach((b) => b.classList.toggle('hidden', soft));
  if (onHiddenTab) setView('result');
  syncButtons();
  if (soft) drawPosPad();
  draw();
}

function setView(m: string): void {
  state.view = m;
  document.querySelectorAll('#tabs button').forEach((x) => {
    x.classList.toggle('active', (x as HTMLElement).dataset.mode === m);
  });
  $('splitWrap').classList.toggle('hidden', !['split', 'target'].includes(m));
}

function initShell(): void {
  on($('modebar'), 'click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    $('modebar').querySelectorAll('button').forEach((x) => x.classList.remove('active'));
    b.classList.add('active');
    state.mode = b.dataset.m as 'soft' | 'bake';
    applyMode();
  });

  on($('tabs'), 'click', (e) => {
    const b = (e.target as HTMLElement).closest('button');
    if (!b) return;
    setView(b.dataset.mode!);
    draw();
  });

  on($('split'), 'input', draw);
  on($('testSel'), 'change', () => {
    state.testId = $<HTMLSelectElement>('testSel').value;
    draw();
  });
  on($('pickTest'), 'click', () => $('testFile').click());
  on($('testFile'), 'change', async () => {
    const f = $<HTMLInputElement>('testFile').files?.[0];
    if (!f) return;
    const t: TestImage = { id: `x${++seq}`, name: f.name, bmp: await loadBitmap(f), pairId: null };
    state.tests.unshift(t);
    state.testId = t.id;
    refreshTestSelect();
    $<HTMLInputElement>('testFile').value = '';
    draw();
  });

  on($('bake'), 'click', doBake);
  on($('export'), 'click', doExport);
  setView('result');
}

function initBakeControls(): void {
  const drop = $('drop');
  const file = $<HTMLInputElement>('file');
  on($('pick'), 'click', () => file.click());
  on(file, 'change', () => {
    addPairFiles([...(file.files ?? [])]);
    file.value = '';
  });
  for (const ev of ['dragenter', 'dragover']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.add('over');
    });
  }
  for (const ev of ['dragleave', 'drop']) {
    drop.addEventListener(ev, (e) => {
      e.preventDefault();
      drop.classList.remove('over');
    });
  }
  drop.addEventListener('drop', (e) => {
    const fs = [...((e as DragEvent).dataTransfer?.files ?? [])].filter((f) => f.type.startsWith('image/'));
    // Thứ tự file khi thả nhiều lúc không ổn định; sắp theo tên để bản gốc đứng trước.
    fs.sort((a, b) => a.name.localeCompare(b.name, 'vi', { numeric: true }));
    addPairFiles(fs);
  });

  const bind = (id: string, out: string, fmt: (v: number) => string, set: (v: number) => void) => {
    const el = $<HTMLInputElement>(id);
    on(el, 'input', () => {
      const v = +el.value;
      $(out).textContent = fmt(v);
      set(v);
      draw();
    });
    $(out).textContent = fmt(+el.value);
  };
  bind('strength', 'o-strength', (v) => `${v}%`, (v) => (state.settings.strength = v / 100));
  bind('grainAmount', 'o-gamt', (v) => `${v}%`, (v) => (state.settings.grainAmount = v / 100));
  bind('grainScale', 'o-gsc', (v) => `${(v / 100).toFixed(2)}×`, (v) => (state.settings.grainScale = v / 100));

  on($('grainMode'), 'change', () => {
    state.settings.grainMode = $<HTMLSelectElement>('grainMode').value as RenderSettings['grainMode'];
    draw();
  });
  on($('degree'), 'change', () => (state.settings.degree = +$<HTMLSelectElement>('degree').value));
  on($('radial'), 'change', () => (state.settings.radial = $<HTMLInputElement>('radial').checked));
}

function initCanvasControls(): void {
  const sel = $<HTMLSelectElement>('canvasPreset');
  sel.innerHTML =
    CANVAS_PRESETS.map((c, i) => `<option value="${i}">${c.label}</option>`).join('') +
    '<option value="-1">Tuỳ chỉnh…</option>';
  const push = () => {
    $<HTMLInputElement>('cw').value = String(state.settings.canvas.w);
    $<HTMLInputElement>('ch').value = String(state.settings.canvas.h);
    $<HTMLInputElement>('dpi').value = String(state.settings.canvas.dpi);
  };
  push();

  on(sel, 'change', () => {
    const i = +sel.value;
    if (i < 0) return;
    state.settings.canvas = { ...CANVAS_PRESETS[i] };
    push();
    drawCells();
    draw();
  });

  for (const id of ['cw', 'ch', 'dpi']) {
    on($(id), 'change', () => {
      state.settings.canvas = {
        w: Math.max(16, Math.round(+$<HTMLInputElement>('cw').value)),
        h: Math.max(16, Math.round(+$<HTMLInputElement>('ch').value)),
        dpi: Math.max(36, Math.round(+$<HTMLInputElement>('dpi').value)),
        label: 'Tuỳ chỉnh',
      };
      sel.value = '-1';
      drawCells();
      draw();
    });
  }

  const lp = $<HTMLSelectElement>('layoutPreset');
  lp.innerHTML = LAYOUT_PRESETS.map((l, i) => `<option value="${i}">${l.label}</option>`).join('');
  on(lp, 'change', () => {
    state.settings.cells = LAYOUT_PRESETS[+lp.value].build();
    state.selCell = -1;
    $<HTMLButtonElement>('delCell').disabled = true;
    drawCells();
    draw();
  });

  document.querySelectorAll<HTMLInputElement>('input[name=apply]').forEach((r) =>
    on(r, 'change', () => {
      state.settings.applyMode = r.value as RenderSettings['applyMode'];
      $('cellBox').classList.toggle('hidden', r.value !== 'cells');
      drawCells();
      draw();
    }),
  );

  on($('addCell'), 'click', () => {
    state.settings.cells.push(makeCell(0.1, 0.1, 0.35, 0.35));
    state.selCell = state.settings.cells.length - 1;
    $<HTMLButtonElement>('delCell').disabled = false;
    drawCells();
  });
  on($('delCell'), 'click', () => {
    if (state.selCell >= 0) state.settings.cells.splice(state.selCell, 1);
    state.selCell = -1;
    $<HTMLButtonElement>('delCell').disabled = true;
    drawCells();
    draw();
  });

  drawCells();
}

function initPresetIO(): void {
  on($('savePreset'), 'click', () => {
    const p =
      state.mode === 'soft'
        ? buildSoftPreset('Soft light', state.settings, state.soft)
        : buildBakedPreset('Bake', state.settings, state.result!);
    download(new Blob([JSON.stringify(p, null, 2)], { type: 'application/json' }), `${p.kind}-preset.json`);
  });
  on($('loadPreset'), 'click', () => $('presetFile').click());
  on($('presetFile'), 'change', async () => {
    const f = $<HTMLInputElement>('presetFile').files?.[0];
    if (!f) return;
    try {
      const p = parsePreset(await f.text());
      state.settings = p.settings;
      if (p.kind === 'soft') {
        state.soft = p.soft!;
        state.mode = 'soft';
        pushSoftToUI();
      } else {
        state.model = modelFromPreset(p);
        state.mode = 'bake';
        // Preset bake chỉ lưu hệ số mô hình và thống kê hạt, không lưu bitmap
        // hạt gốc — nên chế độ "giữ nguyên grain" không dùng lại được.
        if (state.settings.grainMode === 'original') state.settings.grainMode = 'procedural';
        state.result = {
          field: {
            w: 1, h: 1,
            a: new Float32Array(1), u: new Float32Array(3),
            residual: new Float32Array(1), weight: new Float32Array(1),
          },
          model: state.model,
          grain: p.grain!,
          grainField: null,
          diag: p.diag!,
          grainResult: { stats: p.grain!, fixed: new Float32Array(3), w: 1, h: 1 },
        };
        $<HTMLSelectElement>('grainMode').value = state.settings.grainMode;
        showDiag();
      }
      $('modebar').querySelectorAll('button').forEach((b) =>
        b.classList.toggle('active', (b as HTMLElement).dataset.m === state.mode),
      );
      $<HTMLSelectElement>('canvasPreset').value = '-1';
      $<HTMLInputElement>('cw').value = String(state.settings.canvas.w);
      $<HTMLInputElement>('ch').value = String(state.settings.canvas.h);
      $<HTMLInputElement>('dpi').value = String(state.settings.canvas.dpi);
      drawCells();
      applyMode();
    } catch (err) {
      alert(`Không nạp được preset: ${(err as Error).message}`);
    }
    $<HTMLInputElement>('presetFile').value = '';
  });
}

/* ═════════════════════════ khởi động ═════════════════════════ */
async function boot(): Promise<void> {
  initShell();
  initSoftPanel();
  initBakeControls();
  initCanvasControls();
  initPresetIO();

  state.tests.push({ id: 't0', name: 'Bảng kiểm dựng sẵn', bmp: await buildTestCard(), pairId: null });
  state.testId = 't0';
  refreshTestSelect();

  applyMode();
  drawPosPad();
  draw();
  window.addEventListener('resize', () => state.mode === 'soft' && drawPosPad());
}

void boot();
