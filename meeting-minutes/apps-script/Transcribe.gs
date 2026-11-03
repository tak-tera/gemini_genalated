/**
 * Transcribe モード（音声のモデルに「transcribe」を含むモデルを指定したとき）。
 *
 *  - Transcribe は「この時間帯だけ書き起こす」という指示が効かず、1回30分（話者分けあり）までなので、
 *    mp3 をファイルとして区切り（既定25分）ごとに切り出して送る。mp3 は短いフレームの連続なので、
 *    フレームの区切りから切り出せばそのまま再生・認識できる。
 *  - 発言の書き起こしは Transcribe、話し方・場の様子・話者の特徴のメモは「様子メモのモデル」（Argon）が担当し、
 *    同じ文字起こし文書にまとめる。Claude は両方を突き合わせて整理する。
 *  - mp3 以外の音声は切り出せないため、様子メモのモデルによる通常の文字起こしに切り替える。
 *
 * Transcribe の設定の書き方は資料によって違うため、候補を順に試し、通った書き方をスクリプト プロパティ
 * TRANSCRIBE_SHAPE に覚える（testTranscribe で事前に確かめられる）。
 */

function isTranscribeModel_(model) {
  return /transcribe/i.test(String(model || ''));
}

function isMp3_(entry) {
  return /audio\/(mpeg|mp3|mpeg3|x-mp3)/i.test(String(entry.mimeType)) || /\.mp3$/i.test(String(entry.fileName));
}

/** Transcribe に渡すリクエストの候補。先頭から試し、最初に通ったものを使う。 */
function transcribeBodies_(part) {
  const contents = [{ role: 'user', parts: [part] }];
  return [
    { name: '話者分けあり（mode.diarizationMode）', body: { contents: contents, generationConfig: { transcriptionConfig: { mode: { diarizationMode: 'ENABLED' } } } } },
    { name: '話者分けあり（transcriptionConfig.diarization）', body: { contents: contents, generationConfig: { transcriptionConfig: { diarization: true } } } },
    { name: '話者分けあり（diarization）', body: { contents: contents, diarization: true } },
    { name: '設定なし', body: { contents: contents } },
  ];
}

/** Transcribe を呼ぶ。覚えている書き方があればそれを使い、無ければ候補を順に試す。 */
function callTranscribe_(model, part) {
  const candidates = transcribeBodies_(part);
  const saved = prop_('TRANSCRIBE_SHAPE', false);
  const order = candidates.slice().sort(function (a, b) {
    return (a.name === saved ? -1 : 0) - (b.name === saved ? -1 : 0);
  });
  const errors = [];
  for (let i = 0; i < order.length; i++) {
    const res = geminiFetch_('/v1beta/models/' + model + ':generateContent', { method: 'post', json: order[i].body });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code === 200) {
      if (order[i].name !== saved) setProp_('TRANSCRIBE_SHAPE', order[i].name);
      return { shape: order[i].name, text: formatTranscribeResponse_(JSON.parse(text)), raw: text };
    }
    errors.push(order[i].name + ' → ' + code + ' ' + clip_(text, 200));
    // 書き方の誤り（400）のときだけ次の候補へ。それ以外（権限・上限・サーバー）は止める
    if (code !== 400) break;
  }
  throw new Error('Transcribe の呼び出しに失敗: ' + errors.join(' / '));
}

/** Transcribe の応答を「[MM:SS] 話者: 発言」の行にする。形が分からなければ本文の文字だけを取り出す。 */
function formatTranscribeResponse_(response) {
  const lines = [];
  const pick = function (obj, keys) {
    for (let i = 0; i < keys.length; i++) if (obj[keys[i]] !== undefined && obj[keys[i]] !== '') return obj[keys[i]];
    return '';
  };
  const seconds = function (v) {
    if (v === '' || v === undefined) return '';
    if (typeof v === 'object') return (Number(v.seconds) || 0) + (Number(v.nanos) || 0) / 1e9;
    const n = parseFloat(String(v).replace(/s$/, ''));
    return isNaN(n) ? '' : n;
  };
  // 発言の配列（text と、話者または時刻を持つ要素の並び）を探す
  const findSegments = function (node, depth) {
    if (!node || depth > 6) return null;
    if (Array.isArray(node)) {
      if (node.length && typeof node[0] === 'object' && node[0] &&
        (node[0].text !== undefined || node[0].transcript !== undefined) &&
        (node[0].speaker !== undefined || node[0].speakerLabel !== undefined || node[0].speakerTag !== undefined ||
          node[0].startOffset !== undefined || node[0].start_offset !== undefined || node[0].startTime !== undefined)) {
        return node;
      }
      for (let i = 0; i < node.length; i++) {
        const found = findSegments(node[i], depth + 1);
        if (found) return found;
      }
      return null;
    }
    if (typeof node === 'object') {
      const keys = Object.keys(node);
      for (let i = 0; i < keys.length; i++) {
        const found = findSegments(node[keys[i]], depth + 1);
        if (found) return found;
      }
    }
    return null;
  };

  const segments = findSegments(response, 0);
  if (segments) {
    segments.forEach(function (s) {
      const t = seconds(pick(s, ['startOffset', 'start_offset', 'startTime', 'start']));
      const speaker = pick(s, ['speaker', 'speakerLabel', 'speaker_label', 'speakerTag', 'speaker_tag']);
      const text = String(pick(s, ['text', 'transcript'])).trim();
      if (!text) return;
      lines.push((t === '' ? '' : '[' + hms_(t) + '] ') + (speaker !== '' ? '話者' + speaker + ': ' : '') + text);
    });
    if (lines.length) return lines.join('\n');
  }
  try {
    return responseText_(response);
  } catch (e) {
    return clip_(JSON.stringify(response), 20000);
  }
}

