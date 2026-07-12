// main.js — UI:檔案解碼(主線程)→ Worker(pipeline)→ JSZip 譜包下載
const $ = id => document.getElementById(id);
let pickedFile = null;

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
log('info', `WebGPU: ${'gpu' in navigator ? '可用' : '不可用(分離將走 WASM,較慢)'} · 核心數: ${navigator.hardwareConcurrency || '?'}` +
    ` · crossOriginIsolated: ${self.crossOriginIsolated ? '✓(WASM 多線程)' : '✗(WASM 單線程;首次載入應會自動重整套用)'}`);

// 曲名消毒:任何來源(手填/檔名/譜包 #TITLE/metadata)統一過濾 —
// 含 / 的曲名會讓 zip.folder 建出巢狀層級(打包層級錯誤的根源)
const sanitize = s => (s || '').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'song';

// FLAC 編碼(libflac WASM,與 Python 版 dtxgen_drums.flac 格式一致;16-bit 同 soundfile 預設)
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
drop.onclick = () => $('file').click();
drop.ondragover = e => { e.preventDefault(); drop.classList.add('on'); };
drop.ondragleave = () => drop.classList.remove('on');
drop.ondrop = e => {
  e.preventDefault(); drop.classList.remove('on');
  if (e.dataTransfer.files[0]) pick(e.dataTransfer.files[0]);
};
$('file').onchange = () => { if ($('file').files[0]) pick($('file').files[0]); };
function pick(f) {
  pickedFile = f;
  log('info', `選擇檔案:${f.name}(${(f.size/1048576).toFixed(1)} MB, ${f.type || '未知型別'})`);
  drop.textContent = `已選:${f.name}(${(f.size / 1048576).toFixed(1)} MB)`;
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
  if (!pickedFile) return;
  $('go').disabled = true;
  $('err').textContent = ''; $('dl').innerHTML = '';
  $('barbox').style.display = 'block'; $('bar').style.width = '1%';
  try {
    const isZip = /\.zip$/i.test(pickedFile.name);
    let audioBuf, bgmBytes, bgmName, title = $('title').value.trim(), isStem = $('stem').checked;
    if (isZip) {
      $('stage').textContent = '解析譜包 zip(找無損鼓原軌)';
      log('info', '解析譜包 zip …');
      const zip = await JSZip.loadAsync(await pickedFile.arrayBuffer());
      let stemEntry = null, bgmEntry = null, dtxEntry = null, srcEntry = null;
      zip.forEach((path, entry) => {
        const n = path.toLowerCase();
        if (/dtxgen_drums\.(wav|flac)$/.test(n)) stemEntry = entry;
        if (/(^|\/)bgm\.(ogg|mp3|wav|m4a)$/.test(n)) bgmEntry = entry;
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
        isStem = true;                      // 鼓原軌直跑:零損、跳過分離
        audioBuf = await stemEntry.async('arraybuffer');
        log('info', `找到鼓原軌:${stemEntry.name}(${(audioBuf.byteLength/1048576).toFixed(1)} MB)→ 跳過分離`);
        $('stage').textContent = '使用譜包內無損鼓原軌(跳過分離)';
      } else if (bgmEntry) {
        audioBuf = await bgmEntry.async('arraybuffer');
        log('warn', `譜包無鼓原軌 — 用包內 BGM(${bgmEntry.name})走完整流程`);
        $('stage').textContent = '譜包無鼓原軌 — 用包內 BGM 走完整流程';
      } else throw new Error('zip 內找不到鼓原軌或 BGM');
      if (bgmEntry) { bgmBytes = await bgmEntry.async('arraybuffer'); bgmName = 'bgm.' + bgmEntry.name.split('.').pop().toLowerCase(); }
      else { bgmBytes = audioBuf.slice(0); bgmName = 'bgm.flac'; }
    } else {
      audioBuf = await pickedFile.arrayBuffer();
      bgmBytes = audioBuf.slice(0);
      bgmName = 'bgm.' + (pickedFile.name.split('.').pop() || 'ogg').toLowerCase();
    }
    title = sanitize(title || pickedFile.name.replace(/\.[^.]+$/, ''));

    $('stage').textContent = '解碼音訊';
    const tDec = performance.now();
    const ac = new AudioContext({ sampleRate: 44100 });
    const decoded = await ac.decodeAudioData(audioBuf);
    ac.close();
    log('info', `解碼完成:${decoded.duration.toFixed(1)}s ${decoded.numberOfChannels}ch @${decoded.sampleRate}Hz(${(performance.now()-tDec).toFixed(0)}ms)`);
    // resample 到 44100(decodeAudioData 已按 AudioContext sampleRate 重採樣)
    const n = decoded.length;
    const yL = new Float32Array(decoded.getChannelData(0));
    const yR = new Float32Array(decoded.numberOfChannels > 1 ? decoded.getChannelData(1) : decoded.getChannelData(0));

    jobCtx = { title, bgmBytes, bgmName };
    log('info', `提交 pipeline:title=${title} stem=${isStem} bgm=${bgmName} bpmHint=${parseFloat($('bpm').value) || '無'}`);
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
  $('stage').textContent = '打包譜包 zip(FLAC 編碼鼓原軌)';
  const { title, bgmBytes, bgmName } = jobCtx;
  const tF = performance.now();
  const flac = await encodeFlac(m.stemL, m.stemR, m.sr);   // 與 Python 版一致:16-bit FLAC
  log('info', `FLAC 編碼:${(flac.length/1048576).toFixed(1)} MB(${((performance.now()-tF)/1000).toFixed(1)}s)`);
  // zip 內平鋪(無資料夾層):解壓工具會以 zip 檔名建一層,內層再包資料夾會變兩層
  const dir = new JSZip();
  for (const [lv, text] of Object.entries(m.charts)) dir.file(`${lv}.dtx`, text);
  dir.file('SET.def', m.setdef);
  dir.file(bgmName, bgmBytes);
  dir.file('dtxgen_drums.flac', flac);   // 無損鼓原軌:回爐重做的一手素材
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
