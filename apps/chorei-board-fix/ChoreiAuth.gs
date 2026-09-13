/**
 * 誰が何をできるかを1か所で決める。
 *
 * 方針
 *   - 業務で書き込む人だけ `メンバー` シートに置く
 *   - 見るだけの人はアカウントを持たない。@makeshop.co.jp の
 *     Googleアカウントであれば、それだけで閲覧できる
 *
 * ChoreiFix.gs のヘルパー（readTable_ / normName_）を使う。
 */

// このドメインのGoogleアカウントなら、メンバー登録が無くても閲覧できる。
var VIEW_DOMAIN = 'makeshop.co.jp';

/**
 * role → できること。
 *   issue  上長として指示を出せる
 *   edit   日次の投稿・案件の更新ができる
 *   admin  メンバーや設定をいじれる
 */
var ROLE_CAN = {
  master:  { issue: true,  edit: true,  admin: true  },   // 井上
  lead:    { issue: true,  edit: true,  admin: false },   // 深水・竹内・岡本
  member:  { issue: false, edit: true,  admin: false },   // 広瀬・植松ほか営業
  playing: { issue: false, edit: true,  admin: false },   // 伊集院・木戸
  cs:      { issue: false, edit: true,  admin: false },   // 瀧山
  viewer:  { issue: false, edit: false, admin: false }    // ドメイン一致のみ。閲覧だけ
};


/**
 * ログインユーザーの権限を返す。画面もサーバ側もこれ1つで判定する。
 *
 * @param {string=} email 省略時はログインユーザー
 * @return {{ok, email, memberId, name, role, team, can, viewOnly, reason}}
 */
function 権限を判定(email) {
  // 引数を渡されたら、それが空でもログインユーザーに落とさない。
  // 落とすと「メール未登録の行を判定したつもりが、自分の権限を見ていた」になる。
  if (email === undefined || email === null) email = Session.getActiveUser().getEmail();
  email = String(email || '').trim().toLowerCase();
  if (!email) return deny_('', 'メールアドレスが登録されていません');

  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);

  // 1) メンバー登録があればそれを使う
  if (members) {
    var hit = null;
    members.rows.forEach(function (m) {
      if (String(m.email || '').trim().toLowerCase() === email) hit = m;
    });
    if (hit && String(hit.active).toUpperCase() === 'TRUE') {
      var role = String(hit.role || 'member');
      var can = ROLE_CAN[role] || ROLE_CAN.viewer;
      return {
        ok: true, email: email, memberId: String(hit.id), name: String(hit.name || hit.id),
        role: role, team: String(hit.team || ''), can: can, viewOnly: !can.edit, reason: ''
      };
    }
    // 登録があっても active=FALSE なら、閲覧者として扱う（2 に落ちる）
  }

  // 2) 社内ドメインなら閲覧のみ
  if (email.slice(-(VIEW_DOMAIN.length + 1)) === '@' + VIEW_DOMAIN) {
    return {
      ok: true, email: email, memberId: '', name: email.split('@')[0],
      role: 'viewer', team: '', can: ROLE_CAN.viewer, viewOnly: true, reason: ''
    };
  }

  // 3) それ以外は拒否
  return deny_(email, '@' + VIEW_DOMAIN + ' のアカウントではありません');
}

function deny_(email, reason) {
  return {
    ok: false, email: email, memberId: '', name: '', role: '', team: '',
    can: { issue: false, edit: false, admin: false }, viewOnly: true, reason: reason
  };
}

/** 書き込み系の入口で呼ぶ。権限が無ければ例外を投げる。 */
function 書き込み権限を要求_(what) {
  var a = 権限を判定();
  if (!a.ok) throw new Error('アクセスできません: ' + a.reason);
  if (!a.can.edit) throw new Error('閲覧のみのアカウントです（' + a.email + '）。' + (what || '') + 'はできません。');
  return a;
}

