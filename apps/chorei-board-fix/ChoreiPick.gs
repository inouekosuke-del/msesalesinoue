/**
 * 朝礼の「案件候補」を、選べる状態まで絞り込む。
 *
 * いまの候補は取込_案件をほぼそのまま出しているため、
 * 2,360件のうち 82% が「もう選ぶ必要のない案件」になっている。
 *
 *   確定（入金済・検収済・請求書依頼済・請求書発行済・納品済・受注） 1,157件 = 49%
 *   ロスト・ペンディング                                          775件 = 33%
 *   生きている案件                                                428件 = 18%  ← これだけでいい
 *
 * ChoreiFix.gs のヘルパー（toMonthKey_ / readTable_ / num_ / normName_）を使う。
 */

// 受注済み以上。朝礼で「これから動かす案件」としては選ばせない。
var STAGE_CLOSED = {
  '受注': 1, '請求書依頼済': 1, '請求書発行済': 1, '納品済': 1, '検収済': 1, '入金済': 1
};

// 失注・保留。候補からは外すが、掘り起こし用に明示的に呼べるようにしておく。
var STAGE_DEAD = { 'ロスト・ペンディング': 1 };


/**
 * 朝礼で選ばせる案件候補を返す。
 *
 * @param {string=} memberId 担当を絞る。省略で全員。
 * @param {Object=} opts
 *   - includeClosed  true で受注済み以上も含める（既定 false）
 *   - includeDead    true でロスト・ペンディングも含める（既定 false）
 *   - fromMonth      'yyyy-MM'。受注予定日がこの月以降のものだけ（既定は当月）
 *   - overdueOnly    true で「生きているのに受注予定日が過ぎている」案件だけ
 * @return {Object[]} 画面にそのまま渡せる形の配列
 */
function 案件候補(memberId, opts) {
  opts = opts || {};
  var from = opts.fromMonth || Utilities.formatDate(new Date(), TZ, 'yyyy-MM');

  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var deals = readTable_(ss, ['lineId', 'juchuMonth', 'kenshuMonth', 'side']);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  if (!deals) throw new Error('案件シートが見つかりません');
  var idx = members ? memberIndex_(members.rows) : {};

  var out = [];
  deals.rows.forEach(function (r) {
    if (String(r.side) !== '受注') return;            // 案件は受注行と計上行の2行ある
    if (isNonMemberOwner_(r.ownerName)) return;

    var stage = String(r.stage || '');
    if (!opts.includeClosed && STAGE_CLOSED[stage]) return;
    if (!opts.includeDead && STAGE_DEAD[stage]) return;

    var owner = String(r.ownerId || '') || idx[normName_(r.ownerName)] || '';
    if (memberId && owner !== memberId) return;

    var month = toMonthKey_(r.juchuDate);
    var overdue = !!month && month < from;
    if (opts.overdueOnly) { if (!overdue) return; }
    else if (month && overdue) return;                // 期日超過は既定で候補から外す

    out.push({
      lineId: String(r.lineId || ''),
      company: String(r.company || ''),
      product: String(r.product || ''),
      title: String(r.title || ''),
      amount: num_(r.amount),
      stage: stage,
      prob: String(r.prob || ''),
      ownerId: owner,
      juchuDate: safeDate_(r.juchuDate),
      juchuMonth: month,
      overdue: overdue
    });
  });

  // 確度の高い順 → 金額の大きい順。選ぶときに上から見ればいい並びにする。
  var rank = { '内示（A）': 0, '提案中（B）': 1, '案件化（C）': 2, 'リード（D）': 3 };
  out.sort(function (a, b) {
    var ra = (rank[a.stage] === undefined) ? 9 : rank[a.stage];
    var rb = (rank[b.stage] === undefined) ? 9 : rank[b.stage];
    return (ra - rb) || (b.amount - a.amount);
  });
  return out;
}


/** 候補がどれだけノイズを含んでいるかを実測して出す。 */
function 候補ノイズ診断() {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var deals = readTable_(ss, ['lineId', 'juchuMonth', 'kenshuMonth', 'side']);
  if (!deals) { Logger.log('案件シートが見つかりません'); return null; }

  var all = 0, closed = 0, dead = 0;
  deals.rows.forEach(function (r) {
    if (String(r.side) !== '受注') return;
    all++;
    var s = String(r.stage || '');
    if (STAGE_CLOSED[s]) closed++;
    else if (STAGE_DEAD[s]) dead++;
  });
  var live = 案件候補(null, {}).length;

  Logger.log('案件候補の母数: ' + all + '件');
  Logger.log('  受注済み以上      ' + closed + '件 (' + pctOf_(closed, all) + ')  ← 候補に出す必要なし');
  Logger.log('  ロスト・ペンディング ' + dead + '件 (' + pctOf_(dead, all) + ')  ← 同上');
  Logger.log('  絞り込み後        ' + live + '件 (' + pctOf_(live, all) + ')');
  Logger.log('期日超過（生きているのに受注予定日が過去）: ' +
             案件候補(null, { overdueOnly: true }).length + '件 — 別枠で出すとよい');
  return { all: all, closed: closed, dead: dead, live: live };
}

function pctOf_(a, b) { return b ? Math.round(a / b * 100) + '%' : '—'; }
