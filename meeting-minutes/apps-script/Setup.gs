/** 初期設定と動作確認用の関数。Apps Script エディタから手動で実行する。 */

/** 【手動で実行】スプレッドシートのタブと作業フォルダを用意する（何度実行しても既存の内容は消さない）。 */
function setupSheets() {
  const ss = spreadsheet_();
  const ensure = function (name, headers, widths) {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    if (sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold');
      sh.setFrozenRows(1);
      (widths || []).forEach(function (w, i) { if (w) sh.setColumnWidth(i + 1, w); });
    }
    return sh;
  };

  const folders = ensure(SHEET.FOLDERS,
    ['有効', 'フォルダ名（メモ）', '監視フォルダ（URL か ID）', '追記先ドキュメント（URL か ID）', 'メモ文書（任意・URL か ID）', '備考'],
    [50, 180, 320, 320, 320, 200]);
  if (folders.getLastRow() === 1) {
    folders.getRange(2, 1).insertCheckboxes().setValue(false);
    folders.getRange(2, 2, 1, 5).setValues([['例: A社 定例', 'https://drive.google.com/drive/folders/…', 'https://docs.google.com/document/d/…/edit', '', 'メモ文書が空欄なら追記先ドキュメントをメモとして読む']]);
  }

  const settings = ensure(SHEET.SETTINGS, ['項目', '値', '説明'], [220, 260, 520]);
  if (settings.getLastRow() === 1) {
    settings.getRange(2, 1, DEFAULT_SETTINGS.length, 3).setValues(DEFAULT_SETTINGS);
  }
  const values = settings.getDataRange().getValues();
  values.forEach(function (r, i) {
    if (r[0] === '監視開始日時' && r[1] === '') settings.getRange(i + 1, 2).setValue(now_());
    if (r[0] === '作業フォルダID' && r[1] === '') {
      const folder = DriveApp.createFolder('会議録音_文字起こし（作業用）');
      settings.getRange(i + 1, 2).setValue(folder.getId());
      Logger.log('作業フォルダを作成しました: ' + folder.getUrl());
    }
  });

  const log = ensure(SHEET.LOG, LOG_HEADERS, []);
  log.getRange(2, COL.fileId, Math.max(1, log.getMaxRows() - 1), 1).setNumberFormat('@');

  const result = ensure(SHEET.RESULT, ['ファイルID', '行番号', 'テキスト'], [260, 70, 900]);
  result.getRange(2, 1, Math.max(1, result.getMaxRows() - 1), 1).setNumberFormat('@');
  result.getRange(2, 3, Math.max(1, result.getMaxRows() - 1), 1).setNumberFormat('@');

  const first = ss.getSheetByName('シート1') || ss.getSheetByName('Sheet1');
  if (first && first.getLastRow() === 0 && ss.getSheets().length > 1) ss.deleteSheet(first);
  Logger.log('タブを用意しました。「監視フォルダ」タブに行を追加し、A列をオンにしてください。');
}

/** 【手動で実行】トリガーを登録する（何度実行しても重複しない）。 */
function installTriggers() {
  const handlers = ['runPipeline', 'dailyCleanup'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('runPipeline').timeBased().everyMinutes(10).create();
  ScriptApp.newTrigger('dailyCleanup').timeBased().everyDays(1).atHour(3).create();
  Logger.log('トリガーを登録しました（処理: 10分ごと / 文字起こしの削除: 毎日3時台）。');
}

/** 【手動で実行】設定がそろっているか確認し、結果をログに出す。 */
function checkSetup() {
  const results = ['バージョン: ' + APP_VERSION];
  ['SPREADSHEET_ID', 'GEMINI_API_KEY'].forEach(function (key) {
    results.push((prop_(key, false) ? 'OK  ' : 'なし') + ' ' + key);
  });

  let settings = null;
  try {
    settings = getSettings_();
    results.push('OK   設定タブ（モデル: ' + settings.model + ' / ' + (settings.batch ? 'バッチ' : '通常') + ' / 区切り ' + settings.segmentMinutes + '分）');
    if (settings.workFolderId) {
      DriveApp.getFolderById(settings.workFolderId);
      results.push('OK   作業フォルダ');
    } else {
      results.push('NG   作業フォルダID が空です（setupSheets を実行）');
    }
  } catch (e) {
    results.push('NG   設定: ' + e.message);
  }

  try {
    const folders = getFolders_();
    results.push((folders.length ? 'OK  ' : 'NG  ') + ' 監視フォルダ: 有効 ' + folders.length + ' 件');
    folders.forEach(function (f) {
      try {
        DriveApp.getFolderById(f.folderId);
        Docs.Documents.get(f.docId, { fields: 'title' });
        results.push('OK     ' + (f.name || f.folderId));
      } catch (e) {
        results.push('NG     ' + (f.name || f.folderId) + ': ' + e.message);
      }
    });
  } catch (e) {
    results.push('NG   監視フォルダ: ' + e.message);
  }

  if (settings) {
    try {
      const res = geminiJson_('/v1beta/models/' + settings.model);
      results.push('OK   Gemini API（' + (res.displayName || settings.model) + '）');
    } catch (e) {
      results.push('NG   Gemini API: ' + e.message);
    }
  }
  Logger.log(results.join('\n'));
}

/** 【手動で実行】追記の書式を確かめる。監視フォルダ1行目の追記先ドキュメントの末尾にサンプルを書き込む。 */
function testAppendFormat() {
  const folder = getFolders_()[0];
  if (!folder) throw new Error('有効な監視フォルダがありません。');
  appendMarkdownToDoc_(folder.docId, [
    '# 2026-01-01 10:00-11:00 【書式テスト】',
    '## 1. 開催概要・出席者',
    '- **開催日時**: 2026-01-01 10:00 - 11:00',
    '- **出席者**（敬称略・順不同）:',
    '  - テスト社：山田、佐藤',
    '## 4. ToDo',
    '- [ ] 山田：資料を送付する（期限：2026-01-10）',
    '- [ ] （担当未定）：日程を調整する（期限未定）',
  ]);
  Logger.log('書き込みました。確認後、テスト部分は手で削除してください。');
}
