/**
 * 時間主導トリガーで動く処理。
 *  - processPending: 5分ごと。承認待ちの行を Chat の Webhook で確認に出す（確認オフなら直接登録）
 *  - syncQuireMoves: 毎朝。Quire で移動されたタスクを調べ、送信者をルールに覚えさせる
 */

function processPending() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return; // 前回の実行がまだ動いている
  try {
    const settings = getSettings_();
    const pending = getLogEntries_().filter(function (e) {
      return e.status === STATUS.PENDING && !e.notifiedAt;
    });
    if (!pending.length) return;

    if (!settings.confirmInChat) {
      pending.forEach(function (entry) {
        try {
          registerEntry_(entry);
        } catch (e) {
          updateLog_(entry.row, { status: STATUS.ERROR, reason: String(entry.reason) + ' / エラー: ' + e.message });
        }
      });
      return;
    }

    const projects = getProjects_(true);
    pending.forEach(function (entry) {
      const selected = findProjectByName_(entry.judgedProject, projects)
        ? String(entry.judgedProject) : settings.generalProject;
      try {
        const message = sendToChat_({
          text: 'Quire 登録の確認: ' + entry.subject,
          cardsV2: [approvalCard_(entry, selected)],
        });
        updateLog_(entry.row, { notifiedAt: now_(), chatMessage: message.name || '' });
      } catch (e) {
        Logger.log('チャット送信に失敗: ' + entry.messageId + ' ' + e.message);
      }
    });
  } finally {
    lock.releaseLock();
  }
}

/** Quire 側で別プロジェクトへ移されたタスクを見つけて、送信者をそのプロジェクトのルールに追加する。 */
function syncQuireMoves() {
  const settings = getSettings_();
  const projects = getProjects_(false);
  const limit = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30日より古い行は見ない

  getLogEntries_().forEach(function (entry) {
    if (entry.status !== STATUS.DONE || !entry.taskOid || entry.learned === true) return;
    const received = entry.receivedAt instanceof Date ? entry.receivedAt : new Date(entry.receivedAt);
    if (!isNaN(received) && received < limit) return;

    let task;
    try {
      task = quireGetTask_(String(entry.taskOid));
    } catch (e) {
      Logger.log('タスク取得に失敗: ' + entry.taskOid + ' ' + e.message);
      return;
    }
    const project = findProjectById_(projectIdFromTaskUrl_(task.url), projects);
    if (!project || project.name === String(entry.currentProject)) return;

    const updates = { currentProject: project.name, taskUrl: task.url };
    if (project.name !== settings.generalProject) {
      learnSender_(entry.sender, project);
      updates.learned = true;
    }
    updateLog_(entry.row, updates);
  });
}
