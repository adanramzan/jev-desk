import test from 'node:test';
import assert from 'node:assert/strict';
import { request } from 'node:http';
import { startServer } from '../scripts/serve.mjs';

function status(url, path) {
  return new Promise((resolve, reject) => {
    const req = request(url, { path }, res => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('static server binds an ephemeral port and rejects malformed or escaping paths', async t => {
  const server = await startServer(0);
  t.after(() => server.close());
  assert.notEqual(new URL(server.url).port, '0');
  assert.equal(await status(server.url, '/'), 200);
  assert.equal(await status(server.url, '/%'), 400);
  assert.equal(await status(server.url, '/core/%2F..%2Fcore2/secret'), 403);
  assert.equal(await status(server.url, '/'), 200);
});
