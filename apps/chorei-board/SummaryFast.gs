/**
 * SummaryFast.gs — 朝礼ボード「朝礼・終礼のまとめ」高速化モジュール
 *
 * 既存コードには一切手を入れない追加ファイル。Apps Scriptエディタに
 * 新規 .gs として貼り、まとめビューの呼び出し先だけ CB_getSummaryFast に差し替える。
 *
 * 前提を1つも置かないための作り：
 *  - シートは「名前」ではなく「ヘッダー行の並び」で特定する（タブ名が分からなくても動く）
 *  - 列は必ずヘッダー名から引く（列順が変わっても壊れない）
 *  - 案件明細（約4,700行）は参照された dealId のぶんだけ、1回の読み込みで解決する
 *
 * 想定効果：まとめ1回あたりのセル読み込みが 9万 → 1.5万 程度、
 * かつ2回目以降は CacheService で 0 になる。
 */

var CB_CACHE_PREFIX = 'cbsum_v2_';
var CB_CACHE_TTL_SEC = 600;          // 10分。提出時に CB_invalidateSummary で捨てる
var CB_CACHE_MAX_BYTES = 90 * 1024;  // CacheService の 100KB 制限に対する安全域

/** チーム選択（UIの値）→ members.team の対応。UIの選択肢が増えたらここだけ直す */
var CB_TEAM_MAP = {
  'MSE':      ['mse', 'admin'],
  'サクセス':  ['success'],
  'CS':       ['cs'],
  'ALL':      null   // null は全チーム
};

/** ヘッダー署名。先頭いくつかが一致すればそのシートと判定する */
var CB_SHEET_SIG = {
  deals:    ['lineId', 'oppId', 'title', 'company'],
  members:  ['id', 'name', 'sfName', 'email', 'slackId'],
  am:       ['date', 'memberId', 'postedAt', 'juchuFc', 'keijoFc', 'status', 'goal', 'plan', 'act'],
  pm:       ['date', 'memberId', 'postedAt', 'juchuFc', 'keijoFc', 'status', 'goal', 'plan', 'why']
};

// ───────────────────────────────── 公開API

/**
 * まとめビュー用データを返す。
 * @param {Object} p {kind:'朝礼'|'終礼', team:'MSE'|'サクセス'|'CS'|'ALL', date:'YYYY-MM-DD'}
 * @return {Object} {ok, date, kind, team, cached, elapsedMs, blocks:[{
 *           memberId, name, slackId, postedAt, juchuFc, keijoFc, goal, plan, help,
 *           items:[{company, title, juchuDate, amount, probFrom, probTo, acts}]
 *         }], missing:[{memberId,name,slackId}]}
 */
function CB_getSummaryFast(p) {
  var t0 = new Date().getTime();
  p = p || {};
  var kind = p.kind || '朝礼';
  var team = p.team || 'ALL';
  var date = CB_dateKey_(p.date || new Date());

  var key = CB_CACHE_PREFIX + kind + '_' + team + '_' + date;
  var cache = CacheService.getScriptCache();
  var hit = cache.get(key);
  if (hit) {
    var cachedObj = JSON.parse(hit);
    cachedObj.cached = true;
    cachedObj.elapsedMs = new Date().getTime() - t0;
    return cachedObj;
  }

  var ss = SpreadsheetApp.getActive();
  var sheets = CB_resolveSheets_(ss);

  var members = CB_readMembers_(sheets.members, team);
  var reportSheet = (kind === '終礼') ? sheets.pm : sheets.am;
  var reports = CB_readReportsForDate_(reportSheet, date);

  // 参照された dealId を集めてから、案件明細を1回だけ読む
  var wanted = {};
  for (var i = 0; i < reports.length; i++) {
    var ids = CB_collectDealIds_(reports[i]);
    for (var j = 0; j < ids.length; j++) wanted[ids[j]] = true;
  }
  var dealIndex = CB_lookupDeals_(sheets.deals, wanted);

  var blocks = [];
  var posted = {};
  for (var k = 0; k < reports.length; k++) {
    var r = reports[k];
    var m = members.byId[r.memberId];
    if (!m) continue;                 // 対象チーム外は落とす
    posted[r.memberId] = true;
    blocks.push(CB_buildBlock_(r, m, dealIndex, kind));
  }
  blocks.sort(function(a, b) {
    var x = (a.sort == null) ? 9999 : a.sort;   // 0 を falsy で潰さない
    var y = (b.sort == null) ? 9999 : b.sort;
    return x - y;
  });

  var missing = [];
  for (var n = 0; n < members.list.length; n++) {
    var mm = members.list[n];
    if (mm.alert && !posted[mm.id]) {
      missing.push({ memberId: mm.id, name: mm.name, slackId: mm.slackId });
    }
  }

  var out = {
    ok: true, date: date, kind: kind, team: team,
    cached: false, blocks: blocks, missing: missing
  };
  var json = JSON.stringify(out);
  if (json.length < CB_CACHE_MAX_BYTES) cache.put(key, json, CB_CACHE_TTL_SEC);

  out.elapsedMs = new Date().getTime() - t0;
  return out;
}

