// oggopus.js — Ogg/Opus 編碼:WebCodecs AudioEncoder(瀏覽器內建 libopus)+ 極簡 Ogg 封裝
// 「跳過開頭」裁切後的有損來源 BGM 用 — 不轉無損,重編回 lossy(RFC 7845 Ogg 封裝)
// 注意:Opus 只支援 48kHz,輸入須為 48k PCM

const CRC_TABLE = (() => {   // Ogg CRC-32:poly 0x04c11db7,init 0,不反射
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = ((r & 0x80000000) ? (r << 1) ^ 0x04c11db7 : r << 1) >>> 0;
    t[i] = r;
  }
  return t;
})();
const crc32 = bytes => {
  let c = 0;
  for (let i = 0; i < bytes.length; i++) c = (((c << 8) >>> 0) ^ CRC_TABLE[((c >>> 24) & 0xff) ^ bytes[i]]) >>> 0;
  return c;
};

// packets: Uint8Array[](完整落在此頁);granule: 頁尾 granule position(48k 樣本數,含 pre-skip)
function oggPage(packets, granule, seq, { bos = false, eos = false } = {}) {
  const lacing = [];
  for (const p of packets) {
    let len = p.length;
    while (len >= 255) { lacing.push(255); len -= 255; }
    lacing.push(len);   // <255 結尾;長度恰為 255 倍數時自然補 0
  }
  const bodyLen = packets.reduce((s, p) => s + p.length, 0);
  const page = new Uint8Array(27 + lacing.length + bodyLen);
  const v = new DataView(page.buffer);
  page.set([0x4f, 0x67, 0x67, 0x53, 0]);                       // 'OggS' + version
  page[5] = (bos ? 2 : 0) | (eos ? 4 : 0);
  v.setUint32(6, granule >>> 0, true);                          // granule LE64(<2^53 以 Number 拆)
  v.setUint32(10, Math.floor(granule / 4294967296), true);
  v.setUint32(14, 0x64747867, true);                            // serial 'dtxg'
  v.setUint32(18, seq, true);
  page[26] = lacing.length;
  page.set(lacing, 27);
  let o = 27 + lacing.length;
  for (const p of packets) { page.set(p, o); o += p.length; }
  v.setUint32(22, crc32(page), true);                           // CRC 欄位以 0 參與計算後回填
  return page;
}

function opusHeadDefault(preSkip) {   // RFC 7845 §5.1(stereo、mapping family 0)
  const h = new Uint8Array(19);
  h.set([0x4f, 0x70, 0x75, 0x73, 0x48, 0x65, 0x61, 0x64, 1, 2]);   // 'OpusHead' v1 2ch
  const v = new DataView(h.buffer);
  v.setUint16(10, preSkip, true);
  v.setUint32(12, 48000, true);
  return h;
}

// yL/yR:48kHz Float32 PCM → Ogg/Opus 檔 bytes
export async function encodeOggOpus(yL, yR, bitrate = 192000) {
  if (typeof AudioEncoder === 'undefined')
    throw new Error('此瀏覽器不支援 WebCodecs AudioEncoder,無法重編 Opus');
  const n = yL.length;
  const packets = [];
  let opusHead = null, encErr = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !opusHead)   // Chrome 會附 OpusHead(含正確 pre-skip)
        opusHead = d instanceof ArrayBuffer ? new Uint8Array(d.slice(0))
                 : new Uint8Array(d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength));
      const buf = new Uint8Array(chunk.byteLength);
      chunk.copyTo(buf);
      packets.push({ data: buf, samples: Math.round((chunk.duration ?? 20000) * 48000 / 1e6) });
    },
    error: e => { encErr = e; },
  });
  enc.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 2, bitrate });
  const BLOCK = 48000;                                          // 每次餵 1 秒(f32-planar)
  const buf = new Float32Array(BLOCK * 2);
  for (let off = 0; off < n; off += BLOCK) {
    const m = Math.min(BLOCK, n - off);
    buf.set(yL.subarray(off, off + m), 0);
    buf.set(yR.subarray(off, off + m), m);
    enc.encode(new AudioData({
      format: 'f32-planar', sampleRate: 48000, numberOfFrames: m, numberOfChannels: 2,
      timestamp: off / 48000 * 1e6, data: buf.subarray(0, m * 2),
    }));
    if ((off / BLOCK) % 20 === 19) await new Promise(r => setTimeout(r));   // 讓 UI 呼吸
  }
  await enc.flush();
  enc.close();
  if (encErr) throw encErr;
  if (!opusHead) opusHead = opusHeadDefault(312);               // libopus 預設 lookahead
  const preSkip = opusHead[10] | (opusHead[11] << 8);

  // OpusTags(RFC 7845 §5.2):vendor 字串 + 0 則 comment
  const vendor = new TextEncoder().encode('dtxgen-web');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set([0x4f, 0x70, 0x75, 0x73, 0x54, 0x61, 0x67, 0x73]);   // 'OpusTags'
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);

  const pages = [oggPage([opusHead], 0, 0, { bos: true }), oggPage([tags], 0, 1)];
  const endGranule = preSkip + n;                               // 末頁 granule = 裁掉編碼 padding
  let seq = 2, granule = 0, batch = [];
  for (let i = 0; i < packets.length; i++) {
    batch.push(packets[i].data);
    granule += packets[i].samples;
    if (batch.length >= 50 || i === packets.length - 1) {       // ~1s/頁(20ms×50)
      const last = i === packets.length - 1;
      pages.push(oggPage(batch, last ? Math.min(granule, endGranule) : granule, seq++, { eos: last }));
      batch = [];
    }
  }
  const out = new Uint8Array(pages.reduce((s, p) => s + p.length, 0));
  let o = 0;
  for (const p of pages) { out.set(p, o); o += p.length; }
  return out;
}
