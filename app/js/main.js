// main.js — UI:檔案解碼(主線程)→ Worker(pipeline)→ JSZip 譜包下載
import { encodeOggOpus } from './oggopus.js';
import { resample } from './dsp.js';
import { classifyStemPair } from './pipeline.js';
const $ = id => document.getElementById(id);
// pickedFiles:[混音檔] | [zip] | [鼓 stem, 去鼓 BGM stem](兩道 → 跳過分離)
let pickedFiles = null;

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

const drop = $('drop');
const mb = b => (b / 1048576).toFixed(1) + ' MB';
drop.onclick = () => $('file').click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
drop.ondragleave = () => drop.classList.remove('on');
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove('on');
  if (e.dataTransfer.files.length) pick(e.dataTransfer.files);
};
$('file').onchange = () => { if ($('file').files.length) pick($('file').files); };
// 一個混音檔 → 自動分離;兩道 stem(鼓軌 + 去鼓 BGM)→ 跳過分離;zip → 回爐
function pick(fileList) {
  const files = [...fileList].filter(Boolean);
  if (!files.length) return;
  const zip = files.find(f => /\.zip$/i.test(f.name));
  if (zip) {
    pickedFiles = [zip];
    if (files.length > 1) log('warn', '同時選了 zip 與其他檔 — 只用 zip 回爐,其餘忽略');
    drop.textContent = `已選譜包:${zip.name}(${mb(zip.size)})— 回爐重做`;
  } else if (files.length === 1) {
    pickedFiles = [files[0]];
    drop.textContent = `已選混音檔:${files[0].name}(${mb(files[0].size)})— 將自動分離鼓軌`;
  } else {
    // 兩道(含以上)已分離 stem:依檔名判別 drums / 去鼓 BGM(demucs stem 本是兩道)
    if (files.length > 2) log('warn', `選了 ${files.length} 檔 — stem 對只取前兩檔`);
    const two = files.slice(0, 2);
    const cls = classifyStemPair(two[0].name, two[1].name);
    if (!cls) {
      pickedFiles = null;
      $('go').disabled = true;
      drop.textContent = `無法判別哪個是鼓軌:${two[0].name} / ${two[1].name} — 鼓軌檔名需含「drums」`;
      log('warn', `兩檔皆無法判別鼓軌(需一個含 drums、非 no_drums):${two.map(f => f.name).join(' / ')}`);
      return;
    }
    pickedFiles = [two[cls.drum], two[cls.bgm]];   // [鼓 stem, 去鼓 BGM stem]
    drop.textContent = `已選兩道 stem — 鼓軌:${pickedFiles[0].name} · 去鼓 BGM:${pickedFiles[1].name}(跳過分離)`;
  }
  log('info', `選擇:${pickedFiles.map(f => `${f.name}(${mb(f.size)})`).join(' + ')}`);
  $('go').disabled = false;
}

const worker = new Worker(new URL('./worker.js', import.meta.url), { type: 'module' });
let jobCtx = null;

worker.onerror = ev => log('error', `worker 錯誤:${ev.message} @ ${ev.filename}:${ev.lineno}`);
worker.onmessage = ev => {
  const m = ev.data;
  if (m.type === 'log') { log(m.level || 'info', `[worker] ${m.msg}`); return; }
  if (m.type === 'progress') {
    $('bar').style.width = m.pct + '%';
    $('stage').textContent = m.msg;
  } else if (m.type === 'error') {
    log('error', `pipeline 失敗(階段:${m.stage || '?'}):\n${m.error}`);
    $('err').textContent = `失敗於「${m.stage || '?'}」— 詳見下方執行紀錄(可下載 log 回報)`;
    $('stage').textContent = '失敗';
    $('go').disabled = false;
  } else if (m.type === 'done') {
    finishJob(m);
  }
};