/** 提出・更新のあとに呼ぶ。該当日のキャッシュだけ捨てる */
function CB_invalidateSummary(p) {
  p = p || {};
  var date = CB_dateKey_(p.date || new Date());
  var kinds = p.kind ? [p.kind] : ['朝礼', '終礼'];
  var teams = Object.keys(CB_TEAM_MAP);
  var keys = [];
  for (var i = 0; i < kinds.length; i++) {
    for (var j = 0; j < teams.length; j++) {
      keys.push(CB_CACHE_PREFIX + kinds[i] + '_' + teams[j] + '_' + date);
    }
  }
  CacheService.getScriptCache().removeAll(keys);
  return keys.length;
}

// ───────────────────────────────── シート解決

/**
 * ヘッダー署名でシートを特定する。結果はスクリプトプロパティに覚えるので
 * 2回目以降は全タブ走査をしない。タブ名が変わったら自動で拾い直す。
 */
function CB_resolveSheets_(ss) {
  var props = PropertiesService.getScriptProperties();
  var cached = props.getProperty('CB_SHEETMAP_V2');
  var map = cached ? JSON.parse(cached) : null;

  if (map && CB_sheetMapValid_(ss, map)) {
    return {
      deals:   ss.getSheetByName(map.deals),
      members: ss.getSheetByName(map.members),
      am:      ss.getSheetByName(map.am),
      pm:      ss.getSheetByName(map.pm)
    };
  }

  map = {};
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) {
    var sh = all[i];
    if (sh.getLastRow() < 1 || sh.getLastColumn() < 2) continue;
    var header = sh.getRange(1, 1, 1, sh.getLastColumn()).getValues()[0];
    for (var name in CB_SHEET_SIG) {
      if (map[name]) continue;
      if (CB_headerMatches_(header, CB_SHEET_SIG[name])) map[name] = sh.getName();
    }
  }
  var need = ['deals', 'members', 'am', 'pm'];
  for (var n = 0; n < need.length; n++) {
    if (!map[need[n]]) throw new Error('シートを特定できません: ' + need[n] +
      '（ヘッダー行が想定と違う可能性。CB_SHEET_SIG を見直してください）');
  }
  props.setProperty('CB_SHEETMAP_V2', JSON.stringify(map));
  return {
    deals:   ss.getSheetByName(map.deals),
    members: ss.getSheetByName(map.members),
    am:      ss.getSheetByName(map.am),
    pm:      ss.getSheetByName(map.pm)
  };
}

function CB_sheetMapValid_(ss, map) {
  var need = ['deals', 'members', 'am', 'pm'];
  for (var i = 0; i < need.length; i++) {
    var sh = map[need[i]] ? ss.getSheetByName(map[need[i]]) : null;
    if (!sh) return false;
    var header = sh.getRange(1, 1, 1, Math.min(sh.getLastColumn(), 10)).getValues()[0];
    if (!CB_headerMatches_(header, CB_SHEET_SIG[need[i]])) return false;
  }
  return true;
}

