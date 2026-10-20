/**
 * Quire のセクションと依存関係。
 *
 *  - スナップショット: 有効なプロジェクトごとに、未完了のセクションとタスクを「Quireスナップショット」タブに写す。
 *    Claude はこのタブを見てセクションと依存関係を提案し、編集ページは選択肢に使う。
 *    毎時のトリガーで更新し、編集ページの「Quire から最新を読み込む」でもプロジェクト単位で更新できる。
 *  - 依存関係の書き方（登録ログの先行タスク・後続タスク列）:
 *      「#12 資料を作成する」… 登録先プロジェクトの既存タスク（番号は Quire の URL の末尾）
 *      「候補:ID」           … 登録ログの別の候補。両方が登録された時点でつなぐ
 *    複数は ; 区切り。番号はプロジェクトごとなので、登録先が判定と違うときは使わない。
 */

const SNAP_HEADERS = ['取得日時', 'プロジェクト', 'プロジェクトID', '種類', '番号', 'OID', '名前', '期日'];
const SNAP_KIND = { SECTION: 'セクション', TASK: 'タスク' };
const SNAP_MAX = 200;       // 1プロジェクトから読む件数の上限（セクション・タスクそれぞれ）
const MAX_DEPS = 5;         // 1タスクにつなぐ依存関係の上限（先行・後続それぞれ）

// ---------- スナップショット ----------

