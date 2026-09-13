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
      for(let i=0;i<v.length;i++){while(rows.length<r+i)rows.push([]);rows[r-1+i][c-1]=v[i][0];}return this;},
    setNumberFormat(f){WRITES.push({t:'fmt',sheet:name,col:c,f});return this;},
    setFontWeight(){return this;},
  };},
  clear(){},setFrozenRows(){},autoResizeColumn(){}};
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
 return fmt.replace('yyyy',d.getFullYear()).replace('MM',p(d.getMonth()+1)).replace('dd',p(d.getDate()))
           .replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes())).replace('ss',p(d.getSeconds()));}};
const ss={getSheets:()=>sheets,getSheetByName:n=>sheets.find(s=>s.getName()===n)||null,
 insertSheet(n){const s=makeSheet(n,[]);sheets.push(s);return s;}};
global.SpreadsheetApp={openById:()=>ss,flush(){}};
global.DriveApp={getFileById:()=>({makeCopy:()=>({getUrl:()=>'(test)'})})};
eval(fs.readFileSync('ChoreiFix.js','utf8'));
eval(fs.readFileSync('ChoreiAgg.js','utf8'));

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
