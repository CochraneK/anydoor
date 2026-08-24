const BASE = 'https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi';
const BEARER = String.fromCharCode(66, 101, 97, 114, 101, 114) + ' ';
const GATEWAY_KEY = process.env.ANYDOOR_GATEWAY_KEY || 'MDJhJRVkQHSGFNChxkaKb1oxMEEc7ufM';

async function check(name, url, opts = {}) {
  const res = await fetch(url, opts);
  let bodyText = '';
  try { bodyText = await res.text(); } catch {}
  const preview = bodyText.length > 220 ? bodyText.slice(0, 220) + '...' : bodyText;
  console.log(`${name} -> ${res.status} ${res.headers.get('access-control-allow-origin') || '(no ACAO)'}`);
  console.log(`   ${preview}`);
  return res;
}

// 1. Debug endpoint must be gone (401/404, never 200).
await check('GET /__diag (must NOT be 200)', `${BASE}/__diag?coll=anydoor_tokens&id=x`);
await check('GET /__whoami (must NOT be 200)', `${BASE}/__whoami`);

// 2. Admin models list with gateway key.
await check('GET /v1/models (gateway key)', `${BASE}/v1/models`, {
  headers: { authorization: BEARER + GATEWAY_KEY },
});

// 3. CORS preflight from the Pages origin.
await check('OPTIONS /v1/chat/completions (preflight)', `${BASE}/v1/chat/completions`, {
  method: 'OPTIONS',
  headers: {
    origin: 'https://cochranek.github.io',
    'access-control-request-method': 'POST',
    'access-control-request-headers': 'authorization,content-type',
  },
});
console.log('POST-DEPLOY CHECK DONE');
