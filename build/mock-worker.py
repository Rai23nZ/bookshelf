"""Cross-origin stand-in for the standalone Cloudflare Worker
(cloudflare-worker/sync-worker.js). Runs on a DIFFERENT port from the static
site so the browser treats it as a different origin and actually exercises
CORS (preflight OPTIONS, Access-Control-Allow-Origin, etc.) the same way it
will against the real workers.dev deployment.

It mirrors both halves of the worker: the KV sync endpoint on the bare path,
and the book metadata proxy under /meta/*. The metadata half calls the real
Goodreads / Google Books / Open Library upstreams, so what you see locally is
what the deployed worker will return. Set GOOGLE_BOOKS_KEY in the environment
to exercise the Google Books provider; without it that provider is skipped,
exactly as in the worker."""

import http.server, socketserver, json, hashlib, sys, os, re, time
import urllib.request, urllib.parse, urllib.error
from concurrent.futures import ThreadPoolExecutor

PORT = 8744
STORE = {}
MIN_CODE = 16
ALLOWED_ORIGINS = {'http://localhost:8743', 'http://127.0.0.1:8743'}

CODE_RE = re.compile(r'^[A-Za-z0-9_-]+$')

META_TIMEOUT = 5
GOOGLE_BOOKS_KEY = os.environ.get('GOOGLE_BOOKS_KEY', '')
META_CACHE = {}
POOL = ThreadPoolExecutor(max_workers=6)


def read_code(handler):
    code = (handler.headers.get('x-sync-code') or '').strip()
    if len(code) < MIN_CODE or len(code) > 200:
        return None
    if not CODE_RE.match(code):
        return None
    return code


def kv_key(code):
    return 'shelf:' + hashlib.sha256(code.encode()).hexdigest()


# ---- book metadata (/meta/*) ------------------------------------------------
# Mirrors the provider set, normalised shape and merge rules of handleMeta() in
# cloudflare-worker/sync-worker.js. Keep the two in step.

def _get_json(url):
    req = urllib.request.Request(url, headers={
        'accept': 'application/json',
        # Goodreads answers some datacentre clients with an error page unless a
        # normal browser UA is present.
        'user-agent': 'Mozilla/5.0 (compatible; bookshelf-dev/1.0)',
    })
    with urllib.request.urlopen(req, timeout=META_TIMEOUT) as res:
        return json.loads(res.read().decode('utf-8', 'replace'))


def upgrade_goodreads_cover(url):
    # /nophoto/ is Goodreads' grey "no jacket" placeholder, not a cover — the
    # app has its own placeholder that matches the rest of the shelf.
    url = url or ''
    if '/nophoto/' in url:
        return ''
    return re.sub(r'\._S[XY]\d+_\.', '._SY475_.', url)


def from_goodreads(q):
    url = 'https://www.goodreads.com/book/auto_complete?format=json&q=' + urllib.parse.quote(q)
    data = _get_json(url)
    if not isinstance(data, list):
        return []
    out = []
    for d in data:
        title = (d.get('bookTitleBare') or d.get('title') or '').strip()
        if not title:
            continue
        out.append({
            'title': title,
            'author': ((d.get('author') or {}).get('name') or '').strip(),
            'isbn': '', 'isbn13': '',
            'pages': d.get('numPages') or None,
            'avgRating': float(d['avgRating']) if d.get('avgRating') else None,
            'coverUrl': upgrade_goodreads_cover(d.get('imageUrl')),
            'source': 'goodreads',
        })
    return out


def from_google_books(q):
    if not GOOGLE_BOOKS_KEY:
        return []
    url = ('https://www.googleapis.com/books/v1/volumes?maxResults=10&country=US&key='
           + urllib.parse.quote(GOOGLE_BOOKS_KEY) + '&q=' + urllib.parse.quote(q))
    data = _get_json(url)
    out = []
    for item in (data.get('items') or []):
        v = item.get('volumeInfo') or {}
        title = (v.get('title') or '').strip()
        if not title:
            continue
        ids = v.get('industryIdentifiers') or []
        pick = lambda t: next((x.get('identifier', '') for x in ids if x.get('type') == t), '')
        img = (v.get('imageLinks') or {}).get('thumbnail') or (v.get('imageLinks') or {}).get('smallThumbnail') or ''
        out.append({
            'title': title,
            'author': ((v.get('authors') or [''])[0] or '').strip(),
            'isbn': pick('ISBN_10'), 'isbn13': pick('ISBN_13'),
            'pages': v.get('pageCount') or None,
            'avgRating': v.get('averageRating') or None,
            'coverUrl': re.sub(r'^http:', 'https:', img),
            'source': 'google',
        })
    return out


