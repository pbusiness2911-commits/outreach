import http from 'node:http';
const mod = await import('./src/index.js');
const store = {};
const raw = await fetch(process.env.REPLIES_APP_URL + '/replies').then(r => r.json());
store.replies = JSON.stringify(raw); store.secret = 'x';
const env = { KV: { get: async k => store[k] ?? null, put: async () => {} } };
http.createServer(async (req, res) => {
  const r = await mod.default.fetch(new Request('http://localhost:8799' + req.url.replace(/^\/$/, '/a/x/'), { method: req.method }), env);
  res.writeHead(r.status, Object.fromEntries(r.headers)); res.end(Buffer.from(await r.arrayBuffer()));
}).listen(8799, () => console.log('ready'));
