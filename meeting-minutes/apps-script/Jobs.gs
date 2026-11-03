/**
 * 時間主導トリガーで動く処理。
 *  - runPipeline: 10分ごと。新しいファイルを見つけ、アップロード → 文字起こし → ドキュメントへの追記 を少しずつ進める
 *  - dailyCleanup: 毎日。追記済みで保持日数を過ぎた文字起こしをゴミ箱へ移す
 *
 * ステータスの流れ:
 *   待機 → アップロード中 → Gemini準備中 → 文字起こし中 → 整理待ち
 *   →（Claude が整理して）追記待ち → 追記済
 */

function runPipeline() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // 前回の実行がまだ動いている
  const deadline = Date.now() + RUN_BUDGET_MS;
  try {
    const settings = getSettings_();
    scanFolders_(settings);

    const entries = getLogEntries_();
    for (let i = 0; i < entries.length; i++) {
      if (Date.now() > deadline - 30000) break;
      const entry = entries[i];
      try {
        switch (String(entry.status)) {
          case STATUS.WAITING:
          case STATUS.UPLOADING:
            stepUpload_(settings, entry, deadline);
            break;
          case STATUS.PREPARING:
            stepPrepare_(settings, entry);
            break;
          case STATUS.TRANSCRIBING:
            stepTranscribe_(settings, entry, deadline);
            break;
          case STATUS.TO_APPEND:
            stepAppend_(settings, entry);
            break;
        }
      } catch (e) {
        recordError_(entry, e.message);
      }
    }
  } finally {
    lock.releaseLock();
  }
}

/** Drive のファイルを少しずつ読み出し、Gemini へ分割アップロードする。途中で時間切れになれば次回続きから。 */
function stepUpload_(settings, entry, deadline) {
  const size = DriveApp.getFileById(String(entry.fileId)).getSize();
  let uploadUrl = String(entry.uploadUrl || '');
  let offset = 0;

  if (uploadUrl) {
    const received = queryUpload_(uploadUrl);
    if (received >= 0) {
      offset = received;
    } else {
      uploadUrl = ''; // 失効していたら最初からやり直す
    }
  }
  if (!uploadUrl) {
    uploadUrl = startUpload_(entry, size);
    offset = 0;
    updateLog_(entry, { status: STATUS.UPLOADING, uploadUrl: uploadUrl, uploadedBytes: 0 });
  }

  while (offset < size) {
    if (Date.now() > deadline - 45000) return; // 続きは次回
    const end = Math.min(offset + CHUNK_BYTES, size) - 1;
    const isLast = end + 1 >= size;
    const bytes = readDriveRange_(String(entry.fileId), offset, end);
    const file = uploadChunk_(uploadUrl, offset, bytes, isLast);
    offset = end + 1;
    if (isLast) {
      updateLog_(entry, {
        status: STATUS.PREPARING, geminiFile: file.name, uploadUrl: '', uploadedBytes: offset, note: '',
      });
      return;
    }
    updateLog_(entry, { uploadedBytes: offset });
  }
}

/** Gemini 側の読み込みが終わったら長さを調べ、文字起こしを始める。 */
function stepPrepare_(settings, entry) {
  const file = getGeminiFileOrNull_(entry);
  if (!file) return;
  if (file.state === 'PROCESSING') return; // まだ読み込み中
  if (file.state === 'FAILED') {
    updateLog_(entry, { status: STATUS.ERROR, note: 'Gemini がファイルを読み込めませんでした。形式を変えて置き直してください。' });
    return;
  }

  if (!entry.model) updateLog_(entry, { model: modelFor_(settings, entry) });

  // Transcribe モード：mp3 なら区間ごとに切り出して送る。mp3 以外は様子メモのモデルで通常どおり文字起こしする
  if (isTranscribeModel_(entry.model)) {
    if (isMp3_(entry) && settings.noteModel) {
      if (!parseInt(entry.minutes, 10)) {
        const m = measureMinutes_(settings, entry, file, settings.noteModel); // Transcribe は長さの計算に使えないことがある
        updateLog_(entry, { minutes: m.minutes });
      }
      updateLog_(entry, { status: STATUS.TRANSCRIBING, batchName: '', transcriptIds: '' });
      return;
    }
    updateLog_(entry, {
      model: settings.noteModel || settings.fallbackModel,
      note: isMp3_(entry) ? '様子メモのモデルが未設定のため、Transcribe を使わずに文字起こしします。'
        : 'mp3 以外の音声は区間ごとに切り出せないため、Transcribe を使わずに文字起こしします。',
    });
  }

  try {
    startTranscription_(settings, entry, file);
  } catch (e) {
    // 選んだモデルが使えなければ、予備のモデルに切り替えてもう一度だけ試す
    if (!isModelError_(e) || !settings.fallbackModel || String(entry.model) === settings.fallbackModel) throw e;
    const original = String(entry.model);
    updateLog_(entry, {
      model: settings.fallbackModel,
      note: original + ' が使えなかったため ' + settings.fallbackModel + ' に切り替えました（' + clip_(e.message, 150) + '）',
    });
    startTranscription_(settings, entry, file);
  }
}

