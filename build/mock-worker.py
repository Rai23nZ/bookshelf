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
META_UA = 'Mozilla/5.0 (compatible; bookshelf/1.0; +https://github.com/Rai23nZ/bookshelf)'
# Mirrors IMG_HOSTS / MAX_IMG in cloudflare-worker/sync-worker.js.
IMG_HOSTS = {
    'i.gr-assets.com',
    'images.gr-assets.com',
    's.gr-assets.com',
    'covers.openlibrary.org',
    'books.google.com',
    'books.googleusercontent.com',
}
MAX_IMG = 8 * 1024 * 1024
GOOGLE_BOOKS_KEY = os.environ.get('GOOGLE_BOOKS_KEY', '')
META_CACHE = {}
# Each cover lookup occupies several workers at once and an unreachable
# provider holds one for the full timeout, so a small pool serialises the
# shelf-wide backfill badly. The real Worker has no such limit.
POOL = ThreadPoolExecutor(max_workers=16)


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
        # Goodreads sits behind CloudFront, which answers a UA-less request
        # with a 403 error page. Cloudflare's fetch() sends no UA by default,
        # so the worker sets the same one — that mismatch is exactly why this
        # worked locally and failed in production.
        'user-agent': META_UA,
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
            # Ranks cover candidates: a summary edition has tens of ratings
            # where the book it summarises has tens of thousands.
            'ratingsCount': d.get('ratingsCount') or 0,
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
    # yo/ye folded: Goodreads and the shelf disagree about it constantly
    # ("Мария Семёнова" vs "Мария Семенова").
    return NON_WORD_RE.sub(' ', str(s or '').lower().replace('ё', 'е')).strip()


LEAD_ARTICLE_RE = re.compile(r'^(the|a|an) ')


def core_title(t):
    # A leading article is dropped because the comparison is anchored at the
    # start: "Three Kingdoms" would otherwise fail against Goodreads' "The
    # Three Kingdoms. Luo Guanzhong".
    return LEAD_ARTICLE_RE.sub('', norm_text(re.sub(r'[(\[:].*$', '', str(t or ''))))


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
            for field in ('pages', 'avgRating', 'ratingsCount'):
                if seen.get(field) is None and r.get(field) is not None:
                    seen[field] = r[field]
    return [by_key[k] for k in order]


def author_matches(want, got):
    """Surname-level and deliberately loose: editions credit authors
    inconsistently, but this still separates a summary's packager
    ("Short Reads", "BookRags") from the real author."""
    w = [x for x in norm_text(str(want or '').split(',')[0]).split(' ') if x]
    g = norm_text(got)
    if not w or not g:
        return False
    surname = w[-1]
    return len(surname) >= 3 and surname in g.split(' ')


def goodreads_cover(title, author, isbn):
    """Two stages, author required. Without the author in the query the real
    book is often absent from Goodreads' five hits entirely; with it, summary
    editions surface, and those are separated by their author field rather than
    by any title test. The title-only stage is the fallback for books whose
    title+author query returns nothing but study guides. Mirrors
    goodreadsCover() in the worker."""
    if isbn:
        try:
            return from_goodreads(isbn)
        except Exception:
            return []
    first_author = str(author or '').split(',')[0].strip()
    queries = [title + ' ' + first_author, title] if first_author else [title]
    # Issued together, not one after the other: in series the two 5s provider
    # budgets would exceed the client's 9s cover-queue timeout, so the fallback
    # stage would die on exactly the books it exists to rescue. Preference is
    # still by query order, not by whichever answers first.
    futures = [POOL.submit(from_goodreads, q) for q in queries]
    for f in futures:
        try:
            hits = f.result(timeout=META_TIMEOUT + 2)
        except Exception:
            hits = []
        ok = [r for r in hits if title_matches(title, r['title'])
              and (not first_author or author_matches(author, r['author']))]
        if ok:
            ok.sort(key=lambda r: r.get('ratingsCount') or 0, reverse=True)
            return ok
    return []


def cover_providers(title, author, isbn):
    """Open Library and Google Books do not have the summary problem and need
    the author to disambiguate, so they keep the combined query."""
    first_author = str(author or '').split(',')[0].strip()
    wide = isbn or (title + ((' ' + first_author) if first_author else '')).strip()
    # Google Books and Open Library go to the pool; Goodreads runs inline
    # because goodreads_cover() submits its own two queries to that same pool,
    # and a pooled task blocking on other pooled tasks deadlocks once the
    # workers are all occupied. Only the caller's thread may wait on the pool.
    jobs = [POOL.submit(from_google_books, wide), POOL.submit(from_open_library, wide)]
    lists = [goodreads_cover(title, author, isbn)]
    for f in jobs:
        try:
            lists.append(f.result(timeout=META_TIMEOUT + 2))
        except Exception as e:
            sys.stderr.write('[worker-mock] cover provider failed: %s\n' % e)
            lists.append([])
    return merge_results(lists)


