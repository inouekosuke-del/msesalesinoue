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
