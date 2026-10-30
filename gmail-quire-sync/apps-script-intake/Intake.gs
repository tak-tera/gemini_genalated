/**
 * Google Workspace Studio の「Webhook の送信」から呼ばれる受付口。
 * 受け取ったタスク候補を「登録ログ」に「承認待ち」で追記するだけ。
 * Chat の確認カード、Quire への登録、学習は既存の Apps Script（apps-script/）がそのまま行う。
 *
 * 既存の Web アプリ（承認ページ）は「自分のみ」アクセスのため、Studio からは呼べない。
 * そのため、この受付口は別の Apps Script プロジェクトとして「全員」アクセスで公開し、
 * 合言葉（INTAKE_TOKEN）が合わないリクエストは何もしない。
 *
 * スクリプト プロパティ:
 *   SPREADSHEET_ID … 既存と同じスプレッドシート
 *   INTAKE_TOKEN   … 合言葉。setupIntakeToken を実行すると作られる
 *
 * 受け付ける形（どれでもよい）:
 *   - 本文が JSON: { "token": "...", "is_task": true, "sender": "...", "subject": "...", "tasks": [ {...} ] }
 *   - 本文の中に JSON が含まれる文章（Gemini の出力をそのまま送った場合。```json の囲みも可）
 *   - 合言葉は本文の token か、URL の ?key=... のどちらか
 */

const INTAKE = {
  LOG: '登録ログ',
  RULES: '振り分けルール',
  SETTINGS: '設定',
  COLS: 26,               // 登録ログ A〜Z
  MAX_TASKS: 3,           // 1通あたりの最大件数（Claude の判定と同じ）
  MAX_PER_HOUR: 60,       // 想定外の大量送信への歯止め
};

function doPost(e) {
  try {
    const result = handleIntake_(e);
    return json_(result);
  } catch (err) {
    // 中身は返さない（外から呼べる口なので、内部の情報を出さない）
    console.error(err && err.stack || err);
    return json_({ ok: false, error: 'error' });
  }
}

function doGet() {
  return json_({ ok: true, service: 'quire-intake' });
}

function handleIntake_(e) {
  const params = (e && e.parameter) || {};
  const raw = (e && e.postData && e.postData.contents) || '';
  const data = parseBody_(raw);

  const token = String(data.token || params.key || '');
  if (!checkToken_(token)) return { ok: false, error: 'unauthorized' };
  if (!underRateLimit_()) return { ok: false, error: 'rate_limited' };

  if (data.is_task === false || String(data.is_task).toLowerCase() === 'false') {
    return { ok: true, added: 0, note: 'not a task' };
  }
  let tasks = Array.isArray(data.tasks) ? data.tasks : (data.task_name || data.name ? [data] : []);
  tasks = tasks.filter(function (t) { return t && (t.task_name || t.name); }).slice(0, INTAKE.MAX_TASKS);
  if (!tasks.length) return { ok: true, added: 0, note: 'no tasks' };

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const ss = SpreadsheetApp.openById(prop_('SPREADSHEET_ID'));
    const log = ss.getSheetByName(INTAKE.LOG);
    const existing = existingIds_(log);
    const settings = readSettings_(ss);
    const projects = readProjects_(ss);

    const sender = clip_(data.sender || data.from || '', 200);
    const subject = clip_(data.subject || '', 300);
    const receivedAt = clip_(data.received_at || data.receivedAt || now_(), 30);
    const baseId = baseId_(data, sender, subject, receivedAt);

    const rows = [];
    tasks.forEach(function (t, i) {
      const id = tasks.length === 1 ? baseId : baseId + '-' + (i + 1);
      if (existing[id]) return; // 同じメールを二度登録しない
      const route = route_(sender, t, projects, settings);
      const row = new Array(INTAKE.COLS).fill('');
      row[0] = text_(receivedAt);                                   // A 受信日時
      row[1] = id;                                                  // B ID
      row[2] = text_(sender);                                       // C 送信者
      row[3] = text_(subject);                                      // D 件名
      row[4] = text_(clip_(t.task_name || t.name, 60));             // E タスク名案
      row[5] = dateText_(t.due || t.end);                           // F 終了日時
      row[6] = route.project;                                       // G 判定プロジェクト
      row[7] = route.method;                                        // H 判定方法
      row[8] = route.confidence;                                    // I 確信度
      row[9] = text_(clip_(route.reason, 300));                     // J 判定理由
      row[10] = '承認待ち';                                          // K ステータス
      row[14] = safeGmailUrl_(data.gmail_url || data.gmailUrl);     // O Gmail URL
      row[15] = route.newProject;                                   // P 新規PJ候補
      row[19] = text_(clip_(t.summary || data.summary || '', 1000)); // T 要約
      row[20] = dateText_(t.start);                                 // U 開始日時
      row[21] = 'メール';                                            // V 出どころ
      rows.push(row);
    });
    if (rows.length) {
      log.getRange(log.getLastRow() + 1, 1, rows.length, INTAKE.COLS).setValues(rows);
    }
    return { ok: true, added: rows.length };
  } finally {
    lock.releaseLock();
  }
}

