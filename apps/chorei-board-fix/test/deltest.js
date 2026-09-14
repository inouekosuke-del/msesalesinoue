const fs=require('fs');
const h=fs.readFileSync('harness2.js','utf8');
eval(h.slice(0,h.indexOf("eval(fs.readFileSync('ChoreiFix.js','utf8'));")));
eval(fs.readFileSync('ChoreiFix.js','utf8'));
eval(fs.readFileSync('ChoreiAuth.js','utf8'));
eval(fs.readFileSync('ChoreiOrder.js','utf8'));

Logger._l=[]; 指示_列を追加_実行(); console.log(Logger._l[0]);
console.log('\n一覧の初期件数:', 指示の消化状況().length, '件（active=TRUE のまま残っているもの）');

console.log('\n=== 片付け（完了済み＋削除済み）===');
Logger._l=[]; 指示_完了済みを片付ける_実行();
console.log(Logger._l.filter(l=>/件$|\[/.test(l)).slice(0,4).join('\n'));
console.log('  …');
console.log('片付け後:', 指示の消化状況().length, '件');
for(const r of 指示の消化状況()) console.log('   残:', r.who, r.what.slice(0,30));

console.log('\n=== 削除してみる ===');
const 残り=指示の消化状況()[0];
Logger._l=[]; 指示を削除する(残り.id,'井上'); console.log(' ',Logger._l.join('\n  '));
console.log('削除後:', 指示の消化状況().length, '件（0なら一覧から消えた）');

console.log('\n=== シートの状態を確認 ===');
const sh=SpreadsheetApp.openById().getSheetByName('指示');
const hd=sh._rows[0];
const row=sh._rows.find(r=>String(r[hd.indexOf('id')])===String(残り.id));
console.log('  行は残っているか:', row?'はい（消していない）':'いいえ');
console.log('  active   =', row[hd.indexOf('active')]);
console.log('  deletedAt=', row[hd.indexOf('deletedAt')]);
console.log('  deletedBy=', row[hd.indexOf('deletedBy')]);
console.log('  text     =', String(row[hd.indexOf('text')]).slice(0,28), '← 内容は残る');

console.log('\n=== 戻せるか ===');
row[hd.indexOf('active')]='TRUE'; row[hd.indexOf('deletedAt')]='';
console.log('  active=TRUE / deletedAt 空 に戻すと ->', 指示の消化状況().length, '件（1なら復活）');

console.log('\n=== 存在しないid ===');
try{ 指示を削除する('nosuch'); }catch(e){ console.log(' ',e.message); }
