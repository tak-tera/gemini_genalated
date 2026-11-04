/** Google ドライブまわり：新しいファイルの検出、分割読み出し、文字起こし文書の保存と削除。 */

/**
 * 監視フォルダを調べ、まだ処理ログにない音声・動画ファイルを「待機」で追加する。
 * 音声・動画へのショートカットも対象（リンク先のファイルを処理する）。
 */
function scanFolders_(settings) {
  const known = {};
  getLogEntries_().forEach(function (e) { known[String(e.fileId)] = true; });
  const settleLimit = new Date(Date.now() - settings.settleMinutes * 60 * 1000);
  let added = 0;

  getFolders_().forEach(function (f) {
    let files;
    try {
      files = DriveApp.getFolderById(f.folderId).getFiles();
    } catch (e) {
      Logger.log('フォルダを開けません（' + (f.name || f.folderId) + '）: ' + e.message);
      return;
    }
    while (files.hasNext()) {
      const item = files.next();
      // ショートカットなら、リンク先のファイルを処理する。
      // 「置いた日時」はショートカットを作った日時とし、古い録画でもショートカットを置けば処理対象になる
      let file = item;
      let viaShortcut = false;
      if (String(item.getMimeType()) === MimeType.SHORTCUT) {
        const targetId = item.getTargetId();
        if (!targetId || known[targetId]) continue;
        try {
          file = DriveApp.getFileById(targetId);
        } catch (e) {
          Logger.log('ショートカットのリンク先を開けません（' + item.getName() + '）: ' + e.message);
          continue;
        }
        viaShortcut = true;
      }
      const id = file.getId();
      if (known[id]) continue;
      const mime = String(file.getMimeType() || '');
      const kind = mediaKind_(mime, file.getName());
      if (!kind) continue;
      if (settings.since && item.getDateCreated() < settings.since) continue;
      if (file.getLastUpdated() > settleLimit) continue; // まだ同期中かもしれない

      const sizeMb = Math.round(file.getSize() / 1024 / 1024 * 10) / 10;
      const tooLarge = sizeMb > settings.maxSizeMb;
      appendLog_({
        detectedAt: now_(),
        fileId: id,
        fileName: file.getName(),
        folderName: f.name || f.folderId,
        docId: f.docId,
        memoDocId: f.memoDocId,
        kind: kind,
        mimeType: uploadMimeType_(mime, file.getName()),
        sizeMb: sizeMb,
        createdAt: file.getDateCreated(),
        nameDate: dateFromFileName_(file.getName()),
        status: tooLarge ? STATUS.SKIPPED : STATUS.WAITING,
        uploadedBytes: 0,
        errorCount: 0,
        note: tooLarge ? 'ファイルが大きすぎます（上限 ' + settings.maxSizeMb + 'MB）。分割するか、音声だけを取り出してから置き直してください。'
          : (viaShortcut ? 'ショートカット経由（元のファイルはそのままの場所で処理）' : ''),
        updatedAt: now_(),
      });
      known[id] = true;
      added++;
    }
  });
  if (added) Logger.log('新しいファイル: ' + added + ' 件');
}

