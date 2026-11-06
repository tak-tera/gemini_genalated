/** スプレッドシートの読み込み。 */

function prop_(key, required) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v && required !== false) throw new Error('スクリプト プロパティ ' + key + ' が設定されていません。');
  return v;
}

function spreadsheet_() {
  return SpreadsheetApp.openById(prop_('SPREADSHEET_ID'));
}

function sheet_(name) {
  const sh = spreadsheet_().getSheetByName(name);
  if (!sh) throw new Error('シート「' + name + '」が見つかりません。setupSheets を実行してください。');
  return sh;
}

function rows_(name) {
  return sheet_(name).getDataRange().getValues().slice(1);
}

function bool_(v) {
  return v === true || String(v).toUpperCase() === 'TRUE';
}

/** 「8:00」の文字列、またはシートが時刻に変換した値を 'HH:mm' にする。 */
function hhmm_(v, fallback) {
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'HH:mm');
  const m = String(v || '').match(/(\d{1,2}):(\d{2})/);
  return m ? ('0' + m[1]).slice(-2) + ':' + m[2] : fallback;
}

function getSettings_() {
  const map = {};
  rows_(SHEET.SETTINGS).forEach(function (r) {
    if (r[0] !== '') map[String(r[0]).trim()] = r[1];
  });
  return {
    live: String(map['書き込みモード'] || '').trim() === '本番',
    days: Number(map['対象期間（日）']) || 90,
    mainCalendarId: String(map['メインカレンダーID'] || 'primary').trim(),
    mergeGapMin: map['結合する隙間（分）'] === '' || map['結合する隙間（分）'] === undefined ? 30 : Number(map['結合する隙間（分）']),
    maxTitle: Number(map['タイトルの最大文字数']) || 30,
  };
}

const DAY_CHARS = '日月火水木金土';

function getOrgs_() {
  return rows_(SHEET.ORGS).map(function (r) {
    return {
      active: bool_(r[0]),
      code: String(r[1] || '').trim(),
      name: String(r[2] || '').trim(),
      calendarId: String(r[3] || '').trim(),
      prefix: String(r[4] || ''),
      colorId: String(r[5] || '').trim(),
      dayStart: hhmm_(r[6], '08:00'),
      dayEnd: hhmm_(r[7], '18:00'),
      workdays: String(r[8] || '月火水木金').split('').map(function (c) { return DAY_CHARS.indexOf(c); })
        .filter(function (n) { return n >= 0; }),
      blockType: String(r[9] || '不在').trim(),
      mirror: bool_(r[10]),
      block: bool_(r[11]),
    };
  }).filter(function (o) { return o.active && o.code && o.calendarId; });
}

/** キーワード欄（; 区切り。/…/ は正規表現）を正規表現の配列にする。 */
function keywords_(text) {
  return String(text || '').split(/[;；\n]/).map(function (s) { return s.trim(); }).filter(String)
    .map(function (s) {
      const m = s.match(/^\/(.+)\/([a-z]*)$/);
      if (m) return new RegExp(m[1], m[2] || 'i');
      return new RegExp(s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    });
}

function getRules_() {
  return rows_(SHEET.RULES).filter(function (r) { return bool_(r[0]); })
    .map(function (r) {
      return {
        order: Number(r[1]) || 0,
        org: String(r[2] || '').trim(),
        category: String(r[3] || '').trim(),
        patterns: keywords_(r[4]),
        label: String(r[5] || '').trim(),
        before: Number(r[6]) || 0,
        after: Number(r[7]) || 0,
        priority: Number(r[8]) || 0,
      };
    })
    .filter(function (x) { return x.category && x.patterns.length; })
    .sort(function (a, b) { return a.order - b.order; });
}

function getTitleRules_() {
  return rows_(SHEET.TITLES).filter(function (r) { return bool_(r[0]) && String(r[3] || '') !== ''; })
    .map(function (r) {
      return {
        order: Number(r[1]) || 0,
        org: String(r[2] || '').trim(),
        pattern: new RegExp(String(r[3]), 'g'),
        replacement: String(r[4] || ''),
        target: String(r[5] || '削除').trim(),
      };
    })
    .sort(function (a, b) { return a.order - b.order; });
}