function CB_headerMatches_(header, sig) {
  for (var i = 0; i < sig.length; i++) {
    if (String(header[i]).trim() !== sig[i]) return false;
  }
  return true;
}

function CB_colMap_(sheet) {
  var header = sheet.getRange(1, 1, 1, sheet.getLastColumn()).getValues()[0];
  var map = {};
  for (var i = 0; i < header.length; i++) {
    var h = String(header[i]).trim();
    if (h) map[h] = i;
  }
  return map;
}

// ───────────────────────────────── 読み込み

function CB_readMembers_(sheet, team) {
  var last = sheet.getLastRow();
  var byId = {}, list = [];
  if (last < 2) return { byId: byId, list: list };

  var col = CB_colMap_(sheet);
  var rows = sheet.getRange(2, 1, last - 1, sheet.getLastColumn()).getValues();
  var allowed = CB_TEAM_MAP.hasOwnProperty(team) ? CB_TEAM_MAP[team] : null;

  for (var i = 0; i < rows.length; i++) {
    var r = rows[i];
    if (String(r[col['active']]).toUpperCase() !== 'TRUE') continue;
    var t = String(r[col['team']] || '').trim();
    if (allowed && allowed.indexOf(t) === -1) continue;
    var m = {
      id: String(r[col['id']] || '').trim(),
      name: String(r[col['name']] || '').trim(),
      slackId: String(r[col['slackId']] || '').trim(),
      team: t,
      alert: String(r[col['alert']]).toUpperCase() === 'TRUE',
      sort: i
    };
    if (!m.id) continue;
    byId[m.id] = m;
    list.push(m);
  }
  return { byId: byId, list: list };
}

/**
 * 日付列だけを先に1列読み、一致した行だけを本読みする。
 * 報告シートが年間ぶん溜まっても読み込み量が増えない。
 */
function CB_readReportsForDate_(sheet, dateKey) {
  var last = sheet.getLastRow();
  if (last < 2) return [];

  var col = CB_colMap_(sheet);
  var dateCol = col['date'] + 1;
  var dates = sheet.getRange(2, dateCol, last - 1, 1).getValues();

  var hitRows = [];
  for (var i = 0; i < dates.length; i++) {
    if (CB_dateKey_(dates[i][0]) === dateKey) hitRows.push(i + 2);
  }
  if (!hitRows.length) return [];

  // 連続した行はまとめて読む
  var width = sheet.getLastColumn();
  var out = [];
  var start = hitRows[0], prev = hitRows[0];
  for (var j = 1; j <= hitRows.length; j++) {
    var cur = hitRows[j];
    if (cur !== prev + 1) {
      var vals = sheet.getRange(start, 1, prev - start + 1, width).getValues();
      for (var k = 0; k < vals.length; k++) out.push(CB_rowToObj_(vals[k], col));
      start = cur;
    }
    prev = cur;
  }
  return out;
}

function CB_rowToObj_(row, col) {
  var o = {};
  for (var name in col) o[name] = row[col[name]];
  o.memberId = String(o.memberId || '').trim();
  return o;
}

/** items / results から dealId(lineId) を集める */
function CB_collectDealIds_(rep) {
  var ids = [];
  var fields = ['items', 'results'];
  for (var f = 0; f < fields.length; f++) {
    var raw = rep[fields[f]];
    if (!raw) continue;
    var arr;
    try { arr = JSON.parse(raw); } catch (e) { continue; }
    if (!arr || !arr.length) continue;
    for (var i = 0; i < arr.length; i++) {
      var id = arr[i] && (arr[i].dealId || arr[i].lineId);
      if (id) ids.push(String(id));
    }
  }
  return ids;
}

/**
 * 案件明細を1回だけ、必要な3列だけ読んで、欲しい lineId だけ拾う。
 * 全件 getDataRange().getValues() との差はセル数で約6分の1。
 */
