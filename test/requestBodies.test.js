// Compressed request bodies and the Node pin. The Oct 21 2026 Node security release fixed a
// Brotli decoder bug that let crafted data run code, and body-parser decompressed any gzip or
// Brotli request body through that decoder. No browser compresses a form post or a fetch() body,
// so server.js's parsers refuse them. server.js connects to MongoDB as soon as it loads, so these
// read its source and rebuild the parsers with the same settings.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const zlib = require('node:zlib');
const express = require('express');

const SERVER = fs.readFileSync(path.join(__dirname, '../server.js'), 'utf8');
const PACKAGE = require('../package.json');

// True when version a.b.c is the same as or newer than minimum
function atLeast(version, minimum) {
  const have = version.split('.').map(Number);
  const need = minimum.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (have[i] !== need[i]) return have[i] > need[i];
  }
  return true;
}

// Posts raw bytes to the app on a free local port and resolves with the status
async function post(app, contentType, body, encoding) {
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  try {
    return await new Promise((resolve, reject) => {
      const headers = { 'Content-Type': contentType, 'Content-Length': body.length };
      if (encoding) headers['Content-Encoding'] = encoding;
      const req = http.request({ host: '127.0.0.1', port: server.address().port, method: 'POST', path: '/form', headers }, (res) => {
        res.resume();
        res.on('end', () => resolve(res.statusCode));
      });
      req.on('error', reject);
      req.end(body);
    });
  } finally {
    server.close();
  }
}

// An app with server.js's two parsers, recording what reaches the route
function buildApp(options = { inflate: false }) {
  const app = express();
  const reached = [];
  app.use(express.urlencoded({ extended: false, ...options }));
  app.use(express.json(options));
  app.post('/form', (req, res) => {
    reached.push(req.body);
    res.send('ok');
  });
  app.use((err, req, res, _next) => res.status(err.status || 500).send(err.message));
  return { app, reached };
}

describe('server.js', () => {
  it('refuses compressed bodies on both body parsers', () => {
    assert.match(SERVER, /express\.urlencoded\(\{[^}]*inflate:\s*false[^}]*\}\)/);
    assert.match(SERVER, /express\.json\(\{[^}]*inflate:\s*false[^}]*\}\)/);
  });

  // Railway's deploy log then shows which Node the app runs on
  it('logs the Node version at startup', () => {
    assert.ok(SERVER.includes('process.version'));
  });
});

describe('body parsers with inflate: false', () => {
  it('refuse a Brotli-compressed form post with a 415, before the route', async () => {
    const { app, reached } = buildApp();
    assert.equal(await post(app, 'application/x-www-form-urlencoded', zlib.brotliCompressSync('route=W%20LINE'), 'br'), 415);
    assert.deepEqual(reached, []);
  });

  it('refuse a compressed JSON body too', async () => {
    const { app, reached } = buildApp();
    assert.equal(await post(app, 'application/json', zlib.gzipSync('{"route":"W LINE"}'), 'gzip'), 415);
    assert.deepEqual(reached, []);
  });

  it('still read normal form posts and JSON', async () => {
    const { app, reached } = buildApp();
    assert.equal(await post(app, 'application/x-www-form-urlencoded', Buffer.from('route=W%20LINE')), 200);
    assert.equal(await post(app, 'application/json', Buffer.from('{"route":"W LINE"}')), 200);
    assert.deepEqual(reached, [{ route: 'W LINE' }, { route: 'W LINE' }]);
  });

  // What the parsers did before: the Brotli body is decompressed and reaches the route
  it('would have decompressed the same body without inflate: false', async () => {
    const { app, reached } = buildApp({});
    assert.equal(await post(app, 'application/x-www-form-urlencoded', zlib.brotliCompressSync('route=W%20LINE'), 'br'), 200);
    assert.deepEqual(reached, [{ route: 'W LINE' }]);
  });
});

describe('package.json', () => {
  // Railway's builder installs exactly the version in engines. A range let Nixpacks pick whatever
  // it had, so the security release might never arrive. Bump the pin; don't loosen it.
  it('pins Node exactly, no older than the Oct 2026 security release', () => {
    assert.match(PACKAGE.engines.node, /^\d+\.\d+\.\d+$/);
    assert.ok(atLeast(PACKAGE.engines.node, '24.22.1'));
  });
});
