/** スプレッドシートの読み書き。 */

function spreadsheet_() {
  return SpreadsheetApp.openById(prop_('SPREADSHEET_ID'));
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません。setupSheets を実行してください。');
  return sh;
}

// 設定タブの初期値。[項目, 値, 説明]
const DEFAULT_SETTINGS = [
  ['音声のモデル', 'gemini-4-argon', '録音の文字起こしに使うモデル。話し方の注記まで指示どおりに書けるモデルを使う'],
  ['動画のモデル', 'gemini-4-argon', '録画の文字起こしに使うモデル。画面共有の内容も読むため、映像を扱えるモデルを使う'],
  ['予備のモデル', 'gemini-3.1-pro', '上のモデルが使えない（提供終了・名前違いなど）ときに自動で切り替えるモデル。空欄なら切り替えない'],
  ['思考レベル', '低', '低 / 中 / 高。文字起こしは深い推論が要らないので「低」で料金を抑える（Gemini 3 以降のモデルだけに適用）'],
  ['処理方式', 'バッチ', 'バッチ: 料金が約半額で、結果は通常数分〜数時間（最長24時間）。通常: 1区間ずつすぐ実行'],
  ['区切り（分）', 30, '長い録音をこの長さごとに分けて文字起こしする'],
  ['動画の画質', '低', '低: 長い動画向け（画面の文字が細かいと読み落とすことがある）。標準: 画面共有の資料を細かく読みたいとき（1時間程度まで）'],
  ['最大出力トークン', 32768, '1区間の文字起こしの最大の長さ。通常方式（Apps Script からの直接呼び出し）の上限は 32768'],
  ['作業フォルダID', '', '文字起こし（区間ごとの Google ドキュメント）を置くフォルダ。setupSheets で自動作成'],
  ['文字起こしの保持日数', 7, '追記済みになってからこの日数が過ぎた文字起こしをゴミ箱へ移す。0 なら追記後すぐ'],
  ['最大ファイルサイズ（MB）', 2000, 'Gemini の上限は 2GB。これを超えるファイルは「対象外」にする'],
  ['アップロード完了を待つ時間（分）', 10, '最終更新からこの時間が過ぎたファイルだけを処理する（同期中のファイルを避けるため）'],
  ['監視開始日時', '', 'この日時より後に作られたファイルだけを処理する。setupSheets 実行時の日時が入る'],
  ['議事録フォーマット文書', '', 'Claude が読む、整理フォーマットを書いた Google ドキュメントの URL'],
];

/** 設定タブを読み込む。項目名（A列）で値（B列）を引く。 */
function getSettings_() {
  const values = sheet_(SHEET.SETTINGS).getDataRange().getValues();
  const map = {};
  values.slice(1).forEach(function (r) {
    if (r[0] !== '') map[String(r[0]).trim()] = r[1];
  });
  const num = function (key, def) {
    const v = Number(map[key]);
    return isNaN(v) || map[key] === '' ? def : v;
  };
  const since = map['監視開始日時'];
  return {
    audioModel: modelName_(map['音声のモデル'] || map['Gemini モデル'] || 'gemini-4-argon'),
    videoModel: modelName_(map['動画のモデル'] || map['Gemini モデル'] || 'gemini-4-argon'),
    fallbackModel: modelName_(map['予備のモデル']),
    thinkingLevel: ({ '低': 'low', '中': 'medium', '高': 'high' })[String(map['思考レベル'] || '低').trim()] || 'low',
    batch: String(map['処理方式'] || 'バッチ').trim() !== '通常',
    segmentMinutes: Math.max(5, num('区切り（分）', 30)),
    lowResVideo: String(map['動画の画質'] || '低').trim() !== '標準',
    maxOutputTokens: num('最大出力トークン', 32768),
    workFolderId: extractId_(map['作業フォルダID']),
    keepDays: Math.max(0, num('文字起こしの保持日数', 7)),
    maxSizeMb: num('最大ファイルサイズ（MB）', 2000),
    settleMinutes: num('アップロード完了を待つ時間（分）', 10),
    since: since instanceof Date ? since : (since ? new Date(since) : null),
  };
}