// ---------- 入力の読み取り ----------

/** 本文を読む。JSON でなければ、文章の中の最初の { … } を JSON として読む。 */
function parseBody_(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  try { return unwrap_(JSON.parse(text)); } catch (e) { /* 続けて探す */ }
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start >= 0 && end > start) {
    try { return unwrap_(JSON.parse(text.slice(start, end + 1))); } catch (e) { /* 読めない */ }
  }
  return {};
}

/** { "gemini": "…JSON の文字列…" } のように包まれていたら中身を取り出す。 */
function unwrap_(obj) {
  if (obj && typeof obj.gemini === 'string') {
    const inner = parseBody_(obj.gemini);
    Object.keys(obj).forEach(function (k) { if (k !== 'gemini' && inner[k] === undefined) inner[k] = obj[k]; });
    return inner;
  }
  return obj || {};
}

function checkToken_(token) {
  const expected = prop_('INTAKE_TOKEN');
  if (!token || token.length !== expected.length) return false;
  let diff = 0;
  for (let i = 0; i < token.length; i++) diff |= token.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0;
}

function underRateLimit_() {
  const cache = CacheService.getScriptCache();
  const key = 'intake-' + Utilities.formatDate(new Date(), 'UTC', 'yyyyMMddHH');
  const n = Number(cache.get(key) || 0) + 1;
  cache.put(key, String(n), 3700);
  return n <= INTAKE.MAX_PER_HOUR;
}

/** Gmail のメッセージ ID があればそれを使う（Claude の判定と重複しない）。無ければ内容から作る。 */
function baseId_(data, sender, subject, receivedAt) {
  const mid = String(data.message_id || data.messageId || '').trim();
  if (/^[A-Za-z0-9_\-]{6,80}$/.test(mid)) return mid;
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, [sender, subject, receivedAt].join('|'));
  return 'studio-' + digest.slice(0, 8).map(function (b) { return ('0' + (b & 0xff).toString(16)).slice(-2); }).join('');
}

function existingIds_(log) {
  const last = log.getLastRow();
  if (last < 2) return {};
  const ids = {};
  log.getRange(2, 2, last - 1, 1).getValues().forEach(function (r) { if (r[0] !== '') ids[String(r[0])] = true; });
  return ids;
}

// ---------- 振り分け ----------

function readSettings_(ss) {
  const map = {};
  ss.getSheetByName(INTAKE.SETTINGS).getDataRange().getValues().slice(1)
    .forEach(function (r) { if (r[0] !== '') map[String(r[0]).trim()] = r[1]; });
  return {
    general: String(map['General の入れ先'] || 'Inbox（個人）').trim(),
    threshold: Number(map['AI 判断で振り分ける確信度の下限'] || 0.7),
  };
}

function readProjects_(ss) {
  return ss.getSheetByName(INTAKE.RULES).getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0] === true && String(r[1] || '').trim(); })
    .map(function (r) {
      return {
        name: String(r[1]).trim(),
        senders: String(r[4] || '').split(/[;；,、\n]/).map(function (s) { return s.trim().toLowerCase(); }).filter(String),
      };
    });
}

