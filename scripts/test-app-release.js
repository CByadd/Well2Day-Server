const path = require('path');
const assert = require('assert');
// Self-check for routes/appReleaseRoutes.js (no DB/auth needed): node scripts/test-app-release.js
const SERVER = path.join(__dirname, '..');
const tmp = path.join(require('os').tmpdir(), 'w2d-ota-test'); require('fs').rmSync(tmp, { recursive: true, force: true });
process.env.OTA_DATA_DIR = tmp; process.env.ASSETS_DIR = path.join(tmp, 'assets'); process.env.ASSET_BASE_URL = 'http://x/assets';
const updates = [];
require.cache[require.resolve(SERVER + '/db')] = { exports: { adscapePlayer: {
  updateMany: async (a) => updates.push(a), findMany: async () => [{ screenId: '111' }] } } };
require.cache[require.resolve(SERVER + '/middleware/authMiddleware')] = { exports: {
  authenticateToken: (req, _r, n) => { req.user = { email: 'a@b', role: 'super_admin' }; n(); }, requireSuperAdmin: (_q, _r, n) => n() } };
const express = require(SERVER + '/node_modules/express');
const emitted = [];
const io = { emit: (e, p) => emitted.push(['all', e, p]), to: (r) => ({ emit: (e, p) => emitted.push([r, e, p]) }) };
const app = express(); app.use(express.json()); app.use('/api', require(SERVER + '/routes/appReleaseRoutes')(io));
const srv = app.listen(0, async () => {
  const base = `http://127.0.0.1:${srv.address().port}/api`;
  const apk = Buffer.concat([Buffer.from('PK'), Buffer.alloc(100, 1)]);
  const up = async (vc, ids = '') => { const f = new FormData(); f.append('packageName', 'p'); f.append('versionCode', String(vc)); f.append('screenIds', ids); f.append('apk', new Blob([apk]), 'a.apk'); return fetch(base + '/app-releases', { method: 'POST', body: f }); };
  assert.equal((await fetch(base + '/app-release/latest?package=p').then(r => r.json())).release, null);
  assert.equal((await up(5, '111, 222')).status, 200);
  assert.deepEqual(emitted, [['screen:111', 'app-update-available', { packageName: 'p', versionCode: 5 }], ['screen:222', 'app-update-available', { packageName: 'p', versionCode: 5 }]]);
  assert.equal((await fetch(base + '/app-release/latest?package=p&screenId=333').then(r => r.json())).release, null);
  const rel = (await fetch(base + '/app-release/latest?package=p&screenId=111').then(r => r.json())).release;
  assert.equal(rel.versionCode, 5); assert.equal(rel.size, 102); assert.equal(rel.sha256, require('crypto').createHash('sha256').update(apk).digest('hex'));
  assert.match(rel.url, /^http:\/\/x\/assets\/apk\/.+p-5\.apk$/);
  assert.equal((await up(4)).status, 400);
  assert.equal((await up(5)).status, 200); // widen rollout
  assert.equal((await fetch(base + '/app-release/latest?package=p&screenId=333').then(r => r.json())).release.versionCode, 5);
  assert.deepEqual(emitted.at(-1), ['all', 'app-update-available', { packageName: 'p', versionCode: 5 }]);
  const rep = await fetch(base + '/app-release/report', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ screenId: '111', status: 'installed', versionCode: 5 }) });
  assert.equal(rep.status, 200); assert.equal(updates[0].data.appVersionCode, '5');
  const list = await fetch(base + '/app-releases').then(r => r.json());
  assert.equal(list.reports['111'].status, 'installed'); assert.equal(list.screens.length, 1);
  console.log('OK'); srv.close();
});