def from_open_library(q):
    url = ('https://openlibrary.org/search.json?limit=10'
           '&fields=title,author_name,isbn,cover_i,number_of_pages_median&q=' + urllib.parse.quote(q))
    data = _get_json(url)
    out = []
    for d in (data.get('docs') or []):
        title = (d.get('title') or '').strip()
        if not title:
            continue
        isbns = d.get('isbn') or []
        out.append({
            'title': title,
            'author': ((d.get('author_name') or [''])[0] or '').strip(),
            'isbn': isbns[0] if isbns else '',
            'isbn13': next((x for x in isbns if len(str(x)) == 13), ''),
            'pages': d.get('number_of_pages_median') or None,
            'avgRating': None,
            'coverUrl': ('https://covers.openlibrary.org/b/id/%s-M.jpg' % d['cover_i']) if d.get('cover_i') else '',
            'source': 'openlibrary',
        })
    return out


NON_WORD_RE = re.compile(r'[^\w]+', re.UNICODE)


def norm_text(s):
    return NON_WORD_RE.sub(' ', str(s or '').lower()).strip()


def core_title(t):
    return norm_text(re.sub(r'[(\[:].*$', '', str(t or '')))


def merge_key(r):
    words = norm_text(str(r['author']).split(',')[0]).split(' ')
    return core_title(r['title']) + '|' + (words[-1] if words else '')


def title_matches(want, got):
    """Goodreads' auto_complete is a search box, not a lookup: a weak query
    returns whatever was closest. "1С:Программирование..." truncates to "1С"
    and comes back with The Hunger Games. A wrong cover is worse than none."""
    # The second pair drops a trailing comma clause, so "The Hobbit" still
    # matches "The Hobbit, or There and Back Again". Not done in merge_key,
    # where it would over-merge titles sharing a first clause.
    pairs = [
        (core_title(want), core_title(got)),
        (core_title(str(want or '').split(',')[0]), core_title(str(got or '').split(',')[0])),
    ]
    for a, b in pairs:
        if not a or not b:
            continue
        if a == b:
            return True
        short, long = (a, b) if len(a) <= len(b) else (b, a)
        if long.startswith(short) and len(short) >= max(4, len(long) * 0.5):
            return True
    return False


def merge_results(lists):
    by_key = {}
    order = []
    for lst in lists:
        for r in lst:
            key = merge_key(r)
            seen = by_key.get(key)
            if seen is None:
                by_key[key] = dict(r)
                order.append(key)
                continue
            for field in ('isbn', 'isbn13', 'coverUrl', 'author'):
                if not seen.get(field) and r.get(field):
                    seen[field] = r[field]
            for field in ('pages', 'avgRating'):
                if seen.get(field) is None and r.get(field) is not None:
                    seen[field] = r[field]
    return [by_key[k] for k in order]


def search_providers(q):
    futures = [POOL.submit(fn, q) for fn in (from_goodreads, from_google_books, from_open_library)]
    lists = []
    for f in futures:
        try:
            lists.append(f.result(timeout=META_TIMEOUT + 2))
        except Exception as e:
            sys.stderr.write('[worker-mock] provider failed: %s\n' % e)
            lists.append([])
    return merge_results(lists)


def cached(key, ttl, produce):
    hit = META_CACHE.get(key)
    if hit and hit[0] > time.time():
        return hit[1]
    value = produce()
    META_CACHE[key] = (time.time() + ttl, value)
    return value


