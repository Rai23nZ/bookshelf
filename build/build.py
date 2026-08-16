"""Build pwa/index.html from the bundle shell plus the two editable sources.

    build/shell.html      pristine bundler artifact: runtime, design-system CSS,
                          fonts, React, the book catalog. Never hand-edited —
                          the only thing swapped inside it is the app payload.
    src/BookApp.dc.html   the application itself (uuid a7dfff90 in the manifest,
                          stored gzipped + base64 like every other asset)
    src/support.js        the offline layer: background worker, cover cache,
                          sync outbox. Substituted for the __SUPPORT_LAYER__
                          marker in the shell's trailing <script>.

Run after editing either source:

    python3 build/build.py

Both substitutions are verified against the file actually written before the
script reports success, so a silent truncation can't ship.
"""
import base64
import gzip
import hashlib
import io
import json
import os
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SHELL = os.path.join(ROOT, 'build', 'shell.html')
APP = os.path.join(ROOT, 'src', 'BookApp.dc.html')
SUPPORT = os.path.join(ROOT, 'src', 'support.js')
OUT = os.path.join(ROOT, 'pwa', 'index.html')

APP_UUID = 'a7dfff90-c9a5-4dbd-9bc5-23f18950d196'
MARKER = '/* __SUPPORT_LAYER__ */'


def read(path):
    with open(path, 'r', encoding='utf-8') as f:
        return f.read()


def main():
    with open(SHELL, 'r', encoding='utf-8', newline='') as f:
        lines = f.readlines()

    app = read(APP)
    support = read(SUPPORT)

    # ── 1. app payload ────────────────────────────────────────────────────
    # Find the manifest by its tag rather than a fixed offset: editing the
    # static header above it shifts every line number.
    midx = None
    for i, line in enumerate(lines):
        if line.strip().startswith('<script type="__bundler/manifest">'):
            midx = i + 1
            break
    if midx is None:
        sys.exit('build: manifest script tag not found in shell.html')

    manifest = json.loads(lines[midx])
    entry = manifest.get(APP_UUID)
    if entry is None:
        sys.exit('build: app uuid %s missing from manifest' % APP_UUID)
    if entry['mime'] != 'text/html' or not entry['compressed']:
        sys.exit('build: unexpected app entry shape: %r' % {k: v for k, v in entry.items() if k != 'data'})

    buf = io.BytesIO()
    # mtime=0 keeps the output byte-stable across rebuilds of identical input,
    # so a no-op build produces no diff.
    with gzip.GzipFile(fileobj=buf, mode='wb', mtime=0) as gz:
        gz.write(app.encode('utf-8'))
    entry['data'] = base64.b64encode(buf.getvalue()).decode('ascii')
    lines[midx] = json.dumps(manifest, separators=(',', ':'), ensure_ascii=False) + '\n'

    # ── 2. support layer ──────────────────────────────────────────────────
    hits = [i for i, line in enumerate(lines) if MARKER in line]
    if len(hits) != 1:
        sys.exit('build: expected exactly one %s marker, found %d' % (MARKER, len(hits)))
    lines[hits[0]] = support if support.endswith('\n') else support + '\n'

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, 'w', encoding='utf-8', newline='') as f:
        f.writelines(lines)

    # ── 3. verify what was actually written ───────────────────────────────
    with open(OUT, 'r', encoding='utf-8') as f:
        written = f.read()
    with open(OUT, 'r', encoding='utf-8') as f:
        out_lines = f.readlines()

    packed = json.loads(out_lines[midx])[APP_UUID]['data']
    roundtrip = gzip.decompress(base64.b64decode(packed)).decode('utf-8')
    if roundtrip != app:
        sys.exit('build: app payload failed round-trip verification')
    if support.strip() not in written:
        sys.exit('build: support layer missing from output')
    if MARKER in written:
        sys.exit('build: marker still present in output')

    print('app     %6d chars  sha %s' % (len(app), hashlib.sha256(app.encode()).hexdigest()[:12]))
    print('support %6d chars  sha %s' % (len(support), hashlib.sha256(support.encode()).hexdigest()[:12]))
    print('output  %6d bytes -> %s' % (os.path.getsize(OUT), os.path.relpath(OUT, ROOT)))
    print('round-trip verified')


if __name__ == '__main__':
    main()
