/** スプレッドシートの読み書き。 */

function spreadsheet_() {
  return SpreadsheetApp.openById(prop_('SPREADSHEET_ID'));
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません。');
  return sh;
}

/** 設定タブを読み込む。項目名（A列）で値（B列）を引く。 */
function getSettings_() {
  const values = sheet_(SHEET.SETTINGS).getDataRange().getValues();
  const map = {};
  values.slice(1).forEach(function (r) {
    if (r[0] !== '') map[String(r[0]).trim()] = r[1];
  });
  const confirm = map['Google Chat で確認する'];
  return {
    generalProject: String(map['General の入れ先'] || 'Inbox（個人）').trim(),
    confirmInChat: !(confirm === false || String(confirm).toUpperCase() === 'FALSE'),
    newProjectTag: String(map['新規プロジェクト候補のタグ'] || '新規PJ候補').trim(),
    // Quire の担当者。「me」は Quire に接続したユーザー（自分）。複数は ; 区切り。空欄なら担当者なし
    assignees: map['Quire の担当者'] === undefined ? ['me'] : splitList_(map['Quire の担当者']),
  };
}

/** 振り分けルールのプロジェクト一覧。onlyActive が true なら有効な行だけ。 */
function getProjects_(onlyActive) {
  const values = sheet_(SHEET.RULES).getDataRange().getValues();
  const list = [];
  values.slice(1).forEach(function (r, i) {
    const name = String(r[RULE_COL.name - 1] || '').trim();
    const id = String(r[RULE_COL.id - 1] || '').trim();
    if (!name || !id) return;
    const active = r[RULE_COL.active - 1] === true;
    if (onlyActive && !active) return;
    list.push({
      row: i + 2,
      active: active,
      name: name,
      id: id,
      senders: splitList_(r[RULE_COL.senders - 1]),
    });
  });
  return list;
}

function findProjectByName_(name, projects) {
  const target = String(name || '').trim();
  return (projects || getProjects_(false)).filter(function (p) { return p.name === target; })[0] || null;
}

function findProjectById_(id, projects) {
  return (projects || getProjects_(false)).filter(function (p) { return p.id === id; })[0] || null;
}

function splitList_(text) {
  return String(text || '')
    .split(/[;；,、\n]/)
    .map(function (s) { return s.trim().toLowerCase(); })
    .filter(function (s) { return s; });
}

/** 登録ログの全行を読む。各行は COL のキー名でアクセスできるオブジェクト。 */
function getLogEntries_() {
  const values = sheet_(SHEET.LOG).getDataRange().getValues();
  return values.slice(1).map(function (r, i) {
    const entry = { row: i + 2 };
    Object.keys(COL).forEach(function (key) { entry[key] = r[COL[key] - 1]; });
    return entry;
  }).filter(function (e) { return e.messageId !== ''; });
}

function findLogEntry_(messageId) {
  return getLogEntries_().filter(function (e) { return String(e.messageId) === String(messageId); })[0] || null;
}

/** 登録ログの1行に複数の値を書き込む。values は { 列キー: 値 }。 */
function updateLog_(row, values) {
  const sh = sheet_(SHEET.LOG);
  Object.keys(values).forEach(function (key) {
    if (!COL[key]) throw new Error('不明な列: ' + key);
    sh.getRange(row, COL[key]).setValue(values[key]);
  });
}

/** 「名前 <addr@example.com>」からアドレスだけを取り出す。 */
function emailAddress_(sender) {
  const text = String(sender || '');
  const m = text.match(/<([^>]+)>/);
  return (m ? m[1] : text).trim().toLowerCase();
}

/**
 * 送信者アドレスをプロジェクトの「送信元」列に追加する（学習）。
 * すでに同じアドレスかドメインが入っていれば何もしない。
 */
function learnSender_(sender, project) {
  const address = emailAddress_(sender);
  if (!address || address.indexOf('@') < 0) return false;
  const domain = address.split('@')[1];
  if (project.senders.indexOf(address) >= 0 || project.senders.indexOf(domain) >= 0) return false;
  const cell = sheet_(SHEET.RULES).getRange(project.row, RULE_COL.senders);
  const current = String(cell.getValue() || '').trim();
  cell.setValue(current ? current + '; ' + address : address);
  project.senders.push(address);
  return true;
}

/** シートの日付やテキストを Quire 用の yyyy-MM-dd にする。読めなければ空文字。 */
function toQuireDate_(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  const m = String(value || '').match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function now_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}