/**
 * 登録先を決める。順番は Claude の判定と同じ:
 *  1. 送信者のアドレスかドメインが振り分けルールの「送信元」に一致 → ルール
 *  2. Gemini が選んだプロジェクトが実在し、確信度が下限以上 → AI
 *  3. それ以外 → General（判定理由に候補を残す）
 */
function route_(sender, t, projects, settings) {
  const m = String(sender).match(/<([^>]+)>/);
  const address = (m ? m[1] : String(sender)).trim().toLowerCase();
  const domain = address.split('@')[1] || '';
  const byRule = projects.filter(function (p) {
    return p.senders.indexOf(address) >= 0 || (domain && p.senders.indexOf(domain) >= 0);
  })[0];
  if (byRule) {
    return { project: byRule.name, method: 'ルール', confidence: 1, reason: '送信元が振り分けルールに一致（Studio）', newProject: '' };
  }
  const wanted = String(t.project || '').trim();
  const conf = Math.max(0, Math.min(1, Number(t.confidence) || 0));
  const hit = projects.filter(function (p) { return p.name === wanted; })[0];
  const reason = 'Gemini（Studio）: ' + String(t.reason || '');
  if (hit && conf >= settings.threshold) {
    return { project: hit.name, method: 'AI', confidence: conf, reason: reason, newProject: '' };
  }
  return {
    project: settings.general, method: 'General', confidence: conf,
    reason: (wanted ? '候補: ' + wanted + '（' + reason + '）' : reason),
    newProject: hit || !wanted ? '' : text_(clip_(wanted, 60)),
  };
}

// ---------- 小物 ----------

function prop_(key) {
  const v = PropertiesService.getScriptProperties().getProperty(key);
  if (!v) throw new Error('スクリプト プロパティ「' + key + '」が未設定です。');
  return v;
}

function clip_(s, n) {
  s = String(s === undefined || s === null ? '' : s);
  return s.length > n ? s.slice(0, n) : s;
}

/** = + - @ で始まる文字列は数式にされないよう ' を付ける。 */
function text_(s) {
  s = String(s || '');
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** yyyy-MM-dd または yyyy-MM-dd HH:mm だけを通す。 */
function dateText_(v) {
  const m = String(v || '').match(/(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (!m) return '';
  const p = function (x) { return ('0' + x).slice(-2); };
  return m[1] + '-' + p(m[2]) + '-' + p(m[3]) + (m[4] ? ' ' + p(m[4]) + ':' + m[5] : '');
}

function safeGmailUrl_(url) {
  const s = String(url || '');
  return s.indexOf('https://mail.google.com/') === 0 ? clip_(s, 500) : '';
}

function now_() {
  return Utilities.formatDate(new Date(), 'Asia/Tokyo', 'yyyy-MM-dd HH:mm');
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

/** 【手動で実行】合言葉を作り、ログに出す（Studio の Webhook URL の ?key= に使う）。 */
function setupIntakeToken() {
  const token = Utilities.getUuid().replace(/-/g, '') + Utilities.getUuid().replace(/-/g, '');
  PropertiesService.getScriptProperties().setProperty('INTAKE_TOKEN', token);
  Logger.log('INTAKE_TOKEN を設定しました。Studio の Webhook URL の末尾に ?key=（この値）を付けてください:\n' + token);
}

/** 【手動で実行】受付口の動作確認。テスト行を1件追記する（確認後に却下してください）。 */
function testIntake() {
  const res = handleIntake_({
    parameter: { key: prop_('INTAKE_TOKEN') },
    postData: { contents: '```json\n' + JSON.stringify({
      is_task: true, sender: 'テスト <test@example.com>', subject: '【テスト】Studio 受付口の確認',
      message_id: 'studio-test-' + Date.now(),
      tasks: [{ task_name: '受付口の動作を確認する', due: '2026-12-01', project: '', confidence: 0.5,
        reason: '動作確認', summary: 'Studio 受付口のテストです。カードが届いたら却下してください。' }],
    }) + '\n```' },
  });
  Logger.log(JSON.stringify(res));
}
