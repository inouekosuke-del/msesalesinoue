/**
 * MSE朝礼ボード — 集計の参照実装
 *
 * 「その月の個人別 受注見込み／計上見込み」を、データ層から一意に決まる形で計算する。
 * 画面に出ている数字がこれと合わなければ、画面側の集計が間違っている。
 *
 * ChoreiFix.gs のヘルパー（toMonthKey_ / memberIndex_ / readTable_ / num_）を使う。
 * 同じプロジェクトに両方を置くこと。
 *
 * この実装が守っている4つの約束
 *   1. side を必ず指定する         — 案件は受注行と計上行の2行あり、省くと必ず倍になる
 *   2. 月キーは toMonthKey_ で作る  — '2026-9' と '2026-09' を取り違えない
 *   3. 担当は名寄せしてから集計する — ownerId が空でも ownerName から引き直す
 *   4. 知らない進捗は捨てずに返す   — SFに新しい進捗が増えても静かに消えない
 */

// 進捗ステータス → カテゴリ。SFに新しい値が増えたらここだけ足す。
var STAGE_CATEGORY = {
  '入金済': '確定',
  '検収済': '確定',
  '請求書依頼済': '確定',
  '請求書発行済': '確定',
  '納品済': '確定',
  '受注': '確定',
  '内示（A）': '内示',
  '提案中（B）': '提案',
  '案件化（C）': '案件化',
  'リード（D）': 'リード',
  'ロスト・ペンディング': 'ロスト'
};

// カテゴリ → 加重。カテゴリ単位で持つので、進捗名が増えても表は変えなくてよい。
var CATEGORY_WEIGHT = {
  '確定': 1, '内示': 0.9, '提案': 0.5, '案件化': 0.3, 'リード': 0.1, 'ロスト': 0
};


/**
 * 指定月の担当者別集計を返す。
 * @param {string} month 'yyyy-MM'。省略時は当月。
 * @return {{month: string, members: Object[], unknownStages: Object, orphans: Object[]}}
 */
function 集計_月次見込み(month) {
  month = month || Utilities.formatDate(new Date(), TZ, 'yyyy-MM');

  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var deals = readTable_(ss, ['lineId', 'juchuMonth', 'kenshuMonth', 'side']);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  var mTargets = readTable_(ss, ['month', 'memberId', 'targetJuchu']);
  if (!deals || !members) throw new Error('案件シートまたは members シートが見つかりません');

  var idx = memberIndex_(members.rows);
  var acc = {};        // memberId -> 集計
  var unknownStages = {};
  var orphans = [];    // 担当を特定できなかった案件

  members.rows.forEach(function (m) {
    var id = String(m.id || '');
    if (id) acc[id] = blankBucket_(id, m.name);
  });

  deals.rows.forEach(function (r) {
    var side = String(r.side || '');
    if (side !== '受注' && side !== '計上') return;

    // 約束2: 月キーは日付から作り直す。シート上の月キーは信用しない。
    var key = (side === '受注') ? toMonthKey_(r.juchuDate) : toMonthKey_(r.kenshuDate);
    if (key !== month) return;

    // 約束3: ownerId が空でも氏名から引き直す
    if (isNonMemberOwner_(r.ownerName)) return;   // API Integration 等のシステムアカウント
    var id = String(r.ownerId || '') || idx[normName_(r.ownerName)] || '';
    if (!id) {
      orphans.push({ company: r.company, owner: r.ownerName, amount: num_(r.amount), side: side });
      return;
    }
    if (!acc[id]) acc[id] = blankBucket_(id, id);

    var stage = String(r.stage || '');
    var cat = STAGE_CATEGORY[stage];
    // 約束4: 知らない進捗は 0 扱いにしつつ、必ず呼び出し元に報告する
    if (cat === undefined) { unknownStages[stage || '(空)'] = (unknownStages[stage || '(空)'] || 0) + 1; cat = null; }

    var amount = num_(r.amount);
    var b = acc[id][side === '受注' ? 'juchu' : 'keijo'];
    b.total += amount;
    b.weighted += amount * (cat ? CATEGORY_WEIGHT[cat] : 0);
    b.byCategory[cat || '(未分類)'] = (b.byCategory[cat || '(未分類)'] || 0) + amount;
    b.count++;
  });

  // 目標は monthTargets を正とする（members.targetXxx は参照しない）
  var tIndex = {};
  if (mTargets) {
    mTargets.rows.forEach(function (r) {
      // month 列も日付セルなので、必ず正規化してから突合する
      if (toMonthKey_(r.month) === month) tIndex[String(r.memberId)] = r;
    });
  }
  var list = Object.keys(acc).map(function (id) {
    var a = acc[id];
    var t = tIndex[id];
    a.targetJuchu = t ? num_(t.targetJuchu) : null;   // null = 目標未設定。0 と区別する
    a.targetKeijo = t ? num_(t.targetKeijo) : null;
    a.rateJuchu = rate_(a.juchu.total, a.targetJuchu);
    a.rateKeijo = rate_(a.keijo.total, a.targetKeijo);
    return a;
  });

  return { month: month, members: list, unknownStages: unknownStages, orphans: orphans };
}


