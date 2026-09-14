/**
 * 朝礼・終礼の投稿をSlackに流すとき、上長にメンションを付ける。
 *
 * 「植松さんと広瀬さんの朝礼・終礼は井上さんにメンションする」という話だが、
 * 2人の名前をコードに直書きしない。異動や増員のたびにコードを触ることになるので、
 * `メンバー` シートに `reportTo` 列を足して、そこで持つ。
 *
 * ChoreiFix.gs のヘルパー（readTable_ / safeDate_）を使う。
 */

// メンションを付ける投稿の種類。日報以外には付けない。
var MENTION_KINDS = { '朝礼': 1, '終礼': 1 };

// `メンバー` に足す列。誰の投稿を誰に知らせるか。
var REPORT_TO_COL = 'reportTo';

// 列を足すときの初期値。ここに無い人は空のまま＝メンションなし。
var REPORT_TO_DEFAULT = { hirose: 'inoue', uematsu: 'inoue' };


/** `メンバー` に reportTo 列を足す（ドライラン）。 */
function メンバー_報告先を追加_ドライラン() { return addReportTo_(false); }

/**
 * 同上、適用する。列を末尾に足して、広瀬さん・植松さんに inoue を入れる。
 * 既存の列と他の人の行には触れない。
 */
function メンバー_報告先を追加_実行() { return addReportTo_(true); }

function addReportTo_(apply) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  if (!members) { Logger.log('メンバーシートが見つかりません'); return null; }

  var col = members.header.indexOf(REPORT_TO_COL);
  var 新設 = col < 0;
  if (新設) col = members.header.length;

  var 予定 = [];
  members.rows.forEach(function (m, i) {
    var id = String(m.id);
    var いま = 新設 ? '' : String(m[REPORT_TO_COL] || '');
    var これから = REPORT_TO_DEFAULT[id] || '';
    if (!これから || いま === これから) return;
    予定.push({ row: members.firstDataRow + i, id: id, name: String(m.name), to: これから });
  });

  Logger.log((apply ? '' : '【ドライラン】') +
             (新設 ? REPORT_TO_COL + ' 列を新設し、' : '') + 予定.length + '名に報告先を入れる');
  予定.forEach(function (t) {
    var 上長 = members.rows.filter(function (m) { return String(m.id) === t.to; })[0];
    Logger.log('  ' + t.name + ' の朝礼・終礼 → ' +
               (上長 ? String(上長.name) : t.to) + ' にメンション');
  });
  if (!予定.length && !新設) { Logger.log('  変更なし'); return { 予定: [] }; }

  if (apply) {
    var sh = members.sheet;
    if (新設) {
      sh.getRange(1, col + 1).setValue(REPORT_TO_COL);
      sh.getRange(2, col + 1, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    }
    予定.forEach(function (t) { sh.getRange(t.row, col + 1).setValue(t.to); });
    SpreadsheetApp.flush();
    Logger.log('入れた。以後この列を書き換えれば、コードを触らずに宛先を変えられる。');
  }
  return { 予定: 予定, 新設: 新設 };
}


/**
 * その投稿に付けるメンション文字列を返す。付けないときは空文字。
 *
 * @param {string} memberId 投稿した人
 * @param {string} kind '朝礼' | '終礼'
 * @return {string} '<@U06RQRBKM0F>' のような文字列。付けないときは ''
 */
function 通知メンション(memberId, kind) {
  if (!MENTION_KINDS[String(kind)]) return '';

  var members = readTable_(SpreadsheetApp.openById(DATA_SS_ID), ['id', 'sfName', 'slackId']);
  if (!members || members.header.indexOf(REPORT_TO_COL) < 0) return '';

  var 本人 = null;
  members.rows.forEach(function (m) { if (String(m.id) === String(memberId)) 本人 = m; });
  if (!本人) return '';

  var 宛先 = String(本人[REPORT_TO_COL] || '').trim();
  if (!宛先) return '';

  var 上長 = null;
  members.rows.forEach(function (m) { if (String(m.id) === 宛先) 上長 = m; });
  if (!上長) { Logger.log('[警告] reportTo "' + 宛先 + '" が メンバー にいません'); return ''; }

  var slackId = String(上長.slackId || '').trim();
  if (!slackId) { Logger.log('[警告] ' + String(上長.name) + ' の slackId が空です'); return ''; }

  return '<@' + slackId + '>';
}


/**
 * Slackに投げる本文にメンションを足して返す。
 *
 * 本体のSlack投稿処理で、投げる直前にこれを1回通すだけでよい。
 *   var text = 通知本文(memberId, '朝礼', text);
 *
 * メンションは本文の先頭に置く。末尾だと長い日報では流し読みで見落とす。
 */
function 通知本文(memberId, kind, 本文) {
  var m = 通知メンション(memberId, kind);
  return m ? (m + '\n' + 本文) : 本文;
}


/** 誰の投稿が誰に飛ぶかを一覧する。 */
function 通知先診断() {
  var members = readTable_(SpreadsheetApp.openById(DATA_SS_ID), ['id', 'sfName', 'slackId']);
  if (!members) return [];
  if (members.header.indexOf(REPORT_TO_COL) < 0) {
    Logger.log(REPORT_TO_COL + ' 列がありません。先に メンバー_報告先を追加_実行() を走らせること。');
    return [];
  }
  var out = [];
  members.rows.forEach(function (m) {
    if (String(m.active).toUpperCase() !== 'TRUE') return;
    var id = String(m.id);
    var mention = 通知メンション(id, '朝礼');
    out.push({ id: id, name: String(m.name), reportTo: String(m[REPORT_TO_COL] || ''), mention: mention });
    Logger.log(String(m.name) + ' の朝礼・終礼 → ' + (mention || '（メンションなし）'));
  });
  return out;
}
