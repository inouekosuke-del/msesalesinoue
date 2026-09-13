/**
 * MSE朝礼ボード 診断・修復ツール（1ファイル版）
 *
 * これは apps/chorei-board-fix/ の5ファイルを機械的に連結したもの。
 * 編集はそちらで行い、build.py で作り直すこと。ここを直接触らない。
 *
 * 使い方
 *   セットアップ_確認()  読み取りのみ。何が起きるかを全部出す
 *   セットアップ_実行()  バックアップを1つ作ってから、まとめて適用する
 *
 * 個別に走らせたいときは、下の各関数を直接呼んでもよい。
 */



// =========================================================================
// ChoreiFix.gs — 診断・修復と共通ヘルパー
// =========================================================================

/**
 * MSE朝礼ボード — データ層の診断・修復ツール
 *
 * docs/chorei-board-audit-2026-09-11.md で検出した不具合のうち、
 * データ側だけで直せるものを直す。既存のアプリ本体には一切触らない追加ファイル。
 *
 * 使い方
 *   1. このファイルを朝礼ボードのApps Scriptプロジェクトに追加する
 *   2. 診断() を実行 → 「_診断レポート」シートに結果が出る（読み取りのみ）
 *   3. 修復_ドライラン() を実行 → 何をどう書き換えるかだけを出力する（書き込みなし）
 *   4. 内容に納得したら 修復_実行() → バックアップを取ってから書き換える
 *
 * 設計方針
 *   - シートは名前ではなくヘッダー行の組み合わせで特定する（リネームで壊れないように）
 *   - 列は必ずヘッダー名から引く。インデックス直書きはしない
 *   - 行の削除はしない。値の上書きのみ
 *   - 修復_実行() は必ずスプレッドシートのコピーを作ってから走る
 */

var TZ = 'Asia/Tokyo';

// 朝礼ボードのデータ層。コンテナバインドなので既定は「このスプレッドシート」。
var DATA_SS_ID = '18FYRRykL5krlrZe3Sq4hJtl7ZIAUsoX4AxS9RX6QyOU';

var REPORT_SHEET = '_診断レポート';


// ===========================================================================
// エントリポイント
// ===========================================================================

/** 読み取りのみ。現状の不整合を「_診断レポート」シートに書き出す。 */
function 診断() {
  var out = runDiagnostics_();
  writeReport_(out);
  Logger.log(out.map(function (r) { return r.join('\t'); }).join('\n'));
  return out;
}

/** 書き込みなし。修復_実行() が何を変えるかだけを出す。 */
function 修復_ドライラン() {
  var plan = buildRepairPlan_();
  logPlan_(plan, true);
  return plan;
}

/** バックアップを取ってから修復を適用する。 */
function 修復_実行() {
  var plan = buildRepairPlan_();
  if (plan.total === 0) {
    Logger.log('修復すべきセルはありません。');
    return plan;
  }

  var backup = バックアップを作る_('修復前');
  applyRepairPlan_(plan);
  logPlan_(plan, false);
  if (backup) Logger.log('戻すときはこのバックアップから: ' + backup.getUrl());
  return plan;
}


// ===========================================================================
// 診断
// ===========================================================================

