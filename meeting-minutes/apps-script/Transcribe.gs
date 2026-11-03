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
 * Transcribe は Interactions API（POST /v1beta/interactions）で呼ぶ（Audio transcription ガイドの REST の形）。
 * 話者分け（diarization_mode: "speaker"）は verbatim モードで使う。単語ごとの時刻は精度が落ちることがあるため、
 * 設定タブ「Transcribe の時刻」がオンのときだけ付ける。
 */

function isTranscribeModel_(model) {
  return /transcribe/i.test(String(model || ''));
}

function isMp3_(entry) {
  return /audio\/(mpeg|mp3|mpeg3|x-mp3)/i.test(String(entry.mimeType)) || /\.mp3$/i.test(String(entry.fileName));
}

/** Transcribe のリクエスト本体。diarize が false なら話者分けなし（verbatim のまま）。 */
function transcribeBody_(settings, model, fileUri, diarize) {
  const config = {};
  if (settings.transcribeLanguage) config.language_codes = [settings.transcribeLanguage];
  const mode = { type: 'verbatim' };
  if (diarize) mode.diarization_mode = 'speaker';
  if (settings.transcribeTimestamps) mode.timestamp_granularities = ['word'];
  if (diarize || settings.transcribeTimestamps) config.mode = mode;
  return {
    model: 'models/' + model,
    // ガイドの REST の例は type: 'file' だが、実際の API は受け付けない（'audio' を指定する。JavaScript の例と同じ形）
    input: [{ type: 'audio', uri: fileUri, mime_type: 'audio/mp3' }],
    generation_config: { transcription_config: config },
  };
}

/** Transcribe を呼ぶ。話者分けの指定で 400 になったときだけ、話者分けなしでもう一度試す。 */
function callTranscribe_(settings, model, fileUri) {
  const attempts = [true, false];
  const errors = [];
  for (let i = 0; i < attempts.length; i++) {
    const res = geminiFetch_('/v1beta/interactions', { method: 'post', json: transcribeBody_(settings, model, fileUri, attempts[i]) });
    const code = res.getResponseCode();
    const text = res.getContentText();
    if (code === 200) {
      const interaction = waitInteraction_(JSON.parse(text));
      return {
        shape: attempts[i] ? '話者分けあり' : '話者分けなし',
        text: formatTranscribeResponse_(interaction),
        raw: text,
      };
    }
    errors.push((attempts[i] ? '話者分けあり' : '話者分けなし') + ' → ' + code + ' ' + clip_(text, 300));
    if (code !== 400) break; // 書き方の誤り以外（権限・上限・モデルなし）は止める
  }
  throw new Error('Transcribe の呼び出しに失敗: ' + errors.join(' / '));
}

/** 応答が処理中（status が completed 以外）なら、完了するまで少し待って取り直す。 */
function waitInteraction_(interaction) {
  let current = interaction;
  for (let i = 0; i < 30; i++) {
    const status = String(current.status || 'completed');
    if (status === 'completed') return current;
    if (/failed|cancelled|incomplete/.test(status)) {
      throw new Error('Transcribe の処理が ' + status + ' で終わりました: ' + clip_(JSON.stringify(current.error || ''), 200));
    }
    if (!current.id) return current;
    Utilities.sleep(5000);
    const name = /^interactions\//.test(current.id) ? current.id : 'interactions/' + current.id;
    current = geminiJson_('/v1beta/' + name);
  }
  throw new Error('Transcribe の処理が時間内に終わりませんでした。');
}

/**
 * Transcribe の応答を読みやすい行にする。
 * 単語ごとの注記（word_info: text / speaker / start_offset）があれば話者の切り替わりで区切って
 * 「[MM:SS] spk_1: 発言」の形にし、無ければ本文（output_text または steps の text）をそのまま返す。
 */
function formatTranscribeResponse_(interaction) {
  const words = [];
  const texts = [];
  (interaction.steps || []).forEach(function (step) {
    (step.content || []).forEach(function (content) {
      if (content.text) texts.push(content.text);
      (content.annotations || []).forEach(function (a) {
        if (a.type === 'word_info' && a.text !== undefined) words.push(a);
      });
    });
  });

  const hasSpeaker = words.some(function (w) { return w.speaker; });
  if (words.length && hasSpeaker) {
    const seconds = function (v) {
      const n = parseFloat(String(v || '').replace(/s$/, ''));
      return isNaN(n) ? null : n;
    };
    const join = function (a, b) {
      // 英数字どうしだけ空白でつなぐ（日本語は詰める）
      return /[A-Za-z0-9]$/.test(a) && /^[A-Za-z0-9]/.test(b) ? a + ' ' + b : a + b;
    };
    const lines = [];
    let cur = null;
    words.forEach(function (w) {
      const speaker = String(w.speaker || (cur && cur.speaker) || '');
      if (!cur || cur.speaker !== speaker) {
        if (cur) lines.push(cur);
        cur = { speaker: speaker, start: seconds(w.start_offset), text: '' };
      }
      cur.text = join(cur.text, String(w.text));
    });
    if (cur) lines.push(cur);
    return lines.map(function (l) {
      return (l.start === null ? '' : '[' + hms_(l.start) + '] ') + l.speaker + ': ' + l.text.trim();
    }).join('\n');
  }

  if (interaction.output_text) return String(interaction.output_text);
  if (interaction.outputText) return String(interaction.outputText);
  if (texts.length) return texts.join('\n');
  return clip_(JSON.stringify(interaction), 20000);
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
      const tr = callTranscribe_(settings, String(entry.model), part.uri);

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
        '■文字起こし（' + entry.model + '・' + tr.shape + '）',
        '※ この部分の時刻は区間の先頭（元ファイルの ' + hms_(slice.startSec) + '）からの時刻です。元ファイル上の時刻は ' + hms_(slice.startSec) + ' を足してください。',
        '※ 話者の番号（spk_1 など）は区間ごとに振り直されることがあります。下の話者メモで同一人物をそろえてください。',
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
 * 処理ログで最初に見つかった mp3 の先頭約3分を切り出して Transcribe に送り、整形した結果と応答そのものをログに出す。
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
    const tr = callTranscribe_(settings, settings.audioModel, part.uri);
    Logger.log('結果: ' + tr.shape + '\n---- 整形した結果の先頭 ----\n' + clip_(tr.text, 1500)
      + '\n---- 応答そのもの（先頭） ----\n' + clip_(tr.raw, 1500));
  } finally {
    deleteGeminiFile_(part.name);
  }
}