/** 長さを調べ、区間に分けて文字起こしを始める（バッチなら一括送信）。 */
function startTranscription_(settings, entry, file) {
  if (!parseInt(entry.minutes, 10)) {
    const m = measureMinutes_(settings, entry, file);
    updateLog_(entry, { minutes: m.estimated ? m.minutes + '（概算）' : m.minutes });
  }
  const segments = segmentsOf_(settings, entry);

  if (settings.batch) {
    const requests = segments.map(function (seg, i) {
      return buildSegmentRequest_(settings, entry, file, seg, i + 1, segments.length);
    });
    const batchName = submitBatch_(settings, entry, requests);
    updateLog_(entry, { status: STATUS.TRANSCRIBING, batchName: batchName, transcriptIds: '' });
  } else {
    updateLog_(entry, { status: STATUS.TRANSCRIBING, batchName: '', transcriptIds: '' });
  }
}

/** 区間ごとの文字起こしを進め、終わったら文字起こし文書を保存して「整理待ち」にする。 */
function stepTranscribe_(settings, entry, deadline) {
  if (isTranscribeModel_(entry.model)) {
    try {
      stepTranscribeSlices_(settings, entry, deadline);
    } catch (e) {
      // Transcribe が使えなければ、様子メモのモデルによる通常の文字起こしに切り替えて最初からやり直す
      if (!isModelError_(e) || !settings.noteModel) throw e;
      trashTranscripts_(entry);
      updateLog_(entry, {
        status: STATUS.PREPARING, model: settings.noteModel, transcriptIds: '',
        note: 'Transcribe が使えなかったため ' + settings.noteModel + ' に切り替えました（' + clip_(e.message, 150) + '）',
      });
    }
    return;
  }
  const segments = segmentsOf_(settings, entry);
  const total = segments.length;
  const rangeText = function (i) { return hms_(segments[i].start) + '〜' + hms_(segments[i].end); };

  if (entry.batchName) {
    const result = checkBatch_(String(entry.batchName));
    if (result.state === 'running') return;
    if (result.state === 'failed') {
      // 次回、バッチを作り直す
      updateLog_(entry, { status: STATUS.PREPARING, batchName: '' });
      recordError_(entry, 'バッチが失敗しました: ' + result.message);
      return;
    }
    const ids = result.texts.map(function (text, i) {
      return saveTranscriptDoc_(settings, entry, i + 1, total, i < total ? rangeText(i) : '', text);
    });
    finishTranscription_(entry, ids);
    return;
  }

  // 通常方式：1区間ずつ
  const file = getGeminiFileOrNull_(entry);
  if (!file) return;
  const ids = String(entry.transcriptIds || '').split(',').filter(function (s) { return s.trim(); });
  while (ids.length < total) {
    if (Date.now() > deadline - 150000) return; // 1区間に数分かかることがあるので余裕を持って次回へ
    const i = ids.length;
    const text = generateNow_(entry, buildSegmentRequest_(settings, entry, file, segments[i], i + 1, total));
    ids.push(saveTranscriptDoc_(settings, entry, i + 1, total, rangeText(i), text));
    updateLog_(entry, { transcriptIds: ids.join(',') });
  }
  finishTranscription_(entry, ids);
}

