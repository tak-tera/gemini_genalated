/**
 * Gemini API（Google AI Studio の有料枠）の呼び出し。
 *  - Files API への分割（再開可能）アップロード
 *  - 長さの確認（音声はトークン数から計算）
 *  - 区間ごとの文字起こし（バッチ／通常）
 */

const GEMINI_BASE = 'https://generativelanguage.googleapis.com';

function geminiFetch_(path, options) {
  const opts = options || {};
  const headers = opts.headers || {};
  headers['x-goog-api-key'] = prop_('GEMINI_API_KEY');
  const params = {
    method: opts.method || 'get',
    headers: headers,
    muteHttpExceptions: true,
  };
  if (opts.json !== undefined) {
    params.contentType = 'application/json';
    params.payload = JSON.stringify(opts.json);
  } else if (opts.payload !== undefined) {
    params.payload = opts.payload;
    if (opts.contentType) params.contentType = opts.contentType;
  }
  const url = /^https:/.test(path) ? path : GEMINI_BASE + path;
  return UrlFetchApp.fetch(url, params);
}

function geminiJson_(path, options) {
  const res = geminiFetch_(path, options);
  const code = res.getResponseCode();
  const text = res.getContentText();
  if (code < 200 || code >= 300) {
    throw new Error('Gemini API エラー（' + code + '）: ' + clip_(text, 300));
  }
  return text ? JSON.parse(text) : {};
}

function lowerHeaders_(res) {
  const out = {};
  const h = res.getAllHeaders();
  Object.keys(h).forEach(function (k) { out[k.toLowerCase()] = h[k]; });
  return out;
}

/** 再開可能アップロードを始め、アップロード URL を返す。 */
function startUpload_(entry, sizeBytes) {
  const res = geminiFetch_('/upload/v1beta/files', {
    method: 'post',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(sizeBytes),
      'X-Goog-Upload-Header-Content-Type': String(entry.mimeType),
    },
    json: { file: { displayName: clip_(PREFIX + ' ' + entry.fileName, 120) } },
  });
  if (res.getResponseCode() !== 200) {
    throw new Error('アップロード開始に失敗（' + res.getResponseCode() + '）: ' + clip_(res.getContentText(), 300));
  }
  const url = lowerHeaders_(res)['x-goog-upload-url'];
  if (!url) throw new Error('アップロード URL が返りませんでした。');
  return url;
}

/** 中断したアップロードで、Gemini 側が受け取り済みのバイト数を問い合わせる。失効していれば -1。 */
function queryUpload_(uploadUrl) {
  const res = geminiFetch_(uploadUrl, { method: 'post', headers: { 'X-Goog-Upload-Command': 'query' } });
  if (res.getResponseCode() !== 200) return -1;
  const h = lowerHeaders_(res);
  if (String(h['x-goog-upload-status'] || '') === 'final') return -2; // 完了済み
  const received = Number(h['x-goog-upload-size-received']);
  return isNaN(received) ? -1 : received;
}

/** 1チャンクを送る。最後のチャンクなら完了処理も行い、Gemini のファイル情報を返す。 */
function uploadChunk_(uploadUrl, offset, bytes, isLast) {
  const res = geminiFetch_(uploadUrl, {
    method: 'post',
    headers: {
      'X-Goog-Upload-Command': isLast ? 'upload, finalize' : 'upload',
      'X-Goog-Upload-Offset': String(offset),
    },
    payload: bytes,
    contentType: 'application/octet-stream',
  });
  const code = res.getResponseCode();
  if (code !== 200) {
    throw new Error('チャンク送信に失敗（' + code + '、位置 ' + offset + '）: ' + clip_(res.getContentText(), 300));
  }
  if (!isLast) return null;
  const body = JSON.parse(res.getContentText());
  return body.file || body;
}

/** Gemini のファイル情報（state: PROCESSING / ACTIVE / FAILED）。 */
function getGeminiFile_(name) {
  return geminiJson_('/v1beta/' + name);
}

function deleteGeminiFile_(name) {
  if (!name) return;
  try {
    geminiFetch_('/v1beta/' + name, { method: 'delete' });
  } catch (e) {
    Logger.log('Gemini ファイルの削除に失敗: ' + name + ' ' + e.message);
  }
}

function filePart_(entry, file) {
  return { fileData: { mimeType: String(entry.mimeType), fileUri: file.uri } };
}

/** 長さ（分）を調べる。動画は Drive のメタデータ、音声は Gemini のトークン数（1秒 = 32 トークン）から計算する。 */
function measureMinutes_(settings, entry, file) {
  if (entry.kind === '動画') {
    const m = driveVideoMinutes_(String(entry.fileId));
    if (m) return { minutes: m, estimated: false };
  }
  const model = String(entry.model);
  const contents = [{ role: 'user', parts: [filePart_(entry, file)] }];
  const body = entry.kind === '動画'
    ? { generateContentRequest: { model: 'models/' + model, contents: contents, generationConfig: { mediaResolution: 'MEDIA_RESOLUTION_LOW' } } }
    : { contents: contents };
  const res = geminiJson_('/v1beta/models/' + model + ':countTokens', { method: 'post', json: body });
  const tokens = Number(res.totalTokens) || 0;
  if (!tokens) throw new Error('長さを調べられませんでした（トークン数 0）。');
  // 1秒あたりのトークン数。Gemini 3 以降は音声 25、それより前は 32。
  // 少なめの値で割ると長さを長めに見積もる（区間が1つ余分に増えるだけで、取りこぼしはない）ので、小さい方を使う。
  // 動画は低画質で 映像約66〜70＋音声25〜32 ≒ 1秒 100 トークン前後。
  const perSecond = entry.kind === '動画' ? 90 : 25;
  return { minutes: Math.ceil(tokens / perSecond / 60), estimated: entry.kind === '動画' };
}