function runDiagnostics_() {
  var rows = [['区分', '項目', '件数', '金額/詳細', '対処']];
  var ss = SpreadsheetApp.openById(DATA_SS_ID);

  var deals = readTable_(ss, ['lineId', 'juchuMonth', 'kenshuMonth', 'side']);
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  var todo = readTable_(ss, ['lineId', 'todoDue', 'todoOwner']);
  var mTargets = readTable_(ss, ['month', 'memberId', 'targetJuchu']);

  // --- 1. 二重取り込み ---------------------------------------------------
  if (deals) {
    var perKey = {};
    deals.rows.forEach(function (r) {
      var k = String(r.lineId || '') + '\u0000' + String(r.side || '');
      (perKey[k] = perKey[k] || []).push(r);
    });
    var exactDup = 0, keyClash = 0;
    Object.keys(perKey).forEach(function (k) {
      var g = perKey[k];
      if (g.length < 2) return;
      // 中身まで同じなら重複取り込み。違うなら別案件のキー衝突（不具合4）
      var sigs = {};
      g.forEach(function (r) {
        sigs[[r.title, r.juchuDate, r.kenshuDate, r.ownerName, r.stage].join('|')] = 1;
      });
      if (Object.keys(sigs).length === 1) exactDup += g.length - 1; else keyClash++;
    });
    // 注意: SFレポートは商談商品の明細単位なので、同じ商品が2明細あると
    // 全列一致の行が正当に発生しうる。件数が小さいうちは消さずに報告だけする。
    rows.push(['1 取り込み', '全列が一致する重複行',
      exactDup, exactDup > 20 ? '二重取り込みの残骸の可能性が高い'
                              : '少数ならSF側の明細重複かもしれない。消す前に中身を見ること',
      exactDup > 20 ? '取り込みを1回やり直す' : 'OK']);

    // 監査ログの ingest 行から files=2 の日を拾う
    var log = readTable_(ss, ['at', 'email', 'action', 'detail']);
    if (log) {
      var multi = [];
      log.rows.forEach(function (r) {
        if (String(r.action).indexOf('ingest') !== 0) return;
        var m = String(r.detail).match(/files=(\d+)\s+deals=(\d+)/);
        if (m && Number(m[1]) > 1) {
          multi.push(safeDate_(r.at, 'MM/dd') + '(files=' + m[1] + ' deals=' + m[2] + ')');
        }
      });
      rows.push(['1 取り込み', '1回の取り込みで2ファイル以上を処理した日',
        multi.length, multi.slice(-6).join(' ') || '—',
        multi.length ? '夕方の取り込みが18:00のメール着信と競合している。トリガーを18:10以降にずらす' : 'OK']);
    }
  }

  // --- 2. 名寄せ ---------------------------------------------------------
  if (deals && members) {
    var byName = memberIndex_(members.rows);
    var unresolved = {};
    var lost = 0;
    deals.rows.forEach(function (r) {
      if (String(r.side) !== '受注') return;               // 受注行だけ数える
      if (String(r.ownerId || '')) return;
      var nm = String(r.ownerName || '').trim();
      if (!nm || isNonMemberOwner_(nm)) return;
      unresolved[nm] = (unresolved[nm] || 0) + 1;
      if (!byName[normName_(nm)]) lost += num_(r.amount);
    });
    var names = Object.keys(unresolved);
    rows.push(['2 名寄せ', '案件: ownerId が空',
      names.length ? sumValues_(unresolved) : 0,
      names.length ? names.join('、') + ' / ' + yen_(lost) : '—',
      names.length ? 'members シートに追加する（退職者は active=FALSE で登録）' : 'OK']);
  }

  var hist = readTable_(ss, ['date', 'member', 'memberId', 'kind']);
  if (hist && members) {
    var byShort = memberIndex_(members.rows);
    var blank = 0, blankNames = {};
    hist.rows.forEach(function (r) {
      if (String(r.memberId || '')) return;
      blank++;
      var nm = String(r.member || '').trim();
      if (nm) blankNames[nm] = true;
    });
    rows.push(['2 名寄せ', '日次履歴: memberId が空',
      blank, Object.keys(blankNames).join('、') || '—',
      blank ? '同上' : 'OK']);
  }

  // --- 3. 月キーの列が日付型になっていないか -----------------------------
  if (deals) {
    var dateTyped = 0, mismatched = 0;
    deals.rows.forEach(function (r) {
      ['juchuMonth', 'kenshuMonth'].forEach(function (c) {
        var v = r[c];
        if (v instanceof Date) dateTyped++;
        else if (v !== '' && v != null) {
          var want = toMonthKey_(r[c === 'juchuMonth' ? 'juchuDate' : 'kenshuDate']);
          if (want && String(v) !== want) mismatched++;
        }
      });
    });
    rows.push(['2 月キー', '日付セルになっている月キー',
      dateTyped, dateTyped ? 'getValues() が Date を返すので文字列比較が全部外れる' : '—',
      dateTyped ? '修復_実行() で列をテキスト化して書き直す' : 'OK']);
    rows.push(['2 月キー', '日付と食い違う月キー（文字列のもの）',
      mismatched, mismatched || '—', mismatched ? '同上' : 'OK']);
  }

  // --- 4. 一意キーの衝突 -------------------------------------------------
  if (deals) {
    var cnt = {}, noOpp = 0;
    deals.rows.forEach(function (r) {
      var id = String(r.lineId || '');
      if (id && id.slice(-2) !== '#K') cnt[id] = (cnt[id] || 0) + 1;   // 受注側だけ数える
      if (!String(r.oppId || '')) noOpp++;
    });
    // 受注行と計上行は lineId が別（計上は末尾 #K）。同じキーが2行以上あれば別案件の衝突。
    var dup = Object.keys(cnt).filter(function (k) { return cnt[k] > 1; });
    rows.push(['4 キー', 'lineId の衝突（別案件が同一キーになっている）',
      dup.length, dup.slice(0, 5).join(' / ') || '—',
      dup.length ? 'oppId を主キーにする' : 'OK']);
    rows.push(['4 キー', 'oppId が空の行',
      noOpp, noOpp + ' / ' + deals.rows.length,
      noOpp ? 'SFレポートに Opportunity Id 列を追加する' : 'OK']);
  }

  // --- 5. 目標マスタの二重化 --------------------------------------------
  if (members && mTargets) {
    var thisMonth = Utilities.formatDate(new Date(), TZ, 'yyyy-MM');
    var diffs = [], missing = [];
    var tIndex = {};
    mTargets.rows.forEach(function (r) {
      if (toMonthKey_(r.month) === thisMonth) tIndex[String(r.memberId)] = r;
    });
    members.rows.forEach(function (m) {
      if (String(m.active).toUpperCase() === 'FALSE') return;
      var t = tIndex[String(m.id)];
      if (!t) { missing.push(String(m.name || m.id)); return; }
      ['targetJuchu', 'targetKeijo'].forEach(function (k) {
        if (num_(m[k]) !== num_(t[k])) {
          diffs.push(m.name + ' ' + k + ': members=' + yen_(num_(m[k])) +
                     ' / monthTargets=' + yen_(num_(t[k])));
        }
      });
    });
    rows.push(['5 目標', 'members と monthTargets の食い違い（' + thisMonth + '）',
      diffs.length, diffs.join(' / ') || '—',
      diffs.length ? 'monthTargets を正にする' : 'OK']);
    rows.push(['5 目標', 'monthTargets に行が無い在籍メンバー',
      missing.length, missing.join('、') || '—',
      missing.length ? '月初に active 全員分の行を自動生成する' : 'OK']);
  }

  // --- 6. 受注行と計上行の対応 ------------------------------------------
  if (deals) {
    var j = 0, k = 0;
    deals.rows.forEach(function (r) {
      if (String(r.side) === '受注') j++;
      if (String(r.side) === '計上') k++;
    });
    rows.push(['6 2行構造', '受注行数 vs 計上行数',
      Math.abs(j - k), '受注 ' + j + ' / 計上 ' + k,
      j === k ? 'OK' : '取り込みで #K 行が作られなかった案件がある']);
  }

  // --- 7. TODOの欠損列 ---------------------------------------------------
  if (todo) {
    ['todoTitle', 'todoStatus', 'oppId'].forEach(function (c) {
      if (todo.header.indexOf(c) < 0) return;
      var filled = todo.rows.filter(function (r) { return String(r[c] || ''); }).length;
      rows.push(['7 TODO', c + ' が埋まっている行',
        filled, filled + ' / ' + todo.rows.length,
        filled ? 'OK' : 'SFレポートの取得列に追加する']);
    });
  }

  // --- 8. 指示（orders）の完了状態 ---------------------------------------
  var orders = readTable_(ss, ['id', 'scope', 'targetId', 'text', 'due', 'active']);
  if (orders) {
    var doneButActive = 0, allScope = 0;
    orders.rows.forEach(function (r) {
      var isActive = String(r.active).toUpperCase() === 'TRUE';
      if (isActive && String(r.doneAt || '')) doneButActive++;
      if (String(r.scope) === 'all') allScope++;
    });
    rows.push(['8 指示', '完了済み（doneAt あり）なのに active=TRUE',
      doneButActive, doneButActive + ' / ' + orders.rows.length,
      doneButActive ? '一覧の抽出条件を active && !doneAt にする（本体のコード）' : 'OK']);
    rows.push(['8 指示', 'scope=all の指示（個人別の完了を持てない）',
      allScope, allScope ? '完了は doneAt/doneBy の1組のみ' : '—',
      allScope ? '個人別に完了させるなら完了レコードを別シートに分ける' : 'OK']);

  }

  return rows;
}