/** 様子メモ（話し方・場の様子・話者の特徴）の指示文。発言の書き起こしはしない。 */
function notesPrompt_(entry, startSec, endSec, index, total) {
  return [
    'あなたは日本語のビジネス会議の記録係です。添付の録音（元ファイルの ' + hms_(startSec) + '〜' + hms_(endSec) + ' を切り出したもの。全' + total + '区間の第' + index + '区間）を聞き、',
    '発言そのものの書き起こしは別に用意してあるので、それ以外の「文字だけでは伝わらない情報」を短くメモしてください。',
    '',
    '## 出力の形式',
    '最初に「■話者メモ」として、登場する話者を1行ずつ書く。',
    '  形式: 話者名 ｜ 所属・役割（分かれば）｜ 名前を判断した根拠（自己紹介、呼びかけられた名前など）｜ 声や話し方の特徴',
    '  名前が分からない話者は「話者A」「話者B」…とし、特徴を詳しく書く（別の区間と同一人物か照合するため）。',
    '次に「■様子メモ」として、目立った場面を1行ずつ時刻順に書く。',
    '  [HH:MM:SS] 誰が：様子（例: 〔語気が強まる〕「…」と言い切る／〔沈黙 約5秒〕のあと話題が変わる／〔笑い〕で場が和む）',
    '',
    '## ルール',
    '- 時刻は元ファイル先頭からの時刻で書く（切り出しの先頭は ' + hms_(startSec) + '）。',
    '- 書くもの: 語気・熱量・ためらい・言い淀み・沈黙・笑い・ため息・場の緊張や緩和、議論の流れが変わった瞬間、',
    '  同意や反対の温度感（言い切りか、留保付きか、持ち帰りか）、印象的な言い回しや比喩（言葉どおり「」で残す）。',
    '- 発言を順に書き起こさない。推測で補わない。出典番号や引用タグは書かない。前置きやまとめの文も書かない。',
    '',
    '## 参考情報',
    '- ファイル名: ' + entry.fileName,
    '- 録音日時（ファイル名から推定）: ' + (entry.nameDate || '不明'),
  ].join('\n');
}

/** mp3 の位置 offset 以降で、最初のフレームの先頭を探す（bytes は Drive から読んだ先頭部分）。 */
function findMp3FrameStart_(bytes) {
  for (let i = 0; i + 3 < bytes.length; i++) {
    const b0 = bytes[i] & 0xFF, b1 = bytes[i + 1] & 0xFF, b2 = bytes[i + 2] & 0xFF;
    if (b0 !== 0xFF || (b1 & 0xE0) !== 0xE0) continue;
    const version = (b1 >> 3) & 0x03, layer = (b1 >> 1) & 0x03;
    const bitrate = (b2 >> 4) & 0x0F, rate = (b2 >> 2) & 0x03;
    if (version === 1 || layer === 0 || bitrate === 0 || bitrate === 15 || rate === 3) continue;
    return i;
  }
  return -1;
}

/** Drive のファイルの start〜end（end を含む）を、新しい Gemini ファイルとして分割アップロードする。 */
function uploadDriveRangeToGemini_(fileId, start, end, mimeType, displayName) {
  const size = end - start + 1;
  const uploadUrl = startUpload_({ fileName: displayName, mimeType: mimeType }, size);
  let offset = 0;
  let file = null;
  while (offset < size) {
    const pieceEnd = Math.min(offset + CHUNK_BYTES, size) - 1;
    const bytes = readDriveRange_(fileId, start + offset, start + pieceEnd);
    const isLast = pieceEnd + 1 >= size;
    file = uploadChunk_(uploadUrl, offset, bytes, isLast);
    offset = pieceEnd + 1;
  }
  // 読み込みが終わるまで少し待つ（音声は通常数秒）
  for (let i = 0; i < 20 && file && file.state === 'PROCESSING'; i++) {
    Utilities.sleep(3000);
    file = getGeminiFile_(file.name);
  }
  if (!file || file.state !== 'ACTIVE') {
    throw new Error('切り出した音声を Gemini が読み込めませんでした（状態: ' + (file && file.state) + '）。');
  }
  return file;
}

