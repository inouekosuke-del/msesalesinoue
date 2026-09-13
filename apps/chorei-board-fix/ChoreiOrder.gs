/**
 * 上長の指示を「施策・件数・対象・期限」で出せるようにする。
 *
 * いまの `指示` シートは text（自由記述）と due しか無く、
 * 「パートナー施策を5件、代理店リストに対して、9/20 18:00まで」という形で
 * 出すことも、消化を数えることもできない。
 *
 * 新しい仕組みは作らない。同じ軸は `挽回コミット` シートが既に持っている
 * （act / count / done / due / refId）ので、それに合わせて `指示` を拡張する。
 * 施策名の正は `アクションプラン` シート（id=partner「パートナー施策」等）。
 *
 * ChoreiFix.gs のヘルパーを使う。
 */

// 指示に追加する列。既存の列はいじらない。必ず末尾に足す。
var ORDER_NEW_COLS = [
  'actionId',    // アクションプランの id。例 'partner'
  'targetKind',  // 'deal' | 'segment' | 'list' | 'free'
  'targetRef',   // deal なら lineId、それ以外はラベル。例 '代理店リスト'
  'count',       // 何件やるか
  'doneCount'    // 消化件数。担当が更新する
];


/** `指示` シートに不足している列を足す（ドライラン）。 */
function 指示_列を追加_ドライラン() { return addOrderCols_(false); }

/** `指示` シートに不足している列を足す。既存の列と行には触れない。 */
function 指示_列を追加_実行() { return addOrderCols_(true); }

function addOrderCols_(apply) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var orders = readTable_(ss, ['id', 'scope', 'targetId', 'text', 'due', 'active']);
  if (!orders) { Logger.log('指示シートが見つかりません'); return null; }

  var missing = ORDER_NEW_COLS.filter(function (c) { return orders.header.indexOf(c) < 0; });
  if (!missing.length) { Logger.log('追加すべき列はありません。'); return { missing: [] }; }

  Logger.log((apply ? '追加します: ' : '【ドライラン】追加予定: ') + missing.join(', '));
  if (apply) {
    var sh = orders.sheet;
    var at = orders.header.length + 1;
    sh.getRange(1, at, 1, missing.length).setValues([missing]);
    // count / doneCount は数値、それ以外はテキスト。月キーの二の舞を避ける。
    missing.forEach(function (c, i) {
      if (c === 'count' || c === 'doneCount') return;
      sh.getRange(2, at + i, Math.max(sh.getMaxRows() - 1, 1), 1).setNumberFormat('@');
    });
    Logger.log('追加しました。既存の行は空欄のままです（従来どおり text だけの指示として動きます）。');
  }
  return { missing: missing };
}


/**
 * 構造化された指示を1件追加する。
 *
 * @param {Object} o
 *   - scope      'all'（全員） | 'team'（チーム） | 'one'（個人）
 *   - targetId   scope='team' ならチーム名（mse / success / cs / admin）
 *                scope='one'  なら担当者id。scope='all' なら空
 *   - actionId   アクションプランのid。例 'partner'
 *   - targetKind 'deal' | 'segment' | 'list' | 'free'
 *   - targetRef  対象。'代理店リスト' / lineId など
 *   - count      何件
 *   - due        期限。Date か 'yyyy-MM-dd HH:mm'
 *   - text       補足（任意）
 *   - must       必達なら true
 * @return {Object} 追加した行
 */
function 指示を出す(o) {
  指示権限を要求_();                 // 指示を出せるのは master / lead だけ
  var err = 指示を検証(o);
  if (err.length) throw new Error('指示の内容が不正です:\n  ' + err.join('\n  '));

  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var orders = readTable_(ss, ['id', 'scope', 'targetId', 'text', 'due', 'active']);
  ORDER_NEW_COLS.forEach(function (c) {
    if (orders.header.indexOf(c) < 0) {
      throw new Error('指示シートに ' + c + ' 列がありません。先に 指示_列を追加_実行() を走らせること。');
    }
  });

  var now = new Date();
  var row = {};
  orders.header.forEach(function (h) { row[h] = ''; });
  row.id = Utilities.getUuid().slice(0, 8);
  row.date = Utilities.formatDate(now, TZ, 'yyyy-MM-dd');
  row.scope = o.scope || 'one';
  row.targetId = o.targetId || '';
  row.text = o.text || 指示の文面(o);
  row.due = safeDate_(o.due, 'yyyy-MM-dd HH:mm');
  row.createdBy = Session.getActiveUser().getEmail();
  row.createdAt = Utilities.formatDate(now, TZ, 'yyyy-MM-dd HH:mm:ss');
  row.active = 'TRUE';
  row.must = o.must ? 'TRUE' : 'FALSE';
  row.actionId = o.actionId;
  row.targetKind = o.targetKind || 'free';
  row.targetRef = String(o.targetRef || '');
  row.count = Number(o.count);
  row.doneCount = 0;

  orders.sheet.appendRow(orders.header.map(function (h) { return row[h]; }));
  Logger.log('指示を追加しました: ' + 指示の文面(o));
  return row;
}


