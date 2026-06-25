'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { isBlockedIp, assertPublicUrl, ssrfSafeFetch } = require('../src/util/ssrfGuard');

test('isBlockedIp blocks loopback / link-local / metadata / unspecified / multicast / broadcast', () => {
  for (const ip of [
    '127.0.0.1', '127.1.2.3', '0.0.0.0', '169.254.169.254', '169.254.0.1',
    '224.0.0.1', '239.255.255.255', '255.255.255.255',
    '::1', '::', 'fe80::1', 'ff02::1', '::ffff:127.0.0.1',
  ]) {
    assert.equal(isBlockedIp(ip), true, `${ip} should be blocked`);
  }
});

test('isBlockedIp allows public addresses', () => {
  for (const ip of ['8.8.8.8', '1.1.1.1', '142.250.190.78', '2606:4700:4700::1111']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed`);
  }
});

test('private LAN ranges are allowed by default, blocked only when AGENT_HTTP_BLOCK_PRIVATE=true', () => {
  delete process.env.AGENT_HTTP_BLOCK_PRIVATE;
  for (const ip of ['10.0.0.5', '172.16.5.5', '172.31.255.255', '192.168.1.50', '100.64.0.1']) {
    assert.equal(isBlockedIp(ip), false, `${ip} should be allowed by default`);
  }
  // Addresses just outside the private blocks stay public either way.
  assert.equal(isBlockedIp('172.32.0.1'), false);
  assert.equal(isBlockedIp('11.0.0.1'), false);

  process.env.AGENT_HTTP_BLOCK_PRIVATE = 'true';
  try {
    for (const ip of ['10.0.0.5', '172.16.5.5', '192.168.1.50', '100.64.0.1', 'fd00::1']) {
      assert.equal(isBlockedIp(ip), true, `${ip} should be blocked with AGENT_HTTP_BLOCK_PRIVATE`);
    }
    assert.equal(isBlockedIp('172.32.0.1'), false, '172.32 is outside 172.16/12');
    assert.equal(isBlockedIp('8.8.8.8'), false, 'public stays allowed');
  } finally {
    delete process.env.AGENT_HTTP_BLOCK_PRIVATE;
  }
});

test('assertPublicUrl rejects bad scheme, unparseable URLs, and internal addresses', async () => {
  await assert.rejects(() => assertPublicUrl('ftp://example.com/'), /http and https/);
  await assert.rejects(() => assertPublicUrl('file:///etc/passwd'), /http and https/);
  await assert.rejects(() => assertPublicUrl('not a url'), /Invalid URL/);
  await assert.rejects(() => assertPublicUrl('http://127.0.0.1/x'), /non-public/);
  await assert.rejects(() => assertPublicUrl('http://169.254.169.254/latest/meta-data/'), /non-public/);
  await assert.rejects(() => assertPublicUrl('https://[::1]/x'), /non-public/);
  await assert.rejects(() => assertPublicUrl('http://localhost/x'), /non-public/); // resolves to loopback
});

test('assertPublicUrl accepts a public IP literal', async () => {
  const u = await assertPublicUrl('http://8.8.8.8/path?q=1');
  assert.equal(u.hostname, '8.8.8.8');
});

test('ssrfSafeFetch follows redirects and re-validates each hop', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/a') { res.writeHead(302, { Location: '/b' }); return res.end(); }
    if (req.url === '/b') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ ok: true })); }
    res.writeHead(404); res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    // Permissive validator: this test exercises redirect *mechanics* against a
    // loopback server (which the real guard would block). Production uses the
    // default assertPublicUrl.
    const allowAll = async (u) => new URL(u);
    const res = await ssrfSafeFetch(`http://127.0.0.1:${port}/a`, {}, { validate: allowAll });
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { ok: true });
  } finally {
    server.close();
  }
});

test('ssrfSafeFetch blocks a redirect whose target is an internal address', async () => {
  const server = http.createServer((req, res) => {
    // Redirect to the cloud metadata endpoint — the real guard must reject the hop.
    res.writeHead(302, { Location: 'http://169.254.169.254/latest/meta-data/' });
    res.end();
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const port = server.address().port;
    // Allow the loopback origin so we reach the redirect, but delegate every
    // other host to the REAL guard so the metadata hop is the thing under test.
    const validate = async (u) => {
      const url = new URL(u);
      if (url.hostname === '127.0.0.1') return url;
      return assertPublicUrl(u);
    };
    await assert.rejects(
      () => ssrfSafeFetch(`http://127.0.0.1:${port}/a`, {}, { validate }),
      /non-public/,
    );
  } finally {
    server.close();
  }
});
