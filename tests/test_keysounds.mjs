// 現作 keysound 單元驗證:合成音訊 + 已知事件 → makeKeysounds
// 斷言:(1) 選樣選孤立那顆 (2) WAV header/時長正確 (3) 峰值 ≈ -3dB
import { makeKeysounds } from '../app/js/pipeline.js';

const sr = 44100, dur = 20, n = sr * dur;
const yL = new Float32Array(n), yR = new Float32Array(n);
// 在 t 放一個 0.05s 指數衰減 burst(振幅 amp)
function burst(t, amp) {
  const a = Math.round(t * sr), len = Math.round(0.05 * sr);
  for (let i = 0; i < len; i++) {
    const v = amp * Math.exp(-i / (0.01 * sr)) * Math.sin(2 * Math.PI * 200 * i / sr);
    yL[a + i] += v; yR[a + i] += 0.8 * v;
  }
}
// KICK:t=1.0(旁邊 1.05 有 SNARE,吵)、t=10.0(孤立)→ 應選 10.0
burst(1.0, 0.9); burst(1.05, 0.9); burst(10.0, 0.5);
// SNARE 只有一顆(t=1.05)
const events = [
  { t: 1.0, cls: 'KICK' }, { t: 10.0, cls: 'KICK' },
  { t: 1.05, cls: 'SNARE' },
];

const ks = makeKeysounds(events, yL, yR, sr);
let fail = 0;
const A = (cond, msg) => { console.log((cond ? 'PASS' : 'FAIL') + ' ' + msg); if (!cond) fail++; };

A(Object.keys(ks).sort().join() === 'KICK,SNARE', `類別 = ${Object.keys(ks).sort()}`);
A(ks.KICK.name === 'ks_kick.wav' && ks.SNARE.name === 'ks_snare.wav', `檔名 ${ks.KICK.name} ${ks.SNARE.name}`);

for (const [cls, want] of [['KICK', 0.25], ['SNARE', 0.30]]) {
  const v = new DataView(ks[cls].bytes);
  const tag = (o, len) => String.fromCharCode(...new Uint8Array(ks[cls].bytes, o, len));
  A(tag(0, 4) === 'RIFF' && tag(8, 4) === 'WAVE' && tag(36, 4) === 'data', `${cls} WAV header`);
  A(v.getUint16(22, true) === 2 && v.getUint32(24, true) === sr && v.getUint16(34, true) === 16,
    `${cls} stereo/44100/16bit`);
  const nSamp = v.getUint32(40, true) / 4;
  A(Math.abs(nSamp / sr - want) < 0.01, `${cls} 時長 ${(nSamp / sr).toFixed(3)}s ≈ ${want}s`);
  let peak = 0;
  for (let i = 0; i < nSamp; i++) peak = Math.max(peak, Math.abs(v.getInt16(44 + i * 4, true)));
  const db = 20 * Math.log10(peak / 32767);
  A(Math.abs(db + 3) < 0.1, `${cls} 峰值 ${db.toFixed(2)}dB ≈ -3dB`);
}
// 選樣:KICK 應切自 t=10(孤立)而非 t=1 — 檢查切片開頭 5ms 前是靜音(t=10 前無聲;t=1 前也無聲,
// 改用內容判別:t=1 的切窗 0.25s 內含 t=1.05 的 SNARE burst → 若選錯,50ms 處應有第二個峰)
{
  const v = new DataView(ks.KICK.bytes);
  const at = ms => Math.abs(v.getInt16(44 + Math.round(ms / 1000 * sr) * 4, true)) / 32767;
  // 55ms 處:若切自 t=1,SNARE burst 在 +50ms 起,55ms 處仍響(>0.1);切自 t=10 則已衰減到 ~0
  A(at(55) < 0.05, `KICK 切樣 55ms 處振幅 ${at(55).toFixed(4)} < 0.05(確認選了孤立的 t=10)`);
}
console.log(fail ? `\n${fail} 項失敗` : '\n全部通過');
process.exit(fail ? 1 : 0);
