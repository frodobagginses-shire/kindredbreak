#!/usr/bin/env python3
"""
Regenerate js/sld-drops.json (Secret Lair collector number -> drop name) from
MTGJSON's SLD set file. MTGJSON names each drop in the card's `subsets` field.

Usage:
    python3 tools/update_sld_drops.py            # download SLD.json and rewrite the lookup
    python3 tools/update_sld_drops.py SLD.json   # use an already-downloaded file
Then run `python3 build.py` to inline the new lookup into index.html.
"""
import json
import os
import re
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'js', 'sld-drops.json')
URL = 'https://mtgjson.com/api/v5/SLD.json'


def natural_key(num):
    m = re.match(r'(\d+)(.*)', num)
    return (int(m.group(1)), m.group(2)) if m else (float('inf'), num)


def main():
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding='utf-8') as f:
            data = json.load(f)['data']
    else:
        req = urllib.request.Request(URL, headers={'User-Agent': 'KindredBreakCalculator/1.0 (github.com/frodobagginses-shire/kindredbreak)'})
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.load(r)['data']

    lookup = {}
    for card in data.get('cards', []):
        subsets = card.get('subsets') or []
        if subsets and card['number'] not in lookup:
            lookup[card['number']] = subsets[0]

    old = {}
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as f:
            old = json.load(f)
    ordered = {k: lookup[k] for k in sorted(lookup, key=natural_key)}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(ordered, f, ensure_ascii=True, separators=(',', ':'))

    added = [k for k in ordered if k not in old]
    renamed = [k for k in ordered if k in old and old[k] != ordered[k]]
    dropped = [k for k in old if k not in ordered]
    new_drops = sorted({ordered[k] for k in added})
    print(f'{len(ordered)} entries ({len(added)} added, {len(renamed)} renamed, {len(dropped)} removed)')
    for name in new_drops:
        print(f'  new: {name}')


if __name__ == '__main__':
    main()
