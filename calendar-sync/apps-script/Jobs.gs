/** 実行の入口。トリガーからは syncAll、お試しは previewSync を手動で実行する。 */

/** 【トリガー】10分ごと。書き込みモードが「本番」のときだけカレンダーを書き換える。 */
function syncAll() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(5000)) return;
  try {
    const ctx = buildContext_(false);
    if (!ctx.live) return; // お試し中はトリガーでは何もしない（previewSync で確認する）
    runSync_(ctx);
    writeLog_(ctx);
  } finally {
    lock.releaseLock();
  }
}

/** 【手動で実行】カレンダーには書き込まず、判定結果と予定している操作を「プレビュー」に書き出す。 */
function previewSync() {
  const ctx = buildContext_(true);
  runSync_(ctx);
  writePreview_(ctx);
  Logger.log('プレビューを書き出しました: 判定 ' + ctx.previewRows.length + ' 行 / 操作 ' + ctx.ops.length + ' 件');
}

function buildContext_(forcePreview) {
  const settings = getSettings_();
  const ctx = {
    settings: settings,
    live: settings.live && !forcePreview,
    orgs: getOrgs_(),
    rules: getRules_(),
    titleRules: getTitleRules_(),
    ops: [],
    previewRows: [],
    oooUnavailable: {},
    collectPreview: Boolean(forcePreview),
  };
  ctx.writer = Writer_(ctx);
  ctx.op = function (dir, action, org, when, title, note) {
    ctx.ops.push([new Date(), ctx.live ? '本番' : 'お試し', dir, org, action, when, title, note || '']);
  };
  ctx.preview = function (dir, category, r, title, note, result) {
    if (!ctx.collectPreview) return;
    const when = whenText_(r);
    ctx.previewRows.push([r.start, dir, when, String(title || ''), category, note || '', result || '']);
  };
  return ctx;
}

function runSync_(ctx) {
  const timeMin = dateAt_(ymd_(new Date()), '00:00');
  const timeMax = new Date(timeMin.getTime() + ctx.settings.days * 24 * 3600000);
  let mainEvents = listEvents_(ctx.settings.mainCalendarId, timeMin, timeMax);

  // 先に ②（組織→メイン）を行い、写した予定も ① の判定に含める（ほかの組織へのブロックになる）
  const orgEventsByCode = {};
  ctx.orgs.forEach(function (org) {
    orgEventsByCode[org.code] = listEvents_(org.calendarId, timeMin, timeMax);
  });
  ctx.orgs.forEach(function (org) {
    if (!org.mirror) return;
    try {
      syncMirror_(ctx, org, mainEvents, orgEventsByCode[org.code]);
    } catch (err) {
      ctx.op(org.code + '→メイン', 'エラー', org.code, '', '', err.message);
    }
  });
  if (ctx.live && ctx.ops.length) mainEvents = listEvents_(ctx.settings.mainCalendarId, timeMin, timeMax);

  ctx.orgs.forEach(function (org) {
    if (!org.block) return;
    try {
      syncBlocks_(ctx, org, mainEvents, orgEventsByCode[org.code]);
    } catch (err) {
      ctx.op('メイン→' + org.code, 'エラー', org.code, '', '', err.message);
    }
  });
}

function writeLog_(ctx) {
  if (!ctx.ops.length) return;
  const sh = sheet_(SHEET.LOG);
  sh.getRange(sh.getLastRow() + 1, 1, ctx.ops.length, ctx.ops[0].length).setValues(ctx.ops);
}

function writePreview_(ctx) {
  const ss = spreadsheet_();
  const sh = ss.getSheetByName(SHEET.PREVIEW) || ss.insertSheet(SHEET.PREVIEW);
  sh.clear();
  const rows = ctx.previewRows.sort(function (a, b) { return a[0] - b[0] || String(a[1]).localeCompare(String(b[1])); })
    .map(function (r) { return r.slice(1); });
  let row = 1;
  sh.getRange(row, 1).setValue('判定結果（' + Utilities.formatDate(new Date(), TZ, 'M/d HH:mm') + ' 時点・カレンダーへの書き込みなし）').setFontWeight('bold');
  row++;
  const head1 = ['方向', '予定日時', '元のタイトル', '分類', '判定の理由・余白', '結果（ブロック時間／写すタイトル）'];
  sh.getRange(row, 1, 1, head1.length).setValues([head1]).setFontWeight('bold').setBackground('#e8eaed');
  row++;
  if (rows.length) { sh.getRange(row, 1, rows.length, head1.length).setValues(rows); row += rows.length; }
  row++;
  sh.getRange(row, 1).setValue('本番にした場合の操作').setFontWeight('bold');
  row++;
  const head2 = ['方向', '組織', '操作', '日時', 'タイトル', 'メモ'];
  sh.getRange(row, 1, 1, head2.length).setValues([head2]).setFontWeight('bold').setBackground('#e8eaed');
  row++;
  const ops = ctx.ops.map(function (o) { return [o[2], o[3], o[4], o[5], o[6], o[7]]; });
  if (ops.length) sh.getRange(row, 1, ops.length, head2.length).setValues(ops);
  sh.autoResizeColumns(1, 6);
}
