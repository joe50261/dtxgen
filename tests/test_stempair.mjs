// classifyStemPair 單元驗證:跳過分離的正確輸入是「兩道 stem」— drums + 去鼓 BGM。
// 舊「純鼓軌」單檔設計錯在:demucs stem 本是兩道,只給鼓軌會缺伴奏、系統只能
// 誤把鼓軌當 BGM。此處驗證依檔名判別哪道是鼓軌(另一道即去鼓 BGM)。
import { classifyStemPair } from '../app/js/pipeline.js';

let fails = 0;
const A = (ok, msg) => { console.log((ok ? 'PASS' : 'FAIL') + ' ' + msg); if (!ok) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// 上傳實例:MyGO…THE FIRST TAKE 的兩道 demucs stem(.drums.opus + .bgm_d.opus)
A(eq(classifyStemPair('MyGO_THE_FIRST_TAKE.drums.opus', 'MyGO_THE_FIRST_TAKE.bgm_d.opus'),
     { drum: 0, bgm: 1 }), '.drums / .bgm_d(鼓軌在前)');
A(eq(classifyStemPair('MyGO_THE_FIRST_TAKE.bgm_d.opus', 'MyGO_THE_FIRST_TAKE.drums.opus'),
     { drum: 1, bgm: 0 }), '.bgm_d / .drums(鼓軌在後)');

// demucs two-stems 標準輸出:drums.wav + no_drums.wav —— no_drums 含 "drums" 但須排除
A(eq(classifyStemPair('drums.wav', 'no_drums.wav'), { drum: 0, bgm: 1 }), 'drums / no_drums');
A(eq(classifyStemPair('no_drums.wav', 'drums.wav'), { drum: 1, bgm: 0 }), 'no_drums / drums');
A(eq(classifyStemPair('song-nodrums.flac', 'song-drum.flac'), { drum: 1, bgm: 0 }), 'nodrums / drum(單數、連字號)');
A(eq(classifyStemPair('mix (drumless).mp3', 'mix.drums.mp3'), { drum: 1, bgm: 0 }), 'drumless 排除');

// 四 stem 取其一當伴奏也可:另一道非鼓即 BGM
A(eq(classifyStemPair('bass.wav', 'drums.wav'), { drum: 1, bgm: 0 }), 'bass / drums');
A(eq(classifyStemPair('DRUMS.OPUS', 'inst.opus'), { drum: 0, bgm: 1 }), '大小寫不敏感');

// 無法判別 → null(由呼叫端報錯,不猜)
A(classifyStemPair('stem1.opus', 'stem2.opus') === null, '皆不像鼓軌 → null');
A(classifyStemPair('a.drums.opus', 'b.drums.opus') === null, '皆像鼓軌 → null');
A(classifyStemPair('no_drums_a.opus', 'no_drums_b.opus') === null, '皆 no_drums → null');

process.exit(fails ? 1 : 0);