function writeReport_(rows) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var sh = ss.getSheetByName(REPORT_SHEET);
  if (!sh) sh = ss.insertSheet(REPORT_SHEET);
  sh.clear();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
  sh.getRange(rows.length + 2, 1)
    .setValue('診断日時: ' + Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm') +
              ' / 詳細: docs/chorei-board-audit-2026-09-11.md');
  for (var c = 1; c <= rows[0].length; c++) sh.autoResizeColumn(c);
}


// ===========================================================================
// 修復
// ===========================================================================

/**
 * 書き換え計画を作る。実際の書き込みはしない。
 * @return {{edits: Array, total: number, notes: Array}}
 */
function buildRepairPlan_() {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var edits = [];          // セル単位の書き換え
  var columnWrites = [];   // 列まるごとの一括書き換え（数千セルになるため）
  var notes = [];

  // --- 月キーの洗い替え --------------------------------------------------
  // 列が日付型になっているので、セル単位で直すと Sheets がまた日付に変換してしまう。
  // 「列をテキスト書式にする」→「日付から導出した文字列を一括で書く」の順でしか直らない。
  var deals = readTable_(ss, ['lineId', 'juchuMonth', 'kenshuMonth', 'side']);
  if (deals && deals.rows.length) {
    [['juchuDate', 'juchuMonth'], ['kenshuDate', 'kenshuMonth']].forEach(function (p) {
      var col = deals.header.indexOf(p[1]);
      if (col < 0) return;
      var want = deals.rows.map(function (r) { return [toMonthKey_(r[p[0]])]; });
      var changed = 0;
      deals.rows.forEach(function (r, i) {
        var cur = r[p[1]];
        // Date なら必ず要修正。文字列でも導出値と違えば要修正。
        if (cur instanceof Date || String(cur) !== want[i][0]) changed++;
      });
      if (!changed) return;
      columnWrites.push({
        sheet: deals.sheet.getName(), col: col + 1, firstRow: deals.firstDataRow,
        values: want, changed: changed, asText: true,
        why: p[1] + ' を日付から導出した文字列に直す（列をテキスト書式にしてから書く）'
      });
    });
  }

  // --- ownerId / memberId の名寄せ ---------------------------------------
  var members = readTable_(ss, ['id', 'sfName', 'slackId']);
  if (members) {
    var idx = memberIndex_(members.rows);
    var unknown = {};

    if (deals) {
      var ownerCol = deals.header.indexOf('ownerId');
      if (ownerCol >= 0) {
        deals.rows.forEach(function (r, i) {
          if (String(r.ownerId || '')) return;
          var nm = String(r.ownerName || '').trim();
          if (!nm || isNonMemberOwner_(nm)) return;
          var id = idx[normName_(nm)];
          if (!id) { unknown[nm] = true; return; }
          edits.push({
            sheet: deals.sheet.getName(), row: deals.firstDataRow + i, col: ownerCol + 1,
            from: '', to: id, why: '名寄せ（' + nm + '）'
          });
        });
      }
    }

    var hist = readTable_(ss, ['date', 'member', 'memberId', 'kind']);
    if (hist) {
      var mCol = hist.header.indexOf('memberId');
      hist.rows.forEach(function (r, i) {
        if (String(r.memberId || '')) return;
        var nm = String(r.member || '').trim();
        if (!nm) return;
        var id = idx[normName_(nm)];
        if (!id) { unknown[nm] = true; return; }
        edits.push({
          sheet: hist.sheet.getName(), row: hist.firstDataRow + i, col: mCol + 1,
          from: '', to: id, why: '名寄せ（' + nm + '）'
        });
      });
    }

    var un = Object.keys(unknown);
    if (un.length) {
      notes.push('members シートに存在しないため名寄せできなかった担当: ' + un.join('、') +
                 ' — 先に members に追加してから再実行すること');
    }
  }

  var colCells = columnWrites.reduce(function (n, c) { return n + c.changed; }, 0);
  return { edits: edits, columnWrites: columnWrites,
           total: edits.length + colCells, notes: notes };
}