function modelName_(value) {
  return String(value || '').trim().replace(/^models\//, '');
}

/** 監視フォルダの一覧（有効な行だけ）。 */
function getFolders_() {
  const values = sheet_(SHEET.FOLDERS).getDataRange().getValues();
  const list = [];
  values.slice(1).forEach(function (r, i) {
    if (r[0] !== true) return;
    const folderId = extractId_(r[2]);
    const docId = extractId_(r[3]);
    if (!folderId || !docId) return;
    list.push({
      row: i + 2,
      name: String(r[1] || '').trim(),
      folderId: folderId,
      docId: docId,
      memoDocId: extractId_(r[4]),
    });
  });
  return list;
}

/** 処理ログの全行を読む。各行は COL のキー名でアクセスできるオブジェクト。 */
function getLogEntries_() {
  const sh = sheet_(SHEET.LOG);
  const values = sh.getDataRange().getValues();
  return values.slice(1).map(function (r, i) {
    const entry = { row: i + 2 };
    Object.keys(COL).forEach(function (key) { entry[key] = r[COL[key] - 1]; });
    return entry;
  }).filter(function (e) { return e.fileId !== ''; });
}

/** 処理ログの1行に複数の値を書き込む。values は { 列キー: 値 }。entry も同じ値で更新する。 */
function updateLog_(entry, values) {
  const sh = sheet_(SHEET.LOG);
  values.updatedAt = now_();
  Object.keys(values).forEach(function (key) {
    if (!COL[key]) throw new Error('不明な列: ' + key);
    sh.getRange(entry.row, COL[key]).setValue(values[key]);
    entry[key] = values[key];
  });
}

function appendLog_(values) {
  const row = [];
  Object.keys(COL).forEach(function (key) {
    row[COL[key] - 1] = values[key] === undefined ? '' : values[key];
  });
  const sh = sheet_(SHEET.LOG);
  sh.appendRow(row);
  // ID 類が数値や日付に化けないよう、文字列の列は書式を「書式なしテキスト」にしておく
  const last = sh.getLastRow();
  [COL.fileId, COL.docId, COL.memoDocId, COL.transcriptIds].forEach(function (c) {
    sh.getRange(last, c).setNumberFormat('@');
  });
}

/** 一時的な失敗を記録する。回数が上限を超えたらステータスを「エラー」にする。 */
function recordError_(entry, message) {
  const count = (Number(entry.errorCount) || 0) + 1;
  const values = { errorCount: count, note: clip_(message, 500) };
  if (count >= MAX_ERRORS) values.status = STATUS.ERROR;
  updateLog_(entry, values);
  Logger.log('失敗（' + count + '回目）: ' + entry.fileName + ' ' + message);
}

/** 整理結果タブから、指定ファイルの行を行番号順に読む。 */
function getResultLines_(fileId) {
  const sh = sheet_(SHEET.RESULT);
  const values = sh.getDataRange().getValues();
  const rows = [];
  values.slice(1).forEach(function (r, i) {
    if (String(r[0]).trim() === String(fileId)) {
      rows.push({ row: i + 2, no: Number(r[1]) || 0, text: String(r[2] === undefined ? '' : r[2]) });
    }
  });
  rows.sort(function (a, b) { return a.no - b.no; });
  return rows;
}

/** 整理結果タブから、指定ファイルの行を消す（下から順に消す）。 */
function deleteResultLines_(rows) {
  const sh = sheet_(SHEET.RESULT);
  rows.map(function (r) { return r.row; }).sort(function (a, b) { return b - a; })
    .forEach(function (row) { sh.deleteRow(row); });
}

function clip_(text, max) {
  const s = String(text || '');
  return s.length > max ? s.slice(0, max - 1) + '…' : s;
}