/** 指示の内容を検証する。問題があれば理由の配列を返す。 */
function 指示を検証(o) {
  var err = [];
  if (!o) return ['指示が空です'];

  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var plans = readTable_(ss, ['id', 'name', 'kind', 'owner', 'active']);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);

  if (!o.actionId) err.push('actionId（施策）が未指定');
  else if (plans) {
    var p = plans.rows.filter(function (r) { return String(r.id) === String(o.actionId); })[0];
    if (!p) err.push('actionId "' + o.actionId + '" が アクションプラン シートにありません');
    else if (String(p.active).toUpperCase() === 'FALSE') err.push('施策 "' + p.name + '" は active=FALSE です');
  }

  var c = Number(o.count);
  if (!c || c < 1 || c !== Math.floor(c)) err.push('count は1以上の整数にすること（いまは ' + o.count + '）');

  var due = toDate_(o.due);
  if (!due) err.push('due（期限）が読めません');
  else if (due.getTime() < Date.now()) err.push('due が過去です: ' + safeDate_(due, 'yyyy-MM-dd HH:mm'));

  if (!String(o.targetRef || '').trim()) err.push('targetRef（どこに対して）が未指定');

  var scope = o.scope || 'one';
  if (SCOPES.indexOf(scope) < 0) {
    err.push('scope は ' + SCOPES.join(' / ') + ' のいずれかにすること（いまは ' + scope + '）');
  } else if (scope === 'one') {
    if (!o.targetId) err.push('scope=one なら targetId（担当者id）が必要');
    else if (members && !活動中のメンバー_(members).some(function (m) { return String(m.id) === String(o.targetId); })) {
      err.push('担当者 "' + o.targetId + '" が メンバー シートに居ないか、active=FALSE です');
    }
  } else if (scope === 'team') {
    if (!o.targetId) err.push('scope=team なら targetId（チーム名）が必要');
    else if (members) {
      var teams = チーム一覧(members);
      if (teams.indexOf(String(o.targetId)) < 0) {
        err.push('チーム "' + o.targetId + '" が存在しません。いまあるのは ' + teams.join(' / '));
      }
    }
  }
  return err;
}


// 指示の宛先。狭い順に並べてある。
var SCOPES = ['all', 'team', 'one'];

/** active=TRUE かつ閲覧専用でないメンバーだけを返す。 */
function 活動中のメンバー_(members) {
  return members.rows.filter(function (m) {
    return String(m.active).toUpperCase() === 'TRUE' && String(m.role) !== 'viewer';
  });
}

/** いま存在するチーム名を返す。 */
function チーム一覧(members) {
  if (!members) {
    members = readTable_(SpreadsheetApp.openById(DATA_SS_ID), ['id', 'sfName', 'slackId']);
  }
  var seen = {};
  活動中のメンバー_(members).forEach(function (m) {
    var t = String(m.team || '').trim();
    if (t) seen[t] = 1;
  });
  return Object.keys(seen).sort();
}

/**
 * 指示が誰に向いているかを、メンバーidの配列で返す。
 * 画面もSlack通知もこれを使えば、all / team / one を同じ扱いにできる。
 */
function 指示の宛先(order, members) {
  if (!members) {
    members = readTable_(SpreadsheetApp.openById(DATA_SS_ID), ['id', 'sfName', 'slackId']);
  }
  var live = 活動中のメンバー_(members);
  var scope = String(order.scope || 'one');
  if (scope === 'all') return live.map(function (m) { return String(m.id); });
  if (scope === 'team') {
    return live.filter(function (m) { return String(m.team) === String(order.targetId); })
               .map(function (m) { return String(m.id); });
  }
  return order.targetId ? [String(order.targetId)] : [];
}


/** 指示を1行の日本語にする。画面にもSlackにもこの文面を使う。 */
function 指示の文面(o) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var plans = readTable_(ss, ['id', 'name', 'kind', 'owner', 'active']);
  var name = o.actionId;
  if (plans) {
    var p = plans.rows.filter(function (r) { return String(r.id) === String(o.actionId); })[0];
    if (p) name = String(p.name);
  }
  return 宛先の表示(o) + name + ' を ' + o.targetRef + ' に対して ' + o.count + '件、' +
         safeDate_(o.due, 'M/d HH:mm') + ' まで';
}

/** 「【全員】」「【mseチーム】」「【植松】」のような見出しを返す。 */
function 宛先の表示(o) {
  var scope = String(o.scope || 'one');
  if (scope === 'all') return '【全員】';
  if (scope === 'team') return '【' + o.targetId + 'チーム】';
  var members = readTable_(SpreadsheetApp.openById(DATA_SS_ID), ['id', 'sfName', 'slackId']);
  var nm = o.targetId;
  if (members) {
    var m = members.rows.filter(function (x) { return String(x.id) === String(o.targetId); })[0];
    if (m) nm = String(m.name || m.id);
  }
  return '【' + nm + '】';
}


/**
 * 指示の消化状況を一覧する。上長が朝礼で見るための表。
 * @param {string=} memberId 省略で全員
 */