function applyRepairPlan_(plan) {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var cache = {};
  function sheetOf(name) { return cache[name] || (cache[name] = ss.getSheetByName(name)); }

  // 列まるごとの書き換えを先に。数千セルをセル単位で書くと実行時間を使い切る。
  (plan.columnWrites || []).forEach(function (c) {
    var sh = sheetOf(c.sheet);
    var rng = sh.getRange(c.firstRow, c.col, c.values.length, 1);
    // 先にテキスト書式にしないと、書いた文字列がまた日付に変換される
    if (c.asText) rng.setNumberFormat('@');
    rng.setValues(c.values);
  });

  plan.edits.forEach(function (e) {
    sheetOf(e.sheet).getRange(e.row, e.col).setValue(e.to);
  });
  SpreadsheetApp.flush();
}

function logPlan_(plan, isDryRun) {
  var head = isDryRun ? '【ドライラン】書き換え予定 ' : '【実行済み】書き換え ';
  Logger.log(head + plan.total + ' セル');
  (plan.columnWrites || []).forEach(function (c) {
    Logger.log('  [列一括] ' + c.sheet + ' 第' + c.col + '列 ' + c.changed + ' セル : ' + c.why);
    Logger.log('           例: ' + c.values.slice(0, 3).map(function (v) { return v[0]; }).join(', '));
  });
  var byWhy = {};
  plan.edits.forEach(function (e) {
    var k = e.why.replace(/（.*$/, '');
    byWhy[k] = (byWhy[k] || 0) + 1;
  });
  Object.keys(byWhy).forEach(function (k) { Logger.log('  ' + k + ': ' + byWhy[k] + ' セル'); });
  plan.edits.slice(0, 30).forEach(function (e) {
    Logger.log('  ' + e.sheet + '!R' + e.row + 'C' + e.col +
               ' : "' + e.from + '" -> "' + e.to + '"  ' + e.why);
  });
  if (plan.edits.length > 30) Logger.log('  … 他 ' + (plan.edits.length - 30) + ' セル');
  plan.notes.forEach(function (n) { Logger.log('[注意] ' + n); });
}


/**
 * 今日の数字が二重取り込みの影響を受けていないかを判定する。
 *
 * 仕組み: 夕方のレポートメールは 18:00:0x〜18:00:4x に届く。取り込みトリガーが
 * 18:00:2x に走ると取りこぼし、翌朝 07:30 の回が「昨夕」と「今朝」の2通を
 * まとめて処理して件数が倍になる。
 *
 * 朝礼の前にこれを実行して「要注意」が出たら、その日の見込みは信用しない。
 */
