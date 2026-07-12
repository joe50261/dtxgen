// BGM 去鼓回歸:worker 的 BGM 重編路徑之純計算部分。
// 修復前 BGM 直接打包原始混音(含鼓)— 玩家 keysound 與 BGM 鼓聲疊音;
// 修復後 BGM = 分離伴奏(非鼓 stem 相加)重採樣 48k 後編 Opus。
import { accompanimentFromStems } from '../app/js/pipeline.js';
import { resample } from '../app/js/dsp.js';

let fails = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
  if (!ok) fails++;
};

// ── accompanimentFromStems:模擬 demucs 佈局(4 stem × 2ch 共用一塊大 buffer)──
{
  const n = 1000;
  const big = new Float32Array(4 * 2 * n);
  const tracks = {};
  ['drums', 'bass', 'other', 'vocals'].forEach((nm, s) => {
    const L = new Float32Array(big.buffer, (s * 2) * n * 4, n);
    const R = new Float32Array(big.buffer, (s * 2 + 1) * n * 4, n);
    for (let i = 0; i < n; i++) { L[i] = (s + 1) * 0.1; R[i] = -(s + 1) * 0.1; }
    tracks[nm] = { channelData: [L, R], sampleRate: 44100 };
  });
  const { bgmL, bgmR } = accompanimentFromStems(tracks, n);
  // bass+other+vocals = (2+3+4)×0.1 = 0.9;drums(0.1)必須不在內
  check('伴奏 = 非鼓 stem 相加(排除 drums)',
        bgmL.every(v => Math.abs(v - 0.9) < 1e-6) && bgmR.every(v => Math.abs(v + 0.9) < 1e-6),
        `L=${bgmL[0].toFixed(3)} R=${bgmR[0].toFixed(3)}(drums 混入時會是 1.0)`);
  const compact = a => a.byteOffset === 0 && a.byteLength === a.buffer.byteLength;
  let err = null;
  try { structuredClone({ bgmL, bgmR }, { transfer: [bgmL.buffer, bgmR.buffer] }); } catch (e) { err = e; }
  check('輸出緊湊、脫鉤 stem 大 buffer、可 transfer',
        compact(bgmL) && compact(bgmR) && bgmL.buffer !== big.buffer && bgmL.buffer !== bgmR.buffer && !err,
        String(err || 'OK'));
}

// mono 退化:channelData 只有一軌 → 右聲道以左聲道補
{
  const n = 100;
  const mk = v => ({ channelData: [new Float32Array(n).fill(v)], sampleRate: 44100 });
  const { bgmL, bgmR } = accompanimentFromStems(
    { drums: mk(9), bass: mk(0.2), other: mk(0.3), vocals: mk(0.1) }, n);
  check('mono stem 退化', Math.abs(bgmL[0] - 0.6) < 1e-6 && Math.abs(bgmR[0] - 0.6) < 1e-6,
        `L=${bgmL[0].toFixed(3)} R=${bgmR[0].toFixed(3)}`);
}

// ── resample:44.1k → 48k(Opus 前置)──
{
  const sr = 44100, dst = 48000, n = sr;   // 1 秒
  const sine = (f, N, r) => Float32Array.from({ length: N }, (_, i) => Math.sin(2 * Math.PI * f * i / r));
  const t0 = Date.now();
  const y = resample(sine(1000, n, sr), sr, dst);
  check('輸出長度 = ceil(n·160/147)', y.length === Math.ceil(n * 160 / 147), `${y.length}`);
  // 對照理想 48k 正弦(跳過兩端一個核寬;核心對稱 → 無時間偏移)
  let mx = 0;
  for (let j = 64; j < y.length - 64; j++)
    mx = Math.max(mx, Math.abs(y[j] - Math.sin(2 * Math.PI * 1000 * j / dst)));
  check('1kHz 正弦重採樣(頻率/相位/振幅)', mx < 1e-3,
        `max|err|=${mx.toExponential(2)}(實測 ~2e-5;${Date.now() - t0}ms)`);
  // 高頻保持:15kHz RMS 誤差 <0.1dB 級
  const y15 = resample(sine(15000, n, sr), sr, dst);
  let rms = 0, cnt = 0;
  for (let j = 64; j < y15.length - 64; j++) { rms += y15[j] * y15[j]; cnt++; }
  rms = Math.sqrt(rms / cnt);
  check('15kHz 高頻保持', Math.abs(rms - Math.SQRT1_2) < 0.01, `rms=${rms.toFixed(4)}(理想 0.7071)`);
  // DC 平坦(相位核歸一)
  const yDc = resample(new Float32Array(n).fill(1), sr, dst);
  let dcMx = 0;
  for (let j = 64; j < yDc.length - 64; j++) dcMx = Math.max(dcMx, Math.abs(yDc[j] - 1));
  check('DC 平坦(核歸一)', dcMx < 1e-4, `maxDev=${dcMx.toExponential(2)}`);
  // 同率直通
  const x = sine(440, 1000, sr);
  check('srIn=srOut 直通', resample(x, sr, sr) === x);
  // 反向(48k→44.1k)含抗混疊 cutoff 縮放
  const yd = resample(sine(1000, dst, dst), dst, sr);
  let mxd = 0;
  for (let j = 64; j < yd.length - 64; j++)
    mxd = Math.max(mxd, Math.abs(yd[j] - Math.sin(2 * Math.PI * 1000 * j / sr)));
  check('48k→44.1k 反向', yd.length === Math.ceil(dst * 147 / 160) && mxd < 1e-3,
        `len=${yd.length} max|err|=${mxd.toExponential(2)}`);
}

process.exit(fails ? 1 : 0);
