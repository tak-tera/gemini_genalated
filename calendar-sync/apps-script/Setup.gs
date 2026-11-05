/** 初期設定と動作確認用の関数。Apps Script エディタから手動で実行する。 */

/** 【手動で実行】スプレッドシートに必要なタブを作り、初期値を入れる（既にあるタブは触らない）。 */
function setupSheets() {
  const ss = spreadsheet_();
  const made = [];
  const ensure = function (name, header, rows, textCols) {
    if (ss.getSheetByName(name)) return;
    const sh = ss.insertSheet(name);
    if (textCols) textCols.forEach(function (c) { sh.getRange(1, c, 200, 1).setNumberFormat('@'); });
    sh.getRange(1, 1, 1, header.length).setValues([header]).setFontWeight('bold').setBackground('#e8eaed');
    if (rows.length) sh.getRange(2, 1, rows.length, header.length).setValues(rows);
    sh.setFrozenRows(1);
    made.push(name);
  };

  ensure(SHEET.SETTINGS, ['項目', '値', '説明'], [
    ['書き込みモード', 'お試し', '「本番」にするとトリガーでカレンダーを書き換える。お試し中は previewSync で結果を見るだけ'],
    ['対象期間（日）', 90, '今日から何日先までを同期するか'],
    ['メインカレンダーID', 'primary', 'primary＝スクリプトを動かすアカウントのメインカレンダー'],
    ['結合する隙間（分）', 30, '同じ日のブロックの間がこれ以下なら1つにまとめる'],
    ['タイトルの最大文字数', 30, 'これを超えるタイトルは最初のカッコより前だけにする'],
  ]);

  ensure(SHEET.ORGS,
    ['有効', '組織コード', '表示名', 'カレンダーID', 'メインでの接頭辞', '色番号(colorId)', 'ブロック開始', 'ブロック終了',
      'ブロックする曜日', 'ブロック形式', '組織→メインに写す', 'メイン→組織にブロック'],
    [[true, 'TU', '東北大学（TU）', 'takeshi.terao.c4@tohoku.ac.jp', 'TU ', '1', '8:00', '18:00',
      '月火水木金', '不在', true, true]],
    [5, 6, 7, 8]);

  // 上から順に判定し、最初に当たったものを使う（打ち合わせ系を研修系より先に置く）
  ensure(SHEET.RULES,
    ['有効', '順番', '組織コード（空欄＝全組織）', '分類', 'キーワード（; 区切り、/…/ は正規表現）', 'ブロックのタイトル',
      '前の余白（分）', '後の余白（分）', '結合時の優先度'],
    [
      [true, 10, '', EXCLUDE, '近鉄;新幹線;ひのとり;のぞみ;ひかり;こだま;はやぶさ;やまびこ;特急;フライト;ANA;JAL;/→/;/\\s~\\s/', '', 0, 0, 0],
      [true, 20, '', EXCLUDE, 'ホテル;HOTEL;フレッサイン;宿泊;チェックイン', '', 0, 0, 0],
      [true, 25, '', EXCLUDE, '締切;締め切り;〆切;期限;リマインド;調整中;未定;申し込み未;申込未;未申込', '', 0, 0, 0],
      [true, 30, '', '打ち合わせ', '打ち合わせ;打ち合せ;打合せ;打合;定例;会議;委員会;ミーティング;MTG;/\\bMT\\b/;ディスカッション;来訪;面談;相談;ヒアリング', '（打ち合わせ）', 60, 60, 2],
      [true, 40, '', '研修講演', '研修;講演;登壇;講義;授業;セミナー;ゼミナール;ワークショップ;研究会;シンポジウム;フォーラム;記念事業', '（研修講演）', 120, 60, 3],
    ]);

  ensure(SHEET.TITLES,
    ['有効', '順番', '組織コード（空欄＝全組織）', 'パターン（正規表現）', '置き換え後', '消した文字の行き先（削除／場所へ／説明へ／写さない）'],
    [
      [true, 5, '', '【(?:スキップ|中止|休会|キャンセル)】', '', '写さない'],
      [true, 6, '', '申し込み未|申込未|未申込', '', '写さない'],
      [true, 10, 'TU', '^\\s*Sync:\\s*', '', '削除'],
      [true, 20, 'TU', '(?:ハイブリッド|オンライン|対面|Web|WEB)\\s*[:：]\\s*', '', '削除'],
      [true, 25, 'TU', '^(\\d{1,2}:\\d{2})_', '', '説明へ'],
      [true, 30, 'TU', '_([^_]+)$', '', '場所へ'],
      [true, 40, 'TU', '[（(]ミラー[）)]', '', '説明へ'],
      [true, 50, '', '打ち?合わ?せ?', '打ち合わせ', '削除'],
      [true, 60, '', '　', '', '削除'],
    ],
    [4, 5]);

  ensure(SHEET.LOG, ['日時', 'モード', '方向', '組織', '操作', '予定日時', 'タイトル', 'メモ'], []);
  Logger.log(made.length ? '作成したタブ: ' + made.join(', ') : 'タブはすべて作成済みです。');
}