function 二重取り込みチェック() {
  var ss = SpreadsheetApp.openById(DATA_SS_ID);
  var log = readTable_(ss, ['at', 'email', 'action', 'detail']);
  if (!log) { Logger.log('監査ログが見つかりません'); return null; }

  var last = null;
  log.rows.forEach(function (r) {
    if (String(r.action).indexOf('ingest') !== 0) return;
    var m = String(r.detail).match(/files=(\d+)\s+deals=(\d+)\s+todos=(\d+)/);
    if (m) last = { at: r.at, files: +m[1], deals: +m[2], todos: +m[3] };
  });
  if (!last) { Logger.log('取り込みの記録がありません'); return null; }

  // 実際のシートも見る。lineId は別案件どうしで衝突しうるので（不具合4）、
  // ユニーク数との差では判定できない。「全列が一致する行」の数で見る。
  var deals = readTable_(ss, ['lineId', 'juchuMonth', 'kenshuMonth', 'side']);
  var rowCount = deals ? deals.rows.length : 0;
  var seen = {}, exactDup = 0;
  if (deals) {
    deals.rows.forEach(function (r) {
      var sig = deals.header.map(function (h) {
        return (h === 'importedAt') ? '' : String(r[h]);   // 取込時刻は比較から除く
      }).join('\u0001');
      if (seen[sig]) exactDup++; else seen[sig] = 1;
    });
  }

  var ng = (last.files > 1) || (exactDup > 20);
  Logger.log('最終取り込み: ' + safeDate_(last.at, 'yyyy-MM-dd HH:mm') +
             ' / files=' + last.files + ' deals=' + last.deals);
  Logger.log('シート実測: ' + rowCount + '行 / 全列一致の重複 ' + exactDup + '行');
  if (ng) {
    Logger.log('■ 要注意: 二重取り込みの疑いがある。今日の見込み数字は使わないこと。');
    Logger.log('  対処: 取り込みを1回やり直す（1通だけ処理される状態にしてから）');
    Logger.log('  恒久対策: 夕方の取り込みトリガーを 18:00 から 18:10 以降にずらす');
  } else {
    Logger.log('○ 問題なし。');
  }
  return { ok: !ng, last: last, rowCount: rowCount, exactDup: exactDup };
}


/**
 * 名寄せできなかった担当を、members シートに貼れる形で出力する。
 * id の候補は既存の命名（個人チェックシートのキー）に合わせた辞書から引く。
 */
function メンバー追加候補() {
  // 既知の担当は id / 氏名 / SlackID まで埋めて出す。
  // 出典: alert-overdue-mse の references/data-sources.md（メンバー↔Slackメンション表）と
  //       check-sf-sheet-consistency が対象にしている営業5名。
  var KNOWN = {
    '吉牟田': { id: 'yoshimuta', name: '吉牟田', sfName: '吉牟田 淳嗣', slackId: 'U02693MDCQN', team: 'mse' },
    '小菅':   { id: 'kosuge',    name: '小菅',   sfName: '小菅 遥平',   slackId: 'U0A6KNQK7JP', team: 'mse' },
    '重松':   { id: 'shigematsu', name: '重松',  sfName: '重松 篤弘',   slackId: '',            team: 'mse' }
  };
  var plan = buildRepairPlan_();
  var names = {};
  plan.notes.forEach(function (n) {
    var m = n.match(/担当: (.+?) —/);
    if (m) m[1].split('、').forEach(function (x) { names[x.trim()] = true; });
  });
  if (!Object.keys(names).length) { Logger.log('未登録の担当はありません。'); return []; }

  var out = [['id', 'name', 'sfName', 'email', 'slackId', 'role', 'active',
              'alert', 'targetJuchu', 'targetKeijo', 'title', 'team']];
  // 同じ人が '吉牟田' と '吉牟田 淳嗣' の2通りで現れるので、姓でまとめる。
  // sfName にはフルネーム（見つかっていれば）を採る。
  var byPerson = {};
  Object.keys(names).forEach(function (nm) {
    var short = nm.split(/[\s　]/)[0];
    var cur = byPerson[short];
    if (!cur || normName_(nm).length > normName_(cur).length) byPerson[short] = nm;
  });
  Object.keys(byPerson).forEach(function (short) {
    var k = KNOWN[short] || { id: '(要決定)', name: short, sfName: byPerson[short], slackId: '', team: 'mse' };
    out.push([k.id, k.name, k.sfName, '', k.slackId,
              'member', 'TRUE', k.slackId ? 'TRUE' : 'FALSE', 0, 0, '', k.team]);
  });
  Logger.log('members シートに以下を追加してから 修復_実行() を再実行すること:');
  out.forEach(function (r) { Logger.log('  ' + r.join('\t')); });
  Logger.log('※ email は各自のアドレスを入れること（自動では埋まらない）。');
  Logger.log('※ 退職・異動済みなら active を FALSE にする。過去分の名寄せは active に関係なく効く。');
  return out;
}