class Handler(http.server.BaseHTTPRequestHandler):
    def _cors(self, origin):
        if origin in ALLOWED_ORIGINS:
            self.send_header('access-control-allow-origin', origin)
        self.send_header('access-control-allow-methods', 'GET, PUT, OPTIONS')
        self.send_header('access-control-allow-headers', 'content-type, x-sync-code')
        self.send_header('vary', 'origin')

    def _json(self, obj, status=200):
        origin = self.headers.get('origin') or ''
        body = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self._cors(origin)
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        origin = self.headers.get('origin') or ''
        self.send_response(204)
        self._cors(origin)
        self.end_headers()

    def do_GET(self):
        # Sync ignores the path and always has, so routing is additive: peel
        # off /meta/* and let everything else fall through unchanged.
        parsed = urllib.parse.urlparse(self.path)
        if parsed.path.startswith('/meta/'):
            return self._meta(parsed)

        code = read_code(self)
        if not code:
            return self._json({'error': 'missing or malformed sync code'}, 400)
        stored = STORE.get(kv_key(code))
        if not stored:
            return self._json({'error': 'no shelf stored under this code'}, 404)
        origin = self.headers.get('origin') or ''
        body = stored.encode()
        self.send_response(200)
        self.send_header('content-type', 'application/json')
        self.send_header('content-length', str(len(body)))
        self._cors(origin)
        self.end_headers()
        self.wfile.write(body)

    def _meta(self, parsed):
        # Format check only, never a KV lookup — a device that has a code but
        # has never uploaded must still be able to search.
        if not read_code(self):
            return self._json({'error': 'missing or malformed sync code'}, 400)
        params = urllib.parse.parse_qs(parsed.query)
        get = lambda k: (params.get(k) or [''])[0].strip()

        if parsed.path == '/meta/search':
            q = get('q')
            if not q:
                return self._json({'results': []})
            try:
                limit = max(1, min(20, int(get('limit') or 8)))
            except ValueError:
                limit = 8
            results = cached('search:' + norm_text(q), 7 * 24 * 3600, lambda: search_providers(q))
            sys.stderr.write('[worker-mock] /meta/search %r -> %d results\n' % (q, len(results)))
            return self._json({'results': results[:limit]})

        if parsed.path == '/meta/cover':
            isbn, title, author = get('isbn'), get('title'), get('author')
            q = isbn or (re.sub(r'[:(].*$', '', title).strip()
                         + ((' ' + author.split(',')[0]) if author else '')).strip()
            if not q:
                return self._json({'error': 'nothing to look up'}, 400)

            def resolve():
                results = search_providers(q)
                # An isbn already identifies the edition; a title search does
                # not, and has to be checked against what came back.
                ok = results if isbn else [r for r in results if title_matches(title, r['title'])]
                hit = next((r for r in ok if r.get('coverUrl')), None)
                return {'coverUrl': hit['coverUrl'], 'source': hit['source']} if hit else {}

            found = cached('cover:' + norm_text(q), 30 * 24 * 3600, resolve)
            if not found.get('coverUrl'):
                return self._json({'error': 'no cover found'}, 404)
            sys.stderr.write('[worker-mock] /meta/cover %r -> %s\n' % (q, found['source']))
            return self._json(found)

        return self._json({'error': 'not found'}, 404)

    def do_PUT(self):
        code = read_code(self)
        if not code:
            return self._json({'error': 'missing or malformed sync code'}, 400)
        n = int(self.headers.get('content-length') or 0)
        raw = self.rfile.read(n).decode('utf-8', 'replace')
        try:
            data = json.loads(raw)
        except Exception:
            return self._json({'error': 'body is not JSON'}, 400)
        if not isinstance(data.get('slim'), list):
            return self._json({'error': 'not a shelf snapshot'}, 400)
        STORE[kv_key(code)] = json.dumps(data)
        sys.stderr.write('[worker-mock] stored %d books, origin=%s\n' % (len(data['slim']), self.headers.get('origin')))
        return self._json({'ok': True, 'books': len(data['slim']), 'updatedAt': data.get('updatedAt')})

    def log_message(self, fmt, *args):
        sys.stderr.write('[worker-mock] ' + (fmt % args) + '\n')


class Server(socketserver.ThreadingMixIn, http.server.HTTPServer):
    daemon_threads = True
    allow_reuse_address = True


with Server(('127.0.0.1', PORT), Handler) as httpd:
    sys.stderr.write('[worker-mock] serving cross-origin sync mock on %d\n' % PORT)
    httpd.serve_forever()