/** 区間ごとの開始・終了（秒）を作る。前の区間と30秒重ねて、区切り目の言葉の取りこぼしを防ぐ。 */
function buildSegments_(totalMinutes, segmentMinutes, extra) {
  const total = Math.max(1, totalMinutes) * 60;
  const step = segmentMinutes * 60;
  const segments = [];
  for (let start = 0; start < total; start += step) {
    segments.push({ start: Math.max(0, start - (start ? 30 : 0)), end: Math.min(total, start + step) });
  }
  if (extra) segments.push({ start: total - 30, end: total + step }); // 長さが概算のときの予備
  return segments;
}

/** 1区間分の generateContent リクエスト本体。 */
function buildSegmentRequest_(settings, entry, file, seg, index, total) {
  const part = filePart_(entry, file);
  const generationConfig = { maxOutputTokens: settings.maxOutputTokens };
  if (/^gemini-2\./.test(String(entry.model))) {
    generationConfig.temperature = 0.2; // Gemini 3 以降は既定の温度のままにする（下げると不安定になることがある）
  } else {
    generationConfig.thinkingConfig = { thinkingLevel: settings.thinkingLevel };
  }
  if (entry.kind === '動画') {
    part.videoMetadata = { startOffset: seg.start + 's', endOffset: seg.end + 's' };
    if (settings.lowResVideo) generationConfig.mediaResolution = 'MEDIA_RESOLUTION_LOW';
  }
  return {
    contents: [{ role: 'user', parts: [part, { text: transcriptPrompt_(entry, seg, index, total) }] }],
    generationConfig: generationConfig,
  };
}

/** 音声か動画かで、設定タブのモデルを選ぶ。 */
function modelFor_(settings, entry) {
  return entry.kind === '動画' ? settings.videoModel : settings.audioModel;
}

/** モデルが無い・使えない・この使い方に対応していない、という種類のエラーか。 */
function isModelError_(e) {
  return /（404）|NOT_FOUND|not found|not supported|is not available|unsupported/i.test(String(e && e.message));
}

/** 応答から本文を取り出す。途中で切れていれば印を付ける。 */
function responseText_(response) {
  const cand = (response && response.candidates && response.candidates[0]) || null;
  if (!cand) {
    const reason = response && response.promptFeedback && response.promptFeedback.blockReason;
    throw new Error('文字起こし結果が空でした' + (reason ? '（' + reason + '）' : '') + '。');
  }
  const parts = (cand.content && cand.content.parts) || [];
  let text = parts.filter(function (p) { return p.text && !p.thought; })
    .map(function (p) { return p.text; }).join('');
  if (cand.finishReason === 'MAX_TOKENS') {
    text += '\n〔注意: 出力の上限に達したため、この区間の終わりの部分が欠けています〕';
  }
  return text;
}

/** 通常方式：1区間をすぐ文字起こしする。 */
function generateNow_(entry, request) {
  return responseText_(geminiJson_('/v1beta/models/' + String(entry.model) + ':generateContent', {
    method: 'post',
    json: request,
  }));
}

/** バッチ方式：全区間をまとめて送る。バッチ名（batches/…）を返す。 */
function submitBatch_(settings, entry, requests) {
  const res = geminiJson_('/v1beta/models/' + String(entry.model) + ':batchGenerateContent', {
    method: 'post',
    json: {
      batch: {
        displayName: clip_(PREFIX + ' 文字起こし ' + entry.fileName, 100),
        inputConfig: {
          requests: {
            requests: requests.map(function (r, i) {
              return { request: r, metadata: { key: 'seg-' + ('0' + (i + 1)).slice(-2) } };
            }),
          },
        },
      },
    },
  });
  const name = res.name || (res.metadata && res.metadata.name);
  if (!name) throw new Error('バッチ名が返りませんでした: ' + clip_(JSON.stringify(res), 200));
  return name;
}

/**
 * バッチの状態を調べる。
 * 戻り値: { state: 'running' | 'succeeded' | 'failed', texts: [区間ごとの本文], message }
 */
function checkBatch_(batchName) {
  const res = geminiJson_('/v1beta/' + batchName);
  const meta = res.metadata || {};
  const state = String(meta.state || res.state || '');
  if (/FAILED|CANCELLED|EXPIRED/.test(state)) {
    return { state: 'failed', message: state + ' ' + clip_(JSON.stringify(res.error || ''), 200) };
  }
  if (!/SUCCEEDED/.test(state) && !res.done) return { state: 'running' };

  const holder = res.response || meta.output || res.output || {};
  let items = holder.inlinedResponses || [];
  if (!Array.isArray(items)) items = items.inlinedResponses || [];
  if (!items.length) return { state: 'failed', message: 'バッチの結果が空でした。' };

  // metadata.key（seg-01…）があればその順に並べる
  const keyed = items.map(function (item, i) {
    const key = item.metadata && item.metadata.key;
    return { order: key ? Number(String(key).replace(/\D/g, '')) : i + 1, item: item };
  }).sort(function (a, b) { return a.order - b.order; });

  const texts = keyed.map(function (k) {
    if (k.item.error) return '〔この区間は文字起こしに失敗しました: ' + clip_(JSON.stringify(k.item.error), 200) + '〕';
    try {
      return responseText_(k.item.response);
    } catch (e) {
      return '〔' + e.message + '〕';
    }
  });
  return { state: 'succeeded', texts: texts };
}
