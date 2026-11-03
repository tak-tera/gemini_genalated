/**
 * 共通設定。
 * Gemini の API キーはコードやシートに書かず、スクリプト プロパティ GEMINI_API_KEY に保存する（docs/setup.md 参照）。
 */

const APP_VERSION = '2026-11-03 Transcribe（audio 入力）';

// プロジェクト共通の接頭語。Drive のフォルダ・文書名や Gemini 側の表示名の先頭に付ける（docs/naming.md 参照）
const PREFIX = 'mtgmin';

const SHEET = {
  FOLDERS: '監視フォルダ',
  SETTINGS: '設定',
  LOG: '処理ログ',
  RESULT: '整理結果',
};

// 処理ログの列番号（1 始まり）。シートの見出しと順番を合わせること。
// Claude の定期実行タスクは M列（ステータス）・S列（会議見出し）・U列（メモ）だけを書き換える。
const COL = {
  detectedAt: 1,       // A 検出日時
  fileId: 2,           // B ファイルID
  fileName: 3,         // C ファイル名
  folderName: 4,       // D 監視フォルダ
  docId: 5,            // E 追記先ドキュメントID
  memoDocId: 6,        // F メモ文書ID（空欄なら追記先ドキュメントをメモとして読む）
  kind: 7,             // G 種類（音声／動画）
  mimeType: 8,         // H MIME タイプ
  sizeMb: 9,           // I サイズ（MB）
  createdAt: 10,       // J ファイル作成日時（Drive）
  nameDate: 11,        // K 録音日時（ファイル名から推定）
  minutes: 12,         // L 長さ（分）
  status: 13,          // M ステータス
  uploadUrl: 14,       // N アップロード URL（途中再開用）
  uploadedBytes: 15,   // O 送信済みバイト
  geminiFile: 16,      // P Gemini ファイル名（files/…）
  batchName: 17,       // Q バッチ名（batches/…）
  transcriptIds: 18,   // R 文字起こし文書ID（区間ごと、カンマ区切り）
  heading: 19,         // S 会議見出し（Claude が書く）
  errorCount: 20,      // T エラー回数
  note: 21,            // U メモ（エラー内容・確認事項）
  updatedAt: 22,       // V 更新日時
  cleaned: 23,         // W 文字起こし削除済
  model: 24,           // X 使用モデル（音声／動画で選んだモデル。使えなければ予備のモデルに切り替える）
};

const LOG_HEADERS = [
  '検出日時', 'ファイルID', 'ファイル名', '監視フォルダ', '追記先ドキュメントID', 'メモ文書ID',
  '種類', 'MIMEタイプ', 'サイズ(MB)', 'ファイル作成日時', '録音日時(ファイル名から推定)', '長さ(分)',
  'ステータス', 'アップロードURL', '送信済みバイト', 'Geminiファイル名', 'バッチ名', '文字起こし文書ID',
  '会議見出し', 'エラー回数', 'メモ', '更新日時', '文字起こし削除済', '使用モデル',
];

const STATUS = {
  WAITING: '待機',              // 見つけた。これからアップロード
  UPLOADING: 'アップロード中',   // Gemini へ分割アップロード中
  PREPARING: 'Gemini準備中',     // アップロード完了。Gemini 側の読み込み待ち
  TRANSCRIBING: '文字起こし中',  // 区間ごとの文字起こしを実行中
  READY: '整理待ち',             // 文字起こし完了。Claude の整理を待つ
  TO_APPEND: '追記待ち',         // Claude が整理結果を書いた。ドキュメントへの追記を待つ
  DONE: '追記済',
  SKIPPED: '対象外',
  ERROR: 'エラー',
};

// 一時的な失敗はこの回数まで自動で再試行し、超えたらステータスを「エラー」にする
const MAX_ERRORS = 5;

// 1回の実行で使う時間の上限（Apps Script の上限は6分）
const RUN_BUDGET_MS = 4.5 * 60 * 1000;

// 分割アップロードの1回分。Gemini の受け付け単位（8MB）の倍数にする
const CHUNK_BYTES = 16 * 1024 * 1024;

/** スクリプト プロパティを読む。required が true で値が無ければエラー。 */
function prop_(key, required) {
  const value = PropertiesService.getScriptProperties().getProperty(key);
  if (required !== false && !value) {
    throw new Error('スクリプト プロパティ「' + key + '」が未設定です。docs/setup.md を参照してください。');
  }
  return value;
}

function setProp_(key, value) {
  PropertiesService.getScriptProperties().setProperty(key, value);
}

/** URL でも ID でも受け取り、Google ドライブの ID を取り出す。 */
function extractId_(text) {
  const s = String(text || '').trim();
  if (!s) return '';
  const m = s.match(/\/d\/([-\w]{20,})/) || s.match(/\/folders\/([-\w]{20,})/) || s.match(/[?&]id=([-\w]{20,})/);
  if (m) return m[1];
  const bare = s.match(/^[-\w]{20,}$/);
  return bare ? bare[0] : '';
}

function now_() {
  return new Date();
}
