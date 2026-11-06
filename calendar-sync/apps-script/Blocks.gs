/**
 * ① メイン → 組織：不在ブロック。
 * 毎回「あるべきブロック一式」を計算し、スクリプトが作ったブロックとの差分だけを書き込む。
 * 手作業で入れた不在予定には触れない。
 */

function syncBlocks_(ctx, org, mainEvents, orgEvents) {
  // 組織側の「実際の予定」（余白を削る相手）と、手作業の不在
  const busy = [];
  const manualOoo = [];
  orgEvents.forEach(function (e) {
    if (kindOf_(e)) return;
    const r = range_(e);
    if (e.eventType === 'outOfOffice') { manualOoo.push(r); return; }
    if (isRealOrgEvent_(e) && !noMirrorReason_(e, org, ctx) && !r.allDay) busy.push(r);
  });

  // 1. 予定ごとにブロックの候補を作る
  const pieces = [];
  mainEvents.forEach(function (e) {
    const title = String(e.summary || '');
    const r = range_(e);
    const skip = mainSkipReason_(e, org, ctx);
    if (skip) { ctx.preview('メイン→' + org.code, '対象外', r, title, skip, ''); return; }

    const rule = classify_(title, org.code, ctx.rules);
    if (rule.category === EXCLUDE) {
      ctx.preview('メイン→' + org.code, '対象外', r, title, '分類ルール: ' + rule.patterns.join(' '), '');
      return;
    }
    const long = r.allDay || (r.end - r.start) >= LONG_EVENT_HOURS * 3600000;
    if (long && rule.isDefault) {
      ctx.preview('メイン→' + org.code, '対象外', r, title, '終日・長時間で分類キーワードなし', '');
      return;
    }

    let made;
    if (long) {
      made = workdaySpans_(org, r.start, r.end, true);
    } else {
      const s = trimBefore_(r.start, rule.before, busy);
      const t = trimAfter_(r.end, rule.after, busy);
      made = workdaySpans_(org, s, t, false);
    }
    made.forEach(function (p) {
      p.label = rule.label || DEFAULT_RULE.label;
      p.priority = rule.priority;
      pieces.push(p);
    });
    ctx.preview('メイン→' + org.code, rule.category, r, title,
      long ? '終日扱い（' + org.dayStart + '–' + org.dayEnd + '）' : '前' + rule.before + '分/後' + rule.after + '分',
      made.map(function (p) { return whenText_(p); }).join(', ') || '勤務時間外');
  });

  // 2. 近いものを結合し、手作業の不在で覆われているものは除く
  const desired = mergePieces_(pieces, ctx.settings.mergeGapMin).filter(function (b) {
    return !manualOoo.some(function (m) { return m.start <= b.start && m.end >= b.end; });
  });

  // 3. 既存のブロックと突き合わせる
  const existing = orgEvents.filter(function (e) {
    return kindOf_(e) === KIND.BLOCK && privProps_(e)[PROP.ORG] === org.code;
  });
  const keyOf = function (s, t, label) { return s.getTime() + '|' + t.getTime() + '|' + label; };
  const existingByKey = {};
  existing.forEach(function (e) {
    const r = range_(e);
    existingByKey[keyOf(r.start, r.end, e.summary)] = e;
  });
  const leftovers = existing.slice();
  const toCreate = [];
  desired.forEach(function (b) {
    const hit = existingByKey[keyOf(b.start, b.end, b.label)];
    if (hit) {
      leftovers.splice(leftovers.indexOf(hit), 1);
      delete existingByKey[keyOf(b.start, b.end, b.label)];
    } else {
      toCreate.push(b);
    }
  });

  toCreate.forEach(function (b) {
    // 余った既存ブロックがあれば作り直さずに時間とタイトルを直す
    const reuse = leftovers.shift();
    if (reuse) {
      ctx.op('メイン→' + org.code, '更新', org.code, fmtRange_(b.start, b.end), b.label,
        '元: ' + reuse.summary + ' ' + fmtRange_(range_(reuse).start, range_(reuse).end));
      ctx.writer.patch(org.calendarId, reuse.id, { summary: b.label, start: dt_(b.start), end: dt_(b.end) });
    } else {
      ctx.op('メイン→' + org.code, '作成', org.code, fmtRange_(b.start, b.end), b.label, '');
      insertBlock_(ctx, org, b);
    }
  });
  leftovers.forEach(function (e) {
    const r = range_(e);
    ctx.op('メイン→' + org.code, '削除', org.code, fmtRange_(r.start, r.end), e.summary, '');
    ctx.writer.remove(org.calendarId, e.id);
  });
}

