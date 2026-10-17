/**
 * 共通設定。
 * 秘密情報（Webhook URL、Quire のクライアントシークレットなど）はコードやシートに書かず、
 * スクリプト プロパティに保存する（docs/setup.md 参照）。
 */

// Web ページの下に表示するバージョン。デプロイが最新か確かめるときに使う
const APP_VERSION = '2026-10-17 期間登録対応';

const SHEET = {
  RULES: '振り分けルール',
  SETTINGS: '設定',
  LOG: '登録ログ',
};

// 登録ログの列番号（1 始まり）。シートの見出しと順番を合わせること。
const COL = {
  receivedAt: 1,          // 受信日時
  messageId: 2,           // Gmail メッセージID
  sender: 3,              // 送信者
  subject: 4,             // 件名
  taskName: 5,            // タスク名案
  due: 6,                 // 期限（終了日時）
  judgedProject: 7,       // 判定プロジェクト
  method: 8,              // 判定方法（ルール/AI/General）
  confidence: 9,          // 確信度
  reason: 10,             // 判定理由
  status: 11,             // ステータス
  taskUrl: 12,            // Quire タスク URL
  currentProject: 13,     // 現在のプロジェクト
  learned: 14,            // ルールに反映済み
  gmailUrl: 15,           // Gmail URL
  newProjectCandidate: 16,// 新規PJ候補
  notifiedAt: 17,         // 通知日時
  chatMessage: 18,        // Chat メッセージ名
  taskOid: 19,            // Quire タスク OID
  summary: 20,            // メール要約
  start: 21,              // 開始日時
};

// 5分ごとの実行で、チャットへ送る（または自動登録する）最大件数
const MAX_PER_RUN = 20;

const STATUS = {
  PENDING: '承認待ち',
  APPROVED: '承認',
  REJECTED: '却下',
  DONE: '登録済',
  ERROR: 'エラー',
};

// 振り分けルールの列番号（1 始まり）
const RULE_COL = {
  active: 1,
  name: 2,
  id: 3,
  url: 4,
  senders: 5,
  relation: 6,
  keywords: 7,
  note: 8,
};

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
