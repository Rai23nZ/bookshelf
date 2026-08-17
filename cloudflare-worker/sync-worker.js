// Standalone Cloudflare Worker — sync endpoint for the Bookshelf app.
//
// This exists as a SEPARATE worker (not a Pages Function) because the
// dashboard's drag-and-drop upload ("Upload your static files") does not
// support the functions/ folder — that path only works via a Git-connected
// Pages project or the wrangler CLI, neither of which is in use here.
//
// Setup, entirely in the Cloudflare dashboard:
//   1. Workers & Pages -> Create -> "Start with Hello World!"
//      Name it EXACTLY: bookshelf-sync
//      (the app is hardcoded to call https://bookshelf-sync.<your
//      subdomain>.workers.dev — a different name means editing the client)
//   2. Replace the starter code with this file's contents, Deploy.
//   3. Storage & Databases -> KV -> Create instance (any name).
//   4. This worker -> Settings -> Bindings -> Add -> KV namespace:
//        Variable name: BOOKSHELF_KV   (must match exactly)
//        KV namespace: the one from step 3
//   5. Re-deploy (Settings changes need a new deployment to take effect).
//
// The sync code is the only credential. It is never stored in the clear:
// KV is keyed by its SHA-256, so a dump of the namespace does not hand out
// working codes. It travels in a request header, never in the URL, so it
// can't end up in server logs, browser history or a Referer header.
//
// This worker also serves book metadata under /meta/*, because the browser
// cannot reach those providers itself: goodreads.com sends no CORS headers at
// all, and Google Books needs an API key that would be public the moment it
// went into the bundle. Optional extra setup for that half:
//   6. Settings -> Variables and Secrets -> Add -> Secret
//        Name: GOOGLE_BOOKS_KEY   Value: a Google Books API key
// Without it the Google Books provider is simply skipped and the other two
// still answer. Do NOT fall back to keyless Google Books: unauthenticated
// calls share one global anonymous quota that is routinely exhausted (it
// answers 429 "Quota exceeded ... Queries per day" most of the time).

const MIN_CODE = 16;
const MAX_BODY = 5 * 1024 * 1024; // a shelf is ~30-60KB; this is a sanity ceiling

// This worker lives on its own domain (workers.dev), separate from the site
// that calls it, so every request is cross-origin and needs explicit CORS —
// including answering the OPTIONS preflight the browser sends first because
// the request carries a custom header (x-sync-code).
//
// The origin allowlist matters here specifically because this endpoint is
// bearer-auth (the code IS the credential, sent by whichever page asks): a
// wildcard '*' would let ANY page that a user's browser visits read or
// overwrite their shelf if it ever learned their code. Pinning the origin
// closes that off — list every domain the app is actually served from.
// TODO(deploy): replace the first entry with the address Pages actually gives
// the site. Until a real origin is listed here the browser blocks every sync
// call from it — the request leaves, the Worker answers, and the response is
// discarded for want of an Access-Control-Allow-Origin header.
const ALLOWED_ORIGINS = [
  'https://bookshelf.cloudflare-uncommon.workers.dev',
  // Add your Cloudflare Pages domain here once you know it, e.g.:
  // 'https://bookshelf-abc.pages.dev',
];

function corsHeaders(origin) {
  const headers = {
    'access-control-allow-methods': 'GET, PUT, OPTIONS',
    'access-control-allow-headers': 'content-type, x-sync-code',
    'access-control-max-age': '86400',
    vary: 'origin'
  };
  if (ALLOWED_ORIGINS.includes(origin)) headers['access-control-allow-origin'] = origin;
  return headers;
}

function json(obj, status, origin) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders(origin) }
  });
}

