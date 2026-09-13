const fs=require('fs'),path=require('path');
function parseCSV(t){const rows=[];let f='',r=[],q=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){ if(c==='"'){ if(t[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
  else if(c==='"') q=true; else if(c===','){r.push(f);f='';}
  else if(c==='\n'){r.push(f);rows.push(r);r=[];f='';} else if(c!=='\r') f+=c;}
 if(f||r.length){r.push(f);rows.push(r);} return rows;}
// xlsx由来のCSVは日付が 'YYYY-MM-DD HH:MM:SS' 文字列。実GASと同じく Date に戻す
const DATEISH=/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/;
const DATECOLS=new Set(['juchuDate','juchuMonth','kenshuDate','kenshuMonth','sfUpdated','importedAt','month','at','todoDue','createdAt','doneAt','updatedAt','due','date']);
const WRITES=[];
function makeSheet(name,rows){
 return {getName:()=>name,getLastRow:()=>rows.length,getLastColumn:()=>rows.length?rows[0].length:0,
  _rows:rows,
  getRange(r,c,nr,nc){const self=this;return{
    getValues(){const o=[];for(let i=0;i<(nr||1);i++){const src=rows[r-1+i]||[],l=[];
      for(let j=0;j<(nc||1);j++){let v=src[c-1+j];if(v===undefined)v='';l.push(v);}o.push(l);}return o;},
    setValue(v){WRITES.push({t:'cell',sheet:name,row:r,col:c,v});while(rows.length<r)rows.push([]);rows[r-1][c-1]=v;return this;},
    setValues(v){WRITES.push({t:'bulk',sheet:name,row:r,col:c,n:v.length});
      for(let i=0;i<v.length;i++){while(rows.length<r+i)rows.push([]);
        for(let j=0;j<v[i].length;j++)rows[r-1+i][c-1+j]=v[i][j];}return this;},
    setNumberFormat(f){WRITES.push({t:'fmt',sheet:name,col:c,f});return this;},
    setFontWeight(){return this;},
  };},
  clear(){},setFrozenRows(){},autoResizeColumn(){},
  getMaxRows(){return Math.max(rows.length,1);},
  appendRow(v){rows.push(v.map(x=>x===undefined?'':x));WRITES.push({t:'append',sheet:name,n:v.length});}};
}
const order=['取込_案件','休み','挽回コミット','活動種別','プラン計画','行動ログ','フリーTODO','月別目標','行動履歴','行動履歴_月次','月次','取込_TODO','朝礼ログ','終礼ログ','TODOログ','指示','指示回答','アクションプラン','メンバー','設定','監査ログ','内部状態'];
const sheets=[];
for(const nm of order){
  const p='sheets/'+nm+'.csv'; if(!fs.existsSync(p)) continue;
  const rows=parseCSV(fs.readFileSync(p,'utf8')).filter(r=>r.length>1||r[0]!=='');
  const hdr=rows[0]||[];
  for(let i=1;i<rows.length;i++) for(let j=0;j<hdr.length;j++){
    const v=rows[i][j];
    if(typeof v==='string'&&DATEISH.test(v)&&DATECOLS.has(hdr[j])) rows[i][j]=new Date(v.replace(' ','T'));
  }
  sheets.push(makeSheet(nm,rows));
}
global.Logger={_l:[],log(s){this._l.push(String(s));}};
global.Utilities={formatDate(d,tz,fmt){const p=n=>String(n).padStart(2,'0');
 // SimpleDateFormat 相当。長いパターンから順に置換する（MM を M より先に）
 return fmt.replace(/yyyy|MM|dd|HH|mm|ss|M|d|H/g,t=>({
   yyyy:d.getFullYear(), MM:p(d.getMonth()+1), dd:p(d.getDate()),
   HH:p(d.getHours()), mm:p(d.getMinutes()), ss:p(d.getSeconds()),
   M:d.getMonth()+1, d:d.getDate(), H:d.getHours()}[t]));}};
const ss={getSheets:()=>sheets,getSheetByName:n=>sheets.find(s=>s.getName()===n)||null,
 insertSheet(n){const s=makeSheet(n,[]);sheets.push(s);return s;}};
global.SpreadsheetApp={openById:()=>ss,flush(){}};
global.Utilities.getUuid=()=>'abcd1234efgh';
global.LOGIN='inoue.kosuke@makeshop.co.jp';
global.Session={getActiveUser:()=>({getEmail:()=>global.LOGIN})};
global.DriveApp={getFileById:()=>({makeCopy:()=>({getUrl:()=>'(test)'})})};
eval(fs.readFileSync('ChoreiFix.js','utf8'));
eval(fs.readFileSync('ChoreiAgg.js','utf8'));
eval(fs.readFileSync('ChoreiPick.js','utf8'));
eval(fs.readFileSync('ChoreiAuth.js','utf8'));
eval(fs.readFileSync('ChoreiOrder.js','utf8'));

console.log('===== 診断() =====');
for(const r of runDiagnostics_()) console.log(r.map(String).join(' | '));
console.log('\n===== 修復_ドライラン() =====');
const plan=buildRepairPlan_(); logPlan_(plan,true);
console.log(Logger._l.join('\n')); Logger._l=[];
console.log('ドライラン中の書き込み:',WRITES.length,'(0であること)');
module.exports={sheets,plan,WRITES};

console.log('\n===== 回帰テスト =====');
const msh=sheets.find(s=>s.getName()==='メンバー');
[['yoshimuta','吉牟田','吉牟田 淳嗣','','U02693MDCQN','member','TRUE','TRUE',0,0,'','mse'],
 ['kosuge','小菅','小菅 遥平','','U0A6KNQK7JP','member','TRUE','TRUE',0,0,'','mse'],
 ['shigematsu','重松','重松 篤弘','','','member','FALSE','FALSE',0,0,'','mse'],
 ['tsurukawa','鶴川','鶴川 大介','','','member','FALSE','FALSE',0,0,'','mse'],
 ['tsujii','辻井','辻井 利由貴','','','member','FALSE','FALSE',0,0,'','mse'],
 ['takemotoy','竹本佳','竹本 佳和','','','member','FALSE','FALSE',0,0,'','mse'],
].forEach(r=>msh._rows.push(r));

const p2=buildRepairPlan_();
console.log('適用: 列一括',(p2.columnWrites||[]).length,'/ セル',p2.edits.length,'/ 合計',p2.total);
applyRepairPlan_(p2);
const fmts=WRITES.filter(w=>w.t==='fmt');
console.log('setNumberFormat 呼び出し:',fmts.length,'→',fmts.map(f=>'第'+f.col+'列='+f.f).join(' '));
console.log('setValues(一括) 呼び出し:',WRITES.filter(w=>w.t==='bulk').length);

for(const r of runDiagnostics_()) if(/名寄せ|月キー/.test(r[0])) console.log('  ',r[0],'|',r[1],'|',r[2]);
const p3=buildRepairPlan_();
console.log('再実行で残る書き換え:',p3.total,'(0なら冪等)');

console.log('\n--- 2026-09 集計（ロスト含む全件／修復後）---');
const res=集計_月次見込み('2026-09');
let tj=0,tk=0;
for(const m of res.members){ tj+=m.juchu.total; tk+=m.keijo.total;
  if(m.juchu.count||m.keijo.count) console.log(`  ${m.name}\t受注 ${m.juchu.total.toLocaleString()} (加重 ${Math.round(m.juchu.weighted).toLocaleString()})\t計上 ${m.keijo.total.toLocaleString()}\t目標 ${tgt_(m.targetJuchu)}/${tgt_(m.targetKeijo)}`);}
console.log('  合計 受注',tj.toLocaleString(),'/ 計上',tk.toLocaleString());
console.log('  担当不明:',res.orphans.length,'/ 未分類の進捗:',JSON.stringify(res.unknownStages));

console.log('\n===== 二重取り込みチェック() =====');
Logger._l=[]; 二重取り込みチェック(); console.log(Logger._l.join('\n'));

console.log('\n===== 候補ノイズ診断() =====');
Logger._l=[]; 候補ノイズ診断(); console.log(Logger._l.join('\n'));
console.log('\n植松の候補 上位8件:');
for(const d of 案件候補('uematsu').slice(0,8))
  console.log(`  ${d.stage}\t${d.amount.toLocaleString().padStart(11)}\t${d.juchuDate}\t${d.company.slice(0,24)}`);
console.log('  植松の候補 合計:',案件候補('uematsu').length,'件');

console.log('\n===== 指示_列を追加 =====');
Logger._l=[]; 指示_列を追加_ドライラン(); 指示_列を追加_実行(); console.log(Logger._l.join('\n'));

console.log('\n===== 指示を出す（検証）=====');
const NG=[
  {label:'施策が存在しない', o:{scope:'one',targetId:'uematsu',actionId:'nosuch',targetRef:'代理店リスト',count:5,due:'2026-09-20 18:00'}},
  {label:'件数が0',        o:{scope:'one',targetId:'uematsu',actionId:'partner',targetRef:'代理店リスト',count:0,due:'2026-09-20 18:00'}},
  {label:'期限が過去',      o:{scope:'one',targetId:'uematsu',actionId:'partner',targetRef:'代理店リスト',count:5,due:'2026-09-01 18:00'}},
  {label:'担当が居ない',    o:{scope:'one',targetId:'dareka',actionId:'partner',targetRef:'代理店リスト',count:5,due:'2026-09-20 18:00'}},
  {label:'対象が空',        o:{scope:'one',targetId:'uematsu',actionId:'partner',targetRef:'',count:5,due:'2026-09-20 18:00'}},
];
for(const t of NG) console.log(`  ${t.label}: ${指示を検証(t.o).join(' / ')}`);

const ok={scope:'one',targetId:'uematsu',actionId:'partner',targetKind:'list',targetRef:'代理店リスト',count:5,due:'2026-09-20 18:00',must:true};
console.log('  正常:',指示を検証(ok).length===0?'エラーなし':指示を検証(ok));
console.log('  文面:',指示の文面(ok));
Logger._l=[]; 指示を出す(ok); console.log(' ',Logger._l.join('\n'));

console.log('\n===== 指示の消化状況() =====');
for(const r of 指示の消化状況().slice(0,6))
  console.log(`  [${r.期限切れ?'期限切れ':'　　　　'}]${r.must?'[必達]':'      '} ${r.who}\t${r.done}/${r.count}\t~${r.due}\t${r.what.slice(0,42)}`);

console.log('\n===== 権限 =====');
Logger._l=[]; アクセス診断(); console.log(Logger._l.join('\n'));
for(const e of ['tamura@makeshop.co.jp','dareka@makeshop.co.jp','soto@example.com']){
  const a=権限を判定(e);
  console.log(`  ${e.padEnd(30)} ok=${a.ok} role=${a.role||'-'} 指示=${a.can.issue} 編集=${a.can.edit} ${a.reason}`);
}

console.log('\n===== メンバー_閲覧のみを外す =====');
Logger._l=[]; メンバー_閲覧のみを外す_ドライラン(); console.log(Logger._l.join('\n'));
Logger._l=[]; メンバー_閲覧のみを外す_実行(); console.log(Logger._l.slice(-1).join('\n'));
console.log('  外した後:', 権限を判定('tamura@makeshop.co.jp').role, '/ 編集', 権限を判定('tamura@makeshop.co.jp').can.edit);
console.log('  チーム一覧:', チーム一覧().join(' / '));

console.log('\n===== 全員 / チーム / 個人 =====');
for(const t of [
  {scope:'all',  targetId:'',        label:'全員'},
  {scope:'team', targetId:'success',  label:'チーム'},
  {scope:'team', targetId:'nosuch',   label:'存在しないチーム'},
  {scope:'one',  targetId:'hirose',   label:'個人'},
  {scope:'one',  targetId:'tamura',   label:'無効化した人'},
]){
  const o={...t,actionId:'partner',targetKind:'list',targetRef:'代理店リスト',count:3,due:'2026-09-20 18:00'};
  const e=指示を検証(o);
  console.log(`  ${t.label.padEnd(9)} ${e.length? 'NG: '+e.join(' / ') : 'OK  宛先='+指示の宛先(o).join(',')}`);
  if(!e.length) console.log(`             文面: ${指示の文面(o)}`);
}

console.log('\n===== 権限のない人が指示を出す =====');
for(const who of ['hirose@makeshop.co.jp','dareka@makeshop.co.jp','takeuchi@makeshop.co.jp']){
  global.LOGIN=who;
  try{ 指示権限を要求_(); console.log(`  ${who.padEnd(28)} → 出せる`); }
  catch(e){ console.log(`  ${who.padEnd(28)} → ${e.message}`); }
}
global.LOGIN='inoue.kosuke@makeshop.co.jp';

console.log('\n===== 指示の完了 =====');
Logger._l=[]; 指示_完了済みを片付ける_ドライラン(); console.log(Logger._l.join('\n'));
Logger._l=[]; 指示_完了済みを片付ける_実行(); console.log(Logger._l.slice(-2).join('\n'));
Logger._l=[]; 指示を完了にする('abcd1234','井上'); console.log(Logger._l.join('\n'));
console.log('片付け後に残る指示:', 指示の消化状況().length,'件');
for(const r of 指示の消化状況()) console.log('  ',r.who,r.what.slice(0,36));
Logger._l=[]; 指示_完了済みを片付ける_ドライラン(); console.log(Logger._l[0],'(0件なら冪等)');
