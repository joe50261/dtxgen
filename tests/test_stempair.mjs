// classifyStemPair 單元驗證:跳過分離的正確輸入是「兩道 stem」— drums + 去鼓 BGM。
// 舊「純鼓軌」單檔設計錯在:demucs stem 本是兩道,只給鼓軌會缺伴奏、系統只能
// 誤把鼓軌當 BGM。此處驗證依檔名判別哪道是鼓軌(另一道即去鼓 BGM)。
import { classifyStemPair, stemRole, cleanStemTitle, stemBaseKey, groupStemNames } from '../app/js/pipeline.js';

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

// 回歸:曲名尾巴帶 "no" 的檔(Techno / Volcano / Piano / mono…)其 "…no_drums"
// 不可誤中 no_drums 排除 —— 否則真鼓軌被判非鼓、與另一道對調,成品 BGM 變鼓軌
// (正是本修正要杜絕的疊音 bug)。詞界 \b 是關鍵。
A(eq(classifyStemPair('Volcano_drums.opus', 'Volcano_without_drums.opus'),
     { drum: 0, bgm: 1 }), 'Volcano_drums 不被誤排除(無對調)');
A(eq(classifyStemPair('Techno_drums.wav', 'Techno_no_drums.wav'),
     { drum: 0, bgm: 1 }), 'Techno_drums / Techno_no_drums');
A(eq(classifyStemPair('Piano_no_drums.flac', 'Piano_drums.flac'),
     { drum: 1, bgm: 0 }), 'Piano_no_drums / Piano_drums');
// 更多「去鼓」措辭:without / drum-free / drum_removed / minus_drums
A(eq(classifyStemPair('song_drums.wav', 'song_without_drums.wav'),
     { drum: 0, bgm: 1 }), 'without_drums 視為去鼓 BGM');
A(eq(classifyStemPair('drum-free.opus', 'drums.opus'), { drum: 1, bgm: 0 }), 'drum-free 視為去鼓 BGM');
A(eq(classifyStemPair('X.drum_removed.opus', 'X.drums.opus'), { drum: 1, bgm: 0 }), 'drum_removed 視為去鼓 BGM');
A(eq(classifyStemPair('mix.drums.mp3', 'mix.minus_drums.mp3'), { drum: 0, bgm: 1 }), 'minus_drums 視為去鼓 BGM');
// 詞界不可反向誤傷:drums_freestyle 仍是鼓軌(free 非獨立詞尾)
A(eq(classifyStemPair('drums_freestyle.wav', 'no_drums.wav'), { drum: 0, bgm: 1 }), 'drums_freestyle 仍是鼓軌');

// 無法判別 → null(由呼叫端報錯,不猜)
A(classifyStemPair('stem1.opus', 'stem2.opus') === null, '皆不像鼓軌 → null');
A(classifyStemPair('a.drums.opus', 'b.drums.opus') === null, '皆像鼓軌 → null');
A(classifyStemPair('no_drums_a.opus', 'no_drums_b.opus') === null, '皆 no_drums → null');

// ── stemRole:單軌角色('drum' | 'bgm' | 'unknown')──
A(stemRole('song.drums.opus') === 'drum', "stemRole drums → 'drum'");
A(stemRole('song.no_drums.opus') === 'bgm', "stemRole no_drums → 'bgm'");
A(stemRole('song.bgm_d.opus') === 'unknown', "stemRole bgm_d → 'unknown'(非去鼓措辭,配對時歸 BGM)");
A(stemRole('Techno_drums.wav') === 'drum', "stemRole Techno_drums → 'drum'(詞界不誤排除)");
A(stemRole('vocals.wav') === 'unknown', "stemRole vocals → 'unknown'");

// ── cleanStemTitle / stemBaseKey:去 stem 字尾取乾淨曲名 / 配對 key ──
A(cleanStemTitle('MyGO_FIRST_TAKE.drums.opus') === 'MyGO_FIRST_TAKE', 'cleanStemTitle 去 .drums');
A(cleanStemTitle('MyGO_FIRST_TAKE.bgm_d.opus') === 'MyGO_FIRST_TAKE', 'cleanStemTitle 去 .bgm_d');
A(cleanStemTitle('song_no_drums.wav') === 'song', 'cleanStemTitle 去 _no_drums');
A(cleanStemTitle('mix.mp3') === 'mix', 'cleanStemTitle 純混音檔不動(僅去副檔名)');
A(stemBaseKey('Song.DRUMS.opus') === stemBaseKey('Song.no_drums.opus'), '同曲兩道 stem → 同 base key');

// ── groupStemNames:佇列卡片分組 —— 兩道 stem 併一列(跳過分離),其餘各自成列 ──
// 恰兩檔且成對(即使 base key 不同,如上傳檔的隨機前綴)→ 一張卡片
A(eq(groupStemNames(['a1.drums.opus', 'b2.bgm_d.opus']), [{ kind: 'pair', drum: 0, bgm: 1 }]),
  '兩檔成對 → 一列 pair(前綴不同也配)');
A(eq(groupStemNames(['x.bgm_d.opus', 'x.drums.opus']), [{ kind: 'pair', drum: 1, bgm: 0 }]),
  '兩檔成對 → drum/bgm 索引正確(順序反過來)');
// 單一混音檔 → 單列(走完整分離)
A(eq(groupStemNames(['song.mp3']), [{ kind: 'single', i: 0 }]), '單一混音檔 → single');
// 批量:同 base key 的鼓 + 去鼓配對,無關檔各自成列,保留順序
A(eq(groupStemNames(['A.drums.opus', 'A.no_drums.opus', 'B.mp3', 'C.drums.wav', 'C.no_drums.wav']),
     [{ kind: 'pair', drum: 0, bgm: 1 }, { kind: 'single', i: 2 }, { kind: 'pair', drum: 3, bgm: 4 }]),
  '批量:A/C 各自配對、B 單列(保留順序)');
// 批量兩鼓軌不同曲、只有一去鼓 → 只有 key 相符者配對,另一鼓軌單列
A(eq(groupStemNames(['A.drums.opus', 'B.drums.opus', 'A.no_drums.opus']),
     [{ kind: 'pair', drum: 0, bgm: 2 }, { kind: 'single', i: 1 }]),
  '批量:僅同 key 者配對(B 鼓軌無伴奏 → 單列)');

process.exit(fails ? 1 : 0);