$('go').onclick = async () => {
  if (!pickedFiles || !pickedFiles.length) return;
  $('go').disabled = true;
  $('err').textContent = ''; $('dl').innerHTML = '';
  $('barbox').style.display = 'block'; $('bar').style.width = '1%';
  try {
    const primary = pickedFiles[0];
    const isZip = /\.zip$/i.test(primary.name);
    const isPair = pickedFiles.length === 2;   // [鼓 stem, 去鼓 BGM stem] → 跳過分離
    // 跳過開頭秒數:等同 Python 版 YouTube 網址的 t= 參數
    const startSec = Math.max(0, parseFloat($('start').value) || 0);
    let audioBuf, bgmBytes, bgmName, title = $('title').value.trim(), isStem = false;
    let stemPass = null;   // 來源鼓原軌已是 Opus → 原 bytes 原封沿用(重編只添世代損失)
    if (isZip) {
      $('stage').textContent = '解析譜包 zip(找鼓原軌)';
      log('info', '解析譜包 zip …');
      const zip = await JSZip.loadAsync(await primary.arrayBuffer());
      let stemEntry = null, bgmEntry = null, dtxEntry = null, srcEntry = null;
      zip.forEach((path, entry) => {
        const n = path.toLowerCase();
        if (/dtxgen_drums\.(wav|flac|opus)$/.test(n)) stemEntry = entry;
        if (/(^|\/)bgm\.(ogg|opus|mp3|wav|m4a|flac)$/.test(n)) bgmEntry = entry;
        if (/\.dtx$/.test(n) && (!dtxEntry || entry._data.uncompressedSize > dtxEntry._data.uncompressedSize)) dtxEntry = entry;
        if (/dtxgen_source\.json$/.test(n)) srcEntry = entry;
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
        log('info', `找到鼓原軌:${stemEntry.name}(${(audioBuf.byteLength/1048576).toFixed(1)} MB)→ 跳過分離`);
        $('stage').textContent = '使用譜包內鼓原軌(跳過分離)';
      } else if (bgmEntry) {
        audioBuf = await bgmEntry.async('arraybuffer');
        log('warn', `譜包無鼓原軌 — 用包內 BGM(${bgmEntry.name})走完整流程`);
        $('stage').textContent = '譜包無鼓原軌 — 用包內 BGM 走完整流程';
      } else throw new Error('zip 內找不到鼓原軌或 BGM');
      if (bgmEntry) { bgmBytes = await bgmEntry.async('arraybuffer'); bgmName = 'bgm.' + bgmEntry.name.split('.').pop().toLowerCase(); }
      else { bgmBytes = audioBuf.slice(0); bgmName = 'bgm.' + stemEntry.name.split('.').pop().toLowerCase(); }
    } else if (isPair) {
      // 兩道已分離 stem:鼓 stem 供轉譜/keysound/鼓原軌,去鼓 BGM stem 供伴奏。
      // demucs stem 本是兩道 → 跳過分離須同時提供,BGM 才是真正的去鼓伴奏
      // (而非把鼓軌本身誤當 BGM,那會與玩家 keysound 疊音、且無旋律)。
      isStem = true;
      const [drumF, bgmF] = pickedFiles;
      const drumsBuf = await drumF.arrayBuffer();
      bgmBytes = await bgmF.arrayBuffer();
      bgmName = 'bgm.' + (bgmF.name.split('.').pop() || 'opus').toLowerCase();
      if (/\.opus$/i.test(drumF.name)) stemPass = drumsBuf.slice(0);   // decodeAudioData 會 detach → 先留副本
      audioBuf = drumsBuf;
      log('info', `兩道 stem:鼓軌 ${drumF.name}(${(drumsBuf.byteLength/1048576).toFixed(1)} MB)· 去鼓 BGM ${bgmF.name}(${(bgmBytes.byteLength/1048576).toFixed(1)} MB)→ 跳過分離`);
      $('stage').textContent = '使用已分離的兩道 stem(跳過分離)';
    } else {
      // 單一混音檔:走完整分離(demucs),BGM 一律由 worker 從去鼓伴奏重編。
      // 分離路徑 worker 必回 m.bgm,finishJob 不會讀 jobCtx.bgmBytes → 不留輸入副本
      // (省一份可觀的記憶體;bgmName 仍留字串以備日誌/兜底)。
      audioBuf = await primary.arrayBuffer();
      bgmBytes = null;
      bgmName = 'bgm.' + (primary.name.split('.').pop() || 'ogg').toLowerCase();
    }
    title = sanitize(title || primary.name.replace(/\.[^.]+$/, ''));

    $('stage').textContent = '解碼音訊';
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
        $('stage').textContent = `跳過開頭 ${startSec}s — 重編 BGM`;
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

    jobCtx = { title, bgmBytes, bgmName, stemPass };
    log('info', `提交 pipeline:title=${title} stem=${isStem} bgm=${isStem ? bgmName : '(分離後去鼓重編)'} bpmHint=${parseFloat($('bpm').value) || '無'}`);
    worker.postMessage({
      yL, yR, sr: 44100, isDrumsStem: isStem, title, bgmName,
      bpmHint: parseFloat($('bpm').value) || null,
    }, [yL.buffer, yR.buffer]);
  } catch (e) {
    log('error', `前置處理失敗:${e && e.stack || e}`);
    $('err').textContent = '失敗 — 詳見下方執行紀錄(可下載 log 回報)';
    $('go').disabled = false;
  }
};

async function finishJob(m) {
  $('stage').textContent = '打包譜包 zip(Opus 編碼鼓原軌)';
  const { title } = jobCtx;
  // BGM:分離路徑用 worker 重編的去鼓伴奏;兩道 stem/回爐路徑沿用來源去鼓 BGM
  const bgmBytes = m.bgm ? m.bgm.bytes : jobCtx.bgmBytes;
  const bgmName = m.bgm ? m.bgm.name : jobCtx.bgmName;
  if (m.bgm) log('info', `BGM 使用去鼓伴奏:${bgmName}(${(bgmBytes.byteLength / 1048576).toFixed(1)} MB)`);
  const tF = performance.now();
  // 鼓原軌:來源已是 Opus 且未裁切 → 原 bytes 原封沿用(重編只添世代損失);
  // 否則編 Ogg/Opus 192kbps(同 BGM 規格;Opus 只吃 48kHz → 先重採樣),
  // 無 WebCodecs 的瀏覽器退 FLAC — 回爐掃描各副檔名都認
  let stemBytes, stemName;
  if (jobCtx.stemPass) {
    stemBytes = new Uint8Array(jobCtx.stemPass);
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
  const zip = dir;
  // 現作 keysounds(切自該曲鼓軌;缺類 lane 不會出現在譜面,無需預設音)
  for (const [name, bytes] of Object.entries(m.keysounds || {})) dir.file(name, bytes);
  log('info', `keysounds:${Object.keys(m.keysounds || {}).length} 顆(現作)`);
  const blob = await zip.generateAsync({ type: 'blob', compression: 'DEFLATE' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${title}_dtx.zip`;
  a.click();
  const stats = Object.entries(m.stats).map(([k, v]) => `${k.toUpperCase()} ${v.notes}顆/DLV${v.dlevel}`).join(' · ');
  const bpmTxt = m.bpmText || m.bpm;
  log('info', `完成:BPM ${bpmTxt} · 殘差 ${m.meanResid.toFixed(1)}ms · ` +
      Object.entries(m.stats).map(([k,v]) => `${k}=${v.notes}顆/DLV${v.dlevel}`).join(' '));
  $('stage').textContent = `完成 — BPM ${bpmTxt} · 量化殘差 ${m.meanResid.toFixed(1)}ms`;
  $('dl').innerHTML = `<a href="${a.href}" download="${title}_dtx.zip">重新下載譜包</a><div class="meta" style="margin-top:.4rem">${stats}</div>`;
  $('bar').style.width = '100%';
  $('go').disabled = false;
}
