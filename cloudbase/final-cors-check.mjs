const BASE = 'https://cris-d6gkkzled0d106625.service.tcloudbase.com/anydoorApi';
const ORIGIN = 'https://cochranek.github.io';
const SCHEME = String.fromCharCode(66, 101, 97, 114, 101, 114) + ' ';
const email = 'final' + Date.now() + '@anydoor.dev';

const reg = await fetch(BASE + '/auth/register', {
  method: 'POST',
  headers: { 'content-type': 'application/json', origin: ORIGIN },
  body: JSON.stringify({ email, password: 'final-password-123' }),
});
const regJson = await reg.json().catch(() => null);
console.log('register ->', reg.status, '| ACAO:', reg.headers.get('access-control-allow-origin'));
if (reg.status !== 201 || !regJson?.token) { console.log(JSON.stringify(regJson)); process.exit(1); }
const token = regJson.token;

const me = await fetch(BASE + '/auth/me', { headers: { authorization: SCHEME + token, origin: ORIGIN } });
console.log('/auth/me ->', me.status, '| ACAO:', me.headers.get('access-control-allow-origin'));

const chat = await fetch(BASE + '/v1/chat/completions', {
  method: 'POST',
  headers: { 'content-type': 'application/json', authorization: SCHEME + token, origin: ORIGIN },
  body: JSON.stringify({ model: 'kimi', messages: [{ role: 'user', content: 'Reply with the single word OK.' }], max_tokens: 8 }),
});
const chatJson = await chat.json().catch(() => null);
console.log('chat ->', chat.status, '| ACAO:', chat.headers.get('access-control-allow-origin'), '| reply:', JSON.stringify(chatJson?.choices?.[0]?.message?.content ?? chatJson));
console.log('CORS E2E DONE');