// ===========================================================================
// 共通ヘルパー（アプリ本体からも呼べるように単独で完結させてある）
// ===========================================================================

/**
 * 日付値から 'yyyy-MM' を作る。
 * 文字列を '/' で割って繋ぐ実装だと '2026/3/20' が '2026-3' になり、
 * '2026-09' との突合で静かに落ちる。必ずDateに正規化してから組み立てる。
 */
function toMonthKey_(val) {
  var d = toDate_(val);
  return d ? Utilities.formatDate(d, TZ, 'yyyy-MM') : '';
}

function safeDate_(val, fmt) {
  var d = toDate_(val);
  return d ? Utilities.formatDate(d, TZ, fmt || 'yyyy/MM/dd') : '';
}

function toDate_(val) {
  if (!val && val !== 0) return null;
  try {
    if (val instanceof Date) return isNaN(val.getTime()) ? null : val;
    var s = String(val).trim();
    if (!s) return null;
    // 日付だけでなく時刻も拾う。時刻を落とすと updatedAt などが 00:00 になる。
    var m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?)?/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    var d = new Date(s.replace(/-/g, '/'));
    return isNaN(d.getTime()) ? null : d;
  } catch (e) { return null; }
}

/** 全角・半角スペースを除去して氏名を比較可能にする。'吉牟田 淳嗣' と '吉牟田　淳嗣' を同一視する。 */
function normName_(s) {
  return String(s || '').replace(/[\s　]/g, '');
}

/** members シートから 氏名/略称 -> id の索引を作る。 */
/** 担当者ではない書き手。名寄せ対象から外す。 */
var NON_MEMBER_OWNERS = { 'APIIntegration': 1, 'API Integration': 1 };

function isNonMemberOwner_(name) {
  return !!NON_MEMBER_OWNERS[normName_(name)] || !!NON_MEMBER_OWNERS[String(name || '').trim()];
}

function memberIndex_(memberRows) {
  var idx = {};
  memberRows.forEach(function (m) {
    var id = String(m.id || '').trim();
    if (!id) return;
    [m.sfName, m.name, m.id].forEach(function (n) {
      var k = normName_(n);
      if (k) idx[k] = id;
    });
  });
  return idx;
}

// セットアップ_実行() のように複数の修復を続けて走らせるとき、
// それぞれがコピーを作ると4つ増えてどれが正か分からなくなる。
// 先頭で1つ作ったら、以降は作らない。
var BACKUP_TAKEN_ = false;

