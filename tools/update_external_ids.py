#!/usr/bin/env python3
"""
Build js/mtgjson-external-ids.json: for sets whose MTGJSON booster sheets list
printings that MTGJSON files under other sets (Mystery Booster reprints, for
example), map each of those card UUIDs to its Scryfall ID.

The site normally resolves sheet cards from the set's own MTGJSON file plus a
few linked sets (Scryfall child sets, SPG). That can't cover Mystery Booster
sets, whose reprints live in The List (PLST, a very large set file) and
Mystery Booster 2. This lookup lets js/scryfall.js::fetchMtgjsonBooster() go
straight to Scryfall for them.

Usage:
    python3 tools/update_external_ids.py MBC              # add or refresh one set
    python3 tools/update_external_ids.py MB2 MBC          # several sets
    python3 tools/update_external_ids.py --ids cardIdentifiers.csv.xz MBC
                                                         # reuse a downloaded file

Sets already in the lookup that aren't named are kept as they are.

Note: this downloads MTGJSON's bulk identifier table
(csv/cardIdentifiers.csv.xz, about 11 MB), not just per-set files. Only run it
when adding or refreshing a set here.
"""
import csv
import io
import json
import lzma
import os
import sys
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'js', 'mtgjson-external-ids.json')
BASE = 'https://mtgjson.com/api/v5'
IDS_URL = f'{BASE}/csv/cardIdentifiers.csv.xz'
UA = {'User-Agent': 'KindredBreakCalculator/1.0 (github.com/frodobagginses-shire/kindredbreak)'}


def download(url):
    req = urllib.request.Request(url, headers=UA)
    with urllib.request.urlopen(req, timeout=300) as r:
        return r.read()


def external_uuids(code):
    """UUIDs on the set's booster sheets that aren't cards in its own file."""
    data = json.loads(download(f'{BASE}/{code}.json'))['data']
    own = {c['uuid'] for c in data.get('cards', [])}
    out = set()
    for booster in (data.get('booster') or {}).values():
        for sheet in (booster.get('sheets') or {}).values():
            out.update(u for u in (sheet.get('cards') or {}) if u not in own)
    return out


def load_scryfall_ids(path, wanted):
    raw = open(path, 'rb').read() if path else download(IDS_URL)
    if raw[:6] == b'\xfd7zXZ\x00':
        raw = lzma.decompress(raw)
    found = {}
    for row in csv.DictReader(io.StringIO(raw.decode('utf-8'))):
        if row['uuid'] in wanted and row.get('scryfallId'):
            found[row['uuid']] = row['scryfallId']
    return found


def main():
    args = sys.argv[1:]
    ids_path = None
    if '--ids' in args:
        i = args.index('--ids')
        ids_path = args[i + 1]
        del args[i:i + 2]
    codes = [a.upper() for a in args]
    if not codes:
        print(__doc__)
        sys.exit(1)

    wanted = {code: external_uuids(code) for code in codes}
    scryfall = load_scryfall_ids(ids_path, set().union(*wanted.values()))

    lookup = {}
    if os.path.exists(OUT):
        with open(OUT, encoding='utf-8') as f:
            lookup = json.load(f)
    for code in codes:
        uuids = wanted[code]
        if not uuids:
            lookup.pop(code, None)
            print(f'{code}: every booster card is in its own MTGJSON file; nothing to add')
            continue
        lookup[code] = {u: scryfall[u] for u in sorted(uuids) if u in scryfall}
        missing = len(uuids) - len(lookup[code])
        print(f'{code}: {len(lookup[code])} of {len(uuids)} outside cards mapped to Scryfall'
              + (f' ({missing} have no Scryfall ID)' if missing else ''))

    ordered = {k: lookup[k] for k in sorted(lookup)}
    with open(OUT, 'w', encoding='utf-8') as f:
        json.dump(ordered, f, separators=(',', ':'))
        f.write('\n')
    print(f'Wrote {os.path.relpath(OUT, ROOT)} ({os.path.getsize(OUT):,} bytes)')


if __name__ == '__main__':
    main()
