/**
 * ② 組織 → メイン：組織の予定をメインに写す。
 * タイトルは整形し、接頭辞（TU など）と色をつける。本文はコピーせず、元の予定へのリンクだけ残す。
 */

function syncMirror_(ctx, org, mainEvents, orgEvents) {
  // あるべき姿
  const desired = {};
  orgEvents.forEach(function (e) {
    const r = range_(e);
    const skip = mirrorSkipReason_(e) || noMirrorReason_(e, org, ctx);
    if (skip) {
      if (!kindOf_(e) && e.eventType !== 'outOfOffice') ctx.preview(org.code + '→メイン', '対象外', r, e.summary, skip, '');
      return;
    }
    const t = cleanTitle_(e, org, ctx);
    const body = {
      summary: org.prefix + t.title,
      start: e.start.date ? { date: e.start.date } : dt_(r.start),
      end: e.end.date ? { date: e.end.date } : dt_(r.end),
      location: t.location,
      colorId: org.colorId || undefined,
      visibility: 'private',
      transparency: 'opaque',
      description: mirrorDescription_(e, org, t.notes),
      extendedProperties: { private: { calSync: KIND.MIRROR, calSyncOrg: org.code, calSyncSrc: e.id } },
    };
    desired[e.id] = { src: e, body: body, range: r };
    ctx.preview(org.code + '→メイン', '写す', r, e.summary, t.location ? '場所: ' + t.location : '', body.summary);
  });

  // メイン側の現状
  const linked = {};
  const candidates = []; // 紐付け候補: 同じ組織の手入力予定
  mainEvents.forEach(function (e) {
    const p = privProps_(e);
    if (p[PROP.ORG] === org.code && (p[PROP.KIND] === KIND.MIRROR || p[PROP.KIND] === KIND.LINKED)) {
      linked[p[PROP.SRC]] = e;
    } else if (!p[PROP.KIND] && orgOfMainEvent_(e, ctx.orgs) === org.code) {
      candidates.push(e);
    }
  });

  Object.keys(desired).forEach(function (srcId) {
    const d = desired[srcId];
    const cur = linked[srcId];
    if (cur) {
      delete linked[srcId];
      const isLinked = privProps_(cur)[PROP.KIND] === KIND.LINKED;
      const diff = mirrorDiff_(cur, d.body, isLinked);
      if (diff) {
        ctx.op(org.code + '→メイン', '更新', org.code, whenText_(d.range), cur.summary, diff.note);
        ctx.writer.patch(ctx.settings.mainCalendarId, cur.id, diff.patch);
      }
      return;
    }
    // 初回移行: 同じ時間の手入力予定（TU ○○）があれば、作らずに紐付ける
    const same = candidates.filter(function (c) {
      const r = range_(c);
      return r.start.getTime() === d.range.start.getTime() && r.end.getTime() === d.range.end.getTime();
    })[0];
    if (same) {
      candidates.splice(candidates.indexOf(same), 1);
      ctx.op(org.code + '→メイン', '紐付け', org.code, whenText_(d.range), same.summary,
        '手入力の予定をそのまま使う（タイトルは変えない）');
      ctx.writer.patch(ctx.settings.mainCalendarId, same.id, {
        extendedProperties: { private: { calSync: KIND.LINKED, calSyncOrg: org.code, calSyncSrc: srcId } },
      });
      return;
    }
    ctx.op(org.code + '→メイン', '作成', org.code, whenText_(d.range), d.body.summary, d.src.summary);
    ctx.writer.insert(ctx.settings.mainCalendarId, d.body);
  });

  // 元の予定が無くなったもの
  Object.keys(linked).forEach(function (srcId) {
    const e = linked[srcId];
    const r = range_(e);
    if (privProps_(e)[PROP.KIND] === KIND.LINKED) {
      // 手入力の予定は消さない
      ctx.op(org.code + '→メイン', '要確認', org.code, whenText_(r), e.summary,
        org.code + ' 側の元の予定が見つかりません（手入力の予定なので削除していません）');
      return;
    }
    ctx.op(org.code + '→メイン', '削除', org.code, whenText_(r), e.summary, '元の予定が取り消し・変更');
    ctx.writer.remove(ctx.settings.mainCalendarId, e.id);
  });
}