function readCode(request) {
  const code = (request.headers.get('x-sync-code') || '').trim();
  if (code.length < MIN_CODE || code.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
  return code;
}

async function sha256hex(input) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

async function kvKey(code) {
  return 'shelf:' + await sha256hex(code);
}

// ── Book metadata (/meta/*) ─────────────────────────────────────────────────
//
// Three providers, merged. None of them is sufficient alone:
//   - Goodreads has the best covers and is the primary source, but its
//     auto_complete endpoint returns NO isbn field and does not index
//     Cyrillic at all (any Russian-script query comes back empty).
//   - Google Books has the isbn and handles Cyrillic, but needs a key.
//   - Open Library is the only one the client can also call directly, so it
//     stays as the no-key, no-worker fallback path on both sides.

const META_TIMEOUT_MS = 5000;
const META_TTL = 7 * 24 * 60 * 60;   // searches: providers do change their minds
const COVER_TTL = 30 * 24 * 60 * 60; // cover URLs are effectively immutable

// Bump this whenever a provider, its parsing or its request changes. Cached
// entries are keyed through it, so a fix reaches users immediately instead of
// being masked by up to a month of stale answers produced by the old code.
// v2: added the User-Agent below, without which Goodreads returned nothing and
// every cached search held Open Library results only.
// v3: cover lookup stopped putting the author in the Goodreads query and
// started ranking by author match then popularity, so entries cached under v2
// can hold a summary edition's jacket.
// v4: that turned out to be a bad trade — without the author in the query the
// real book is often absent from Goodreads' five hits entirely, and ranking
// (rather than requiring) an author match then handed the cover to whatever
// popular book shared the title prefix. v3 entries hold covers from other
// books outright.
// v5: two fixes to the cover route, both able to have poisoned a v4 entry —
// titleMatches() accepted a suffix that did not start a new word (so "Aliens"
// took "Alien"'s jacket), and the providers were queried with the full title
// including its subtitle, which returns nothing from Goodreads for a long one.
const META_CACHE_VERSION = 'v5';

// Cloudflare's fetch() sends NO User-Agent unless one is set, and Goodreads
// sits behind CloudFront, which answers a UA-less request with a 403 error
// page. Locally this never showed up because the python mock sends a UA.
const META_UA = 'Mozilla/5.0 (compatible; bookshelf/1.0; +https://github.com/Rai23nZ/bookshelf)';

function metaFetch(url, init) {
  // One slow provider must not hold the whole response hostage; a provider
  // that times out just contributes nothing.
  return fetch(url, {
    ...init,
    headers: { 'user-agent': META_UA, ...((init && init.headers) || {}) },
    signal: AbortSignal.timeout(META_TIMEOUT_MS)
  });
}

// Goodreads hands out a thumbnail (._SY75_ / ._SX50_, ~2KB). The same path
// with a bigger size token is the full cover (~25KB) — worth doing once here
// rather than shipping a blurry image to every device.
//
// A book Goodreads knows but has no jacket for comes back with a /nophoto/
// placeholder rather than an empty field. That has to be treated as "no
// cover": it is a grey rectangle, and the app has its own placeholder that
// looks like the rest of the shelf.
function upgradeGoodreadsCover(url) {
  if (!url) return '';
  const s = String(url);
  if (s.includes('/nophoto/')) return '';
  return s.replace(/\._S[XY]\d+_\./, '._SY475_.');
}

async function fromGoodreads(q) {
  const url = 'https://www.goodreads.com/book/auto_complete?format=json&q=' + encodeURIComponent(q);
  // Throw rather than return [] on a bad status: a provider that quietly
  // contributes nothing is indistinguishable from one that legitimately found
  // nothing, which is exactly how the missing User-Agent above went unnoticed.
  // searchProviders() catches this and reports it in the response.
  const res = await metaFetch(url, { headers: { accept: 'application/json' } });
  if (!res.ok) throw new Error('goodreads http ' + res.status);
  const list = await res.json();
  if (!Array.isArray(list)) return [];
  return list.map(d => ({
    title: String(d.bookTitleBare || d.title || '').trim(),
    author: String((d.author && d.author.name) || '').trim(),
    isbn: '', isbn13: '',
    pages: d.numPages || null,
    avgRating: d.avgRating ? Number(d.avgRating) : null,
    // Carried purely to rank cover candidates: a summary edition has tens of
    // ratings where the book it summarises has tens of thousands.
    ratingsCount: d.ratingsCount || 0,
    coverUrl: upgradeGoodreadsCover(d.imageUrl),
    source: 'goodreads'
  })).filter(x => x.title);
}

async function fromGoogleBooks(q, key) {
  if (!key) return [];
  // country is required for this endpoint from some datacentre IPs — without
  // it Google answers 403 "unable to determine location".
  const url = 'https://www.googleapis.com/books/v1/volumes?maxResults=10&country=US&key='
    + encodeURIComponent(key) + '&q=' + encodeURIComponent(q);
  const res = await metaFetch(url);
  if (!res.ok) throw new Error('google books http ' + res.status);
  const data = await res.json();
  return ((data && data.items) || []).map(item => {
    const v = item.volumeInfo || {};
    const ids = v.industryIdentifiers || [];
    const pick = type => (ids.find(x => x.type === type) || {}).identifier || '';
    const img = (v.imageLinks && (v.imageLinks.thumbnail || v.imageLinks.smallThumbnail)) || '';
    return {
      title: String(v.title || '').trim(),
      author: String((v.authors && v.authors[0]) || '').trim(),
      isbn: pick('ISBN_10'), isbn13: pick('ISBN_13'),
      pages: v.pageCount || null,
      avgRating: v.averageRating || null,
      coverUrl: img.replace(/^http:/, 'https:'),
      source: 'google'
    };
  }).filter(x => x.title);
}

async function fromOpenLibrary(q) {
  const url = 'https://openlibrary.org/search.json?limit=10&fields=title,author_name,isbn,cover_i,number_of_pages_median&q='
    + encodeURIComponent(q);
  const res = await metaFetch(url);
  if (!res.ok) throw new Error('open library http ' + res.status);
  const data = await res.json();
  return ((data && data.docs) || []).map(d => ({
    title: String(d.title || '').trim(),
    author: String((d.author_name && d.author_name[0]) || '').trim(),
    isbn: (d.isbn || [])[0] || '',
    isbn13: (d.isbn || []).find(x => String(x).length === 13) || '',
    pages: d.number_of_pages_median || null,
    avgRating: null,
    coverUrl: d.cover_i ? 'https://covers.openlibrary.org/b/id/' + d.cover_i + '-M.jpg' : '',
    source: 'openlibrary'
  })).filter(x => x.title);
}

// Superscript digits are Unicode numbers, so the strip below keeps them and
// "Alien³" normalises to "alien³" — a string no provider ever returns. Folded
// to ASCII here, it becomes "alien3", one squeezed space away from Goodreads'
// "Alien 3". See titleMatches().
const SUPERSCRIPT_DIGITS = { '⁰': '0', '¹': '1', '²': '2', '³': '3', '⁴': '4', '⁵': '5', '⁶': '6', '⁷': '7', '⁸': '8', '⁹': '9' };

function normText(s) {
  // ё/е is folded because Goodreads and the shelf disagree about it constantly
  // ("Мария Семёнова" vs "Мария Семенова"), and that alone would fail an
  // otherwise exact author match.
  return String(s || '').toLowerCase()
    .replace(/ё/g, 'е')
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]/g, c => SUPERSCRIPT_DIGITS[c])
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}

