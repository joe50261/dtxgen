// stem transfer 回歸:demucs 的 channelData 是「全部 stem 共用一塊大 buffer」
// 的 view — 直接把左右聲道的 .buffer 放進 transfer list 會因重複 ArrayBuffer
// 而 DataCloneError(真實案例:322.8s 曲目跑完 16 分鐘在最後一步 DTX 寫出炸掉)。
// detachStems 需保證:緊湊、buffer 相異、內容不變、可 structuredClone+transfer。
import { detachStems } from '../app/js/pipeline.js';

let fails = 0;
const A = (ok, msg) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + msg); if (!ok) fails++; };

const compactDistinct = (a, b) =>
  a.byteOffset === 0 && a.byteLength === a.buffer.byteLength &&
  b.byteOffset === 0 && b.byteLength === b.buffer.byteLength && a.buffer !== b.buffer;

// ── demucs 路徑:4 stem × 2ch 全在同一塊 buffer,drums 是其中兩段 view ──
{
  const length = 1000;
  const big = new Float32Array(4 * 2 * length);
  for (let i = 0; i < big.length; i++) big[i] = Math.sin(i);
  const dL = new Float32Array(big.buffer, 0 * length * 4, length);           // byteOffset=0 但非整塊
  const dR = new Float32Array(big.buffer, 1 * length * 4, length);
  const yL = new Float32Array(length), yR = new Float32Array(length);
  const { stemL, stemR } = detachStems(dL, dR, yL, yR);
  A(compactDistinct(stemL, stemR), 'demucs 路徑:緊湊且 buffer 相異');
  A(stemL.buffer !== big.buffer && stemR.buffer !== big.buffer, 'demucs 路徑:不搬整塊 4-stem buffer');
  A(stemL.every((v, i) => v === dL[i]) && stemR.every((v, i) => v === dR[i]), 'demucs 路徑:內容不變');
  // 回歸斷言:模擬 worker postMessage 的 transfer list(修復前這裡拋
  // DataCloneError: ArrayBuffer at index 1 is a duplicate of an earlier ArrayBuffer)
  let err = null;
  try { structuredClone({ stemL, stemR }, { transfer: [stemL.buffer, stemR.buffer] }); }
  catch (e) { err = e; }
  A(!err, `transfer list 無重複可轉移:${err || 'OK'}`);
}

// ── 純鼓軌路徑:dL/dR 即輸入,transfer 前需與輸入脫鉤 ──
{
  const n = 500;
  const yL = new Float32Array(n).fill(0.5), yR = new Float32Array(n).fill(-0.5);
  const { stemL, stemR } = detachStems(yL, yR, yL, yR);
  A(compactDistinct(stemL, stemR) && stemL.buffer !== yL.buffer && stemR.buffer !== yR.buffer,
    '純鼓軌路徑:slice 脫鉤輸入');
  A(stemL[0] === 0.5 && stemR[0] === -0.5, '純鼓軌路徑:內容不變');
}

// ── 退化:左右是同一個 view(單聲道來源)──
{
  const d = new Float32Array(300).fill(0.25);
  const { stemL, stemR } = detachStems(d, d, new Float32Array(300), new Float32Array(300));
  A(compactDistinct(stemL, stemR), '同一 view 傳兩次:buffer 仍相異');
}

process.exit(fails ? 1 : 0);
