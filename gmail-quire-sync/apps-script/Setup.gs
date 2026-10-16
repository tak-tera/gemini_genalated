/** 初期設定と動作確認用の関数。Apps Script エディタから手動で実行する。 */

/** 【手動で実行】トリガーを登録する（何度実行しても重複しない）。 */
function installTriggers() {
  const handlers = ['processPending', 'syncQuireMoves'];
  ScriptApp.getProjectTriggers().forEach(function (t) {
    if (handlers.indexOf(t.getHandlerFunction()) >= 0) ScriptApp.deleteTrigger(t);
  });
  ScriptApp.newTrigger('processPending').timeBased().everyMinutes(5).create();
  ScriptApp.newTrigger('syncQuireMoves').timeBased().everyDays(1).atHour(7).create();
  Logger.log('トリガーを登録しました（承認待ちの確認: 5分ごと / 移動の学習: 毎朝7時台）。');
}

/** 【手動で実行】設定がそろっているか確認し、結果をログに出す。 */
function checkSetup() {
  const results = [];
  ['SPREADSHEET_ID', 'QUIRE_CLIENT_ID', 'QUIRE_CLIENT_SECRET', 'SERVICE_ACCOUNT_EMAIL', 'OWNER_EMAIL', 'CHAT_SPACE']
    .forEach(function (key) {
      const ok = !!prop_(key, false) || (key === 'SERVICE_ACCOUNT_EMAIL' && !!prop_('SERVICE_ACCOUNT_KEY', false));
      results.push((ok ? 'OK  ' : 'なし') + ' ' + key);
    });

  try {
    const projects = getProjects_(true);
    results.push('OK   振り分けルール: 有効なプロジェクト ' + projects.length + ' 件');
    const settings = getSettings_();
    results.push((findProjectByName_(settings.generalProject, projects) ? 'OK  ' : 'NG  ')
      + ' General の入れ先: ' + settings.generalProject);
  } catch (e) {
    results.push('NG   スプレッドシート: ' + e.message);
  }

  try {
    testQuire();
    results.push('OK   Quire API');
  } catch (e) {
    results.push('NG   Quire API: ' + e.message);
  }

  try {
    chatAccessToken_();
    results.push('OK   Chat API のトークン');
  } catch (e) {
    results.push('NG   Chat API のトークン: ' + e.message);
  }
  Logger.log(results.join('\n'));
}

/** 【手動で実行】チャットにテストメッセージを送る。 */
function sendTestMessage() {
  const space = prop_('CHAT_SPACE');
  chatCreateMessage_(space, { text: 'テスト送信です。この通知が届いていれば設定は完了です。' });
  Logger.log('送信しました: ' + space);
}