/** 区間 i（0 始まり）の、元ファイル上のバイト範囲と時刻を計算する。 */
function transcribeSlice_(settings, entry, sizeBytes, i) {
  const totalSec = Math.max(1, parseInt(entry.minutes, 10) || 1) * 60;
  const step = settings.transcribeMinutes * 60;
  const count = Math.ceil(totalSec / step);
  const bytesPerSec = sizeBytes / totalSec;
  const startSec = i * step;
  const endSec = Math.min(totalSec, (i + 1) * step);
  return {
    count: count,
    startSec: startSec,
    endSec: endSec,
    start: Math.floor(startSec * bytesPerSec),
    end: i === count - 1 ? sizeBytes - 1 : Math.floor(endSec * bytesPerSec) - 1,
  };
}

/** Transcribe モードで、区間を1つずつ切り出して文字起こしと様子メモを作る。 */
function stepTranscribeSlices_(settings, entry, deadline) {
  const fileId = String(entry.fileId);
  const size = DriveApp.getFileById(fileId).getSize();
  const ids = String(entry.transcriptIds || '').split(',').filter(function (s) { return s.trim(); });
  const total = transcribeSlice_(settings, entry, size, 0).count;

  while (ids.length < total) {
    if (Date.now() > deadline - 210000) return; // 1区間に3分ほどかかるので、余裕がなければ次回へ
    const i = ids.length;
    const slice = transcribeSlice_(settings, entry, size, i);

    // 区切り位置をフレームの先頭にそろえる（先頭の区間はファイルの先頭からそのまま）
    let start = slice.start;
    if (i > 0) {
      const head = readDriveRange_(fileId, start, Math.min(start + 16384, size - 1));
      const skip = findMp3FrameStart_(head);
      if (skip > 0) start += skip;
    }

    const part = uploadDriveRangeToGemini_(fileId, start, slice.end, 'audio/mp3',
      entry.fileName + ' ' + (i + 1) + '/' + total);
    try {
      const filePartData = { fileData: { mimeType: 'audio/mp3', fileUri: part.uri } };
      const tr = callTranscribe_(String(entry.model), filePartData);

      let notes = '（様子メモのモデルが未設定のため、様子メモはありません）';
      if (settings.noteModel) {
        const res = geminiJson_('/v1beta/models/' + settings.noteModel + ':generateContent', {
          method: 'post',
          json: {
            contents: [{ role: 'user', parts: [filePartData, { text: notesPrompt_(entry, slice.startSec, slice.endSec, i + 1, total) }] }],
            generationConfig: { maxOutputTokens: 8192, thinkingConfig: { thinkingLevel: settings.thinkingLevel } },
          },
        });
        notes = responseText_(res);
      }

      const text = [
        '■文字起こし（' + entry.model + '・書き方: ' + tr.shape + '）',
        '※ この部分の時刻は区間の先頭（元ファイルの ' + hms_(slice.startSec) + '）からの時刻です。元ファイル上の時刻は ' + hms_(slice.startSec) + ' を足してください。',
        '※ 話者の番号は区間ごとに振り直されることがあります。下の話者メモで同一人物をそろえてください。',
        tr.text,
        '',
        notes.replace(/^\s+/, ''),
      ].join('\n');
      ids.push(saveTranscriptDoc_(settings, entry, i + 1, total, hms_(slice.startSec) + '〜' + hms_(slice.endSec), text));
      updateLog_(entry, { transcriptIds: ids.join(',') });
    } finally {
      deleteGeminiFile_(part.name);
    }
  }
  finishTranscription_(entry, ids);
}

/**
 * 【手動で実行】Transcribe の呼び出しを試す。
 * 処理ログで最初に見つかった mp3 の先頭約3分を切り出し、どの書き方が通るか・どんな形で返るかをログに出す。
 */
function testTranscribe() {
  const settings = getSettings_();
  if (!isTranscribeModel_(settings.audioModel)) throw new Error('設定タブの「音声のモデル」が Transcribe ではありません。');
  const entry = getLogEntries_().filter(isMp3_)[0];
  if (!entry) throw new Error('処理ログに mp3 のファイルがありません。');
  const fileId = String(entry.fileId);
  const size = DriveApp.getFileById(fileId).getSize();
  const end = Math.min(size, 3 * 1024 * 1024) - 1; // 128kbps で約3分
  const part = uploadDriveRangeToGemini_(fileId, 0, end, 'audio/mp3', 'テスト ' + entry.fileName);
  try {
    PropertiesService.getScriptProperties().deleteProperty('TRANSCRIBE_SHAPE'); // 書き方を一から試す
    const tr = callTranscribe_(settings.audioModel, { fileData: { mimeType: 'audio/mp3', fileUri: part.uri } });
    Logger.log('通った書き方: ' + tr.shape + '\n---- 整形した結果の先頭 ----\n' + clip_(tr.text, 1500)
      + '\n---- 応答そのもの（先頭） ----\n' + clip_(tr.raw, 1500));
  } finally {
    deleteGeminiFile_(part.name);
  }
}