/** 【手動で実行】トリガーを登録する（何度実行しても重複しない）。 */
function installTriggers() {
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (t.getHandlerFunction() === 'syncAll') ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('syncAll').timeBased().everyMinutes(10).create();
  Logger.log('トリガーを登録しました（10分ごと）。書き込みモードが「本番」のときだけ書き換えます。');
}

/** 【手動で実行】設定と、各カレンダーへの権限を確認する。 */
function checkSetup() {
  const out = [];
  try {
    const s = getSettings_();
    out.push('OK   設定: 書き込みモード=' + (s.live ? '本番' : 'お試し') + ' / 対象 ' + s.days + ' 日');
    const main = Calendar.CalendarList.get(s.mainCalendarId);
    out.push('OK   メインカレンダー: ' + main.summary + '（権限 ' + main.accessRole + '）');
    getOrgs_().forEach(function (o) {
      try {
        const c = Calendar.CalendarList.get(o.calendarId);
        const ok = c.accessRole === 'owner' || c.accessRole === 'writer';
        out.push((ok ? 'OK   ' : 'NG   ') + o.code + ': ' + o.calendarId + '（権限 ' + c.accessRole + '）'
          + (ok ? '' : ' … 書き込み権限が必要です'));
      } catch (e) {
        out.push('NG   ' + o.code + ': ' + o.calendarId + ' を開けません（カレンダーリストに追加されているか確認）: ' + e.message);
      }
    });
    out.push('OK   分類ルール ' + getRules_().length + ' 件 / タイトル整形 ' + getTitleRules_().length + ' 件');
  } catch (e) {
    out.push('NG   ' + e.message);
  }
  Logger.log(out.join('\n'));
}

/**
 * 【手動で実行】組織カレンダーに「不在」予定を作れるか、目印（非公開プロパティ）を読み戻せるかを試す。
 * 明日の 7:00–7:30 に作ってすぐ消す。不在が作れなければ、組織タブの「ブロック形式」を「予定あり」にする。
 */
function testOutOfOffice() {
  const org = getOrgs_()[0];
  const day = ymd_(new Date(Date.now() + 24 * 3600000));
  let ev;
  try {
    ev = Calendar.Events.insert({
      summary: '（テスト）',
      eventType: 'outOfOffice',
      outOfOfficeProperties: { autoDeclineMode: 'declineNone' },
      start: dt_(dateAt_(day, '07:00')),
      end: dt_(dateAt_(day, '07:30')),
      transparency: 'opaque',
      extendedProperties: { private: { calSync: 'test', calSyncOrg: org.code } },
    }, org.calendarId);
  } catch (e) {
    Logger.log('NG: 不在予定を作れませんでした（' + e.message + '）。組織タブの「ブロック形式」を「予定あり」にしてください。');
    return;
  }
  try {
    const back = Calendar.Events.get(org.calendarId, ev.id);
    const ok = privProps_(back)[PROP.KIND] === 'test';
    Logger.log((ok ? 'OK: ' : 'NG: ') + org.code + ' に不在予定を作成できました。目印の読み戻し: ' + (ok ? 'OK' : 'できません（同期が正しく動きません）'));
  } finally {
    Calendar.Events.remove(org.calendarId, ev.id);
  }
}
