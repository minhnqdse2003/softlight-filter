import type { BakeResult, Diagnostics, SmoothModel } from './types';
import { solveField } from './solve';
import { fitModel, renderModelToField } from './model';
import { analyzeGrain } from './grain';
import type { GrainResult } from './grain';

export interface BakeInput {
  srcs: Float32Array[];
  dsts: Float32Array[];
  w: number;
  h: number;
  degree: number;
  radial: boolean;
}

export interface FullBake extends BakeResult {
  grainResult: GrainResult;
}

/**
 * Đánh giá mô hình: dựng lại ảnh đích từ ảnh gốc bằng overlay đã fit, rồi đo
 * sai lệch. Đây là con số duy nhất đáng tin để biết overlay có tái tạo được
 * filter hay không — nếu filter chứa blur hoặc tone-curve phi tuyến mạnh thì
 * sai số ở đây sẽ bật lên rõ rệt.
 */
function diagnose(
  model: SmoothModel,
  srcs: Float32Array[],
  dsts: Float32Array[],
  w: number,
  h: number,
): Diagnostics {
  const rec = renderModelToField(model, w, h);
  const n = w * h;
  let sse = 0;
  let cnt = 0;
  let within = 0;
  let tVar = 0;
  let tMean = 0;
  const warnings: string[] = [];

  for (let p = 0; p < srcs.length; p++) {
    for (let i = 0, k = 0; i < n; i++, k += 3) {
      const a = rec.a[i];
      let worst = 0;
      for (let c = 0; c < 3; c++) {
        const pred = rec.u[i * 3 + c] + (1 - a) * srcs[p][k + c];
        const diff = (pred - dsts[p][k + c]) * 255;
        sse += diff * diff;
        cnt++;
        worst = Math.max(worst, Math.abs(diff));
        tMean += dsts[p][k + c];
      }
      if (worst <= 3) within++;
    }
  }
  tMean /= cnt;
  for (let p = 0; p < srcs.length; p++) {
    for (let i = 0; i < n * 3; i++) tVar += (dsts[p][i] - tMean) ** 2;
  }
  const rmse255 = Math.sqrt(sse / cnt);
  const explained = tVar > 0 ? Math.max(0, 1 - sse / 65025 / tVar) : 0;
  const within3 = within / (n * srcs.length);

  if (srcs.length === 1) {
    warnings.push(
      'Chỉ có 1 cặp ảnh: alpha được suy từ cửa sổ lân cận nên có thể lệch trên ảnh khác. Thêm 2–3 cặp nữa sẽ chắc hơn nhiều.',
    );
  }
  if (rmse255 > 6) {
    warnings.push(
      `Sai số tái tạo ${rmse255.toFixed(1)}/255 là cao. Filter gốc nhiều khả năng có blur, zoom blur hoặc tone-curve phi tuyến mạnh — những thứ overlay tĩnh không tả được.`,
    );
  }
  if (explained < 0.9 && rmse255 > 4) {
    warnings.push('Mô hình chỉ giải thích được một phần biến thiên. Kiểm tra lại việc căn ảnh trước khi dùng.');
  }
  return { pairs: srcs.length, rmse255, within3, explained, warnings };
}

export function bake(input: BakeInput): FullBake {
  const { srcs, dsts, w, h, degree, radial } = input;
  const field = solveField({ srcs, dsts, w, h });
  const model = fitModel(field, degree, radial);
  const grainResult = analyzeGrain(srcs, dsts, field);
  const diag = diagnose(model, srcs, dsts, w, h);
  return {
    field,
    model,
    grain: grainResult.stats,
    grainField: null,
    diag,
    grainResult,
  };
}
