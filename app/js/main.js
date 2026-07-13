// main.js — UI:多選/批量導入 → 佇列依序製譜(檔案解碼主線程 → Worker pipeline → JSZip 譜包下載)
// 跳過分離的正確輸入是「兩道 stem」(鼓軌 + 去鼓 BGM):加入佇列時自動配對成同一張卡片。
import { encodeOggOpus } from './oggopus.js';
import { resample } from './dsp.js';
import { cleanStemTitle, groupStemNames } from './pipeline.js';
const $ = id => document.getElementById(id);

// ── logger:UI 面板 + console 同步;error 帶完整 stack;可下載 ──
const logLines = [];
export function log(level, msg) {
  const ts = new Date().toISOString().slice(11, 23);
  const line = `[${ts}] ${level.toUpperCase().padEnd(5)} ${msg}`;
  logLines.push(line);
  const el = $('log');
  if (el) {
    el.textContent = logLines.slice(-800).join('\n');
    el.scrollTop = el.scrollHeight;
  }
  (level === 'error' ? console.error : level === 'warn' ? console.warn : console.log)('[dtxgen]', line);
  if (level === 'error') $('logbox').open = true;   // 出錯自動展開
}
$('dlLog').onclick = e => {
  e.preventDefault();
  const blob = new Blob([logLines.join('\n')], { type: 'text/plain' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `dtxgen_log_${new Date().toISOString().replace(/[:.]/g, '-')}.txt`;
  a.click();
};
$('clearLog').onclick = e => { e.preventDefault(); logLines.length = 0; $('log').textContent = ''; };
// 全域例外全部進 log
window.addEventListener('error', ev =>
  log('error', `未捕捉例外:${ev.message} @ ${ev.filename}:${ev.lineno}:${ev.colno}\n${ev.error?.stack || ''}`));
window.addEventListener('unhandledrejection', ev =>
  log('error', `未處理的 Promise 拒絕:${ev.reason?.stack || ev.reason}`));
log('info', `dtxgen web 啟動 — UA: ${navigator.userAgent}`);
log('info', `WebGPU: ${'gpu' in navigator ? '可用' : '不可用(分離將走 WASM,較慢)'} · 核心數: ${navigator.hardwareConcurrency || '?'}`);

// 曲名消毒:任何來源(手填/檔名/譜包 #TITLE/metadata)統一過濾 —
// 含 / 的曲名會讓 zip.folder 建出巢狀層級(打包層級錯誤的根源)
const sanitize = s => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'song';
const mb = b => (b / 1048576).toFixed(1) + ' MB';

// FLAC 編碼(libflac WASM;16-bit 同 soundfile 預設)— 無損來源 BGM 重編,
// 以及無 WebCodecs 時鼓原軌的退路
function encodeFlac(yL, yR, sr) {
  return new Promise((resolve, reject) => {
    const run = () => {
      try {
        const n = yL.length;
        // total_samples 先宣告 → STREAMINFO 從頭正確(stream 模式無法回寫)
        const enc = Flac.create_libflac_encoder(sr, 2, 16, 5, n, true);
        if (!enc) return reject(new Error('FLAC encoder 建立失敗'));
        const chunks = [];
        Flac.init_encoder_stream(enc, (data) => { chunks.push(data.slice ? data.slice() : new Uint8Array(data)); });
        const BLOCK = 65536;
        const buf = new Int32Array(BLOCK * 2);
        for (let off = 0; off < n; off += BLOCK) {
          const m = Math.min(BLOCK, n - off);
          for (let i = 0; i < m; i++) {
            buf[2 * i] = Math.max(-32768, Math.min(32767, Math.round(yL[off + i] * 32767)));
            buf[2 * i + 1] = Math.max(-32768, Math.min(32767, Math.round(yR[off + i] * 32767)));
          }
          if (!Flac.FLAC__stream_encoder_process_interleaved(enc, buf.subarray(0, m * 2), m))
            return reject(new Error('FLAC 編碼失敗'));
        }
        Flac.FLAC__stream_encoder_finish(enc);
        Flac.FLAC__stream_encoder_delete(enc);
        const total = chunks.reduce((s, c) => s + c.length, 0);
        const out = new Uint8Array(total);
        let o = 0;
        for (const c of chunks) { out.set(c, o); o += c.length; }
        resolve(out);
      } catch (e) { reject(e); }
    };
    if (typeof Flac !== 'undefined' && Flac.isReady()) run();
    else Flac.on('ready', run);
  });
}

// ── 佇列:多選 / 批量導入,共用單一 worker 依序製譜(模型只載入一次、保持熱)──
// item: { id, file, bgmFile, pair, name, autoTitle, status, title, bpm, start,
//         finalTitle, progress, stage, error, url, dlName, summary, stats, ctx, el }
//   pair=true:兩道已分離 stem — file=鼓軌、bgmFile=去鼓 BGM,跳過分離。
const queue = [];
let seq = 0;
let processing = false;       // 佇列驅動中(有工作在跑或排隊等跑)
let stopRequested = false;    // 要求完成當前工作後暫停
let currentJob = null;        // 目前這輪處理的 item(前置處理或送 worker 中)
let inFlight = null;          // 已 postMessage 進 worker、正等 worker 回覆的 item
let runDone = 0, runErr = 0;  // 本輪(這次「開始製譜」)的成功/失敗計數(完成/失敗列會留在佇列供重下,故不能用全佇列統計)

const DROP_HINT = '拖放或點擊選擇 — 可一次多選音檔或譜包 zip 回爐;鼓軌 + 去鼓 BGM 兩道會自動配對成一張卡片';
const drop = $('drop');
drop.onclick = () => $('file').click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
drop.ondragleave = () => drop.classList.remove('on');
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove('on');
  if (e.dataTransfer.files.length) addFiles(e.dataTransfer.files);
};
// value 清空:同一批檔案再次選取(或移除後重選)仍會觸發 change
$('file').onchange = () => { if ($('file').files.length) addFiles($('file').files); $('file').value = ''; };

// 保留拖入順序地把整批(含 zip)規劃成佇列單元:zip 各自單檔;音檔交給 groupStemNames 配對。
// 音檔中成對的「鼓 stem + 去鼓 BGM stem」併為同一列(跳過分離),其餘各自成列。
// 回傳單元:{kind:'single', file} | {kind:'pair', drum, bgm}
function planUnits(fresh) {
  const audio = fresh.filter(f => !/\.zip$/i.test(f.name));
  const pairMap = new Map();    // drumFile -> bgmFile
  const consumed = new Set();   // 已被配對吃掉的 bgm 檔(走訪時跳過)
  for (const u of groupStemNames(audio.map(f => f.name)))
    if (u.kind === 'pair') { pairMap.set(audio[u.drum], audio[u.bgm]); consumed.add(audio[u.bgm]); }
  const units = [];
  for (const f of fresh) {
    if (consumed.has(f)) continue;
    if (/\.zip$/i.test(f.name)) { units.push({ kind: 'single', file: f }); continue; }
    if (pairMap.has(f)) units.push({ kind: 'pair', drum: f, bgm: pairMap.get(f) });
    else units.push({ kind: 'single', file: f });
  }
  return units;
}

function baseItem(file, over) {
  return {
    id: ++seq, file, bgmFile: null, pair: false,
    name: file.name, autoTitle: file.name.replace(/\.[^.]+$/, ''),
    status: 'pending',
    // 每列參數:加入時以上方「預設值」帶入,之後可個別調整(曲名留空 → 自動用檔名/譜包內曲名)
    title: '', bpm: $('bpm').value.trim(), start: $('start').value.trim(),
    finalTitle: '',   // 製譜時解析出的實際曲名(供卡片顯示)
    progress: 0, stage: '', error: '', url: null, dlName: '', summary: '', stats: '',
    ctx: null, el: null, ...over,
  };
}

function addFiles(fileList) {
  // 去重:與尚未完成(等待/處理中)項目的任一來源檔(單檔 file 或 pair 的 file/bgmFile)同名同大小即略過
  const isQueued = f => queue.some(j => (j.status === 'pending' || j.status === 'active')
    && ((j.file.name === f.name && j.file.size === f.size)
      || (j.bgmFile && j.bgmFile.name === f.name && j.bgmFile.size === f.size)));
  const fresh = [];
  let skipped = 0;
  for (const f of [...fileList]) { if (isQueued(f)) skipped++; else fresh.push(f); }
  let added = 0, pairs = 0;
  for (const u of planUnits(fresh)) {
    if (u.kind === 'pair') {
      const title = cleanStemTitle(u.drum.name);
      queue.push(baseItem(u.drum, { bgmFile: u.bgm, pair: true, name: title, autoTitle: title }));
      pairs++;
    } else {
      queue.push(baseItem(u.file, {}));
    }
    added++;
  }
  log('info', `加入佇列:${added} 列${pairs ? `(其中 ${pairs} 組兩道 stem)` : ''}${skipped ? `,略過 ${skipped} 個重複檔` : ''} — 目前佇列 ${queue.length} 列`);
  drop.textContent = queue.length ? `已選 ${queue.length} 列(可再拖入更多)— 按「開始製譜」` : DROP_HINT;
  renderQueue();
  updateControls();
}

let worker;
function spawnWorker() {
  worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
  worker.onerror = onWorkerError;
  worker.onmessage = onWorkerMessage;
}

function onWorkerError(ev) {
  log('error', `worker 錯誤:${ev.message} @ ${ev.filename}:${ev.lineno}`);
  // onerror 多為致命崩潰:可復原的失敗 pipeline 內已 try/catch 轉成 {type:'error'} 訊息,
  // 能走到這裡的通常是把 worker 打死的崩潰(OOM / WebGPU / 模組錯誤)。
  // 只在確有在飛工作(inFlight active)時介入 —— inFlight 於收到終結訊息(done/error)
  // 時即清空,故打包/下一件前置處理(主線程 await)期間的殘留 onerror 不會誤判。
  // 介入時必須「重建 worker」:崩潰的 worker 可能已死,若把下一件送進去會永遠收不到
  // 回覆而整批卡死;重建後下一件會重新載入模型(以一次重載換取不卡死)。
  if (inFlight && inFlight.status === 'active') {
    const j = inFlight; inFlight = null;
    try { worker.terminate(); } catch {}
    spawnWorker();
    log('warn', 'worker 已重建 — 下一件將重新載入模型');
    settleError(j, `worker 崩潰(已重建 worker):${ev.message}`);
  }
}

function onWorkerMessage(ev) {
  const m = ev.data;
  if (m.type === 'log') { log(m.level || 'info', `[worker] ${m.msg}`); return; }
  if (!currentJob) return;   // 無在飛工作時忽略殘留訊息
  if (m.type === 'progress') {
    currentJob.progress = m.pct; currentJob.stage = m.msg;
    $('bar').style.width = m.pct + '%';
    $('stage').textContent = `處理中 ${doneCount() + 1}/${queue.length} — ${currentJob.name}:${m.msg}`;
    renderRow(currentJob);
  } else if (m.type === 'error') {
    inFlight = null;   // 終結訊息:worker 對本件已無後續訊息
    settleError(currentJob, `階段「${m.stage || '?'}」:${m.error}`);
  } else if (m.type === 'done') {
    inFlight = null;   // 終結訊息:接下來的打包在主線程 await,期間 onerror 不應誤判本件
    finishJob(currentJob, m);
  }
}

spawnWorker();

const doneCount = () => queue.filter(j => j.status === 'done' || j.status === 'error').length;

$('go').onclick = () => {
  if (processing) return;
  if (!queue.some(j => j.status === 'pending')) { log('warn', '佇列沒有待處理項目'); return; }
  processing = true; stopRequested = false;
  runDone = 0; runErr = 0;   // 本輪計數歸零(不含前次已完成/失敗且留在佇列的列)
  $('err').textContent = '';
  $('barbox').style.display = 'block'; $('bar').style.width = '1%';
  updateControls();
  advance();   // 送出第一個
};

$('stop').onclick = () => {
  if (!processing || stopRequested) return;
  stopRequested = true;
  $('stop').disabled = true;
  log('info', '已要求停止 — 完成當前工作後暫停');
  $('stage').textContent = '停止中 — 完成當前工作後暫停…';
};

$('clearQ').onclick = () => {
  // 清掉非「處理中」的項目並釋放其 object URL;保留正在跑的當前工作
  for (const j of queue) {
    if (j === currentJob) continue;
    if (j.url) { URL.revokeObjectURL(j.url); j.url = null; }
  }
  const keep = currentJob ? [currentJob] : [];
  queue.length = 0; queue.push(...keep);
  log('info', '已清空佇列' + (currentJob ? '(當前工作保留)' : ''));
  drop.textContent = queue.length ? `已選 ${queue.length} 列(可再拖入更多)— 按「開始製譜」` : DROP_HINT;
  renderQueue();
  updateControls();
};

// 送出下一個待處理工作;沒有則收尾
function advance() {
  currentJob = null; inFlight = null;
  $('bar').style.width = '0%';
  const next = queue.find(j => j.status === 'pending');
  if (stopRequested) {
    stopRequested = false;
    if (next) {   // 確有未處理項目才顯示「已停止」;否則其實已全部做完 → 走正常收尾
      processing = false;
      log('info', '已停止佇列 — 尚有未處理項目,可再按「開始製譜」續跑');
      $('stage').textContent = '已停止 — 佇列尚有未處理項目';
      $('barbox').style.display = 'none';
      updateControls();
      return;
    }
  }
  if (next) { submitJob(next); return; }
  // 全部處理完 —— 用本輪計數(完成/失敗列會留在佇列供重下,不能用全佇列統計)
  processing = false;
  $('stage').textContent = `全部完成 — 成功 ${runDone}${runErr ? ` · 失敗 ${runErr}` : ''}`;
  $('barbox').style.display = 'none';
  log('info', `佇列處理完畢 — 成功 ${runDone} 失敗 ${runErr}`);
  updateControls();
}

// 結算失敗:標記、記錄、續跑(冪等:已結算則不重複前進)
function settleError(item, msg) {
  if (item.status === 'done' || item.status === 'error') return;
  item.status = 'error'; item.error = msg; item.stage = ''; runErr++;
  releaseCtx(item);   // 釋放來源音訊位元組副本,勿隨失敗項留在佇列
  log('error', `失敗(${item.name}):${msg}`);
  renderRow(item);
  advance();
}

// 釋放 item.ctx 內的來源音訊位元組副本(bgmBytes / stemPass)。這些只在打包時需要;
// 若不釋放,整批的來源副本會隨各佇列項目累積在主線程記憶體(原單一全域 jobCtx 只留一份)。
function releaseCtx(item) {
  if (item.ctx) { item.ctx.bgmBytes = null; item.ctx.stemPass = null; }
}

// 前置處理(解 zip / 解碼 / 跳秒裁切)→ 送進 worker。以 item 取代原全域狀態。
async function submitJob(item) {
  currentJob = item;
  item.status = 'active'; item.progress = 1; item.stage = '準備中'; item.error = '';
  renderRow(item);
  const f = item.file;   // pair:f = 鼓 stem;單檔:f = 該檔
  const setStage = txt => { item.stage = txt; $('stage').textContent = `處理中 ${doneCount() + 1}/${queue.length} — ${item.name}:${txt}`; renderRow(item); };
  try {
    const isZip = /\.zip$/i.test(f.name);
    // 參數一律取自「本卡片」(加入時由上方預設值帶入,之後可個別調整)
    // 跳過開頭秒數:等同 Python 版 YouTube 網址的 t= 參數
    const startSec = Math.max(0, parseFloat(item.start) || 0);
    // 曲名:卡片填了就用,留空 → 自動用檔名(pair 取去 stem 字尾的乾淨曲名)/ 譜包內曲名
    let title = (item.title || '').trim();
    let isStem = false;   // 跳過分離(鼓 stem 直跑):由 zip 內含鼓原軌、或 pair 兩道 stem 觸發
    let audioBuf, bgmBytes, bgmName, stemPass = null;   // 來源鼓原軌已是 Opus → 原 bytes 原封沿用
    if (isZip) {
      setStage('解析譜包 zip(找鼓原軌)');
      log('info', `解析譜包 zip … (${f.name})`);
      const zip = await JSZip.loadAsync(await f.arrayBuffer());
      let stemEntry = null, bgmEntry = null, dtxEntry = null, srcEntry = null;
      zip.forEach((path, entry) => {
        const nn = path.toLowerCase();
        if (/dtxgen_drums\.(wav|flac|opus)$/.test(nn)) stemEntry = entry;
        if (/(^|\/)bgm\.(ogg|opus|mp3|wav|m4a|flac)$/.test(nn)) bgmEntry = entry;
        if (/\.dtx$/.test(nn) && (!dtxEntry || entry._data.uncompressedSize > dtxEntry._data.uncompressedSize)) dtxEntry = entry;
        if (/dtxgen_source\.json$/.test(nn)) srcEntry = entry;
      });
      if (srcEntry && !title) {
        try { title = (JSON.parse(await srcEntry.async('string')) || {}).title || ''; } catch {}
      }
      if (!title && dtxEntry) {
        const txt = await dtxEntry.async('string');
        const mm = txt.match(/#TITLE:\s*(.+)/);
        if (mm) title = mm[1].trim();
      }
      if (stemEntry) {
        isStem = true;                      // 鼓原軌直跑:跳過分離
        audioBuf = await stemEntry.async('arraybuffer');
        if (/\.opus$/i.test(stemEntry.name)) stemPass = audioBuf.slice(0);   // decodeAudioData 會 detach → 先留副本
        log('info', `找到鼓原軌:${stemEntry.name}(${mb(audioBuf.byteLength)})→ 跳過分離`);
        setStage('使用譜包內鼓原軌(跳過分離)');
      } else if (bgmEntry) {
        audioBuf = await bgmEntry.async('arraybuffer');
        log('warn', `譜包無鼓原軌 — 用包內 BGM(${bgmEntry.name})走完整流程`);
        setStage('譜包無鼓原軌 — 用包內 BGM 走完整流程');
      } else throw new Error('zip 內找不到鼓原軌或 BGM');
      if (bgmEntry) { bgmBytes = await bgmEntry.async('arraybuffer'); bgmName = 'bgm.' + bgmEntry.name.split('.').pop().toLowerCase(); }
      else { bgmBytes = audioBuf.slice(0); bgmName = 'bgm.' + stemEntry.name.split('.').pop().toLowerCase(); }
    } else if (item.pair) {
      // 兩道已分離 stem:鼓 stem 供轉譜/keysound/鼓原軌,去鼓 BGM stem 供伴奏。
      // demucs stem 本是兩道 → 跳過分離須兩道同時提供,BGM 才是真正的去鼓伴奏
      //(而非把鼓軌本身誤當 BGM,那會與玩家 keysound 疊音、且完全沒有旋律/貝斯/人聲)。
      isStem = true;
      const bgmF = item.bgmFile;
      const drumsBuf = await f.arrayBuffer();
      bgmBytes = await bgmF.arrayBuffer();
      bgmName = 'bgm.' + (bgmF.name.split('.').pop() || 'opus').toLowerCase();
      if (/\.opus$/i.test(f.name)) stemPass = drumsBuf.slice(0);   // decodeAudioData 會 detach → 先留副本
      audioBuf = drumsBuf;
      log('info', `兩道 stem:鼓軌 ${f.name}(${mb(drumsBuf.byteLength)})· 去鼓 BGM ${bgmF.name}(${mb(bgmBytes.byteLength)})→ 跳過分離`);
      setStage('使用已分離的兩道 stem(跳過分離)');
    } else {
      // 單一混音檔:走完整分離(demucs),BGM 由 worker 從去鼓伴奏重編。
      // 不再有「純鼓軌」單檔捷徑:單一鼓軌缺伴奏,舊設計只能把鼓軌本身誤當 BGM(疊音 bug)。
      audioBuf = await f.arrayBuffer();
      bgmBytes = audioBuf.slice(0);   // 分離路徑不採用(worker 產 BGM);僅供未走分離時兜底
      bgmName = 'bgm.' + (f.name.split('.').pop() || 'ogg').toLowerCase();
    }
    title = sanitize(title || item.autoTitle);
    item.finalTitle = title;   // 解析後的實際曲名 → 卡片顯示
    renderRow(item);

    setStage('解碼音訊');
    const tDec = performance.now();
    const ac = new AudioContext({ sampleRate: 44100 });
    const decoded = await ac.decodeAudioData(audioBuf);
    ac.close();
    log('info', `解碼完成:${decoded.duration.toFixed(1)}s ${decoded.numberOfChannels}ch @${decoded.sampleRate}Hz(${(performance.now()-tDec).toFixed(0)}ms)`);
    // resample 到 44100(decodeAudioData 已按 AudioContext sampleRate 重採樣)
    const n = decoded.length;
    let yL = new Float32Array(decoded.getChannelData(0));
    let yR = new Float32Array(decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0));

    if (startSec > 0) {
      stemPass = null;   // 裁切後內容已變 → 不能沿用,回打包重編
      const off = Math.round(startSec * 44100);
      if (off >= n) throw new Error(`跳過秒數(${startSec}s)不小於音檔長度(${(n / 44100).toFixed(1)}s)`);
      yL = yL.slice(off); yR = yR.slice(off);
      if (isStem) {
        setStage(`跳過開頭 ${startSec}s — 重編 BGM`);
        // BGM 也要同起點:壓縮格式無法原樣裁切 → 解碼裁切後重編。
        // 有損來源重編回 Ogg/Opus(不轉無損);無損來源(wav/flac)重編 FLAC。
        // Opus 只吃 48kHz,故有損來源在 48k 解碼裁切
        const lossless = /\.(wav|flac)$/i.test(bgmName);
        const bgmSr = lossless ? 44100 : 48000;
        const ac2 = new AudioContext({ sampleRate: bgmSr });
        const bgmDec = await ac2.decodeAudioData(bgmBytes);
        ac2.close();
        const o = Math.min(Math.round(startSec * bgmSr), bgmDec.length);
        const bL = bgmDec.getChannelData(0).subarray(o);
        const bR = (bgmDec.numberOfChannels > 1 ? bgmDec.getChannelData(1) : bgmDec.getChannelData(0)).subarray(o);
        bgmBytes = lossless ? await encodeFlac(bL, bR, 44100) : await encodeOggOpus(bL, bR);
        bgmName = lossless ? 'bgm.flac' : 'bgm.opus';   // Opus 封裝副檔名 .opus(RFC 7845),.ogg 會被當 Vorbis
        log('info', `跳過開頭 ${startSec}s → 剩 ${(yL.length / 44100).toFixed(1)}s(BGM 重編 ${bgmName.split('.')[1]} ${(bgmBytes.length / 1048576).toFixed(1)} MB)`);
      } else {
        // 分離路徑:BGM 由 worker 從(已裁切的)輸入分離出的伴奏重編,起點自然一致
        log('info', `跳過開頭 ${startSec}s → 剩 ${(yL.length / 44100).toFixed(1)}s(BGM 稍後由去鼓伴奏重編,同起點)`);
      }
    }

    item.ctx = { title, bgmBytes, bgmName, stemPass };
    setStage('送入 pipeline');
    log('info', `提交 pipeline:title=${title} stem=${isStem} bgm=${isStem ? bgmName : '(分離後去鼓重編)'} bpmHint=${parseFloat(item.bpm) || '無'}`);
    inFlight = item;   // 自此刻起本件確實在 worker 內;收到 done/error 前歸 onerror 認領
    worker.postMessage({
      yL, yR, sr: 44100, isDrumsStem: isStem, title, bgmName,
      bpmHint: parseFloat(item.bpm) || null,
    }, [yL.buffer, yR.buffer]);
  } catch (e) {
    log('error', `前置處理失敗(${f.name}):${e && e.stack || e}`);
    settleError(item, `前置處理:${e && e.message || e}`);
  }
}

async function finishJob(item, m) {
  if (item.status !== 'active') return;   // 冪等保險
  const setStage = txt => { item.stage = txt; $('stage').textContent = `${item.name}:${txt}`; renderRow(item); };
  try {
    setStage('打包譜包 zip(Opus 編碼鼓原軌)');
    const { title } = item.ctx;
    // BGM:分離路徑用 worker 重編的去鼓伴奏;兩道 stem/回爐路徑沿用來源去鼓 BGM
    const bgmBytes = m.bgm ? m.bgm.bytes : item.ctx.bgmBytes;
    const bgmName = m.bgm ? m.bgm.name : item.ctx.bgmName;
    if (m.bgm) log('info', `BGM 使用去鼓伴奏:${bgmName}(${(bgmBytes.byteLength / 1048576).toFixed(1)} MB)`);
    const tF = performance.now();
    // 鼓原軌:來源已是 Opus 且未裁切 → 原 bytes 原封沿用(重編只添世代損失);
    // 否則編 Ogg/Opus 192kbps(同 BGM 規格;Opus 只吃 48kHz → 先重採樣),
    // 無 WebCodecs 的瀏覽器退 FLAC — 回爐掃描各副檔名都認
    let stemBytes, stemName;
    if (item.ctx.stemPass) {
      stemBytes = new Uint8Array(item.ctx.stemPass);
      stemName = 'dtxgen_drums.opus';
      log('info', `鼓原軌沿用來源 Opus bytes(免重編、零世代損失):${(stemBytes.length/1048576).toFixed(1)} MB`);
    } else try {
      stemBytes = await encodeOggOpus(resample(m.stemL, m.sr, 48000), resample(m.stemR, m.sr, 48000));
      stemName = 'dtxgen_drums.opus';
      log('info', `鼓原軌編碼:${stemName}(${(stemBytes.length/1048576).toFixed(1)} MB,${((performance.now()-tF)/1000).toFixed(1)}s)`);
    } catch (e) {
      log('warn', `Opus 編碼不可用(${e && e.message || e})— 鼓原軌退 FLAC`);
      stemBytes = await encodeFlac(m.stemL, m.stemR, m.sr);
      stemName = 'dtxgen_drums.flac';
      log('info', `鼓原軌編碼:${stemName}(${(stemBytes.length/1048576).toFixed(1)} MB,${((performance.now()-tF)/1000).toFixed(1)}s)`);
    }
    // zip 內平鋪(無資料夾層):解壓工具會以 zip 檔名建一層,內層再包資料夾會變兩層
    const dir = new JSZip();
    for (const [lv, text] of Object.entries(m.charts)) dir.file(`${lv}.dtx`, text);
    dir.file('SET.def', m.setdef);
    dir.file(bgmName, bgmBytes);
    dir.file(stemName, stemBytes);   // 鼓原軌:回爐重做的一手素材
    dir.file('dtxgen_source.json', JSON.stringify({ generator: 'dtxgen-web', title, created: Date.now() }));
    // 現作 keysounds(切自該曲鼓軌;缺類 lane 不會出現在譜面,無需預設音)
    for (const [name, bytes] of Object.entries(m.keysounds || {})) dir.file(name, bytes);
    log('info', `keysounds:${Object.keys(m.keysounds || {}).length} 顆(現作)`);
    const blob = await dir.generateAsync({ type: 'blob', compression: 'DEFLATE' });
    releaseCtx(item);   // 來源位元組已入 zip,釋放主線程副本(避免整批累積)
    // 防守:打包期間若本件已被(如 onerror)結算,放棄本結果、勿重複前進 advance()
    if (item.status !== 'active') { log('warn', `${item.name} 於打包期間已結算(${item.status})— 丟棄本次結果`); return; }
    if (item.url) URL.revokeObjectURL(item.url);   // 重跑同項目時釋放舊 URL
    item.url = URL.createObjectURL(blob);
    item.dlName = `${title}_dtx.zip`;
    const a = document.createElement('a');   // 自動下載(與單檔行為一致;批次逐一下載,連結留在列上可重下)
    a.href = item.url; a.download = item.dlName; a.click();
    const bpmTxt = m.bpmText || m.bpm;
    item.stats = Object.entries(m.stats).map(([k, v]) => `${k.toUpperCase()} ${v.notes}顆/DLV${v.dlevel}`).join(' · ');
    item.summary = `BPM ${bpmTxt} · 殘差 ${m.meanResid.toFixed(1)}ms · ${item.stats}`;
    item.status = 'done'; item.progress = 100; item.stage = ''; runDone++;
    log('info', `完成(${item.name}):BPM ${bpmTxt} · 殘差 ${m.meanResid.toFixed(1)}ms · ` +
        Object.entries(m.stats).map(([k, v]) => `${k}=${v.notes}顆/DLV${v.dlevel}`).join(' '));
    renderRow(item);
  } catch (e) {
    settleError(item, `打包:${e && e.stack || e}`);
    return;
  }
  advance();
}

// ── 佇列 UI 渲染 ──
function updateControls() {
  const pending = queue.some(j => j.status === 'pending');
  $('go').disabled = processing || !pending;
  $('go').textContent = processing ? '處理中…' : '開始製譜';
  $('stop').style.display = processing ? '' : 'none';
  $('stop').disabled = false;
  $('clearQ').style.display = queue.length ? '' : 'none';
}

function renderQueue() {
  const box = $('queue');
  box.textContent = '';
  for (const item of queue) box.appendChild(buildRow(item));
}

function buildRow(item) {
  const row = document.createElement('div');
  row.className = 'qrow';
  const head = document.createElement('div');
  head.className = 'qhead';
  const name = document.createElement('span');
  name.className = 'qname';
  const totalSize = item.file.size + (item.bgmFile ? item.bgmFile.size : 0);
  name.textContent = `${item.name}(${(totalSize / 1048576).toFixed(1)} MB)`;
  head.append(name);
  if (item.pair) {
    const tag = document.createElement('span');
    tag.className = 'qtag'; tag.textContent = '兩道 stem · 跳過分離';
    head.append(tag);
  }
  const badge = document.createElement('span');
  badge.className = 'qbadge';
  const dl = document.createElement('a');
  dl.className = 'qdl'; dl.style.display = 'none';
  const x = document.createElement('button');
  x.className = 'qx'; x.title = '移除'; x.textContent = '✕';
  x.onclick = () => removeItem(item);
  head.append(badge, dl, x);

  // pair:副標顯示配對到的鼓軌 / 去鼓 BGM 兩檔實際檔名
  let sub = null;
  if (item.pair) {
    sub = document.createElement('div');
    sub.className = 'qsub';
    sub.textContent = `鼓軌 ${item.file.name} ＋ 去鼓 BGM ${item.bgmFile.name}`;
  }

  // 每列可調參數(曲名 / BPM 提示 / 跳秒)— 等待中可編輯,其餘唯讀顯示
  const params = document.createElement('div');
  params.className = 'qparams';
  const mkText = (cls, ph, val, key) => {
    const i = document.createElement('input');
    i.type = 'text'; i.className = cls; i.placeholder = ph; i.value = val || '';
    i.oninput = () => { item[key] = i.value; };
    return i;
  };
  const pTitle = mkText('qp-title', `曲名(留空=自動:${item.autoTitle})`, item.title, 'title');
  const pBpm = mkText('qp-bpm', 'BPM', item.bpm, 'bpm');
  const pStart = mkText('qp-start', '跳秒', item.start, 'start');
  params.append(pTitle, pBpm, pStart);

  const bar = document.createElement('div');
  bar.className = 'qbar'; bar.style.display = 'none';
  const barI = document.createElement('i');
  bar.appendChild(barI);
  const stage = document.createElement('div');
  stage.className = 'qstage';
  const err = document.createElement('div');
  err.className = 'qerr'; err.style.display = 'none';
  row.append(head);
  if (sub) row.append(sub);
  row.append(params, bar, stage, err);
  item.el = { row, badge, dl, x, params, pTitle, pBpm, pStart, bar, barI, stage, err };
  renderRow(item);
  return row;
}

const BADGE = { pending: '等待', active: '處理中', done: '完成', error: '失敗' };

function renderRow(item) {
  const el = item.el;
  if (!el) return;
  el.badge.className = `qbadge ${item.status}`;
  el.badge.textContent = BADGE[item.status];
  el.x.style.display = item.status === 'pending' ? '' : 'none';
  // 參數:等待中可編輯;開始處理後鎖定並顯示實際採用值(曲名顯示解析後的實際曲名)
  const editable = item.status === 'pending';
  el.pTitle.disabled = el.pBpm.disabled = el.pStart.disabled = !editable;
  el.pTitle.value = editable ? (item.title || '') : (item.finalTitle || item.title || '');
  el.pBpm.value = item.bpm || '';
  el.pStart.value = item.start || '';
  const active = item.status === 'active';
  el.bar.style.display = active ? '' : 'none';
  if (active) el.barI.style.width = (item.progress || 0) + '%';
  if (item.status === 'done') {
    el.dl.style.display = '';
    el.dl.href = item.url; el.dl.download = item.dlName;
    el.dl.textContent = '⬇ 下載譜包';
    el.stage.textContent = item.summary;
  } else {
    el.dl.style.display = 'none';
    el.stage.textContent = item.status === 'error' ? '' : (item.stage || '');
  }
  el.err.style.display = item.status === 'error' ? '' : 'none';
  el.err.textContent = item.status === 'error' ? item.error : '';
}

function removeItem(item) {
  if (item.status === 'active') return;   // 處理中不可移除
  if (item.url) URL.revokeObjectURL(item.url);
  const i = queue.indexOf(item);
  if (i >= 0) queue.splice(i, 1);
  drop.textContent = queue.length ? `已選 ${queue.length} 列(可再拖入更多)— 按「開始製譜」` : DROP_HINT;
  renderQueue();
  updateControls();
}
