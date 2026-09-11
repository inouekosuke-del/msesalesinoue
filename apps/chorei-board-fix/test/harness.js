const fs=require('fs');
// --- CSV -> rows -----------------------------------------------------------
function parseCSV(t){const rows=[];let f='',r=[],q=false;
 for(let i=0;i<t.length;i++){const c=t[i];
  if(q){ if(c==='"'){ if(t[i+1]==='"'){f+='"';i++;} else q=false; } else f+=c; }
  else if(c==='"') q=true;
  else if(c===','){r.push(f);f='';}
  else if(c==='\n'){r.push(f);rows.push(r);r=[];f='';}
  else if(c!=='\r') f+=c;}
 if(f||r.length){r.push(f);rows.push(r);} return rows;}

const NAMES={ '00':'deals','01':'leave','02':'recovery','03':'teams','04':'planMonth',
 '05':'planDaily','06':'focus','07':'monthTargets','08':'histDaily','09':'histMonth',
 '10':'monthPlan','11':'todo','12':'dailyAm','13':'dailyPm','14':'dealActions',
 '15':'orders','16':'orderResults','17':'plans','18':'members','19':'config',
 '20':'importLog','21':'state' };

const sheets=[];
for(const k of Object.keys(NAMES)){
  const p=`sheets/block${k}.csv`; if(!fs.existsSync(p)) continue;
  sheets.push(makeSheet(NAMES[k], parseCSV(fs.readFileSync(p,'utf8')).filter(r=>r.length>1||r[0]!=='')));
}
const WRITES=[];
function makeSheet(name,rows){
  return {
    _name:name,_rows:rows,
    getName(){return name;},
    getLastRow(){return rows.length;},
    getLastColumn(){return rows.length?rows[0].length:0;},
    getRange(r,c,nr,nc){
      return {
        getValues(){const o=[];for(let i=0;i<(nr||1);i++){const src=rows[r-1+i]||[];const line=[];
          for(let j=0;j<(nc||1);j++)line.push(src[c-1+j]===undefined?'':src[c-1+j]);o.push(line);}return o;},
        setValue(v){WRITES.push({sheet:name,row:r,col:c,value:v});},
        setValues(v){WRITES.push({sheet:name,row:r,col:c,n:v.length});},
        setFontWeight(){return this;},
      };
    },
    clear(){}, setFrozenRows(){}, autoResizeColumn(){},
  };
}

// --- GAS stubs -------------------------------------------------------------
global.Logger={_l:[],log(s){this._l.push(String(s));}};
global.Utilities={formatDate(d,tz,fmt){
  const p=n=>String(n).padStart(2,'0');
  return fmt.replace('yyyy',d.getFullYear()).replace('MM',p(d.getMonth()+1))
            .replace('dd',p(d.getDate())).replace('HH',p(d.getHours())).replace('mm',p(d.getMinutes()));
}};
const fakeSS={getSheets:()=>sheets,getSheetByName:n=>sheets.find(s=>s.getName()===n)||null,
  insertSheet(n){const s=makeSheet(n,[]);sheets.push(s);return s;}};
global.SpreadsheetApp={openById:()=>fakeSS,flush(){}};
global.DriveApp={getFileById:()=>({makeCopy:()=>({getUrl:()=>'(dry)'})})};

// --- load ------------------------------------------------------------------
eval(fs.readFileSync('ChoreiFix.js','utf8'));
eval(fs.readFileSync('ChoreiAgg.js','utf8'));

console.log('===== 診断() =====');
const rep=runDiagnostics_();
for(const r of rep) console.log(r.map(x=>String(x)).join(' | '));

console.log('\n===== 修復_ドライラン() =====');
const plan=buildRepairPlan_();
logPlan_(plan,true);
console.log(Logger._l.join('\n'));
console.log('\n書き込み回数(実行されていないこと):',WRITES.length);

console.log('\n===== 集計_月次見込み("2026-09") =====');
const res=集計_月次見込み('2026-09');
for(const m of res.members){
  if(!m.juchu.count && !m.keijo.count && m.targetJuchu===null) continue;
  console.log(`${m.name}\t受注 ${m.juchu.total.toLocaleString()} (加重 ${Math.round(m.juchu.weighted).toLocaleString()}) 目標 ${tgt_(m.targetJuchu)} ${pct_(m.rateJuchu)}\t計上 ${m.keijo.total.toLocaleString()} 目標 ${tgt_(m.targetKeijo)} ${pct_(m.rateKeijo)}`);
}
console.log('未分類の進捗:',res.unknownStages);
console.log('担当不明の案件:',res.orphans);
console.log('\n--- 検証: 集計後の合計 ---');
const tj=res.members.reduce((s,m)=>s+m.juchu.total,0);
const tk=res.members.reduce((s,m)=>s+m.keijo.total,0);
console.log('受注見込み合計',tj.toLocaleString(),'/ 計上見込み合計',tk.toLocaleString());

console.log('\n===== メンバー追加候補() =====');
Logger._l=[];
メンバー追加候補();
console.log(Logger._l.join('\n'));

// ===== 回帰テスト: 修復を適用してから再診断 =====
console.log('\n===== 回帰テスト =====');
// 1) members に吉牟田・小菅を追加（メンバー追加候補() の出力どおり）
const msh=sheets.find(s=>s.getName()==='members');
msh._rows.push(['yoshimuta','吉牟田','吉牟田 淳嗣','','','member','TRUE','FALSE','0','0','','mse']);
msh._rows.push(['kosuge','小菅','小菅 遥平','','','member','TRUE','FALSE','0','0','','mse']);

// 2) 修復を実際に適用（setValue をシートに反映するよう差し替え）
for(const s of sheets){
  const orig=s.getRange.bind(s);
  s.getRange=(r,c,nr,nc)=>{const g=orig(r,c,nr,nc);const sv=g.setValue.bind(g);
    g.setValue=v=>{while(s._rows.length<r)s._rows.push([]);s._rows[r-1][c-1]=v;return g;};return g;};
}
const plan2=buildRepairPlan_();
console.log('適用するセル数:',plan2.total);
applyRepairPlan_(plan2);

// 3) 再診断
const rep2=runDiagnostics_();
for(const r of rep2.slice(1)) if(/月キー|名寄せ/.test(r[0])) console.log('  ',r[0],'|',r[1],'|',r[2],'|',r[3]);
const plan3=buildRepairPlan_();
console.log('再実行で残る書き換え:',plan3.total,'(0なら冪等)');

// 4) 再集計
const res2=集計_月次見込み('2026-09');
console.log('2026-09 受注見込み合計:',res2.members.reduce((s,m)=>s+m.juchu.total,0).toLocaleString());
console.log('2026-09 計上見込み合計:',res2.members.reduce((s,m)=>s+m.keijo.total,0).toLocaleString());
console.log('担当不明の案件:',res2.orphans.length);
const y=res2.members.find(m=>m.id==='yoshimuta');
console.log('吉牟田が集計対象に入ったか:', y? 'yes (受注'+y.juchu.total+')':'no');
const resNov=集計_月次見込み('2026-11');
const y11=resNov.members.find(m=>m.id==='yoshimuta');
console.log('2026-11 吉牟田 受注見込み:', y11 ? y11.juchu.total.toLocaleString() : '—', '(修復前は担当不明で0だった)');