function finishTranscription_(entry, ids) {
  deleteGeminiFile_(String(entry.geminiFile));
  updateLog_(entry, {
    status: STATUS.READY, transcriptIds: ids.join(','), geminiFile: '', batchName: '', errorCount: 0, note: '',
  });
}

/** Claude が整理結果タブに書いた内容を、追記先ドキュメントの末尾に書式付きで追記する。 */
function stepAppend_(settings, entry) {
  const rows = getResultLines_(String(entry.fileId));
  if (!rows.length) throw new Error('整理結果タブにこのファイルの行がありません。');
  const anchor = String(entry.anchor || '').trim();
  const found = insertMarkdownToDoc_(String(entry.docId), rows.map(function (r) { return r.text; }), anchor);
  const values = { status: STATUS.DONE, errorCount: 0 };
  if (anchor && !found) {
    values.note = clip_((entry.note ? entry.note + ' / ' : '') + 'メモの見出し「' + anchor + '」が見つからなかったため、ドキュメントの先頭に追記しました。', 500);
  }
  updateLog_(entry, values);
  deleteResultLines_(rows);
  if (settings.keepDays === 0) {
    trashTranscripts_(entry);
    updateLog_(entry, { cleaned: true });
  }
}

/** Gemini のファイルを取得する。48時間の保存期限が切れていたら、最初からやり直すよう戻して null を返す。 */
function getGeminiFileOrNull_(entry) {
  try {
    return getGeminiFile_(String(entry.geminiFile));
  } catch (e) {
    if (/（(403|404)）/.test(e.message)) {
      trashTranscripts_(entry);
      updateLog_(entry, {
        status: STATUS.WAITING, uploadUrl: '', uploadedBytes: 0, geminiFile: '', batchName: '', transcriptIds: '',
        note: 'Gemini 側のファイルの保存期限が切れたため、アップロードからやり直します。',
      });
      return null;
    }
    throw e;
  }
}

function segmentsOf_(settings, entry) {
  const minutes = parseInt(entry.minutes, 10) || 1;
  return buildSegments_(minutes, settings.segmentMinutes, /概算/.test(String(entry.minutes)));
}

/** 追記済みで保持日数を過ぎた文字起こしをゴミ箱へ移す。 */
function dailyCleanup() {
  const settings = getSettings_();
  const limit = new Date(Date.now() - settings.keepDays * 24 * 60 * 60 * 1000);
  getLogEntries_().forEach(function (entry) {
    if (entry.status !== STATUS.DONE || entry.cleaned === true) return;
    const updated = entry.updatedAt instanceof Date ? entry.updatedAt : new Date(entry.updatedAt);
    if (!isNaN(updated) && updated > limit) return;
    trashTranscripts_(entry);
    updateLog_(entry, { cleaned: true });
  });
}

/**
 * 【手動で実行】「エラー」の行をやり直す。
 * 整理結果が残っていれば追記から、文字起こしが済んでいれば整理待ちから、それ以外はアップロードからやり直す。
 */
function retryErrors() {
  let count = 0;
  getLogEntries_().forEach(function (entry) {
    if (entry.status !== STATUS.ERROR) return;
    count++;
    if (getResultLines_(String(entry.fileId)).length) {
      updateLog_(entry, { status: STATUS.TO_APPEND, errorCount: 0, note: '' });
      return;
    }
    if (entry.transcriptIds && !entry.geminiFile && !entry.batchName) {
      updateLog_(entry, { status: STATUS.READY, errorCount: 0, note: '' });
      return;
    }
    deleteGeminiFile_(String(entry.geminiFile));
    trashTranscripts_(entry);
    updateLog_(entry, {
      status: STATUS.WAITING, uploadUrl: '', uploadedBytes: 0, geminiFile: '', batchName: '',
      transcriptIds: '', errorCount: 0, note: '',
    });
  });
  Logger.log('やり直しにした行: ' + count + ' 件');
}
