const fs=require('fs');
const h=fs.readFileSync('harness2.js','utf8');
eval(h.slice(0,h.indexOf("eval(fs.readFileSync('ChoreiFix.js','utf8'));")));
eval(fs.readFileSync('ChoreiFix.js','utf8'));
eval(fs.readFileSync('ChoreiAuth.js','utf8'));
eval(fs.readFileSync('ChoreiOrder.js','utf8'));

const opt=指示フォームの選択肢();
console.log('=== scope プルダウン ===');
opt.scopes.forEach(o=>console.log(`  ${o.value.padEnd(5)} ${o.label}`));
console.log('\n=== scope=team のときの対象 ===');
opt.teams.forEach(o=>console.log(`  ${o.value.padEnd(9)} ${o.label}`));
console.log('\n=== scope=one のときの対象 ===');
opt.members.forEach(o=>console.log(`  ${o.value.padEnd(10)} ${o.label}`));

console.log('\n=== 各チームに実際に何人展開されるか ===');
for(const t of opt.teams){
  const to=指示の宛先({scope:'team',targetId:t.value});
  console.log(`  ${t.label.padEnd(18)} -> ${to.length}名 [${to.join(', ')}]`);
}
console.log('  全員                 ->', 指示の宛先({scope:'all'}).length+'名');

console.log('\n=== 実際に出してみる（successチームに3件）===');
const o={scope:'team',targetId:'success',actionId:'partner',targetKind:'list',
         targetRef:'代理店リスト',count:3,due:'2026-09-25 18:00',must:false};
console.log('  検証:', 指示を検証(o).length===0?'エラーなし':指示を検証(o));
console.log('  文面:', 指示の文面(o));
console.log('  宛先:', 指示の宛先(o).join(', '));
Logger._l=[]; 指示_列を追加_実行(); 指示を出す(o);
console.log('\n=== 一覧（竹内さんの画面）===');
for(const r of 指示の消化状況('takeuchi')) console.log(`  ${r.who} ${r.done??'-'}/${r.count??'-'}  ${r.what.slice(0,44)}`);
console.log('=== 一覧（広瀬さんの画面 / successではない）===');
console.log('  successの指示が見えていないこと ->',
  指示の消化状況('hirose').some(r=>r.what.indexOf('success')>=0)?'NG 見えている':'OK 見えていない');
