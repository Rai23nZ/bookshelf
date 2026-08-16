"""Cross-origin stand-in for the standalone Cloudflare Worker
(cloudflare-worker/sync-worker.js). Runs on a DIFFERENT port from the static
site so the browser treats it as a different origin and actually exercises
CORS (preflight OPTIONS, Access-Control-Allow-Origin, etc.) the same way it
will against the real workers.dev deployment."""

import http.server, socketserver, json, hashlib, sys

PORT = 8744
STORE = {}
MIN_CODE = 16
ALLOWED_ORIGINS = {'http://localhost:8743', 'http://127.0.0.1:8743'}

import re
CODE_RE = re.compile(r'^[A-Za-z0-9_-]+$')


def read_code(handler):
    code = (handler.headers.get('x-sync-code') or '').strip()
    if len(code) < MIN_CODE or len(code) > 200:
        return None
    if not CODE_RE.match(code):
        return None
    return code


def kv_key(code):
    return 'shelf:' + hashlib.sha256(code.encode()).hexdigest()


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
