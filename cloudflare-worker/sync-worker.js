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

async function kvKey(code) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(code));
  return 'shelf:' + [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get('origin') || '';

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(origin) });
    }

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
