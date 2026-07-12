# dtxgen web — 純前端版

所有運算(demucs 分離、ADTOF 鼓偵測、量化、難度簡化)都在瀏覽器內完成,
檔案不離開你的電腦。零 Python、零依賴安裝。

## 啟動

瀏覽器安全策略要求以 http 服務(不能直接雙擊 index.html):

```bash
cd dtxgen_web
python3 -m http.server 8080     # 或:npx serve
# 開 http://localhost:8080
```

也可整個資料夾部署到 GitHub Pages / 任何靜態空間。

WASM 多執行緒需要 crossOriginIsolated(COOP/COEP header)。Cloudflare Pages
由 `_headers` 原生下發(首載即隔離、免重整);GitHub Pages 等設不了 header
的主機由 `coi-serviceworker.min.js`(Service Worker)於執行期注入:首次
載入會自動重整一次頁面以套用(有原生 header 時 SW 不會註冊)。之後
`crossOriginIsolated` 為 true,ort 以多線程跑。兩者皆不可用時(如 Firefox
隱私視窗開本機 http.server)自動退回單線程,功能不受影響。

注意:本機開發時 SW 註冊在整個 `localhost:8080` origin 且**跨專案殘留** —
之後在同一 port 服務別的專案,回應仍會被注入 COOP/COEP(跨來源 iframe/
圖片可能莫名壞掉)。遇到時到 DevTools → Application → Service Workers
unregister,或換一個 port。

## 使用

拖入音檔(mp3/ogg/wav/m4a/flac)→ 開始製譜 → 自動下載譜包 zip。
- 譜包內含鼓原軌(dtxgen_drums.opus,Ogg/Opus 192kbps;無 WebCodecs 的瀏覽器
  退 FLAC)— 把譜包 zip 拖回來即「回爐重做」:直接從鼓原軌起跑、跳過分離,
  數十秒完成。回爐時鼓原軌原封沿用、不重編(零世代損失;設「跳過開頭秒數」
  或舊譜包的 dtxgen_drums.flac / .wav 才重編一次)
- keysound 現作:各鼓件的擊打音(ks_*.wav)切自該曲鼓軌 — 選孤立度最大、
  能量達標的一擊,fade + 峰值 -3dB 正規化;不是罐頭音色
- BGM 自動去鼓:完整混音輸入時,BGM 以分離出的伴奏(bass/other/vocals 相加)
  重編為 Ogg/Opus 192kbps — 鼓聲只由你打出的 keysound 發出,不與 BGM 疊音
  (無 WebCodecs 的瀏覽器退 16-bit WAV;純鼓軌/回爐路徑沿用來源 BGM)
- 「純鼓軌」勾選:輸入已是鼓軌時跳過分離
- 「跳過開頭秒數」= 原 YouTube 網址的 `t=` 參數:譜面與 BGM 都從該秒起算
  (BGM 裁切後重編:有損來源 → Ogg/Opus 192kbps,wav/flac 來源 → FLAC)
- 完整混音的分離在 Chrome/Edge 走 WebGPU(M 系列很快);其他瀏覽器 WASM 較慢
- 首次使用會載入 97MB 分離模型(之後瀏覽器快取)

## 變速曲

支援分段變速(v2.2):主段 BPM 之外,「有鼓異段」由網格殘差偵測、
「無鼓異段」(稀疏 intro/break)由 onset envelope 自相關補證,
變速點 snap 小節線、前段 BPM 微調對齊接縫(與 Python 版同款規整)。
實測 ETERNAL BLAZE(105→155)與 Python 版輸出一致(變速於小節 8)。

## 已知邊界(相對 Python 版)

- YouTube 網址不支援(瀏覽器無法下載 YouTube;請先自行取得音檔;
  跳秒改填「跳過開頭秒數」)
- BPM < 100 的曲請填「BPM 提示」(無提示時預設範圍 100-240,與 Python 版同)
- 2:1 整倍變速(如 85→170)偵測不到 — 兩網格相容,殘差不升;此類曲譜面等價
- 開鈸/閉鈸細分較保守(無 keysound NMF;以高頻衰減特徵替代)

驗證:與 Python 版逐組件數值對照(mel 3e-5、GBDT 6e-17、ADTOF 事件 F1≥0.998),
端到端譜面品質相同(Distortion:KICK 0.961 / SNARE 0.929 / HH 0.873)。
