// NODE_PATH should point to an external install containing playwright and @electric-sql/pglite.
// No real provider credentials, paid requests, or production data are used.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { stripTypeScriptTypes } = require('node:module');
const root = path.resolve(__dirname, '..');
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';

async function backendTests() {
  const src = stripTypeScriptTypes(fs.readFileSync(path.join(root, 'supabase/functions/ai-proxy/handler.ts'), 'utf8'));
  const { makeHandler } = await import('data:text/javascript;base64,' + Buffer.from(src).toString('base64'));
  const env = { ALLOWED_ORIGINS: 'https://studio.test', ALLOWED_OR_MODELS: 'allowed-text', ALLOWED_GEMINI_MODELS: 'allowed-gemini', ALLOWED_IMAGE_MODELS: 'allowed-image', OPENROUTER_API_KEY: 'private-or-fixture', GEMINI_API_KEY: 'private-gm-fixture' };
  let quota = 'ok', upstream = 200, calls = [], reservations = [];
  const handler = makeHandler({ env: n => env[n], verify: async t => t === 'valid' ? userA : null,
    reserve: async (id, image) => { reservations.push({ id, image }); return quota; },
    fetch: async (url, init) => { calls.push({ url, init }); const image = url.endsWith('/images'); return Response.json(upstream === 200 ? (image ? { data: [{ b64_json: 'YWJj', media_type: 'image/png' }], usage: { cost: .01, secret: 'do-not-return' } } : { choices: [{ message: { content: 'test' }, finish_reason: 'stop' }], usage: { total_tokens: 12, secret: 'do-not-return' }, secret: 'do-not-return' }) : { error: { message: env.OPENROUTER_API_KEY } }, { status: upstream }); }
  });
  const body = { action: 'chat', provider: 'or', model: 'allowed-text', messages: [{ role: 'user', content: 'test' }], maxTokens: 100, effort: 'low' };
  const call = (data = body, token = 'valid', origin = 'https://studio.test', method = 'POST') => handler(new Request('https://edge.test', { method, headers: { Origin: origin, Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' }, ...(method === 'POST' ? { body: JSON.stringify(data) } : {}) }));
  assert.equal((await call(body, 'invalid')).status, 401);
  assert.equal((await call(body, 'valid', 'https://evil.test')).status, 403);
  assert.equal((await call(body, 'valid', 'https://studio.test', 'OPTIONS')).status, 204);
  assert.equal((await call({ ...body, model: 'expensive-unapproved' })).status, 400);
  assert.equal((await call({ ...body, maxTokens: 9000 })).status, 400);
  assert.equal((await call({ ...body, messages: [{ role: 'tool', content: 'test' }] })).status, 400);
  assert.equal((await call({ ...body, messages: [{ role: 'user', content: 'x'.repeat(210000) }] })).status, 400);
  assert.equal(calls.length, 0);
  quota = 'forbidden'; assert.equal((await call()).status, 403);
  for (const q of ['daily', 'minute', 'images']) { quota = q; assert.equal((await call()).status, 429); }
  assert.equal(calls.length, 0);
  quota = 'ok';
  const r = await call({ ...body, user_id: userB, url: 'https://evil.test', apiKey: 'ignored', stream: true });
  assert.equal(r.status, 200);
  const output = await r.text(); assert(!output.includes('private')); assert(!output.includes('do-not-return'));
  assert.equal(reservations.at(-1).id, userA);
  assert.equal(calls.at(-1).url, 'https://openrouter.ai/api/v1/chat/completions');
  const sent = JSON.parse(calls.at(-1).init.body); assert(!sent.url && !sent.apiKey && !sent.stream);
  assert.equal(calls.at(-1).init.redirect, 'error');
  assert.equal((await call({ ...body, provider: 'gm', model: 'allowed-gemini' })).status, 200);
  assert(calls.at(-1).url.startsWith('https://generativelanguage.googleapis.com/'));
  upstream = 401;
  const failed = await call(); assert.equal(failed.status, 502); assert(!(await failed.text()).includes('private-or-fixture'));
  upstream = 200;
  assert.equal((await call({ action: 'image', provider: 'or', model: 'allowed-image', prompt: 'coffee', ratio: '4:5' })).status, 200);
  assert.equal(JSON.parse(calls.at(-1).init.body).n, 1);
  delete env.OPENROUTER_API_KEY;
  assert.equal((await call()).status, 503);
  console.log('PASS backend: authentication, allowlists, quota denial, request/response sanitization, text + image routing');
}

async function databaseTests() {
  const { PGlite } = require('@electric-sql/pglite');
  const db = new PGlite();
  try {
    await db.exec(`create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
      grant usage on schema auth, public to anon, authenticated, service_role;
      insert into auth.users values ('${userA}'), ('${userB}');`);
    await db.exec(fs.readFileSync(path.join(root, 'supabase/migrations/202611130001_secure_ai.sql'), 'utf8'));
    await db.exec(`set role authenticated; set request.jwt.claim.sub = '${userA}'; insert into public.user_settings values ('${userA}', '{"spec":"A"}', now());`);
    await assert.rejects(db.exec(`insert into public.user_settings(user_id,data) values ('${userB}', '{}')`), /row-level security/);
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${userB}';`);
    assert.equal((await db.query('select * from public.user_settings')).rows.length, 0);
    assert.equal((await db.query(`update public.user_settings set data = '{}' where user_id = '${userA}' returning *`)).rows.length, 0);
    await assert.rejects(db.exec('select * from public.ai_members'), /permission denied/);
    await assert.rejects(db.exec(`select public.reserve_ai_request('${userA}', false)`), /permission denied/);
    await db.exec(`reset role; set role authenticated; set request.jwt.claim.sub = '${userA}';`);
    await assert.rejects(db.exec(`update public.user_settings set data = '{"key":"secret"}'`), /check constraint/);
    await assert.rejects(db.exec(`update public.user_settings set data = '{"spec":{"key":"secret"}}'`), /check constraint/);
    await db.exec(`reset role; set role anon;`);
    await assert.rejects(db.exec('select * from public.user_settings'), /permission denied/);
    await db.exec(`reset role; insert into public.ai_members(user_id,enabled,daily_requests,daily_images,minute_requests) values ('${userA}',true,3,1,2); set role service_role;`);
    const reserve = async (id, image) => (await db.query('select public.reserve_ai_request($1,$2) as result', [id, image])).rows[0].result;
    assert.equal(await reserve(userB, false), 'forbidden');
    assert.equal(await reserve(userA, true), 'ok');
    assert.equal(await reserve(userA, true), 'images');
    assert.equal(await reserve(userA, false), 'ok');
    assert.equal(await reserve(userA, false), 'minute');
    await db.exec(`update public.ai_usage set minute_start = now() - interval '2 minutes'`);
    assert.equal(await reserve(userA, false), 'ok');
    assert.equal(await reserve(userA, false), 'daily');
    await db.exec(`update public.ai_usage set usage_day = current_date - 2, minute_start = now() - interval '2 minutes'`);
    assert.equal(await reserve(userA, true), 'ok');
    await db.exec(`update public.ai_members set enabled = false`);
    assert.equal(await reserve(userA, false), 'forbidden');
    console.log('PASS PostgreSQL: settings isolation, no key fields, admin-only membership/quota, daily/image/minute limits + reset');
  } finally { await db.close(); }
}

async function browserTests() {
  const { chromium } = require('playwright');
  const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  const server = http.createServer((req, res) => { res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(html); });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const context = await browser.newContext();
  const page = await context.newPage(), errors = [], requests = [];
  const cloud = { [userA]: { spec: 'account A brand', order: 'or-only' }, [userB]: { spec: 'account B brand', order: 'or-only' } };
  const stub = `window.testAuth = null; window.testUser = null; window.failSettings = false;
    window.supabase = {createClient:()=>({auth:{onAuthStateChange:cb=>{window.testAuth=cb},getSession:async()=>({data:{session:window.testUser?{user:{id:window.testUser},access_token:'test-session'}:null}}),signOut:async()=>{window.testUser=null;window.testAuth('SIGNED_OUT',null);return {error:null}}},
    from:table=>({select:()=>({eq:(key,id)=>({maybeSingle:async()=>({data:window.failSettings?null:(window.testCloud[id]?{data:window.testCloud[id]}:null),error:window.failSettings?{message:'offline'}:null})}),order:async()=>({data:[],error:null})}),upsert:async row=>{window.testSaved=row;window.testCloud[row.user_id]=row.data;return {error:null}}})})};`;
  await context.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: stub }));
  await context.route('https://**/functions/v1/ai-proxy', r => {
    const body = r.request().postDataJSON();
    requests.push({ headers: r.request().headers(), body });
    return r.fulfill({ contentType: 'application/json', body: JSON.stringify(body.action === 'image'
      ? { src: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', cost: .01 }
      : { text: '【IG】test', usage: { total_tokens: 10 } }) });
  });
  await context.route('https://openrouter.ai/**', () => { throw new Error('frontend called OpenRouter directly'); });
  await context.route('https://generativelanguage.googleapis.com/**', () => { throw new Error('frontend called Gemini directly'); });
  page.on('pageerror', e => errors.push(e.message));
  await page.addInitScript(({ cloud }) => { window.testCloud = cloud; localStorage.setItem('demo-settings', JSON.stringify({ spec: 'legacy brand', key: 'legacy-secret', gkey: 'legacy-gemini' })); }, { cloud });
  try {
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.waitForFunction(() => typeof askAI === 'function');
    assert(!(await page.evaluate(() => localStorage.getItem('demo-settings'))).includes('legacy-secret'));
    assert.equal(await page.locator('#setKey, #setGKey').count(), 0);
    assert.match(await page.evaluate(async () => { try { await askAI([{ role: 'user', content: 'test' }]); return '' } catch(e) { return e.message } }), /登入/);
    const login = async id => { await page.evaluate(id => { window.testUser=id; window.testAuth('SIGNED_IN',{user:{id,email:id+'@test'}}) },id); await page.waitForFunction(() => settingsReady); };
    await login(userA);
    await page.locator('#btnSet').click();
    assert.equal(await page.locator('#setSpec').inputValue(), 'account A brand');
    await page.locator('#setSpec').fill('updated A'); await page.locator('#btnSetSave').click();
    await page.waitForFunction(() => !!window.testSaved);
    const saved = await page.evaluate(() => window.testSaved);
    assert.equal(saved.user_id, userA); assert(!('key' in saved.data)); assert(!('gkey' in saved.data));
    // A genuinely separate browser storage starts with only the cloud settings.
    const mobile = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true });
    try {
      await mobile.route('https://cdn.jsdelivr.net/**', r => r.fulfill({ contentType: 'application/javascript', body: stub }));
      await mobile.addInitScript(({ id, data }) => { window.testCloud = { [id]: data }; }, { id: userA, data: saved.data });
      const phone = await mobile.newPage();
      await phone.goto(`http://127.0.0.1:${server.address().port}`);
      await phone.evaluate(id => { window.testUser=id;window.testAuth('SIGNED_IN',{user:{id,email:'phone@test'}}) }, userA);
      await phone.waitForFunction(() => settingsReady);
      await phone.locator('#btnSet').click();
      assert.equal(await phone.locator('#setSpec').inputValue(), 'updated A');
      assert(!(await phone.evaluate(() => JSON.stringify(localStorage))).includes('legacy-secret'));
    } finally { await mobile.close(); }
    await login(userB); assert.equal(await page.locator('#setSpec').inputValue(), 'account B brand');
    await page.evaluate(() => askAI([{ role: 'user', content: 'hello' }]));
    assert.equal(requests.length, 1); assert.equal(requests[0].headers.authorization, 'Bearer test-session');
    assert(!JSON.stringify(requests[0].body).includes('secret'));
    const image = await page.evaluate(() => askImage('coffee', '1:1'));
    assert.match(image.src, /^data:image\/jpeg;base64,/);
    assert.equal(requests.at(-1).body.action, 'image');
    await page.evaluate(() => { window.failSettings = true; settingsReady = false; });
    await page.locator('#btnSettingsPull').click(); await page.locator('#btnSetSave').click();
    assert.match(await page.locator('#settingsSay').innerText(), /先成功載入/);
    await page.evaluate(() => window.testAuth('SIGNED_OUT',null));
    assert.equal(await page.evaluate(() => settingsUser), null);
    assert.equal(await page.locator('#setSpec').inputValue(), 'legacy brand');
    assert.deepEqual(errors, []);
    console.log('PASS browser: legacy key cleanup, login gate, cross-device settings, account switch, sync-failure guard, backend-only text + image AI');
  } finally { await context.close(); await browser.close(); server.close(); }
}

(async () => { await backendTests(); await databaseTests(); await browserTests(); })().catch(e => { console.error(e); process.exitCode = 1; });