/** 組織の予定をメインに写さない理由。写すなら ''。 */
function mirrorSkipReason_(e) {
  if (kindOf_(e)) return 'このスクリプトが作った予定';
  if (e.eventType && e.eventType !== 'default') return '不在など（' + e.eventType + '）';
  if (e.transparency === 'transparent') return '「空き時間」の予定';
  const res = myResponse_(e);
  if (res === 'declined') return '欠席と回答済み';
  if (res === 'needsAction') return '未回答';
  return '';
}

/** タイトル整形で「写さない」にしたパターン（【スキップ】【中止】など）に当たるか。 */
function noMirrorReason_(e, org, ctx) {
  const title = String(e.summary || '');
  const hit = ctx.titleRules.filter(function (r) {
    if (r.target !== '写さない' || (r.org && r.org !== org.code)) return false;
    r.pattern.lastIndex = 0;
    return r.pattern.test(title);
  })[0];
  return hit ? '写さない: ' + hit.pattern.source : '';
}

/** タイトル整形ルールを順に当てる。「場所へ」「説明へ」は消した文字を場所・説明に回す。 */
function cleanTitle_(e, org, ctx) {
  let title = String(e.summary || '');
  let location = String(e.location || '').trim();
  const notes = [];
  ctx.titleRules.forEach(function (r) {
    if (r.target === '写さない' || (r.org && r.org !== org.code)) return;
    r.pattern.lastIndex = 0;
    if (!r.pattern.test(title)) return;
    r.pattern.lastIndex = 0;
    if (r.target === '場所へ' || r.target === '説明へ') {
      title.replace(r.pattern, function () {
        const m = arguments;
        const text = String(m[1] !== undefined && typeof m[1] === 'string' ? m[1] : m[0]).trim();
        if (r.target === '場所へ' && !location) location = text;
        if (r.target === '説明へ') notes.push(text);
        return '';
      });
      r.pattern.lastIndex = 0;
    }
    title = title.replace(r.pattern, r.replacement);
  });
  title = title.replace(/\s{2,}/g, ' ').trim();
  if (title.length > ctx.settings.maxTitle) {
    const cut = title.split(/[（(【\[]/)[0].trim();
    if (cut) title = cut;
  }
  return { title: title || String(e.summary || '').trim(), location: location, notes: notes };
}

function mirrorDescription_(e, org, notes) {
  const lines = [org.name + ' のカレンダーから自動で写した予定です。'];
  if (notes.length) lines.push('メモ: ' + notes.join(' / '));
  const url = conferenceUrl_(e);
  if (url) lines.push('会議 URL: ' + url);
  if (e.htmlLink) lines.push('元の予定: ' + e.htmlLink);
  return lines.join('\n');
}

/** 会議 URL（Meet / Teams / Zoom）。本文はコピーしないので URL だけ拾う。 */
function conferenceUrl_(e) {
  if (e.hangoutLink) return e.hangoutLink;
  const ep = e.conferenceData && (e.conferenceData.entryPoints || []).filter(function (p) { return p.entryPointType === 'video'; })[0];
  if (ep) return ep.uri;
  const m = String(e.description || '').match(/https:\/\/(meet\.google\.com\/[\w-]+|teams\.microsoft\.com\/\S+|[\w.]*zoom\.us\/\S+)/);
  return m ? m[0] : '';
}

/** 変わった項目だけの patch を返す。紐付けた手入力予定は時間だけ合わせる。 */
function mirrorDiff_(cur, body, timeOnly) {
  const patch = {};
  const notes = [];
  const same = function (a, b) { return JSON.stringify(a || null) === JSON.stringify(b || null); };
  const curRange = range_(cur);
  const newRange = body.start.date
    ? { start: dateAt_(body.start.date, '00:00'), end: dateAt_(body.end.date, '00:00') }
    : { start: new Date(body.start.dateTime), end: new Date(body.end.dateTime) };
  if (curRange.start.getTime() !== newRange.start.getTime() || curRange.end.getTime() !== newRange.end.getTime()
      || Boolean(cur.start.date) !== Boolean(body.start.date)) {
    patch.start = body.start;
    patch.end = body.end;
    notes.push('時間');
  }
  if (!timeOnly) {
    ['summary', 'location', 'colorId'].forEach(function (k) {
      if (!same(cur[k], body[k])) { patch[k] = body[k] || ''; notes.push(k); }
    });
    if (!same(cur.description, body.description)) patch.description = body.description;
  }
  if (!Object.keys(patch).length) return null;
  return { patch: patch, note: notes.length ? '変更: ' + notes.join(', ') : '説明を更新' };
}
