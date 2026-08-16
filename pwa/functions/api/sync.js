// Cloudflare Pages Function — GET/PUT the shelf snapshot for one sync code.
//
// Setup (Cloudflare dashboard):
//   Workers & Pages -> your project -> Settings -> Functions -> KV namespace
//   bindings -> add binding named  BOOKSHELF_KV  pointing at a KV namespace
//   you create under Storage & Databases -> KV.
//
// The sync code is the only credential. It is never stored or logged in the
// clear: KV is keyed by its SHA-256, so a dump of the namespace does not hand
// out working codes. Anyone holding a code can read and overwrite that shelf,
// which is why the client generates a 48-hex-character one.

const MIN_CODE = 16;
const MAX_BODY = 5 * 1024 * 1024; // a shelf is ~30KB; this is a sanity ceiling

function json(obj, status) {
  return new Response(JSON.stringify(obj), {
    status: status || 200,
    headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
  });
}

function readCode(request) {
  const code = (request.headers.get('x-sync-code') || '').trim();
  // Deliberately header-only: a code in the query string would end up in
  // server logs, browser history and any referrer.
  if (code.length < MIN_CODE || code.length > 200) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(code)) return null;
  return code;
}

async function kvKey(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return 'shelf:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export async function onRequest(context) {
  const { request, env } = context;
  const kv = env.BOOKSHELF_KV;
  if (!kv) return json({ error: 'KV binding BOOKSHELF_KV is not configured' }, 500);

  const code = readCode(request);
  if (!code) return json({ error: 'missing or malformed sync code' }, 400);
  const key = await kvKey(code);

  if (request.method === 'GET') {
    const stored = await kv.get(key);
    if (!stored) return json({ error: 'no shelf stored under this code' }, 404);
    return new Response(stored, {
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
    });
  }

  if (request.method === 'PUT' || request.method === 'POST') {
    const body = await request.text();
    if (body.length > MAX_BODY) return json({ error: 'payload too large' }, 413);
    let data;
    try { data = JSON.parse(body); } catch (e) { return json({ error: 'body is not JSON' }, 400); }
    if (!data || !Array.isArray(data.slim)) return json({ error: 'not a shelf snapshot' }, 400);
    data.updatedAt = data.updatedAt || Date.now();
    await kv.put(key, JSON.stringify(data));
    return json({ ok: true, books: data.slim.length, updatedAt: data.updatedAt });
  }

  return json({ error: 'method not allowed' }, 405);
}
