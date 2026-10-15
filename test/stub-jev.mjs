import { createServer } from 'node:http';

export function startStubJev({ truthFor }) {
  const calls = [];
  const server = createServer(async (req, res) => {
    if (req.method !== 'POST' || req.url !== '/v1/systemone') {
      res.writeHead(404).end();
      return;
    }
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const request = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(request);
      const answers = await truthFor(request);
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ model: 'jev-1.14.0', answers, usage: { input_tokens: 3000, output_tokens: 90 } }));
    } catch (error) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ message: error.message }));
    }
  });
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve({
      url: `http://127.0.0.1:${server.address().port}`,
      calls,
      close: () => new Promise(done => server.close(done)),
    }));
  });
}