/** 音声なら「音声」、動画なら「動画」、それ以外は空文字。 */
function mediaKind_(mime, name) {
  if (/^audio\//.test(mime)) return '音声';
  if (/^video\//.test(mime)) return '動画';
  const ext = String(name || '').toLowerCase().split('.').pop();
  if (['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'aiff', 'aif', 'opus', 'wma'].indexOf(ext) >= 0) return '音声';
  if (['mp4', 'mov', 'webm', 'mkv', 'avi', 'mpeg', 'mpg', '3gp', 'wmv', 'flv'].indexOf(ext) >= 0) return '動画';
  return '';
}

/**
 * Gemini に渡す MIME タイプ。拡張子が分かればそれを優先する。
 * Drive は m4a を audio/mpeg（mp3 の型）と記録することがあり、そのまま渡すと Gemini が音声を読めないため。
 */
function uploadMimeType_(mime, name) {
  const map = {
    mp3: 'audio/mp3', m4a: 'audio/mp4', wav: 'audio/wav', aac: 'audio/aac', ogg: 'audio/ogg',
    flac: 'audio/flac', aiff: 'audio/aiff', aif: 'audio/aiff', opus: 'audio/ogg', wma: 'audio/x-ms-wma',
    mp4: 'video/mp4', mov: 'video/mov', webm: 'video/webm', mkv: 'video/x-matroska', avi: 'video/avi',
    mpeg: 'video/mpeg', mpg: 'video/mpg', '3gp': 'video/3gpp', wmv: 'video/wmv', flv: 'video/x-flv',
  };
  const byExt = map[String(name || '').toLowerCase().split('.').pop()];
  if (byExt) return byExt;
  if (mime === 'audio/x-m4a' || mime === 'audio/mp4a-latm') return 'audio/mp4';
  return mime;
}

/**
 * ファイル名から録音日時を読み取り「YYYY-MM-DD HH:MM」（時刻が無ければ「YYYY-MM-DD」）で返す。
 * 例: 20261021_1400.m4a / 2026-10-21 14-00-05.webm / 録音 2026年10月21日 14時00分.mp3
 */
function dateFromFileName_(name) {
  const s = String(name || '');
  const pad = function (n) { return ('0' + n).slice(-2); };
  const patterns = [
    // 2026-10-21 14:00 / 2026_10_21-14-00 / 2026.10.21 1400
    /(20\d{2})[-_.\/](\d{1,2})[-_.\/](\d{1,2})(?:[ T_\-　]*(\d{1,2})[-_.:時h]?(\d{2}))?/,
    // 2026年10月21日 14時00分
    /(20\d{2})年(\d{1,2})月(\d{1,2})日(?:[^\d]{0,3}(\d{1,2})[時:](\d{2}))?/,
    // 20261021_1400 / 20261021-140005 / 20261021
    /(20\d{2})(\d{2})(\d{2})(?:[ T_\-]?(\d{2})(\d{2}))?/,
  ];
  // Screencastify などの英語表記: November 4, 2026 3:36 PM / Nov 4, 2026
  const months = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  const en = s.match(/\b(jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\.?\s+(\d{1,2}),?\s+(20\d{2})(?:[ ,]+(\d{1,2}):(\d{2})(?::\d{2})?\s*([ap]\.?m\.?)?)?/i);
  if (en) {
    let text = en[3] + '-' + pad(months.indexOf(en[1].toLowerCase()) + 1) + '-' + pad(Number(en[2]));
    if (en[4] !== undefined) {
      let h = Number(en[4]);
      const ampm = String(en[6] || '').toLowerCase().replace(/\./g, '');
      if (ampm === 'pm' && h < 12) h += 12;
      if (ampm === 'am' && h === 12) h = 0;
      text += ' ' + pad(h) + ':' + en[5];
    }
    return text;
  }
  for (let i = 0; i < patterns.length; i++) {
    const m = s.match(patterns[i]);
    if (!m) continue;
    const y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    if (mo < 1 || mo > 12 || d < 1 || d > 31) continue;
    let text = m[1] + '-' + pad(mo) + '-' + pad(d);
    if (m[4] !== undefined && m[5] !== undefined) {
      const h = Number(m[4]), mi = Number(m[5]);
      if (h <= 23 && mi <= 59) text += ' ' + pad(h) + ':' + pad(mi);
    }
    if (y >= 2000) return text;
  }
  return '';
}

/** Drive のファイルの一部（start〜end バイト、end を含む）を読み出す。 */
function readDriveRange_(fileId, start, end) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId)
    + '?alt=media&supportsAllDrives=true';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken(), Range: 'bytes=' + start + '-' + end },
    muteHttpExceptions: true,
  });
  const code = res.getResponseCode();
  if (code !== 206 && code !== 200) {
    throw new Error('Drive の読み出しに失敗（' + code + '）: ' + clip_(res.getContentText(), 200));
  }
  return res.getContent();
}

/** 動画の長さ（分）を Drive のメタデータから読む。読めなければ 0。 */
function driveVideoMinutes_(fileId) {
  const url = 'https://www.googleapis.com/drive/v3/files/' + encodeURIComponent(fileId)
    + '?fields=videoMediaMetadata&supportsAllDrives=true';
  const res = UrlFetchApp.fetch(url, {
    headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
    muteHttpExceptions: true,
  });
  if (res.getResponseCode() !== 200) return 0;
  const meta = JSON.parse(res.getContentText()).videoMediaMetadata || {};
  const ms = Number(meta.durationMillis) || 0;
  return ms ? Math.ceil(ms / 60000) : 0;
}

/** 文字起こし1区間を Google ドキュメントとして作業フォルダに保存し、その ID を返す。 */
function saveTranscriptDoc_(settings, entry, index, total, range, text) {
  const title = PREFIX + '-文字起こし-' + entry.fileName + '（' + index + '/' + total + '）';
  const doc = DocumentApp.create(title);
  const header = [
    '元ファイル: ' + entry.fileName,
    '元ファイルID: ' + entry.fileId,
    '区間: ' + index + '/' + total + '（' + range + '）',
    '録音日時（ファイル名から推定）: ' + (entry.nameDate || '不明'),
    'ファイル作成日時（Drive）: ' + formatDateTime_(entry.createdAt),
    '長さ: 約' + entry.minutes + '分',
    '----',
  ].join('\n');
  doc.getBody().setText(header + '\n' + text);
  doc.saveAndClose();
  const file = DriveApp.getFileById(doc.getId());
  if (settings.workFolderId) file.moveTo(DriveApp.getFolderById(settings.workFolderId));
  return doc.getId();
}

/** 文字起こし文書をゴミ箱へ移す。 */
function trashTranscripts_(entry) {
  String(entry.transcriptIds || '').split(',').map(function (s) { return s.trim(); })
    .filter(function (s) { return s; })
    .forEach(function (id) {
      try {
        DriveApp.getFileById(id).setTrashed(true);
      } catch (e) {
        Logger.log('文字起こしの削除に失敗: ' + id + ' ' + e.message);
      }
    });
}

function formatDateTime_(value) {
  if (value instanceof Date && !isNaN(value)) {
    return Utilities.formatDate(value, Session.getScriptTimeZone(), 'yyyy-MM-dd HH:mm');
  }
  return String(value || '不明');
}
