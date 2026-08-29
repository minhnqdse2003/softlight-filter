import type { BakeResult, PresetFile, RenderSettings, SmoothModel } from './types';
import type { SoftLightParams } from './softlight';

const HEAD = { format: 'filmong-overlay-preset', version: 1 } as const;

export function buildSoftPreset(name: string, settings: RenderSettings, soft: SoftLightParams): PresetFile {
  return { ...HEAD, kind: 'soft', name, createdAt: new Date().toISOString(), settings, soft };
}

export function buildBakedPreset(name: string, settings: RenderSettings, b: BakeResult): PresetFile {
  return {
    ...HEAD,
    kind: 'baked',
    name,
    createdAt: new Date().toISOString(),
    settings,
    model: {
      degree: b.model.degree,
      radial: b.model.radial,
      terms: b.model.terms,
      ca: Array.from(b.model.ca),
      cu: Array.from(b.model.cu),
    },
    grain: b.grain,
    diag: b.diag,
  };
}

export function parsePreset(json: string): PresetFile {
  const p = JSON.parse(json) as PresetFile;
  if (p?.format !== 'filmong-overlay-preset') throw new Error('File không phải preset của công cụ này.');
  if (p.kind !== 'soft' && p.kind !== 'baked') throw new Error('Preset thiếu trường "kind".');
  if (p.kind === 'soft' && !p.soft) throw new Error('Preset soft light thiếu tham số.');
  if (p.kind === 'baked' && !p.model) throw new Error('Preset bake thiếu hệ số mô hình.');
  return p;
}

export function modelFromPreset(p: PresetFile): SmoothModel {
  const m = p.model!;
  return {
    degree: m.degree,
    radial: m.radial,
    terms: m.terms,
    ca: Float64Array.from(m.ca),
    cu: Float64Array.from(m.cu),
  };
}
