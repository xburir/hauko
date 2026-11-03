// Hauko — staticky server pre psik.html (otazka na rande).
// Ciste node http, ziadne npm zavislosti. pm2 `hauko`, port 3032.
// Server je potrebny, lebo psik.html si cez fetch() taha texty.json,
// co z file:// nefunguje.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = Number(process.env.PORT) || 3032;
const ROOT = __dirname;

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
};

http.createServer((req, res) => {
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405).end();
    return;
  }
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  if (p === '/') p = '/psik.html';
  const file = path.join(ROOT, path.normalize(p));
  const type = TYPES[path.extname(file).toLowerCase()];
  // len subory z tohto priecinka, ziadne skryte (.git) ani ine pripony
  if (!file.startsWith(ROOT + path.sep) || p.split('/').some((s) => s.startsWith('.')) || !type) {
    res.writeHead(404).end('404');
    return;
  }
  fs.readFile(file, (err, data) => {
    if (err) {
      res.writeHead(404).end('404');
      return;
    }
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}).listen(PORT, '0.0.0.0', () => console.log(`hauko na :${PORT}`));
