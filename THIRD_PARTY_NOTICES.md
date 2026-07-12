# 第三方授權聲明(Third-Party Notices)

本 repo 與其 GitHub Pages 站台散布下列第三方元件。根目錄 `LICENSE`(MIT)
僅涵蓋本專案自身的程式碼與訓練產物,不涵蓋以下元件。

## 進版控的手工 vendor

### JSZip — `app/vendor/jszip.min.js`

JSZip v3.10.1,(c) 2009-2016 Stuart Knightley,雙授權 MIT 或 GPLv3
(本專案依 MIT 使用)。檔頭保留原始授權聲明。內含 pako(MIT)。
<https://github.com/Stuk/jszip>

### libflac.js — `app/vendor/libflac.min.wasm.js` / `.wasm`

libflac.js(<https://github.com/mmig/libflac.js>),MIT License —
libFLAC 的 Emscripten/WebAssembly 封裝。

其內嵌之 libFLAC 1.3.3(Xiph.Org Foundation)採 BSD-3-Clause:

```
Copyright (C) 2000-2009  Josh Coalson
Copyright (C) 2011-2019  Xiph.Org Foundation

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions
are met:

- Redistributions of source code must retain the above copyright
notice, this list of conditions and the following disclaimer.

- Redistributions in binary form must reproduce the above copyright
notice, this list of conditions and the following disclaimer in the
documentation and/or other materials provided with the distribution.

- Neither the name of the Xiph.Org Foundation nor the names of its
contributors may be used to endorse or promote products derived from
this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
``AS IS'' AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE FOUNDATION
OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT
LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE,
DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY
THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT
(INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
```

## 安裝/建站時同步(不進版控,但隨 Pages 站台散布)

由 `scripts/sync-vendor.mjs` 從 npm 套件同步:

### demucs(demucs-js)— `app/vendor/demucs/`、`app/models/htdemucs.onnx.*`(24MiB 分塊部署)

<https://github.com/bakkot/demucs-js>,程式碼 MIT License
(Copyright (c) 2014 Kevin Gibbons and contributors)。

**注意**:套件內含之權重檔 `htdemucs.onnx` 不在 MIT 授權範圍 —
其源自 Meta 提供之權重,依上游聲明**僅限個人與研究用途**
(personal and research use only)。本站台部署即再散布該權重檔,
請確認你的使用情境符合此限制。

### ONNX Runtime Web — `app/vendor/ort/`

<https://github.com/microsoft/onnxruntime>,MIT License
(Copyright (c) Microsoft Corporation)。