def search_providers(q):
    """Returns (merged_results, per_provider_status). The status mirrors the
    worker's: a dead provider looks exactly like one with no matches, which is
    how a missing User-Agent on Goodreads went unnoticed in production."""
    jobs = [('goodreads', from_goodreads), ('google', from_google_books), ('openlibrary', from_open_library)]
    futures = [(name, POOL.submit(fn, q)) for name, fn in jobs]
    lists, providers = [], {}
    for name, f in futures:
        try:
            got = f.result(timeout=META_TIMEOUT + 2)
            providers[name] = ('%d results' % len(got)) if got else 'no results'
            lists.append(got)
        except Exception as e:
            providers[name] = 'failed: %s' % e
            sys.stderr.write('[worker-mock] provider %s failed: %s\n' % (name, e))
            lists.append([])
    if not GOOGLE_BOOKS_KEY:
        providers['google'] = 'skipped (no GOOGLE_BOOKS_KEY secret)'
    return merge_results(lists), providers


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
        params = urllib.parse.parse_qs(parsed.query)
        get = lambda k: (params.get(k) or [''])[0].strip()

        # Unauthenticated on purpose: an <img> cannot send x-sync-code. Kept
        # narrow by the host allowlist instead. Mirrors handleImage() in the
        # worker — keep the two in step.
        if parsed.path == '/meta/img':
            return self._meta_img(get('u'))

        # Format check only, never a KV lookup — a device that has a code but
        # has never uploaded must still be able to search.
        if not read_code(self):
            return self._json({'error': 'missing or malformed sync code'}, 400)

        if parsed.path == '/meta/search':
            q = get('q')
            if not q:
                return self._json({'results': []})
            try:
                limit = max(1, min(20, int(get('limit') or 8)))
            except ValueError:
                limit = 8
            results, providers = cached('search:' + norm_text(q), 7 * 24 * 3600, lambda: search_providers(q))
            sys.stderr.write('[worker-mock] /meta/search %r -> %d results %s\n' % (q, len(results), providers))
            return self._json({'results': results[:limit], 'providers': providers})

        if parsed.path == '/meta/cover':
            isbn, title, author = get('isbn'), get('title'), get('author')
            q = isbn or (re.sub(r'[:(].*$', '', title).strip()
                         + ((' ' + author.split(',')[0]) if author else '')).strip()
            if not q:
                return self._json({'error': 'nothing to look up'}, 400)

            def resolve():
                results = cover_providers(title, author, isbn)
                # An isbn already identifies the edition; a title search does
                # not, and has to be checked against what came back.
                ok = results if isbn else [r for r in results if title_matches(title, r['title'])]
                # Goodreads entries arrive already author-filtered and ranked by
                # goodreads_cover(), and merge_results keeps them first. This
                # only promotes an author match within the Open Library /
                # Google Books tail, by stable partition so ranking survives.
                if author:
                    ok = ([r for r in ok if author_matches(author, r['author'])]
                          + [r for r in ok if not author_matches(author, r['author'])])
                hit = next((r for r in ok if r.get('coverUrl')), None)
                return {'coverUrl': hit['coverUrl'], 'source': hit['source']} if hit else {}

            found = cached('cover:' + norm_text(q), 30 * 24 * 3600, resolve)
            if not found.get('coverUrl'):
                return self._json({'error': 'no cover found'}, 404)
            sys.stderr.write('[worker-mock] /meta/cover %r -> %s\n' % (q, found['source']))
            return self._json(found)

        return self._json({'error': 'not found'}, 404)

    def _meta_img(self, src):
        try:
            target = urllib.parse.urlparse(src)
        except Exception:
            return self._json({'error': 'bad or missing u parameter'}, 400)
        if target.scheme != 'https' or target.hostname not in IMG_HOSTS:
            return self._json({'error': 'host not allowed'}, 403)
        try:
            req = urllib.request.Request(src, headers={'user-agent': META_UA})
            with urllib.request.urlopen(req, timeout=15) as res:
                ctype = res.headers.get('content-type') or ''
                if not ctype.startswith('image/'):
                    return self._json({'error': 'not an image'}, 415)
                body = res.read(MAX_IMG + 1)
        except urllib.error.HTTPError as e:
            return self._json({'error': 'upstream %d' % e.code}, 404 if e.code == 404 else 502)
        except Exception:
            return self._json({'error': 'upstream unreachable'}, 502)
        if len(body) > MAX_IMG:
            return self._json({'error': 'image too large'}, 413)

        origin = self.headers.get('origin') or ''
        self.send_response(200)
        self.send_header('content-type', ctype)
        self.send_header('content-length', str(len(body)))
        self.send_header('cache-control', 'public, max-age=31536000, immutable')
        self._cors(origin)
        self.end_headers()
        self.wfile.write(body)

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
