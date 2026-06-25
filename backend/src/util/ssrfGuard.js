// SSRF protection for server-side outbound HTTP — currently the agent
// `http_request` tool (engine/agentEngine.js), whose URL is admin/MCP-configured
// and whose params are filled by the LLM at call time.
//
// Goal: stop a tool URL (or a redirect from one) from reaching addresses the
// server can reach but the caller never should — cloud metadata
// (169.254.169.254), loopback, link-local, and other internal endpoints —
// WITHOUT breaking legitimate calls.
//
// Private LAN ranges (10/8, 172.16/12, 192.168/16, CGNAT 100.64/10, IPv6 ULA)
// are ALLOWED by default, because this tool is explicitly documented for calling
// LAN devices/hardware. Set AGENT_HTTP_BLOCK_PRIVATE=true to also block those.
// The always-blocked categories (loopback / link-local / metadata / unspecified
// / multicast / broadcast) have no legitimate external-API use, so blocking them
// cannot break a real integration.

const dns = require('dns').promises;
const net = require('net');

// Read the env on each call (not at module load) so it can be toggled per
// deployment / per test without re-requiring the module.
function blockPrivate() {
  return process.env.AGENT_HTTP_BLOCK_PRIVATE === 'true';
}

// Decide whether a single resolved IP must be blocked.
function isBlockedIp(ip) {
  let addr = String(ip);
  // Unwrap IPv4-mapped IPv6 (e.g. ::ffff:127.0.0.1) to its IPv4 form so the
  // IPv4 rules below catch it.
  if (net.isIP(addr) === 6 && addr.toLowerCase().startsWith('::ffff:')) {
    const tail = addr.slice(addr.lastIndexOf(':') + 1);
    if (net.isIP(tail) === 4) addr = tail;
  }
  const kind = net.isIP(addr);

  if (kind === 4) {
    const [a, b] = addr.split('.').map(Number);
    if (a === 0) return true;                    // 0.0.0.0/8 "this network"
    if (a === 127) return true;                  // loopback 127.0.0.0/8
    if (a === 169 && b === 254) return true;     // link-local 169.254/16 (incl. cloud metadata)
    if (a >= 224) return true;                   // multicast 224/4 + reserved 240/4 + 255.255.255.255
    if (blockPrivate()) {
      if (a === 10) return true;                         // 10/8
      if (a === 172 && b >= 16 && b <= 31) return true;  // 172.16/12
      if (a === 192 && b === 168) return true;           // 192.168/16
      if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    }
    return false;
  }

  if (kind === 6) {
    const l = addr.toLowerCase();
    if (l === '::' || l === '::1') return true;  // unspecified / loopback
    if (l.startsWith('fe80')) return true;       // link-local
    if (l.startsWith('ff')) return true;         // multicast
    if (l.startsWith('::ffff:')) return true;    // any still-mapped IPv4 form → block defensively
    if (blockPrivate() && (l.startsWith('fc') || l.startsWith('fd'))) return true; // ULA fc00::/7
    return false;
  }

  return true; // not a valid IP literal → block defensively
}

// Validate that a URL is safe to fetch. Throws an Error (message is safe to
// surface to the LLM) when it is not. Returns the parsed URL on success.
async function assertPublicUrl(rawUrl) {
  let u;
  try { u = new URL(String(rawUrl)); }
  catch { throw new Error('Invalid URL.'); }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new Error('Only http and https URLs are allowed.');
  }

  const host = u.hostname.replace(/^\[/, '').replace(/\]$/, ''); // strip IPv6 brackets
  let addresses;
  if (net.isIP(host)) {
    addresses = [host];
  } else {
    let resolved;
    try { resolved = await dns.lookup(host, { all: true }); }
    catch { throw new Error(`Could not resolve host "${host}".`); }
    addresses = resolved.map((r) => r.address);
  }
  if (!addresses.length) throw new Error(`Could not resolve host "${host}".`);

  for (const ip of addresses) {
    if (isBlockedIp(ip)) {
      throw new Error('Refusing to call a non-public/internal address.');
    }
  }
  return u;
}

// fetch() wrapper that validates the URL AND every redirect hop. Mirrors the
// standard fetch redirect semantics — GET-ify a non-GET/HEAD request on
// 301/302/303 (dropping the body) and preserve method+body on 307/308 — so it's
// a drop-in for the default redirect:'follow' behaviour, just with each hop
// checked. `validate` is injectable for tests; production uses assertPublicUrl.
async function ssrfSafeFetch(rawUrl, init = {}, { maxRedirects = 20, validate = assertPublicUrl } = {}) {
  let url = String(rawUrl);
  let method = (init.method || 'GET').toUpperCase();
  let body = init.body;
  let headers = init.headers;

  for (let hop = 0; ; hop++) {
    await validate(url);
    const res = await fetch(url, { ...init, method, body, headers, redirect: 'manual' });

    const location = res.status >= 300 && res.status < 400 ? res.headers.get('location') : null;
    if (!location) return res;
    if (hop >= maxRedirects) throw new Error('Too many redirects.');

    // Release the redirect response body so the socket can be reused.
    try { await res.body?.cancel(); } catch { /* ignore */ }

    const next = new URL(location, url).toString();
    if ((res.status === 301 || res.status === 302 || res.status === 303) && method !== 'GET' && method !== 'HEAD') {
      method = 'GET';
      body = undefined;
      if (headers && typeof headers === 'object') {
        headers = { ...headers };
        for (const k of Object.keys(headers)) {
          if (/^content-(type|length)$/i.test(k)) delete headers[k];
        }
      }
    }
    url = next;
  }
}

module.exports = { assertPublicUrl, isBlockedIp, ssrfSafeFetch };