function CB_lookupDeals_(sheet, wanted) {
  var index = {};
  var keys = Object.keys(wanted);
  if (!keys.length) return index;

  var last = sheet.getLastRow();
  if (last < 2) return index;

  var col = CB_colMap_(sheet);
  var need = ['lineId', 'title', 'juchuDate'];
  var min = last, max = 1;
  for (var i = 0; i < need.length; i++) {
    var c = col[need[i]] + 1;
    if (c < min) min = c;
    if (c > max) max = c;
  }
  var block = sheet.getRange(2, min, last - 1, max - min + 1).getValues();
  var oLine = col['lineId'] - (min - 1);
  var oTitle = col['title'] - (min - 1);
  var oDate = col['juchuDate'] - (min - 1);

  var remaining = keys.length;
  for (var r = 0; r < block.length && remaining > 0; r++) {
    var id = String(block[r][oLine] || '');
    if (!id || !wanted[id] || index[id]) continue;
    index[id] = {
      title: String(block[r][oTitle] || ''),
      juchuDate: CB_dateKey_(block[r][oDate])
    };
    remaining--;
  }
  return index;
}

// ───────────────────────────────── 組み立て

function CB_buildBlock_(rep, member, dealIndex, kind) {
  var srcField = (kind === '終礼') ? 'results' : 'items';
  var arr = [];
  try { arr = JSON.parse(rep[srcField] || '[]') || []; } catch (e) { arr = []; }

  var items = [];
  for (var i = 0; i < arr.length; i++) {
    var it = arr[i];
    if (!it || !it.company) continue;
    var id = String(it.dealId || it.lineId || '');
    var d = dealIndex[id] || {};
    items.push({
      company: String(it.company),
      title: d.title || '',
      juchuDate: d.juchuDate || '',
      amount: Number(it.amount) || 0,
      probFrom: String(it.prob || it.probFrom || ''),
      probTo: String(it.aim || it.probTo || ''),
      acts: String(it.acts || it.result || ''),
      note: String(it.note || '')
    });
  }

  return {
    memberId: member.id,
    name: member.name,
    slackId: member.slackId,
    sort: member.sort,
    postedAt: CB_timeStr_(rep.postedAt),
    juchuFc: Number(rep.juchuFc) || 0,
    keijoFc: Number(rep.keijoFc) || 0,
    goal: Number(rep.goal) || 0,
    plan: String(rep.plan || ''),
    help: String(rep.help || ''),
    itemCount: items.length,
    items: items
  };
}

// ───────────────────────────────── ユーティリティ

/** Date / 'YYYY-MM-DD' / 'YYYY/M/D' のどれが来ても 'YYYY-MM-DD' に揃える */
function CB_dateKey_(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  }
  var s = String(v).trim();
  var m = s.match(/^(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})/);
  if (!m) return '';
  return m[1] + '-' + ('0' + m[2]).slice(-2) + '-' + ('0' + m[3]).slice(-2);
}

function CB_timeStr_(v) {
  if (v == null || v === '') return '';
  if (Object.prototype.toString.call(v) === '[object Date]') {
    if (isNaN(v.getTime())) return '';
    return Utilities.formatDate(v, Session.getScriptTimeZone(), 'HH:mm');
  }
  return String(v).trim();
}

// ───────────────────────────────── 計測・点検

/** 実行ログに所要時間を出す。改修前後の比較用 */
function CB_benchSummary() {
  var p = { kind: '朝礼', team: 'MSE', date: CB_dateKey_(new Date()) };
  CB_invalidateSummary(p);
  var cold = CB_getSummaryFast(p);
  var warm = CB_getSummaryFast(p);
  Logger.log('cold=%sms blocks=%s / warm=%sms(cached=%s)',
    cold.elapsedMs, cold.blocks.length, warm.elapsedMs, warm.cached);
  return { coldMs: cold.elapsedMs, warmMs: warm.elapsedMs, blocks: cold.blocks.length };
}

/** 朝礼の自動投稿が止まっている件の一次点検。トリガーの生き死にを一覧する */
function CB_listTriggers() {
  var ts = ScriptApp.getProjectTriggers();
  var rows = ts.map(function(t) {
    var at = '';
    try { at = t.getTriggerSource() + '/' + t.getEventType(); } catch (e) { at = '?'; }
    return t.getHandlerFunction() + '  ' + at;
  });
  Logger.log('triggers=%s\n%s', ts.length, rows.join('\n'));
  return rows;
}
