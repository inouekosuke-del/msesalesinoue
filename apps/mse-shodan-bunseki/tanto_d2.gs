/**
 * 担当_XX シートを「D2単軸」に直す（案C）
 * ------------------------------------------------------------------
 * 目的:
 *   左【計上：検収月】/ 右【受注：受注月】の横並びをやめ、
 *   D2（基準）で選んだ1軸だけを左ブロックに出す。
 *     D2=受注日 → その月に受注した案件（AR / 状態=受注到達）
 *     D2=検収日 → その月に計上した案件（AU / 検収到達=○）
 *     D2=作成日 → その月に作成された商談（AM / 状態=受注到達）
 *
 * 設計:
 *   - 行の挿入・削除をしない。既存セルの数式を差し替えるだけ。
 *   - 右ブロック（G:K）は内容を消す。G2（対象件数）は担当で絞る形に直す。
 *   - U列以降の案件一覧（QUERY）は触らない。元からD2に追従している。
 *   - 数式内に $D$2 の分岐を残すので、実行後もプルダウンの切替に即応する。
 *
 * 使い方:
 *   1. このファイルを新規 .gs として追加する（コード.gs は編集しない）
 *   2. コード.gs のタブが開いていたら閉じる（Runはプロジェクト全体を保存するため）
 *   3. まず rebuildTantoD2_HiroseOnly を実行し、担当_広瀬 の数字を確認する
 *      期待値（期間2026-07 / 基準=受注日）: 受注済み 3件 / 売上 462,250 / 粗利 346,250
 *      基準=検収日 に切り替えて 計上済み 2件 / 406,250 / 235,250 になれば正しい
 *   4. 問題なければ rebuildTantoD2 で残り4名ぶんを実行する
 *
 * ※ onOpen は定義しない。コード.gs 側の onOpen と衝突して既存メニューが壊れるため。
 *
 * 既知の未対応（別途）:
 *   - ロスト・ペンディングの行が無い点は未対応（行の追加が必要なため）
 *   - 経由メモ別に「経由：運営代行」の行が無い点も未対応（同上）
 *   - 主集計シート（商材区分別など）の検収4列の削除も未対応
 */

var D2_DETAIL = '明細';
var D2_ROWS   = '$2:$5000';

/** 期間の条件 */
function d2Period_() {
  return 'IF($B$2="全期間","*",$B$2)';
}

/** 明細の列参照 */
function d2Col_(letter) {
  return "'" + D2_DETAIL + "'!$" + letter + "$2:$" + letter + "$5000";
}

/**
 * D2の3分岐を組む。
 * @param {function(string,string):string} make (月列letter, 到達条件の文字列) => 数式本体
 *   到達条件は 「,範囲,条件」の形でそのまま連結できる文字列
 */
function d2Branch_(make) {
  var reachJu  = ',' + d2Col_('X') + ',"受注到達"';   // 状態 = 受注到達
  var reachKen = ',' + d2Col_('Z') + ',"○"';          // 検収到達 = ○（全角）
  return 'IF($D$2="検収日",' + make('AU', reachKen) +
         ',IF($D$2="受注日",' + make('AR', reachJu) +
         ',' + make('AM', reachJu) + '))';
}

/**
 * 到達行（受注済み／計上済み）の SUMIFS / COUNTIFS
 * @param {string} owner 担当名（明細S列と完全一致）
 * @param {string} sumLetter 合計する列（J=売上, M=原価）。null なら COUNTIFS
 * @param {string} extra 追加条件（',範囲,条件' 形式）。無ければ ''
 */
function d2ReachFormula_(owner, sumLetter, extra) {
  extra = extra || '';
  return d2Branch_(function (mon, reach) {
    var head = sumLetter
      ? 'SUMIFS(' + d2Col_(sumLetter) + ','
      : 'COUNTIFS(';
    return head +
      d2Col_('V') + ',"○",' +
      d2Col_('S') + ',"' + owner + '",' +
      d2Col_(mon) + ',' + d2Period_() +
      reach + extra + ')';
  });
}

/**
 * 確度別（内示(A)など）の行。到達条件のかわりに進捗状況で絞る。
 */
function d2StageFormula_(owner, sumLetter, stage) {
  return d2Branch_(function (mon) {
    var head = sumLetter
      ? 'SUMIFS(' + d2Col_(sumLetter) + ','
      : 'COUNTIFS(';
    return head +
      d2Col_('V') + ',"○",' +
      d2Col_('S') + ',"' + owner + '",' +
      d2Col_(mon) + ',' + d2Period_() + ',' +
      d2Col_('G') + ',"' + stage + '")';
  });
}

/** 売上 / 粗利 / 件数 の3本を返す（到達行） */
function d2ReachTriple_(owner, extra) {
  return [
    '=' + d2ReachFormula_(owner, 'J', extra),
    '=' + d2ReachFormula_(owner, 'J', extra) + '-' + d2ReachFormula_(owner, 'M', extra),
    '=' + d2ReachFormula_(owner, null, extra)
  ];
}

/** 売上 / 粗利 / 件数 の3本を返す（確度別行） */
function d2StageTriple_(owner, stage) {
  return [
    '=' + d2StageFormula_(owner, 'J', stage),
    '=' + d2StageFormula_(owner, 'J', stage) + '-' + d2StageFormula_(owner, 'M', stage),
    '=' + d2StageFormula_(owner, null, stage)
  ];
}

