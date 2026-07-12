// 單元對照:mel、GBDT、peak picking → Python 參考
import { readFileSync } from 'fs';
import { logMelSpectrogram } from '../app/js/dsp.js';
import { gbdtPredict } from '../app/js/pipeline.js';

let fails = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

// ── mel 對照 ──
{
  const pcm = readFileSync('/tmp/js_drums_f32.pcm');
  const nS = pcm.length / 8;
  const inter = new Float32Array(pcm.buffer, pcm.byteOffset, nS * 2);
  const mono = new Float32Array(nS);
  for (let i = 0; i < nS; i++) mono[i] = (inter[2 * i] + inter[2 * i + 1]) / 2;
  const fb = new Float32Array(readFileSync('../app/models/fb_matrix.bin').buffer);
  const t0 = Date.now();
  const { data, T, bands } = logMelSpectrogram(mono, fb);
  const meta = JSON.parse(readFileSync('/tmp/mel_ref.json'));
  const refBuf = readFileSync('/tmp/mel_ref.bin');
  const ref = new Float32Array(refBuf.buffer, refBuf.byteOffset, meta.T * meta.bands);
  const n = Math.min(T, meta.T) * bands;
  let sum = 0, mx = 0;
  for (let i = 0; i < n; i++) { const d = Math.abs(data[i] - ref[i]); sum += d; if (d > mx) mx = d; }
  check('mel 前處理', sum / n < 2e-4 && Math.abs(T - meta.T) <= 1,
        `T=${T}/${meta.T} mean|diff|=${(sum / n).toExponential(2)} max=${mx.toExponential(2)} (${Date.now() - t0}ms)`);
}

// ── GBDT 對照 ──
{
  const gbdt = JSON.parse(readFileSync('../app/models/simplify_gbdt.json'));
  const ref = JSON.parse(readFileSync('/tmp/gbdt_ref.json'));
  let mx = 0;
  for (let i = 0; i < ref.X.length; i++) {
    const p = gbdtPredict(gbdt, ref.X[i]);
    mx = Math.max(mx, Math.abs(p - ref.p[i]));
  }
  check('GBDT 推論', mx < 1e-6, `max|Δp|=${mx.toExponential(2)} (${ref.X.length} 樣本)`);
}

process.exit(fails ? 1 : 0);
