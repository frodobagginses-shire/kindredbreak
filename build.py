#!/usr/bin/env python3
"""
Kindred Break Calculator build script.

Bundles the modules in MODULES (plus the inlined SLD lookup and demo preload
JSON) into one script, splices it into index.html, and writes js/app.bundle.js.
If a docs/ folder exists (the local GitHub Pages copy), index.html is copied
there too. In the GitHub repo, js/app.bundle.js and docs/ are git-ignored.

Usage:
    python3 build.py            # build
    python3 build.py --check    # rebuild in memory and report whether it matches what's on disk
"""
import json
import os
import re
import sys

ROOT = os.path.dirname(os.path.abspath(__file__))
MODULES = ['scryfall.js', 'booster-models.js', 'collation.js', 'simulation.js', 'app.js']


def read(rel):
    with open(os.path.join(ROOT, rel), encoding='utf-8') as f:
        return f.read()


def write(rel, text):
    with open(os.path.join(ROOT, rel), 'w', encoding='utf-8') as f:
        f.write(text)


def strip_module_syntax(src):
    """Drop import statements (single or multi-line) and `export` keywords."""
    out = []
    in_import = False
    for line in src.split('\n'):
        if in_import:
            if re.search(r"from\s+['\"][^'\"]+['\"];?\s*$", line):
                in_import = False
            continue
        if line.startswith('import '):
            # Each import statement collapses to a single blank line.
            out.append('')
            if not re.search(r"from\s+['\"][^'\"]+['\"];?\s*$", line):
                in_import = True
            continue
        out.append(re.sub(r'^export (default )?', '', line))
    return '\n'.join(out)


def indent(src):
    return '\n'.join(('  ' + l) if l.strip() else '' for l in src.split('\n'))


def build_bundle():
    sld = read('js/sld-drops.json').strip()
    demo = read('js/demo-preload.json').strip()
    parts = [
        '/** Kindred Bundle */',
        '(function () {',
        "  'use strict';",
        '',
        f'  globalThis.__SLD_DROP_LOOKUP__ = {sld};',
        '',
        f'  globalThis.__DEMO_PRELOAD__ = {demo};',
        '',
    ]
    for name in MODULES:
        body = indent(strip_module_syntax(read('js/' + name)).strip('\n'))
        parts.append(f'  // ── {name} ──')
        parts.append(body)
        parts.append('')
    parts.append('})();')
    return '\n'.join(parts)


def splice_into_html(html, bundle):
    start_tag = '<script>\n'
    i = html.index(start_tag, html.index('jspdf'))
    j = html.rindex('</script>')
    return html[:i + len(start_tag)] + bundle + '\n' + html[j:]


def main():
    check = '--check' in sys.argv
    bundle = build_bundle()
    html = splice_into_html(read('index.html'), bundle)
    has_docs = os.path.isdir(os.path.join(ROOT, 'docs'))
    if check:
        ok = html == read('index.html')
        print(f'index.html matches sources: {ok}')
        if os.path.exists(os.path.join(ROOT, 'js', 'app.bundle.js')):
            same_bundle = bundle == read('js/app.bundle.js')
            print(f'js/app.bundle.js matches sources: {same_bundle}')
            ok = ok and same_bundle
        sys.exit(0 if ok else 1)
    write('js/app.bundle.js', bundle)
    write('index.html', html)
    built = ['js/app.bundle.js', 'index.html']
    if has_docs:
        write('docs/index.html', html)
        built.append('docs/index.html')
    print(f'Built {", ".join(built)} ({len(bundle):,}-char bundle)')


if __name__ == '__main__':
    main()