function snapshotSheet_() {
  const ss = spreadsheet_();
  let sh = ss.getSheetByName(SHEET.SNAPSHOT);
  if (!sh) {
    sh = ss.insertSheet(SHEET.SNAPSHOT);
    sh.getRange(1, 1, 1, SNAP_HEADERS.length).setValues([SNAP_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** 【トリガー・手動で実行】有効なプロジェクトすべてのセクションと未完了タスクを読み直す。 */
function refreshQuireSnapshot() {
  const old = readSnapshotRows_();
  const rows = [];
  const stamp = now_();
  getProjects_(true).forEach(function (project) {
    try {
      rows.push.apply(rows, snapshotRows_(project, fetchProjectStructure_(project), stamp));
    } catch (e) {
      // 読めなかったプロジェクトは前回の内容を残す
      Logger.log('スナップショット取得に失敗: ' + project.name + ' ' + e.message);
      rows.push.apply(rows, old.filter(function (r) { return String(r[2]) === project.id; }));
    }
  });
  writeSnapshotRows_(rows);
  Logger.log('スナップショットを更新しました: ' + rows.length + ' 行');
}

/** 1プロジェクトだけ読み直してシートに反映する。戻り値は fetchProjectStructure_ と同じ形。 */
function refreshProjectSnapshot_(project) {
  const structure = fetchProjectStructure_(project);
  const rows = readSnapshotRows_().filter(function (r) { return String(r[2]) !== project.id; });
  rows.push.apply(rows, snapshotRows_(project, structure, now_()));
  writeSnapshotRows_(rows);
  structure.fetchedAt = now_();
  return structure;
}

/** Quire からセクションと未完了タスクを読む。戻り値: { sections: [{id, oid, name}], tasks: [{id, oid, name, due}] } */
function fetchProjectStructure_(project) {
  const pick = function (t) {
    return { id: Number(t.id), oid: String(t.oid || ''), name: clip_(t.name || '', 200), due: dueText_(t.due) };
  };
  const valid = function (t) { return t.id > 0; };
  return {
    sections: searchActive_(project, 'section').map(pick).filter(valid),
    tasks: searchActive_(project, '!section').map(pick).filter(valid),
  };
}

/** 未完了タスクの検索。Quire の無料プランは1回 30 件までなので、断られたら 30 件で読み直す。 */
function searchActive_(project, type) {
  const path = function (limit) {
    return '/task/search/id/' + encodeURIComponent(project.id) + '?status=active&limit=' + limit
      + '&type=' + encodeURIComponent(type);
  };
  try {
    return quireFetch_('get', path(SNAP_MAX)) || [];
  } catch (e) {
    if (!/エラー 40[02]/.test(e.message)) throw e;
    return quireFetch_('get', path(30)) || [];
  }
}

function dueText_(due) {
  const s = String(due || '');
  if (!s) return '';
  if (/T/.test(s)) {
    const d = new Date(s);
    return isNaN(d) ? s.slice(0, 10) : Utilities.formatDate(d, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return s.slice(0, 10);
}

function snapshotRows_(project, structure, stamp) {
  const row = function (kind, t) {
    return [stamp, sheetText_(project.name), sheetText_(project.id), kind, t.id, sheetText_(t.oid), sheetText_(t.name), t.due];
  };
  return structure.sections.map(function (t) { return row(SNAP_KIND.SECTION, t); })
    .concat(structure.tasks.map(function (t) { return row(SNAP_KIND.TASK, t); }));
}

function readSnapshotRows_() {
  const sh = snapshotSheet_();
  const last = sh.getLastRow();
  if (last < 2) return [];
  return sh.getRange(2, 1, last - 1, SNAP_HEADERS.length).getValues()
    .filter(function (r) { return r[2] !== ''; });
}

function writeSnapshotRows_(rows) {
  const sh = snapshotSheet_();
  const last = sh.getLastRow();
  if (last >= 2) sh.getRange(2, 1, last - 1, SNAP_HEADERS.length).clearContent();
  if (rows.length) sh.getRange(2, 1, rows.length, SNAP_HEADERS.length).setValues(rows);
}

/** シートに書く外部由来の文字列。= + - @ で始まると数式として扱われるので、先頭に ' を付ける。 */
function sheetText_(value) {
  const s = String(value === undefined || value === null ? '' : value);
  return /^[=+\-@]/.test(s) ? "'" + s : s;
}

/** スナップショットをプロジェクトID ごとにまとめる。{ id: { fetchedAt, sections: [...], tasks: [...] } } */
function getSnapshot_() {
  const map = {};
  readSnapshotRows_().forEach(function (r) {
    const pid = String(r[2]);
    const p = map[pid] || (map[pid] = { fetchedAt: '', sections: [], tasks: [] });
    const fetched = r[0] instanceof Date
      ? Utilities.formatDate(r[0], Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm') : String(r[0]);
    if (!p.fetchedAt || fetched > p.fetchedAt) p.fetchedAt = fetched;
    const item = { id: Number(r[4]), oid: String(r[5]), name: String(r[6]), due: r[7] instanceof Date
      ? Utilities.formatDate(r[7], Session.getScriptTimeZone(), 'yyyy-MM-dd') : String(r[7] || '') };
    (r[3] === SNAP_KIND.SECTION ? p.sections : p.tasks).push(item);
  });
  return map;
}

function projectSnapshot_(project, snapshot) {
  return (snapshot || getSnapshot_())[project.id] || { fetchedAt: '', sections: [], tasks: [] };
}

/** セクション名からセクションを探す。見つからなければ1回だけ Quire から読み直す。 */
function findSection_(project, name, snapshot) {
  const target = String(name || '').trim();
  if (!target) return null;
  const find = function (s) {
    return s.sections.filter(function (x) { return x.name === target; })[0] || null;
  };
  const hit = find(projectSnapshot_(project, snapshot));
  if (hit) return hit;
  try {
    return find(refreshProjectSnapshot_(project));
  } catch (e) {
    Logger.log('セクションの読み直しに失敗: ' + e.message);
    return null;
  }
}

// ---------- 依存関係の書き方 ----------

/** 「#12 名前; 候補:ID」を [{ type: 'task', id: 12 } | { type: 'cand', id: 'ID' }] にする。読めない部分は無視。 */
function parseRefs_(text) {
  const out = [];
  const seen = {};
  String(text || '').split(/[;；\n]/).forEach(function (part) {
    let ref = null;
    let m = part.match(/候補\s*[:：]\s*([A-Za-z0-9_\-]{1,120})/);
    if (m) ref = { type: 'cand', id: m[1] };
    else if ((m = part.match(/#\s*(\d{1,9})/))) ref = { type: 'task', id: Number(m[1]) };
    if (!ref) return;
    const key = ref.type + ':' + ref.id;
    if (seen[key]) return;
    seen[key] = true;
    out.push(ref);
  });
  return out;
}

/** 参照を、人が読める「#12 名前」「候補:ID」の形にする。 */
function refsText_(refs, project, snapshot) {
  const snap = project ? projectSnapshot_(project, snapshot) : { tasks: [] };
  return refs.map(function (r) {
    if (r.type === 'cand') return '候補:' + r.id;
    const t = snap.tasks.filter(function (x) { return x.id === r.id; })[0];
    return '#' + r.id + (t ? ' ' + clip_(t.name, 60) : '');
  }).join('; ');
}

/** カードや画面に出す説明。候補は登録ログのタスク名を添える。 */
function refsLabel_(text, entries) {
  return parseRefs_(text).map(function (r) {
    if (r.type === 'task') {
      const m = String(text).match(new RegExp('#\\s*' + r.id + '\\s*([^;；\\n]*)'));
      return '#' + r.id + (m && m[1].trim() ? ' ' + clip_(m[1].trim(), 60) : '');
    }
    const e = (entries || []).filter(function (x) { return String(x.messageId) === r.id; })[0];
    return '候補 ' + (e ? clip_(e.taskName || e.subject, 60) : r.id);
  }).join(' / ');
}

function candIds_(refs) {
  return refs.filter(function (r) { return r.type === 'cand'; }).map(function (r) { return r.id; });
}

// ---------- 登録後に依存関係をつなぐ ----------

/**
 * 登録したタスクに依存関係をつなぐ。
 *  preds: このタスクより前に終わらせるもの（相手 → このタスク）
 *  succs: このタスクのあとに続くもの（このタスク → 相手）
 * Quire では「相手の後続（successors）にこのタスクを足す」形でつなぐ。
 * 戻り値: 結果のメモ（文字列の配列）
 */
function linkDependencies_(selfId, task, project, preds, succs, entries) {
  const notes = [];
  const link = function (fromOid, fromIdPath, toOid, label) {
    try {
      if (fromOid) quireFetch_('put', '/task/' + encodeURIComponent(fromOid), { addSuccessors: [toOid] });
      else quireFetch_('put', fromIdPath, { addSuccessors: [toOid] });
      notes.push(label + ' ✓');
      return true;
    } catch (e) {
      notes.push(label + ' ✗ ' + clip_(e.message, 80));
      return false;
    }
  };
  const resolveCand = function (id) {
    if (id === String(selfId)) return { skip: '自分自身' };
    const e = entries.filter(function (x) { return String(x.messageId) === id; })[0];
    if (!e) return { skip: '登録ログに無い' };
    if (e.status !== STATUS.DONE || !e.taskOid) return { skip: '未登録（登録されたらつなぐ）' };
    if (String(e.currentProject) !== project.name) return { skip: '別プロジェクトのためつながない' };
    return { oid: String(e.taskOid), entry: e };
  };
  // 相手の行のメモにも、つないだことを残す
  const noteOther = function (c) {
    updateLog_(c.entry.row, { depNote: clip_([String(c.entry.depNote || ''), '候補:' + selfId + ' とつなぎました ✓']
      .filter(String).join(' / '), 500) });
  };
  const pidPath = function (n) {
    return '/task/id/' + encodeURIComponent(project.id) + '/' + n;
  };

  preds.forEach(function (r) {
    const label = '先行 ' + (r.type === 'task' ? '#' + r.id : '候補:' + r.id);
    if (r.type === 'task') return link('', pidPath(r.id), task.oid, label);
    const c = resolveCand(r.id);
    if (c.skip) return notes.push(label + ' … ' + c.skip);
    if (link(c.oid, '', task.oid, label)) noteOther(c);
  });
  succs.forEach(function (r) {
    const label = '後続 ' + (r.type === 'task' ? '#' + r.id : '候補:' + r.id);
    if (r.type === 'task') return link(task.oid, '', '#' + r.id, label);
    const c = resolveCand(r.id);
    if (c.skip) return notes.push(label + ' … ' + c.skip);
    if (link(task.oid, '', c.oid, label)) noteOther(c);
  });
  return notes;
}

/**
 * ほかの登録済みの候補が「候補:selfId」を参照して待っていれば、いまつなぐ。
 * exclude は同時に登録した候補の ID（自分で先につないだので除く）。
 */
function linkWaiting_(selfId, task, project, entries, exclude) {
  entries.forEach(function (e) {
    const id = String(e.messageId);
    if (id === String(selfId) || (exclude && exclude.indexOf(id) >= 0)) return;
    if (e.status !== STATUS.DONE || !e.taskOid || String(e.currentProject) !== project.name) return;
    const waitsForMe = parseRefs_(e.predecessors).some(function (r) { return r.type === 'cand' && r.id === String(selfId); });
    const followsMe = parseRefs_(e.successors).some(function (r) { return r.type === 'cand' && r.id === String(selfId); });
    if (!waitsForMe && !followsMe) return;
    const notes = [];
    try {
      // e が自分を先行に指定 → 自分の後続に e。e が自分を後続に指定 → e の後続に自分
      if (waitsForMe) quireFetch_('put', '/task/' + encodeURIComponent(task.oid), { addSuccessors: [String(e.taskOid)] });
      if (followsMe) quireFetch_('put', '/task/' + encodeURIComponent(String(e.taskOid)), { addSuccessors: [task.oid] });
      notes.push('候補:' + selfId + ' とつなぎました ✓');
    } catch (err) {
      notes.push('候補:' + selfId + ' とつなげませんでした ✗ ' + clip_(err.message, 80));
    }
    updateLog_(e.row, { depNote: clip_([String(e.depNote || ''), notes.join(' / ')].filter(String).join(' / '), 500) });
  });
}