/** 指示を出す入口で呼ぶ。 */
function 指示権限を要求_() {
  var a = 権限を判定();
  if (!a.ok) throw new Error('アクセスできません: ' + a.reason);
  if (!a.can.issue) throw new Error('指示を出せるのは master / lead だけです（いまは ' + (a.role || '未登録') + '）。');
  return a;
}


/**
 * 見るだけの人を `メンバー` シートから外す（ドライラン）。
 * 対象は role=manager で、一度も書き込んでいない人。
 */
function メンバー_閲覧のみを外す_ドライラン() { return demoteViewers_(false); }

/**
 * 同上、適用する。
 *
 * **行は消さない。** `active` を FALSE にして `role` を viewer にするだけ。
 * 行ごと消すと `ownerName` からの名寄せが切れ、その人が過去に持っていた案件が
 * 担当不明になる（竹本さんは案件を1件持っている）。
 * active=FALSE なら画面の一覧からは消え、過去の名寄せだけが残る。
 */
function メンバー_閲覧のみを外す_実行() { return demoteViewers_(true); }

function demoteViewers_(apply) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  if (!members) { Logger.log('メンバーシートが見つかりません'); return null; }

  var log = readTable_(ss, ['at', 'email', 'action', 'detail']);
  var wrote = {};
  if (log) log.rows.forEach(function (r) { wrote[String(r.email || '').toLowerCase()] = 1; });

  var cRole = members.header.indexOf('role');
  var cActive = members.header.indexOf('active');

  var targets = [];
  members.rows.forEach(function (m, i) {
    if (String(m.role) !== 'manager') return;
    if (String(m.active).toUpperCase() !== 'TRUE') return;
    var em = String(m.email || '').toLowerCase();
    targets.push({
      row: members.firstDataRow + i, id: String(m.id), name: String(m.name),
      email: em, everWrote: !!wrote[em]
    });
  });

  Logger.log((apply ? '' : '【ドライラン】') + '閲覧のみとして外す対象: ' + targets.length + '名');
  targets.forEach(function (t) {
    Logger.log('  ' + t.name + '（' + t.id + ' / ' + t.email + '）' +
               (t.everWrote ? ' ※過去に書き込みの記録あり。要確認' : ' 書き込み実績なし'));
  });
  Logger.log('外したあとも @' + VIEW_DOMAIN + ' のアカウントであれば閲覧はできる。');

  if (apply && targets.length) {
    var backup = DriveApp.getFileById(DATA_SS_ID)
      .makeCopy('【メンバー整理前】MSE朝礼ボード_データ ' +
                Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'));
    Logger.log('バックアップ: ' + backup.getUrl());
    targets.forEach(function (t) {
      if (cRole >= 0) members.sheet.getRange(t.row, cRole + 1).setValue('viewer');
      if (cActive >= 0) members.sheet.getRange(t.row, cActive + 1).setValue('FALSE');
    });
    SpreadsheetApp.flush();
    Logger.log('active=FALSE / role=viewer にした。画面の一覧からは消える。');
  }
  return targets;
}


/** 誰がどの権限になるかを一覧する。 */
function アクセス診断() {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  if (!members) return [];
  var out = [];
  members.rows.forEach(function (m) {
    var a = 権限を判定(String(m.email || ''));
    out.push({ id: m.id, name: m.name, team: m.team,
               role: a.role || String(m.role || '') + '（判定不可）',
               指示: a.can.issue ? '○' : '', 編集: a.can.edit ? '○' : '', 状態: a.ok ? '' : a.reason });
  });
  out.forEach(function (r) {
    Logger.log([r.id, r.name, r.team, r.role, '指示' + (r.指示 || '×'), '編集' + (r.編集 || '×'), r.状態].join('\t'));
  });
  Logger.log('※ 上の一覧に無い @' + VIEW_DOMAIN + ' のアカウントは、すべて viewer（閲覧のみ）になる。');
  return out;
}