/** メインの予定を組織 org へのブロック対象から外す理由。対象なら ''。 */
function mainSkipReason_(e, org, ctx) {
  if (e.eventType && e.eventType !== 'default') return '予定の種類: ' + e.eventType;
  // 「空き時間」の設定は見ない（終日予定は既定で空き時間になるため）。分類ルールで判断する
  // 他の人からの招待は「承諾」したものだけ（社外コミュニティなどの参加未定・辞退はブロックしない）
  const res = myResponse_(e);
  if (res === 'declined') return '欠席と回答済み';
  if (res === 'needsAction') return '招待に未回答（参加未定）';
  if (res === 'tentative') return '招待に「未定」と回答';
  const owner = orgOfMainEvent_(e, ctx.orgs);
  if (owner === org.code) return org.code + ' の予定（接頭辞・色・同期元）';
  return '';
}

/** 組織側の予定のうち、自分が出る「実際の予定」か（不在・未回答・欠席・空き時間は除く）。 */
function isRealOrgEvent_(e) {
  if (e.eventType && e.eventType !== 'default') return false;
  if (kindOf_(e)) return false;
  if (e.transparency === 'transparent') return false;
  const res = myResponse_(e);
  return res !== 'declined' && res !== 'needsAction';
}

/** 開始前の余白。組織側の予定と重なる部分は削る（＝空いているところから）。 */
function trimBefore_(start, minutes, busy) {
  let s = new Date(start.getTime() - minutes * 60000);
  busy.forEach(function (b) {
    if (b.end > s && b.start < start) s = new Date(Math.min(start.getTime(), Math.max(s.getTime(), b.end.getTime())));
  });
  return s;
}

/** 終了後の余白。組織側の予定と重なる部分は削る。 */
function trimAfter_(end, minutes, busy) {
  let t = new Date(end.getTime() + minutes * 60000);
  busy.forEach(function (b) {
    if (b.start < t && b.end > end) t = new Date(Math.max(end.getTime(), Math.min(t.getTime(), b.start.getTime())));
  });
  return t;
}

/** [s, t) を日ごとに分け、組織の勤務曜日・勤務時間に切り詰める。fullDay なら各日の勤務時間すべて。 */
function workdaySpans_(org, s, t, fullDay) {
  const out = [];
  let day = dateAt_(ymd_(s), '00:00');
  while (day < t) {
    const ymd = ymd_(day);
    const dow = Number(Utilities.formatDate(day, TZ, 'u')) % 7; // 1=月 … 7=日 → 0=日
    if (org.workdays.indexOf(dow) >= 0) {
      const ws = dateAt_(ymd, org.dayStart);
      const we = dateAt_(ymd, org.dayEnd);
      const a = fullDay ? ws : new Date(Math.max(ws.getTime(), s.getTime()));
      const b = fullDay ? we : new Date(Math.min(we.getTime(), t.getTime()));
      if (b > a) out.push({ start: a, end: b });
    }
    day = new Date(day.getTime() + 24 * 3600000);
  }
  return out;
}

/** 同じ日で重なる・隙間が gapMin 分以内のブロックを1つにまとめる。タイトルは優先度の高い方。 */
function mergePieces_(pieces, gapMin) {
  const sorted = pieces.slice().sort(function (a, b) { return a.start - b.start; });
  const out = [];
  sorted.forEach(function (p) {
    const last = out[out.length - 1];
    if (last && ymd_(last.start) === ymd_(p.start) && p.start.getTime() - last.end.getTime() <= gapMin * 60000) {
      if (p.end > last.end) last.end = p.end;
      if (p.priority > last.priority) { last.priority = p.priority; last.label = p.label; }
    } else {
      out.push({ start: p.start, end: p.end, label: p.label, priority: p.priority });
    }
  });
  return out;
}

/** 不在予定として作る。不在が作れない場合は「予定あり」の通常予定で代用する。 */
function insertBlock_(ctx, org, b) {
  const base = {
    summary: b.label,
    start: dt_(b.start),
    end: dt_(b.end),
    transparency: 'opaque',
    extendedProperties: { private: { calSync: KIND.BLOCK, calSyncOrg: org.code } },
  };
  if (org.blockType === '不在' && !ctx.oooUnavailable[org.code]) {
    try {
      return ctx.writer.insert(org.calendarId, Object.assign({}, base, {
        eventType: 'outOfOffice',
        outOfOfficeProperties: { autoDeclineMode: 'declineNone' },
      }));
    } catch (err) {
      ctx.oooUnavailable[org.code] = true;
      ctx.op('メイン→' + org.code, '注意', org.code, '', '',
        '不在予定を作れなかったため通常の予定で作成します: ' + err.message);
    }
  }
  return ctx.writer.insert(org.calendarId, base);
}
