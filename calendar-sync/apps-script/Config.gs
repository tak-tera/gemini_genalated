/**
 * 共通設定。
 * 組織・分類・タイトル整形の中身はスプレッドシートで管理する（setupSheets で初期値を作成）。
 */

const APP_VERSION = '2026-11-05 プレビュー反映2';
const TZ = 'Asia/Tokyo';

const SHEET = {
  SETTINGS: '設定',
  ORGS: '組織',
  RULES: '分類ルール',
  TITLES: 'タイトル整形',
  LOG: '同期ログ',
  PREVIEW: 'プレビュー',
};

// スクリプトが作った予定に付ける非公開の印（extendedProperties.private）
const PROP = {
  KIND: 'calSync',        // 'block'（組織側の不在ブロック） / 'mirror'（メインに写した予定） / 'linked'（手入力の予定と紐付け）
  ORG: 'calSyncOrg',      // 組織コード（TU など）
  SRC: 'calSyncSrc',      // 写した元の予定 ID（mirror / linked）
};
const KIND = { BLOCK: 'block', MIRROR: 'mirror', LINKED: 'linked' };

// 分類ルールの「分類」が この値なら対象外
const EXCLUDE = '対象外';
// どのキーワードにも当たらなかったとき
const DEFAULT_RULE = { category: '不明', label: '（不在）', before: 0, after: 0, priority: 1, isDefault: true };

// 終日扱いにする長さ（これ以上の時間指定予定は、終日予定と同じ扱い）
const LONG_EVENT_HOURS = 12;
