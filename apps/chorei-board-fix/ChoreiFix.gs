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

  var backup = DriveApp.getFileById(DATA_SS_ID)
    .makeCopy('【修復前バックアップ】MSE朝礼ボード_データ ' +
              Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'));
  Logger.log('バックアップ: ' + backup.getUrl());

  applyRepairPlan_(plan);
  logPlan_(plan, false);
  Logger.log('バックアップ: ' + backup.getUrl());
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
    rows.push(['1 取り込み', '中身まで同一の重複行（二重取り込みの残骸）',
      exactDup, exactDup ? '同じレポートを2回処理した可能性' : '—',
      exactDup ? '取り込みを全消し→全書き込みにするか、書き込み前に重複を落とす' : 'OK']);

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
        multi.length ? 'その日の数字は倍になっている可能性がある。取り込み側の修正が必要' : 'OK']);
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
    var m = s.match(/^(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
    if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
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