function 指示の消化状況(memberId) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var orders = readTable_(ss, ['id', 'scope', 'targetId', 'text', 'due', 'active']);
  if (!orders) return [];
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  var hasNew = orders.header.indexOf('count') >= 0;

  var now = Date.now();
  var out = [];
  orders.rows.forEach(function (r) {
    if (String(r.active).toUpperCase() !== 'TRUE') return;
    if (String(r.doneAt || '')) return;                       // 完了済みは出さない
    // all / team / one を宛先の配列に展開してから絞る
    if (memberId && 指示の宛先(r, members).indexOf(memberId) < 0) return;

    var due = toDate_(r.due);
    var cnt = hasNew ? num_(r.count) : 0;
    var done = hasNew ? num_(r.doneCount) : 0;
    out.push({
      id: String(r.id),
      who: 宛先の表示(r),
      宛先: 指示の宛先(r, members),
      what: hasNew && cnt ? 指示の文面({
        scope: r.scope, targetId: r.targetId,
        actionId: r.actionId, targetRef: r.targetRef, count: cnt, due: r.due
      }) : String(r.text),
      // 従来どおりの text だけの指示は件数を持たない。0/0 と出さず null にして、
      // 画面側が「件数なし」と区別できるようにする。
      count: cnt || null,
      done: cnt ? done : null,
      残り: cnt ? Math.max(cnt - done, 0) : null,
      due: safeDate_(r.due, 'M/d HH:mm'),
      期限切れ: !!(due && due.getTime() < now),
      must: String(r.must).toUpperCase() === 'TRUE'
    });
  });
  out.sort(function (a, b) { return (b.期限切れ - a.期限切れ) || (b.must - a.must); });
  return out;
}


// ===========================================================================
// 完了したら消える
// ===========================================================================
//
// いまの `指示` シートは12件すべて active=TRUE で、うち10件は doneAt が入っている。
// 完了操作が doneAt / doneBy を書くだけで active を落としていないため、
// 一覧の抽出条件が active を見ていると、完了しても消えずに出続ける。
//
// ここでは「完了＝active を落とす」に揃える。抽出条件が active でも doneAt でも、
// どちらを見ていても消えるようになる。


/**
 * 指示を完了にする。行番号ではなく id で探して書く。
 *
 * 行番号で書き戻すと、並び替えや行挿入が入った瞬間に別の行を完了にしてしまう。
 * id で引き直すこと。
 *
 * @param {string} id 指示のid
 * @param {string=} byName 完了にした人の表示名。省略時はログインユーザー
 */
function 指示を完了にする(id, byName) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var orders = readTable_(ss, ['id', 'scope', 'targetId', 'text', 'due', 'active']);
  if (!orders) throw new Error('指示シートが見つかりません');

  var at = -1;
  orders.rows.forEach(function (r, i) { if (String(r.id) === String(id)) at = i; });
  if (at < 0) throw new Error('指示 "' + id + '" が見つかりません');

  var row = orders.firstDataRow + at;
  var now = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm:ss');
  var set = {
    doneAt: now,
    doneBy: byName || Session.getActiveUser().getEmail(),
    active: 'FALSE'        // ← これが無いと一覧から消えない
  };
  Object.keys(set).forEach(function (col) {
    var c = orders.header.indexOf(col);
    if (c >= 0) orders.sheet.getRange(row, c + 1).setValue(set[col]);
  });
  SpreadsheetApp.flush();
  Logger.log('完了にしました: ' + id + ' / ' + String(orders.rows[at].text).slice(0, 40));
  return { id: id, row: row };
}


/** 完了済みなのに active=TRUE のまま残っている指示を片付ける（ドライラン）。 */
function 指示_完了済みを片付ける_ドライラン() { return tidyDoneOrders_(false); }

/**
 * 同上、適用する。
 *
 * doneAt が入っている指示の active を FALSE にするだけ。行は消さない。
 * 元に戻したくなったら active を TRUE に戻せばよい。
 */
function 指示_完了済みを片付ける_実行() { return tidyDoneOrders_(true); }

function tidyDoneOrders_(apply) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var orders = readTable_(ss, ['id', 'scope', 'targetId', 'text', 'due', 'active']);
  if (!orders) { Logger.log('指示シートが見つかりません'); return null; }
  var col = orders.header.indexOf('active');
  if (col < 0) { Logger.log('active 列がありません'); return null; }

  var targets = [];
  orders.rows.forEach(function (r, i) {
    if (!String(r.doneAt || '')) return;
    if (String(r.active).toUpperCase() !== 'TRUE') return;
    targets.push({ row: orders.firstDataRow + i, id: String(r.id), text: String(r.text) });
  });

  Logger.log((apply ? '' : '【ドライラン】') + '完了済みなのに active=TRUE の指示: ' + targets.length + '件');
  targets.forEach(function (t) { Logger.log('  ' + t.id + ' : ' + t.text.slice(0, 44)); });

  if (apply && targets.length) {
    バックアップを作る_('指示の片付け前');
    targets.forEach(function (t) { orders.sheet.getRange(t.row, col + 1).setValue('FALSE'); });
    SpreadsheetApp.flush();
    Logger.log('active を FALSE にしました。一覧から消えます。');
  }
  return targets;
}
