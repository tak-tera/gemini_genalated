/** Calendar API（高度なサービス）の薄いラッパー。書き込みは Context の dry-run を通す。 */

function listEvents_(calendarId, timeMin, timeMax) {
  const items = [];
  let pageToken;
  do {
    const res = Calendar.Events.list(calendarId, {
      timeMin: timeMin.toISOString(),
      timeMax: timeMax.toISOString(),
      singleEvents: true,
      showDeleted: false,
      maxResults: 2500,
      eventTypes: ['default', 'outOfOffice'],
      pageToken: pageToken,
    });
    (res.items || []).forEach(function (e) { items.push(e); });
    pageToken = res.nextPageToken;
  } while (pageToken);
  return items.filter(function (e) { return e.status !== 'cancelled'; });
}

function privProps_(e) {
  return (e.extendedProperties && e.extendedProperties.private) || {};
}

function kindOf_(e) {
  return privProps_(e)[PROP.KIND] || '';
}

/** 予定の開始・終了を Date で返す。終日予定は 00:00 起点。 */
function range_(e) {
  if (e.start.date) {
    return { start: dateAt_(e.start.date, '00:00'), end: dateAt_(e.end.date, '00:00'), allDay: true };
  }
  return { start: new Date(e.start.dateTime), end: new Date(e.end.dateTime), allDay: false };
}

function dateAt_(ymd, hm) {
  return new Date(ymd + 'T' + hm + ':00+09:00');
}

function ymd_(d) {
  return Utilities.formatDate(d, TZ, 'yyyy-MM-dd');
}

function fmt_(d) {
  return Utilities.formatDate(d, TZ, 'M/d(E) HH:mm');
}

function fmtRange_(s, e) {
  return fmt_(s) + '–' + Utilities.formatDate(e, TZ, 'HH:mm');
}

/** 予定日時の表示。終日予定は「11/6(金) 終日」。 */
function whenText_(r) {
  if (!r.allDay) return fmtRange_(r.start, r.end);
  const last = new Date(r.end.getTime() - 24 * 3600000);
  const d = function (x) { return Utilities.formatDate(x, TZ, 'M/d(E)'); };
  return d(r.start) + (ymd_(last) === ymd_(r.start) ? '' : '–' + d(last)) + ' 終日';
}

/** 自分の出欠。attendees が無い予定（Garoon からの同期など）は '' を返す。 */
function myResponse_(e) {
  const me = (e.attendees || []).filter(function (a) { return a.self; })[0];
  return me ? me.responseStatus : '';
}

function dt_(d) {
  return { dateTime: Utilities.formatDate(d, TZ, "yyyy-MM-dd'T'HH:mm:ssXXX"), timeZone: TZ };
}

/** 書き込みをまとめて扱う。live が false のときは何も書かずに記録だけ残す。 */
function Writer_(ctx) {
  return {
    insert: function (calendarId, body) {
      if (!ctx.live) return null;
      Utilities.sleep(150);
      return Calendar.Events.insert(body, calendarId);
    },
    patch: function (calendarId, eventId, body) {
      if (!ctx.live) return null;
      Utilities.sleep(150);
      return Calendar.Events.patch(body, calendarId, eventId);
    },
    remove: function (calendarId, eventId) {
      if (!ctx.live) return;
      Utilities.sleep(150);
      Calendar.Events.remove(calendarId, eventId);
    },
  };
}
