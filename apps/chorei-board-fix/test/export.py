"""board.xlsx の全シートを sheets/<シート名>.csv に書き出す。

read_file_content のような自然文表現は大きなシートを切り詰めるため、
必ず xlsx から読むこと。日付セルは 'YYYY-MM-DD HH:MM:SS' で出る
（harness.js 側で Date に戻す）。
"""
import csv, os, re
import openpyxl

wb = openpyxl.load_workbook('board.xlsx', data_only=True, read_only=True)
os.makedirs('sheets', exist_ok=True)
for ws in wb.worksheets:
    rows = []
    for r in ws.iter_rows(values_only=True):
        if r is None or all(c is None or str(c).strip() == '' for c in r):
            continue
        rows.append(['' if c is None else c for c in r])
    name = re.sub(r'[^\w一-龯ぁ-んァ-ヶー]', '_', ws.title)
    with open(f'sheets/{name}.csv', 'w', newline='') as f:
        csv.writer(f).writerows(rows)
    print(f'{ws.title:<16} {len(rows) - 1 if rows else 0:>6} 行')