/** 担当名 → シート名（姓のみ） */
function d2SheetNameFor_(owner) {
  return '担当_' + String(owner).split(/[ 　]/)[0];
}

/** _設定 M5:M24 から担当一覧 */
function d2Owners_() {
  var sh = SpreadsheetApp.getActive().getSheetByName('_設定');
  if (!sh) throw new Error('_設定 シートが見つかりません');
  return sh.getRange('M5:M24').getValues()
    .map(function (r) { return String(r[0]).trim(); })
    .filter(function (v) { return v !== ''; });
}

/**
 * ブロック定義。行番号は現在のレイアウト固定（行の増減はしない）。
 *   keyCol: 明細の絞り込み列（null = 確度別ブロック）
 *   from/to: データ行の範囲
 */
function d2Blocks_() {
  return [
    { title: 5,  titleText: '■ 確度別',       keyCol: null, from: 7,  to: 11 },
    { title: 14, titleText: '■ 大カテゴリ',    keyCol: 'AG', from: 16, to: 23 },
    { title: 26, titleText: '■ 小カテゴリ',    keyCol: 'AF', from: 28, to: 37 },
    { title: 40, titleText: '■ 経由メモ別',    keyCol: 'AS', from: 42, to: 70 },
    { title: 73, titleText: '■ 商品別',       keyCol: 'E',  from: 75, to: 94 }
  ];
}

var D2_STAGES = ['内示（A）', '提案中（B）', '案件化（C）', 'リード（D）'];

/** 1枚ぶん書き換える */
function d2RebuildOne_(owner) {
  var ss = SpreadsheetApp.getActive();
  var name = d2SheetNameFor_(owner);
  var sh = ss.getSheetByName(name);
  if (!sh) return name + ': シートなし（スキップ）';

  var blocks = d2Blocks_();

  // --- 見出し・注記 ---
  blocks.forEach(function (b) {
    sh.getRange(b.title, 1).setValue(b.titleText);   // 【計上：検収月】を外す
  });
  sh.getRange('A3').setValue(
    'D2の基準で選んだ1軸だけで集計しています。受注日＝その月に受注した案件、'
    + '検収日＝その月に計上した案件、作成日＝その月に作成された商談。'
    + '母集団は2026年に作成された商談のみ。業績管理・SFの計上額とは母集団が違うため一致しません。'
  );

  // --- 対象件数（G2）: 担当で絞る ---
  sh.getRange('G2').setFormula(
    '=' + d2Branch_(function (mon) {
      return 'COUNTIFS(' + d2Col_('V') + ',"○",' +
             d2Col_('S') + ',"' + owner + '",' +
             d2Col_(mon) + ',' + d2Period_() + ')';
    }) + '&" / "&COUNTIF(' + d2Col_('V') + ',"○")&" 件"'
  );

  // --- 到達行のラベル（受注済み / 計上済み） ---
  sh.getRange(7, 1).setFormula('=IF($D$2="検収日","計上済み","受注済み")');

  // --- 各ブロックの B:D を書き換え（E＝粗利率は既存の C/B 参照のまま） ---
  blocks.forEach(function (b) {
    var keys = sh.getRange(b.from, 1, b.to - b.from + 1, 1).getValues();
    var out = [];
    for (var i = 0; i < keys.length; i++) {
      var label = String(keys[i][0]).trim();
      if (label === '') { out.push(['', '', '']); continue; }

      if (b.keyCol === null) {
        // 確度別: 1行目が到達行、以降は進捗状況
        if (b.from + i === 7) out.push(d2ReachTriple_(owner, ''));
        else {
          var stage = D2_STAGES[b.from + i - 8];
          out.push(stage ? d2StageTriple_(owner, stage) : ['', '', '']);
        }
      } else {
        var extra = ',' + d2Col_(b.keyCol) + ',"' + label.replace(/"/g, '""') + '"';
        out.push(d2ReachTriple_(owner, extra));
      }
    }
    sh.getRange(b.from, 2, out.length, 3).setFormulas(out);
  });

  // --- 右ブロック（G:K）の中身を消す。G2 と 4行目のヘッダ残骸も消す ---
  var lastBlock = blocks[blocks.length - 1];
  sh.getRange(4, 7, lastBlock.to + 2 - 4 + 1, 5).clearContent();
  sh.getRange(4, 2, 1, 17).clearContent();   // 4行目のヘッダ残骸（原因6）

  return name + ': OK';
}

/** 全担当ぶん */
function rebuildTantoD2() {
  var msgs = d2Owners_().map(d2RebuildOne_);
  SpreadsheetApp.flush();
  Logger.log('担当シートをD2単軸に直しました\n' + msgs.join('\n'));
  return msgs.join(' / ');
}

/** まず1枚だけ試す（広瀬）。最初はこれを実行して数字を確認すること。 */
function rebuildTantoD2_HiroseOnly() {
  var owner = d2Owners_().filter(function (o) { return o.indexOf('広瀬') === 0; })[0];
  if (!owner) throw new Error('_設定 M列に広瀬が見つかりません');
  var msg = d2RebuildOne_(owner);
  SpreadsheetApp.flush();
  Logger.log(msg);
  return msg;
}