function バックアップを作る_(label) {
  if (BACKUP_TAKEN_) return null;
  var f = DriveApp.getFileById(DATA_SS_ID)
    .makeCopy('【' + label + '】MSE朝礼ボード_データ ' +
              Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'));
  Logger.log('バックアップ: ' + f.getUrl());
  return f;
}

function num_(v) {
  if (v === '' || v == null) return 0;
  var n = Number(String(v).replace(/[,￥¥\s]/g, ''));
  return isNaN(n) ? 0 : n;
}

function yen_(n) {
  return '￥' + Math.round(n).toLocaleString('ja-JP');
}

function amountFromLineId_(lineId) {
  var p = String(lineId).replace(/#K$/, '').split('|');
  return num_(p[p.length - 1]);
}

function sumValues_(obj) {
  return Object.keys(obj).reduce(function (s, k) { return s + obj[k]; }, 0);
}

/**
 * ヘッダー名の組み合わせでシートを特定して読む。
 * シート名は変わりうるが、ヘッダーの組み合わせは変わらない。
 * @return {{sheet, header: string[], firstDataRow: number, rows: Object[]}|null}
 */
function readTable_(ss, requiredHeaders) {
  var sheets = ss.getSheets();
  for (var i = 0; i < sheets.length; i++) {
    var sh = sheets[i];
    if (sh.getLastRow() < 1 || sh.getLastColumn() < 1) continue;
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0]
      .map(function (v) { return String(v).trim(); });
    var ok = requiredHeaders.every(function (h) { return header.indexOf(h) >= 0; });
    if (!ok) continue;

    var rows = [];
    if (sh.getLastRow() > 1) {
      var values = sh.getRange(2, 1, sh.getLastRow() - 1, header.length).getValues();
      values.forEach(function (v) {
        var o = {};
        header.forEach(function (h, c) { if (h) o[h] = v[c]; });
        rows.push(o);
      });
    }
    return { sheet: sh, header: header, firstDataRow: 2, rows: rows };
  }
  Logger.log('[警告] ヘッダー ' + requiredHeaders.join(',') + ' を持つシートが見つかりません');
  return null;
}


// =========================================================================
// ChoreiAgg.gs — 集計の参照実装
// =========================================================================

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


// =========================================================================
// ChoreiPick.gs — 案件候補の絞り込み
// =========================================================================

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


// =========================================================================
// ChoreiAuth.gs — 権限
// =========================================================================

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
    バックアップを作る_('メンバー整理前');
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


// =========================================================================
// ChoreiOrder.gs — 指示
// =========================================================================

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


// =========================================================================
// ChoreiTrigger.gs — 取り込みトリガーの張り替え
// =========================================================================

/**
 * 取り込みトリガーの時刻を組み直す。
 *
 * 夕方の取り込みが 18:00:2x に走り、レポートメールの着信（18:00:05〜18:00:42）と
 * 競合して取りこぼしている。取りこぼした分は翌朝の回が今朝の分と一緒に処理するため、
 * 案件数がちょうど倍になる（9/10〜9/12に発生）。
 *
 * このファイルは朝礼ボードと同じプロジェクトに貼るので、ScriptApp からトリガーを
 * 張り替えられる。トリガー画面を手で触る必要はない。
 */

// 取り込みを走らせる時間帯。nearMinute の窓は前後15分なので、
// 18:30 を指定すると 18:15〜18:45 のどこかで走る。メール着信より確実に後になる。
var INGEST_AM = { hour: 7, minute: 30 };    // 7:15〜7:45。朝5:00の便はもう届いている
var INGEST_PM = { hour: 18, minute: 30 };   // 18:15〜18:45。夕18:00の便に間に合う


/**
 * いま張られているトリガーを一覧する。
 *
 * 注意: Apps Script の API は、トリガーの「何時に走るか」を読み出せない。
 * 取得できるのは実行する関数名・種類・IDだけ。実際の時刻はトリガー画面で見ること。
 */
function トリガー診断() {
  var ts = ScriptApp.getProjectTriggers();
  Logger.log('トリガー ' + ts.length + '件');
  var byFn = {};
  ts.forEach(function (t) {
    var fn = t.getHandlerFunction();
    var type = String(t.getEventType());
    Logger.log('  ' + fn + '  [' + type + ']  id=' + t.getUniqueId());
    byFn[fn] = (byFn[fn] || 0) + 1;
  });
  Logger.log('\n関数ごとの本数:');
  Object.keys(byFn).forEach(function (fn) {
    Logger.log('  ' + fn + ': ' + byFn[fn] + '本' +
               (byFn[fn] >= 2 ? '  ← 朝と夕の2本はこれ' : ''));
  });
  Logger.log('\n※ 何時に走るかはAPIから読めない。時刻はトリガー画面で確認すること。');
  Logger.log('※ 取り込みの関数名が分かったら 取り込みトリガーを組み直す_実行(関数名) を呼ぶ。');
  return ts.map(function (t) {
    return { fn: t.getHandlerFunction(), type: String(t.getEventType()), id: t.getUniqueId() };
  });
}


/** 組み直す前に、何が消えて何ができるかを出す。 */
function 取り込みトリガーを組み直す_ドライラン(handlerName) {
  return rebuildIngestTriggers_(handlerName, false);
}

/**
 * 取り込みトリガーを張り替える。
 *
 * **朝と夕の両方を作り直す。**
 * Apps Script はトリガーの時刻を読み出せないので、「夕方のほうだけ」を選べない。
 * その関数の時刻トリガーを全部消して、朝7:30・夕18:30 の2本を作り直す。
 *
 * @param {string} handlerName 取り込みを実行している関数名。
 *                             トリガー診断() で2本張られている関数がそれ。
 */
function 取り込みトリガーを組み直す_実行(handlerName) {
  return rebuildIngestTriggers_(handlerName, true);
}

function rebuildIngestTriggers_(handlerName, apply) {
  if (!handlerName) {
    throw new Error('関数名を渡すこと。トリガー診断() で、時刻トリガーが2本張られている関数を探す。\n' +
                    '例: 取り込みトリガーを組み直す_実行("ingestMail")');
  }

  var all = ScriptApp.getProjectTriggers();
  var mine = all.filter(function (t) {
    return t.getHandlerFunction() === handlerName &&
           String(t.getEventType()) === String(ScriptApp.EventType.CLOCK);
  });

  if (!mine.length) {
    var names = {};
    all.forEach(function (t) { names[t.getHandlerFunction()] = 1; });
    throw new Error('"' + handlerName + '" の時刻トリガーがありません。\n' +
                    'いまある関数: ' + Object.keys(names).join(', '));
  }

  Logger.log((apply ? '' : '【ドライラン】') + handlerName + ' の時刻トリガーを組み直す');
  Logger.log('  消す: ' + mine.length + '本');
  mine.forEach(function (t) { Logger.log('    id=' + t.getUniqueId()); });
  Logger.log('  作る: 朝 ' + hhmm_(INGEST_AM) + '（' + window_(INGEST_AM) + '）');
  Logger.log('        夕 ' + hhmm_(INGEST_PM) + '（' + window_(INGEST_PM) + '）');
  Logger.log('  夕方のレポートメールは 18:00:05〜18:00:42 に届く。' +
             window_(INGEST_PM) + ' なら確実に後になる。');

  if (!apply) {
    Logger.log('\n問題なければ 取り込みトリガーを組み直す_実行("' + handlerName + '") を呼ぶ。');
    return { deleted: mine.length, handler: handlerName };
  }

  mine.forEach(function (t) { ScriptApp.deleteTrigger(t); });
  [INGEST_AM, INGEST_PM].forEach(function (w) {
    ScriptApp.newTrigger(handlerName).timeBased()
      .atHour(w.hour).nearMinute(w.minute).everyDays(1).create();
  });

  Logger.log('\n組み直した。' + handlerName + ' の時刻トリガーは2本になっている。');
  Logger.log('明日以降、監査ログの ingest 行が files=1 のままなら成功。');
  Logger.log('files=2 が出たら 二重取り込みチェック() が拾うので、その日の数字は使わない。');
  return { deleted: mine.length, created: 2, handler: handlerName };
}

function hhmm_(w) { return w.hour + ':' + (w.minute < 10 ? '0' : '') + w.minute; }

/** nearMinute の窓は前後15分。実際に走りうる範囲を文字列で返す。 */
function window_(w) {
  var f = w.hour * 60 + w.minute - 15, t = w.hour * 60 + w.minute + 15;
  return pad2_(Math.floor(f / 60)) + ':' + pad2_(f % 60) + '〜' +
         pad2_(Math.floor(t / 60)) + ':' + pad2_(t % 60);
}
function pad2_(n) { return (n < 10 ? '0' : '') + n; }


// =========================================================================
// セットアップ — まとめて確認し、まとめて適用する
// =========================================================================

/**
 * 読み取りのみ。適用したら何が起きるかを全部出す。
 * まずこれを実行して、実行ログを上から読むこと。
 */
function セットアップ_確認() {
  var steps = [
    ['いまの状態', 診断],
    ['二重取り込み', 二重取り込みチェック],
    ['案件候補のノイズ', 候補ノイズ診断],
    ['メンバーに足りない人', メンバー追加候補],
    ['月キーと名寄せの修復', 修復_ドライラン],
    ['閲覧のみの人を外す', メンバー_閲覧のみを外す_ドライラン],
    ['指示シートの列追加', 指示_列を追加_ドライラン],
    ['完了済み指示の片付け', 指示_完了済みを片付ける_ドライラン],
    ['権限の一覧', アクセス診断],
    ['トリガー', トリガー診断]
  ];
  steps.forEach(function (s, i) {
    Logger.log('\n===== ' + (i + 1) + '. ' + s[0] + ' =====');
    try { s[1](); } catch (e) { Logger.log('  エラー: ' + e.message); }
  });
  Logger.log('\n確認はここまで。問題なければ セットアップ_実行() を走らせる。');
  Logger.log('トリガーは別。上の一覧で時刻トリガーが2本ある関数を見つけて、');
  Logger.log('  取り込みトリガーを組み直す_実行("その関数名") を呼ぶ。');
}


/**
 * 適用する。最初にスプレッドシート全体のコピーを1つ作る。
 *
 * 先に メンバー追加候補() の出力を メンバー シートに貼っておくこと。
 * 貼っていないと、その人たちの名寄せだけが飛ばされる（他は進む）。
 *
 * 何度実行しても結果は同じ。2回目は差分0になる。
 */
function セットアップ_実行() {
  var backup = DriveApp.getFileById(DATA_SS_ID)
    .makeCopy('【セットアップ前】MSE朝礼ボード_データ ' +
              Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'));
  Logger.log('バックアップ: ' + backup.getUrl());
  BACKUP_TAKEN_ = true;     // 個別の関数が重ねてコピーを作らないようにする

  try {
    var steps = [
      ['月キーと名寄せ', function () { applyRepairPlan_(buildRepairPlan_()); }],
      ['閲覧のみの人を外す', function () { demoteViewers_(true); }],
      ['指示シートの列追加', function () { addOrderCols_(true); }],
      ['完了済み指示の片付け', function () { tidyDoneOrders_(true); }]
    ];
    steps.forEach(function (s, i) {
      Logger.log('\n===== ' + (i + 1) + '. ' + s[0] + ' =====');
      s[1]();
    });

    Logger.log('\n===== 適用後の確認 =====');
    診断();
    var left = buildRepairPlan_();
    Logger.log('やり残しの書き換え: ' + left.total + '（0なら完了）');
    検算_今月();
    Logger.log('\n_診断レポート と _集計検算 のシートを見ること。');
    Logger.log('画面の数字が _集計検算 と合わなければ、画面側の集計が間違っている。');
  } finally {
    BACKUP_TAKEN_ = false;
  }
  Logger.log('\n戻したいときはこのバックアップから: ' + backup.getUrl());
}