/**
 * 集計結果を「_集計検算」シートに書き出す。画面の数字と突き合わせるための対照表。
 */
function 検算_今月(month) {
  var res = 集計_月次見込み(month);
  var rows = [['担当', '受注見込(合計)', '受注見込(加重)', '受注目標', '達成率',
               '計上見込(合計)', '計上見込(加重)', '計上目標', '達成率', '案件数']];

  res.members
    .filter(function (m) { return m.juchu.count || m.keijo.count || m.targetJuchu; })
    .sort(function (a, b) { return b.juchu.total - a.juchu.total; })
    .forEach(function (m) {
      rows.push([m.name,
        m.juchu.total, Math.round(m.juchu.weighted), tgt_(m.targetJuchu), pct_(m.rateJuchu),
        m.keijo.total, Math.round(m.keijo.weighted), tgt_(m.targetKeijo), pct_(m.rateKeijo),
        m.juchu.count + m.keijo.count]);
    });

  rows.push([]);
  rows.push(['担当を特定できなかった案件', res.orphans.length, '', '', '', '', '', '', '', '']);
  res.orphans.forEach(function (o) {
    rows.push(['  ' + o.owner + ' / ' + o.company, o.amount, o.side, '', '', '', '', '', '', '']);
  });

  var uk = Object.keys(res.unknownStages);
  rows.push([]);
  rows.push(['STAGE_CATEGORY に無い進捗', uk.length,
    uk.map(function (k) { return k + '×' + res.unknownStages[k]; }).join(' / ') || '—',
    '', '', '', '', '', '', '']);

  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var sh = ss.getSheetByName('_集計検算') || ss.insertSheet('_集計検算');
  sh.clear();
  var width = rows[0].length;
  var padded = rows.map(function (r) {
    var c = r.slice();
    while (c.length < width) c.push('');
    return c;
  });
  sh.getRange(1, 1, padded.length, width).setValues(padded);
  sh.getRange(1, 1, 1, width).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(padded.length + 2, 1)
    .setValue(res.month + ' / 検算日時 ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'));
  return res;
}


function blankBucket_(id, name) {
  return {
    id: id, name: String(name || id),
    juchu: { total: 0, weighted: 0, count: 0, byCategory: {} },
    keijo: { total: 0, weighted: 0, count: 0, byCategory: {} }
  };
}

/** 目標未設定（null）と目標0を区別する。0除算で Infinity を返さない。 */
function rate_(actual, target) {
  if (target === null || target === undefined) return null;
  if (!target) return null;
  return actual / target;
}

function pct_(r) { return (r === null) ? '目標未設定' : Math.round(r * 1000) / 10 + '%'; }
function tgt_(t) { return (t === null) ? '未設定' : t; }
