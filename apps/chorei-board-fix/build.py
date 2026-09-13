"""5本の .gs を1本にまとめて bundle/ChoreiBundle.gs を作る。

Apps Script に貼るファイルを1つにするためだけのもの。
中身は各ファイルのままで、順番と見出しを足しているだけ。
編集は必ず元の .gs 側で行い、そのあとこれを流す。
"""
import os, io

ORDER = [
    ('ChoreiFix.gs',   '診断・修復と共通ヘルパー'),
    ('ChoreiAgg.gs',   '集計の参照実装'),
    ('ChoreiPick.gs',  '案件候補の絞り込み'),
    ('ChoreiAuth.gs',  '権限'),
    ('ChoreiOrder.gs', '指示'),
    ('ChoreiTrigger.gs','取り込みトリガーの張り替え'),
]
HERE = os.path.dirname(os.path.abspath(__file__))

parts = ["""/**
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
"""]

for fn, label in ORDER:
    src = io.open(os.path.join(HERE, fn), encoding='utf-8').read().rstrip()
    parts.append('\n\n// ' + '=' * 73 +
                 '\n// ' + fn + ' — ' + label +
                 '\n// ' + '=' * 73 + '\n\n' + src)

parts.append(io.open(os.path.join(HERE, 'setup.gs.part'), encoding='utf-8').read())

out = os.path.join(HERE, 'bundle', 'ChoreiBundle.gs')
os.makedirs(os.path.dirname(out), exist_ok=True)
io.open(out, 'w', encoding='utf-8').write('\n'.join(parts) + '\n')
print('wrote', out, os.path.getsize(out), 'bytes')
