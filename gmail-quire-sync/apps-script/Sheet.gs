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

/** 元の行をもとに、登録ログへ1行追加する（1通から複数タスクを作ったとき）。values で列を上書きする。 */
function appendLogCopy_(entry, newId, values) {
  const row = [];
  Object.keys(COL).forEach(function (key) {
    const v = values.hasOwnProperty(key) ? values[key] : entry[key];
    row[COL[key] - 1] = v === undefined ? '' : v;
  });
  row[COL.messageId - 1] = newId;
  sheet_(SHEET.LOG).appendRow(row);
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

/**
 * シートの日付・日時（Date または文字列）を { date: 'yyyy-MM-dd', time: 'HH:mm' } に分ける。
 * 時刻が無い、または 0:00 のときは time を空にする（日付のみとして扱う）。読めなければ両方空。
 */
function toDateParts_(value) {
  const pad = function (n) { return ('0' + n).slice(-2); };
  if (value instanceof Date && !isNaN(value)) {
    const tz = Session.getScriptTimeZone();
    const time = Utilities.formatDate(value, tz, 'HH:mm');
    return { date: Utilities.formatDate(value, tz, 'yyyy-MM-dd'), time: time === '00:00' ? '' : time };
  }
  const m = String(value || '').match(/(\d{4})[-\/年](\d{1,2})[-\/月](\d{1,2})日?(?:[ T　]+(\d{1,2}):(\d{2}))?/);
  if (!m) return { date: '', time: '' };
  const time = m[4] ? pad(m[4]) + ':' + m[5] : '';
  return { date: m[1] + '-' + pad(m[2]) + '-' + pad(m[3]), time: time === '00:00' ? '' : time };
}

/** シートの値を Quire 用の yyyy-MM-dd にする（日付だけ）。読めなければ空文字。 */
function toQuireDate_(value) {
  return toDateParts_(value).date;
}

/**
 * 日本時間の日付と時刻を Quire API の形式にする。
 * 時刻なし → 'yyyy-MM-dd'、時刻あり → UTC の 'yyyy-MM-ddTHH:mmZ'（Quire の仕様）。
 */
function toQuireDateTime_(date, time) {
  if (!date) return '';
  if (!time) return date;
  const d = Utilities.parseDate(date + ' ' + time, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  return Utilities.formatDate(d, 'UTC', "yyyy-MM-dd'T'HH:mm") + 'Z';
}

/** 表示・シート保存用の「yyyy-MM-dd」または「yyyy-MM-dd HH:mm」。 */
function partsText_(parts) {
  return parts.date ? parts.date + (parts.time ? ' ' + parts.time : '') : '';
}

/**
 * 「登録する」ボタンで使う日程。標準は期間（開始〜終了）。
 * 終了（期限）があって開始が無いときは、登録した日を開始日にする。開始が終了より後なら終了日にそろえる。
 * 戻り値: { start: parts, end: parts }
 */
function defaultSchedule_(entry) {
  const end = toDateParts_(entry.due);
  let start = toDateParts_(entry.start);
  if (end.date && !start.date) {
    start = { date: Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd'), time: '' };
  }
  if (start.date && end.date && compareParts_(start, end) > 0) start = { date: end.date, time: '' };
  return { start: start, end: end };
}

/** 2つの日時を比べる。時刻が無い開始はその日の 0:00、時刻が無い終了はその日の終わりとみなす。 */
function compareParts_(start, end) {
  const a = start.date + ' ' + (start.time || '00:00');
  const b = end.date + ' ' + (end.time || '23:59');
  return a < b ? -1 : a > b ? 1 : 0;
}

/** カード表示用の「10/20 〜 10/31 18:00」。 */
function scheduleLabel_(schedule) {
  const f = function (p) { return p.date ? p.date.slice(5).replace('-', '/') + (p.time ? ' ' + p.time : '') : ''; };
  if (schedule.start.date && schedule.end.date) return f(schedule.start) + ' 〜 ' + f(schedule.end);
  if (schedule.end.date) return '期日 ' + f(schedule.end);
  if (schedule.start.date) return f(schedule.start) + ' 〜';
  return '';
}

function now_() {
  return Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
}