// A leading article is dropped because the comparison below is anchored at the
// start of the string: without this, "Three Kingdoms" fails against Goodreads'
// "The Three Kingdoms. Luo Guanzhong" even though it is plainly the same book.
function coreTitle(t) {
  return normText(String(t || '').replace(/[(\[:].*$/, '')).replace(/^(the|a|an) /, '');
}

// What is actually typed into a provider's search box, as opposed to what the
// answer is then checked against. Goodreads' auto_complete is a search box and
// a 140-character title with its full subtitle returns nothing at all from it:
// "Empire of the Summer Moon: Quanah Parker and the Rise and Fall of the
// Comanches, the Most Powerful Indian Tribe in American History" found no
// cover for the shelf, while typing three words of it into Add a book found it
// at once. The subtitle is dropped for the QUERY only — every result is still
// matched against the full title, so a short stem cannot widen what is
// accepted. Falls back to the whole title for one that is nothing but
// subtitle.
function searchTitle(title) {
  const t = String(title || '')
    // Goodreads' index has no superscripts, and it does not ignore them
    // either: "Alien³" comes back with Ruby Dixon and Bukowski, "Alien3" with
    // nothing at all, and "Alien 3" with the novelisation on the first line.
    .replace(/[⁰¹²³⁴⁵⁶⁷⁸⁹]+/g, run => ' ' + run.replace(/./gu, c => SUPERSCRIPT_DIGITS[c]))
    .replace(/\s+/g, ' ')
    .trim();
  return t.replace(/[(\[:].*$/, '').trim() || t;
}

// Providers title the same book differently ("Dune" vs "Dune (Dune, #1)"), so
// an exact comparison would never merge anything and Goodreads hits would
// never pick up an isbn. Compare the title before any subtitle or bracketed
// series, plus the first author's surname.
function mergeKey(r) {
  const words = normText(String(r.author).split(',')[0]).split(' ');
  return coreTitle(r.title) + '|' + (words[words.length - 1] || '');
}

// Goodreads' auto_complete is a search box, not a lookup: a weak query gets
// whatever it thought was closest rather than nothing. Asking it about
// "1С:Программирование для начинающих" — which truncates to "1С" — comes back
// with The Hunger Games, and that cover would then be cached onto the book for
// a month. A wrong cover is worse than none, since the app's own placeholder
// at least looks deliberate, so a title-based hit has to actually match.
function titleMatches(want, got) {
  // Second pair drops a trailing comma clause, so "The Hobbit" still matches
  // Goodreads' "The Hobbit, or There and Back Again" — the same book, and
  // exactly the kind of cover this whole path exists to fetch. The comma is
  // NOT dropped in mergeKey, where it would over-merge unrelated titles that
  // happen to share a first clause.
  const pairs = [
    [coreTitle(want), coreTitle(got)],
    [coreTitle(String(want || '').split(',')[0]), coreTitle(String(got || '').split(',')[0])]
  ];
  for (const [a, b] of pairs) {
    if (!a || !b) continue;
    // Spaces are squeezed out for the equality test so a numeral written two
    // ways still lands: "Alien³" normalises to "alien3" and Goodreads' "Alien
    // 3" to "alien 3", which are the same book by any reading.
    if (a === b || a.replace(/ /g, '') === b.replace(/ /g, '')) return true;
    // Tolerate one side carrying an edition or series suffix the other lacks,
    // but not a bare prefix that happens to collide.
    const short = a.length <= b.length ? a : b;
    const long = a.length <= b.length ? b : a;
    // The suffix has to begin a NEW word, and that word must not be a number.
    // Without the first rule one trailing character swallowed a whole other
    // book — "Alien", "Aliens" and "Alien³" are three separate Alan Dean
    // Foster novelisations, same author, so the author check waves them
    // through too, and all three took the jacket of whichever was most rated.
    // Without the second, "Alien" still matched "Alien 3", which is how
    // Goodreads spells the third of them.
    if (long.startsWith(short + ' ') && !/^\d/.test(long.slice(short.length + 1))
        && short.length >= Math.max(4, long.length * 0.5)) return true;
  }
  return false;
}

// Later providers fill gaps in earlier ones; they never overwrite. Order in
// equals rank out, so Goodreads results stay on top with their covers while
// gaining the isbn only Google Books and Open Library report.
function mergeResults(lists) {
  const byKey = new Map();
  for (const list of lists) {
    for (const r of list) {
      const key = mergeKey(r);
      const seen = byKey.get(key);
      if (!seen) { byKey.set(key, { ...r }); continue; }
      for (const field of ['isbn', 'isbn13', 'coverUrl', 'author']) {
        if (!seen[field] && r[field]) seen[field] = r[field];
      }
      for (const field of ['pages', 'avgRating', 'ratingsCount']) {
        if (seen[field] == null && r[field] != null) seen[field] = r[field];
      }
    }
  }
  return [...byKey.values()];
}

// Returns the merged hits AND a per-provider status line, which is echoed on
// /meta/search. Diagnosing "why is everything tagged Open Library?" otherwise
// means guessing from the outside, since a dead provider looks exactly like a
// provider with no matches.
// Surname-level, deliberately loose. Editions credit authors inconsistently
// ("Lee Child" vs "Child, Lee" vs "Lee Child (Author)"), so anything stricter
// rejects the right book; anything looser stops telling a summary's packager
// ("Short Reads", "BookRags", "SuperSummary") apart from the real author,
// which is the whole point of the check.
function authorMatches(want, got) {
  const w = normText(String(want || '').split(',')[0]).split(' ').filter(Boolean);
  const g = normText(got);
  if (!w.length || !g) return false;
  const surname = w[w.length - 1];
  return surname.length >= 3 && g.split(' ').includes(surname);
}

// Resolving a cover is not the same problem as a free-text search, and getting
// it wrong is worse: a search result the user rejects costs nothing, a cover is
// attached to their book silently.
//
// Goodreads' auto_complete matches on TITLES and returns about five hits ranked
// by popularity. That has two consequences pulling in opposite directions:
//
//   - Without the author in the query the real book is frequently absent
//     altogether. "The Secret" returns Harry Potter and The Secret Garden and
//     no Lee Child; "Revelations" returns Melissa de la Cruz and no Oliver
//     Bowden; Recall, Brotherhood, In the Darkness and The Method return
//     nothing relevant at all. With the author appended, every one of them
//     comes back at position one.
//   - With the author in the query, summary editions surface, because they are
//     literally titled "<Title> by <Author>" — and their titles truncate to
//     exactly the real one, so no title test can separate them.
//
// What does separate them is the author field: a summary is credited to its
// packager ("Short Reads", "BookRags", "Unknown Author"). So the author goes
// back into the query AND becomes a requirement on the results. The title-only
// query survives as a second stage for the case the first was meant to fix —
// Station Eleven, whose title+author query returns nothing but study guides.
async function goodreadsCover(title, author, isbn) {
  if (isbn) return fromGoodreads(isbn).catch(() => []);
  const firstAuthor = String(author || '').split(',')[0].trim();
  // Subtitle-stripped stages are appended, not substituted: the full title is
  // the more specific question and stays first, so a book whose subtitle
  // Goodreads copes with is answered exactly as before. They collapse away
  // entirely for a title that has no subtitle to drop.
  const stem = searchTitle(title);
  const queries = [...new Set(firstAuthor
    ? [title + ' ' + firstAuthor, stem + ' ' + firstAuthor, stem]
    : [title, stem])];
  // Issued together, not one after the other. Awaiting the first before
  // deciding whether to run the second would put two 5s provider budgets in
  // series, and the client's cover queue gives up at 9s — the fallback stage
  // would time out exactly on the books it exists to rescue. Preference is
  // still by query order, not by whichever answers first.
  const settled = await Promise.allSettled(queries.map(q => fromGoodreads(q)));
  for (const r of settled) {
    const hits = r.status === 'fulfilled' ? r.value : [];
    const ok = hits.filter(x => titleMatches(title, x.title)
      && (!firstAuthor || authorMatches(author, x.author)));
    // An exact title beats a merely tolerated one, and most-rated wins among
    // equals — the canonical edition rather than a box set or a reissue. The
    // first half matters for a family the title check cannot separate at all,
    // because coreTitle() drops what distinguishes them: "The Sandman: Act I",
    // "Act II" and "Act III" all reduce to "sandman", so on ratings alone the
    // most popular volume answered for its two siblings as well.
    const exact = normText(title);
    const isExact = r => (normText(r.title) === exact ? 1 : 0);
    if (ok.length) return ok.sort((a, b) => isExact(b) - isExact(a) || (b.ratingsCount || 0) - (a.ratingsCount || 0));
  }
  return [];
}

// Open Library and Google Books do not have the summary problem and genuinely
// need the author to disambiguate, so they keep the combined query.
async function coverProviders(title, author, isbn, env) {
  const firstAuthor = String(author || '').split(',')[0].trim();
  // Full title here, unlike the Goodreads stages above: these two are ordinary
  // full-text searches that degrade with a long query rather than returning
  // nothing, and dropping a subtitle is what makes two books in one series
  // ("Alien: River of Pain", "Alien: Sea of Sorrows") look like one question.
  const wide = isbn || (title + (firstAuthor ? ' ' + firstAuthor : '')).trim();
  const settled = await Promise.allSettled([
    goodreadsCover(title, author, isbn),
    fromGoogleBooks(wide, env.GOOGLE_BOOKS_KEY),
    fromOpenLibrary(wide)
  ]);
  return mergeResults(settled.map(r => (r.status === 'fulfilled' ? r.value : [])));
}

async function searchProviders(q, env) {
  const jobs = [
    ['goodreads', () => fromGoodreads(q)],
    ['google', () => fromGoogleBooks(q, env.GOOGLE_BOOKS_KEY)],
    ['openlibrary', () => fromOpenLibrary(q)]
  ];
  const settled = await Promise.allSettled(jobs.map(([, run]) => run()));
  const providers = {};
  const lists = settled.map((r, i) => {
    const name = jobs[i][0];
    if (r.status === 'fulfilled') {
      providers[name] = r.value.length ? r.value.length + ' results' : 'no results';
      return r.value;
    }
    providers[name] = 'failed: ' + ((r.reason && r.reason.message) || String(r.reason));
    return [];
  });
  if (!env.GOOGLE_BOOKS_KEY) providers.google = 'skipped (no GOOGLE_BOOKS_KEY secret)';
  return { results: mergeResults(lists), providers };
}

// Cache is best-effort on purpose: without a KV binding /meta still answers,
// it just costs a provider round trip every time. The Google Books key is the
// real reason this exists — it is what keeps repeat lookups inside quota.
async function cached(env, key, ttl, produce) {
  const kv = env.BOOKSHELF_KV;
  if (!kv) return produce();
  const hit = await kv.get(key).catch(() => null);
  if (hit) { try { return JSON.parse(hit); } catch (e) { /* poisoned entry, refetch */ } }
  const value = await produce();
  await kv.put(key, JSON.stringify(value), { expirationTtl: ttl }).catch(() => {});
  return value;
}

// Cover images are the one part of this app a network can break on its own:
// metadata rides this Worker and gets through, while the browser fetches the
// image bytes straight from the CDN. A mobile carrier blocking i.gr-assets.com
// therefore leaves a shelf full of placeholders while search looks perfectly
// healthy. Re-serving those bytes from here removes the whole class of failure.
//
// Deliberately NOT authenticated: an <img> tag cannot send a custom header, so
// x-sync-code is impossible here, and moving the code into the query string
// would defeat the reason it lives in a header at all — it would land in
// server logs, browser history and Referer. The route is kept narrow instead:
// https only, a fixed list of book-cover CDNs, an image content-type and a
// size ceiling. That makes it useless as a general relay.
const IMG_HOSTS = new Set([
  'i.gr-assets.com',
  'images.gr-assets.com',
  's.gr-assets.com',
  'covers.openlibrary.org',
  'books.google.com',
  'books.googleusercontent.com'
]);
const MAX_IMG = 8 * 1024 * 1024;

async function handleImage(origin, url) {
  let target;
  try { target = new URL(url.searchParams.get('u') || ''); }
  catch (e) { return json({ error: 'bad or missing u parameter' }, 400, origin); }
  if (target.protocol !== 'https:' || !IMG_HOSTS.has(target.hostname)) {
    return json({ error: 'host not allowed' }, 403, origin);
  }

  let res;
  try {
    res = await fetch(target.toString(), {
      headers: { 'user-agent': META_UA },
      // Longer than META_TIMEOUT_MS: this budget covers streaming the body,
      // not just the response head.
      signal: AbortSignal.timeout(15000)
    });
  } catch (e) {
    return json({ error: 'upstream unreachable' }, 502, origin);
  }
  if (!res.ok) return json({ error: 'upstream ' + res.status }, res.status === 404 ? 404 : 502, origin);

  const type = res.headers.get('content-type') || '';
  if (!type.startsWith('image/')) return json({ error: 'not an image' }, 415, origin);
  const len = +(res.headers.get('content-length') || 0);
  if (len > MAX_IMG) return json({ error: 'image too large' }, 413, origin);

  // Streamed, not buffered. Cover URLs embed a content hash, so they are
  // immutable and can be cached hard at both the edge and the browser.
  return new Response(res.body, {
    headers: {
      'content-type': type,
      'cache-control': 'public, max-age=31536000, immutable',
      ...corsHeaders(origin)
    }
  });
}

async function handleMeta(request, env, origin, path) {
  if (request.method !== 'GET') return json({ error: 'method not allowed' }, 405, origin);

  // Before the credential check, for the reason spelled out above.
  if (path === '/meta/img') return handleImage(origin, new URL(request.url));

  // Same credential as sync, format-checked only — deliberately NOT looked up
  // in KV, so a device that has a code but has never uploaded can still
  // search. Requiring the header at all is what forces a CORS preflight,
  // which is what makes ALLOWED_ORIGINS bite for browsers, and it keeps this
  // from being a wide-open relay.
  if (!readCode(request)) return json({ error: 'missing or malformed sync code' }, 400, origin);

  const params = new URL(request.url).searchParams;

  if (path === '/meta/search') {
    const q = (params.get('q') || '').trim();
    if (!q) return json({ results: [] }, 200, origin);
    const limit = Math.min(20, Math.max(1, +(params.get('limit') || 8) || 8));
    const key = 'meta:' + META_CACHE_VERSION + ':search:' + await sha256hex(normText(q));
    const data = await cached(env, key, META_TTL, () => searchProviders(q, env));
    // `providers` describes the moment this entry was produced, not this
    // request — a cache hit replays it. Query something new to see live status.
    return json({ results: (data.results || []).slice(0, limit), providers: data.providers }, 200, origin);
  }

  if (path === '/meta/cover') {
    const isbn = (params.get('isbn') || '').trim();
    const title = (params.get('title') || '').trim();
    const author = (params.get('author') || '').trim();
    // Keyed on the FULL title, not the stem the providers are queried with:
    // "The Sandman: Act I", "Act II" and "Act III" are three questions with
    // three answers, and a stripped key handed all of them whichever was asked
    // first. The stem belongs in the query, where a provider needs it short;
    // it does not belong in the identity of the lookup.
    const q = isbn || (title + (author ? ' ' + author.split(',')[0] : '')).trim();
    if (!q) return json({ error: 'nothing to look up' }, 400, origin);
    const key = 'meta:' + META_CACHE_VERSION + ':cover:' + await sha256hex(normText(q));
    // A miss is cached too: a book no provider has must not re-run three
    // lookups on every single session.
    const found = await cached(env, key, COVER_TTL, async () => {
      const results = await coverProviders(title, author, isbn, env);
      // An isbn already identifies the edition, so anything it returns is the
      // right book. A title search does not, and has to be checked.
      const ok = isbn ? results : results.filter(r => titleMatches(title, r.title));
      // Goodreads entries arrive already author-filtered and ranked by
      // goodreadsCover(), and mergeResults keeps them first. This only promotes
      // an author match within the Open Library / Google Books tail, and does
      // it by stable partition rather than a sort so that ranking survives.
      const ranked = author
        ? [...ok.filter(r => authorMatches(author, r.author)),
           ...ok.filter(r => !authorMatches(author, r.author))]
        : ok;
      const withCover = ranked.find(r => r.coverUrl);
      return withCover ? { coverUrl: withCover.coverUrl, source: withCover.source } : {};
    });
    if (!found || !found.coverUrl) return json({ error: 'no cover found' }, 404, origin);
    return json(found, 200, origin);
  }

  return json({ error: 'not found' }, 404, origin);
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

    // Sync ignores the path entirely and always has — every existing client
    // PUTs and GETs the bare worker URL, so routing is additive: only /meta/*
    // is peeled off, everything else falls through to exactly what ran before.
    const path = new URL(request.url).pathname;
    if (path.startsWith('/meta/')) return handleMeta(request, env, origin, path);

    const kv = env.BOOKSHELF_KV;
    if (!kv) return json({ error: 'KV binding BOOKSHELF_KV is not configured' }, 500, origin);

    const code = readCode(request);
    if (!code) return json({ error: 'missing or malformed sync code' }, 400, origin);
    const key = await kvKey(code);

    if (request.method === 'GET') {
      const stored = await kv.get(key);
      if (!stored) return json({ error: 'no shelf stored under this code' }, 404, origin);
      return new Response(stored, {
        headers: { 'content-type': 'application/json', 'cache-control': 'no-store', ...corsHeaders(origin) }
      });
    }

    if (request.method === 'PUT' || request.method === 'POST') {
      const body = await request.text();
      if (body.length > MAX_BODY) return json({ error: 'payload too large' }, 413, origin);
      let data;
      try { data = JSON.parse(body); } catch (e) { return json({ error: 'body is not JSON' }, 400, origin); }
      if (!data || !Array.isArray(data.slim)) return json({ error: 'not a shelf snapshot' }, 400, origin);
      data.updatedAt = data.updatedAt || Date.now();
      await kv.put(key, JSON.stringify(data));
      return json({ ok: true, books: data.slim.length, updatedAt: data.updatedAt }, 200, origin);
    }

    return json({ error: 'method not allowed' }, 405, origin);
  }
};
