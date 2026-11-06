// Hauko — otazka s utekajucim "Nie" + webove UI na vlastne scenare.
// Ciste node http, ziadne npm zavislosti. pm2 `hauko`, port 3032.
//
// Cesty:
//   GET  /               presmeruje na /create (stary scenar zo scenar.json: /s/<nazov>, napr. /s/rande)
//   GET  /create         verejny formular na vlastny scenar
//   GET  /api/status     kolko odkazov este moze vytvorit + ci nie je plny disk
//   POST /api/create     uloz scenar + obrazky -> { id, url }
//   GET  /s/<id>         psik.html, ktory si nacita /s/<id>/scenar.json
//   GET  /s/<id>/<subor> scenar.json alebo nahrany obrazok z data/<id>/
//   (id moze byt aj nazov z priklady/, napr. /s/rande)
//
// Ochrany: max 3 vytvorenia / IP / hodinu, obrazok max 5 MB (len png,
// jpg, gif, webp — overene podla obsahu, nie pripony), texty len ako text.
// Ked data/ prerastie 10 GB, vytvaranie sa zablokuje a pride Telegram.
//
// Sprava = rucne: `rm -r data/<id>` a link prestane fungovat (v scenar.json je
// cas vytvorenia a IP autora). Servuje sa LEN to, co je vymenovane nizsie.
const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT) || 3032;
const ROOT = __dirname;
const DATA = path.join(ROOT, 'data');

const MAX_IMG = 5 * 1024 * 1024;              // 5 MB na obrazok
const MAX_BODY = 4 * Math.ceil(MAX_IMG / 3) * 4 + 256 * 1024; // 4 obrazky v base64 + texty
const RATE_MAX = 3;                           // vytvoreni na IP
const RATE_WINDOW = 60 * 60 * 1000;           // za hodinu
const DISK_LIMIT = Number(process.env.HAUKO_DISK_LIMIT) || 10 * 1024 ** 3; // 10 GB pre data/

const log = (...a) => console.log(new Date().toISOString(), ...a);

// ---- Telegram: ten isty bot ako ytdl/monitor (monitor/config.json "telegram")
let TG = null;
try { TG = JSON.parse(fs.readFileSync(path.join(ROOT, '..', 'monitor', 'config.json'), 'utf8')).telegram; } catch { /* bez Telegramu */ }
function tgSend(text) {
  if (!TG || !TG.token || !TG.chat) { log('[telegram vypnuty]', text); return; }
  fetch(`https://api.telegram.org/bot${TG.token}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG.chat, text }),
    signal: AbortSignal.timeout(10000),
  }).then((r) => { if (!r.ok) log('telegram HTTP', r.status); })
    .catch((e) => log('telegram chyba', e.message));
}

// ---- velkost data/ ----------------------------------------------------------
let dataSize = 0, alerted = false;
async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fsp.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fsp.stat(p).catch(() => ({ size: 0 }))).size;
  }
  return total;
}
const gb = (n) => (n / 1024 ** 3).toFixed(2) + ' GB';
function checkDisk() {
  if (dataSize >= DISK_LIMIT && !alerted) {
    alerted = true;
    log('data/ prekrocilo limit', gb(dataSize));
    tgSend(`🐶 Hauko: priecinok so scenarmi ma ${gb(dataSize)} (limit ${gb(DISK_LIMIT)}). Vytvaranie novych scenarov je ZABLOKOVANE, kym nieco nezmazes v ${DATA}.`);
  } else if (dataSize < DISK_LIMIT * 0.95 && alerted) {
    alerted = false;
    log('data/ zase pod limitom', gb(dataSize));
    tgSend(`🐶 Hauko: scenare maju ${gb(dataSize)}, vytvaranie je zase povolene.`);
  }
}
async function rescan() {
  dataSize = await dirSize(DATA);
  checkDisk();
}

// ---- rate limit -------------------------------------------------------------
const hits = { create: new Map() };
function recent(map, ip) {
  const now = Date.now();
  const list = (map.get(ip) || []).filter((t) => now - t < RATE_WINDOW);
  map.set(ip, list);
  return list;
}
setInterval(() => {
  for (const map of Object.values(hits)) for (const ip of map.keys()) if (!recent(map, ip).length) map.delete(ip);
}, RATE_WINDOW).unref();

// Za nginx/cloudflared je socket z 127.0.0.1 a skutocna IP je v hlavicke.
// Hlavickam verime len vtedy, ked poziadavka ide z loopbacku (inak by si ju kazdy podvrhol).
function clientIp(req) {
  const remote = req.socket.remoteAddress || '';
  if (/^(::1|127\.|::ffff:127\.)/.test(remote)) {
    const h = req.headers['cf-connecting-ip'] || String(req.headers['x-forwarded-for'] || '').split(',')[0];
    if (h && String(h).trim()) return String(h).trim();
  }
  return remote;
}

// ---- validacia scenara ------------------------------------------------------
const EMOJI_THEMES = (() => {
  try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'emojis.json'), 'utf8')); } catch { return {}; }
})();
const IMG_STATES = ['neutralny', 'priAno', 'priNie', 'ano'];
const EMOJI_PLACES = ['ano', 'priAno', 'priNie', 'poAno'];

class Bad extends Error {}
const str = (v, max, name) => {
  if (v == null) return '';
  if (typeof v !== 'string') throw new Bad(`${name}: ma byt text`);
  const s = v.trim();
  if ([...s].length > max) throw new Bad(`${name}: najviac ${max} znakov`);
  return s;
};
const list = (v, maxItems, maxLen, name) => {
  if (v == null) return [];
  if (!Array.isArray(v)) throw new Bad(`${name}: ma byt zoznam`);
  if (v.length > maxItems) throw new Bad(`${name}: najviac ${maxItems} poloziek`);
  return v.map((x, i) => str(x, maxLen, `${name} ${i + 1}`)).filter(Boolean);
};

function cleanTexts(t) {
  t = t && typeof t === 'object' ? t : {};
  return {
    question: str(t.question, 200, 'Otazka'),
    ano: str(t.ano, 40, 'Tlacidlo Ano'),
    nie: str(t.nie, 40, 'Tlacidlo Nie'),
    done: str(t.done, 200, 'Nadpis po Ano'),
    bubbleHappy: list(t.bubbleHappy, 15, 120, 'Bublina pri Ano'),
    bubbleNeutral: list(t.bubbleNeutral, 15, 120, 'Bublina v strede'),
    bubbleSad: list(t.bubbleSad, 15, 120, 'Bublina pri Nie'),
    bubbleDone: str(t.bubbleDone, 120, 'Bublina po Ano'),
    hints: list(t.hints, 30, 150, 'Hint'),
  };
}

function cleanColors(f) {
  f = f && typeof f === 'object' ? f : {};
  const out = {};
  for (const [k, name] of [['pozadie', 'Farba pozadia'], ['ano', 'Farba tlacidla Ano']]) {
    const v = f[k] == null ? '' : String(f[k]).trim();
    if (v && !/^#[0-9a-fA-F]{6}$/.test(v)) throw new Bad(`${name}: zla farba`);
    out[k] = v.toLowerCase();
  }
  return out;
}

function cleanEmoji(e) {
  e = e && typeof e === 'object' ? e : {};
  const out = {};
  for (const k of EMOJI_PLACES) {
    const v = e[k];
    if (v == null || v === '') out[k] = '';
    else if (typeof v === 'string') {
      if (!Object.prototype.hasOwnProperty.call(EMOJI_THEMES, v)) throw new Bad(`Emoji ${k}: nezname tema "${v}"`);
      out[k] = v;
    } else out[k] = list(v, 30, 16, `Emoji ${k}`);
  }
  return out;
}

// typ obrazka podla prvych bajtov (pripone ani MIME od prehliadaca neverime; SVG nie — moze mat skript)
function sniff(buf) {
  if (buf.length > 8 && buf.readUInt32BE(0) === 0x89504e47) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.toString('latin1', 0, 6))) return 'gif';
  if (buf.length > 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function cleanImages(imgs) {
  imgs = imgs && typeof imgs === 'object' ? imgs : {};
  const out = {};
  for (const k of IMG_STATES) {
    const v = imgs[k];
    if (!v) continue;
    if (typeof v !== 'string') throw new Bad(`Obrazok ${k}: zly format`);
    const m = /^data:[\w.+/-]*;base64,([A-Za-z0-9+/=\s]+)$/.exec(v);
    if (!m) throw new Bad(`Obrazok ${k}: zly format`);
    const buf = Buffer.from(m[1], 'base64');
    if (buf.length > MAX_IMG) throw new Bad(`Obrazok ${k}: najviac 5 MB`);
    const ext = sniff(buf);
    if (!ext) throw new Bad(`Obrazok ${k}: povolene su len PNG, JPG, GIF a WEBP`);
    out[k] = { buf, ext };
  }
  return out;
}

// ---- HTTP pomocky -----------------------------------------------------------
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
const SECURITY = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'same-origin',
};

function json(res, status, obj) {
  res.writeHead(status, { ...SECURITY, 'Content-Type': TYPES['.json'], 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}

function sendFile(req, res, file, cache = 'no-cache') {
  const type = TYPES[path.extname(file).toLowerCase()];
  if (!type) return notFound(res);
  fs.readFile(file, (err, data) => {
    if (err) return notFound(res);
    const headers = { ...SECURITY, 'Content-Type': type, 'Cache-Control': cache };
    // obrazky z data/ su od cudzich ludi — nech sa nikdy nespravaju ako stranka
    if (file.startsWith(DATA + path.sep)) headers['Content-Security-Policy'] = "default-src 'none'; sandbox";
    res.writeHead(200, headers);
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}
const notFound = (res) => res.writeHead(404, SECURITY).end('404');

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const len = Number(req.headers['content-length'] || 0);
    if (len > limit) return reject(new Bad('Prilis velke (obrazky spolu)'));
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) { reject(new Bad('Prilis velke (obrazky spolu)')); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

// ---- API --------------------------------------------------------------------
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;
const newId = () => crypto.randomBytes(6).toString('base64url'); // 8 znakov

async function apiCreate(req, res, ip) {
  // velkost sa prepocita pri kazdom vytvoreni — tak sa prejavi aj rucne zmazanie priecinkov
  await rescan();
  if (dataSize >= DISK_LIMIT) {
    return json(res, 507, { error: 'Vytvaranie je docasne vypnute (plny disk). Autor uz o tom vie.' });
  }
  if (recent(hits.create, ip).length >= RATE_MAX) {
    return json(res, 429, { error: `Najviac ${RATE_MAX} odkazy za hodinu. Skus neskor.` });
  }

  let scen;
  try {
    const body = JSON.parse((await readBody(req, MAX_BODY)).toString('utf8'));
    const images = cleanImages(body.obrazky);
    scen = {
      texty: cleanTexts(body.texty),
      emoji: cleanEmoji(body.emoji),
      farby: cleanColors(body.farby),
      images,
    };
  } catch (e) {
    if (e instanceof Bad) return json(res, 400, { error: e.message });
    return json(res, 400, { error: 'Zla poziadavka' });
  }

  // rezervuj miesto v limite hned (paralelne poziadavky)
  hits.create.get(ip).push(Date.now());

  let id, dir;
  for (let i = 0; i < 5; i++) {
    id = newId();
    dir = path.join(DATA, id);
    try { await fsp.mkdir(dir, { recursive: false }); break; } catch (e) { if (e.code !== 'EEXIST') throw e; dir = null; }
  }
  if (!dir) return json(res, 500, { error: 'Nepodarilo sa vytvorit' });

  const obrazky = {};
  let written = 0;
  for (const [k, { buf, ext }] of Object.entries(scen.images)) {
    const name = `${k}.${ext}`;
    await fsp.writeFile(path.join(dir, name), buf);
    obrazky[k] = name;
    written += buf.length;
  }
  const out = {
    vytvorene: new Date().toISOString(),
    ip,
    texty: scen.texty,
    emoji: scen.emoji,
    farby: scen.farby,
    obrazky,
  };
  const jsonText = JSON.stringify(out, null, 2);
  await fsp.writeFile(path.join(dir, 'scenar.json'), jsonText);
  dataSize += written + Buffer.byteLength(jsonText);
  checkDisk();

  log(`novy scenar ${id} z ${ip} (${(written / 1024 / 1024).toFixed(1)} MB obrazkov)`);
  json(res, 200, { id, url: `/s/${id}`, zostava: Math.max(0, RATE_MAX - recent(hits.create, ip).length) });
}

// ---- routing ----------------------------------------------------------------
// staticke subory, ktore sa smu servovat (nic ine z priecinka — ani server.js, ani data/ mimo /s/)
const PUBLIC_FILES = new Set(['/psik.html', '/create.html', '/emojis.json', '/scenar.json']);
const PUBLIC_DIRS = ['/priklady/', '/obrazky/'];

http.createServer(async (req, res) => {
  let p;
  try {
    p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  } catch {
    return res.writeHead(400, SECURITY).end();
  }
  const ip = clientIp(req);

  try {
    if (req.method === 'POST') {
      if (p === '/api/create') return await apiCreate(req, res, ip);
      return res.writeHead(404, SECURITY).end();
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') return res.writeHead(405, SECURITY).end();

    if (p === '/') return res.writeHead(302, { ...SECURITY, Location: '/create' }).end();
    if (p === '/api/status') {
      return json(res, 200, { zostava: Math.max(0, RATE_MAX - recent(hits.create, ip).length), blokovane: dataSize >= DISK_LIMIT, maxObrazok: MAX_IMG });
    }
    if (p === '/create' || p === '/create/') return sendFile(req, res, path.join(ROOT, 'create.html'));

    // /s/<id> a /s/<id>/<subor>
    const m = /^\/s\/([^/]+)(?:\/([^/]*))?$/.exec(p);
    if (m) {
      const [, id, file] = m;
      if (!ID_RE.test(id)) return notFound(res);
      const dir = path.join(DATA, id);
      if (file === undefined || file === '') {
        // existuje vlastny scenar alebo priklad s tym menom?
        const ok = fs.existsSync(path.join(dir, 'scenar.json')) || fs.existsSync(path.join(ROOT, 'priklady', id + '.json'));
        if (!ok) return notFound(res);
        return sendFile(req, res, path.join(ROOT, 'psik.html'));
      }
      if (file === 'scenar.json') {
        const own = path.join(dir, 'scenar.json');
        if (fs.existsSync(own)) return sendFile(req, res, own);
        return sendFile(req, res, path.join(ROOT, 'priklady', id + '.json'));
      }
      if (/^(neutralny|priAno|priNie|ano)\.(png|jpg|gif|webp)$/.test(file)) {
        return sendFile(req, res, path.join(dir, file), 'public, max-age=86400, immutable');
      }
      return notFound(res);
    }

    const norm = path.posix.normalize(p);
    if (norm !== p || p.split('/').some((s) => s.startsWith('.'))) return notFound(res);
    if (PUBLIC_FILES.has(p) || PUBLIC_DIRS.some((d) => p.startsWith(d))) return sendFile(req, res, path.join(ROOT, p));
    return notFound(res);
  } catch (e) {
    log('chyba', p, e && e.stack);
    if (!res.headersSent) json(res, 500, { error: 'Chyba servera' });
    else res.end();
  }
}).listen(PORT, '0.0.0.0', async () => {
  await fsp.mkdir(DATA, { recursive: true });
  await rescan(); // len aby /api/status vedel, ci je plno; inak sa pocita pri vytvoreni
  log(`hauko na :${PORT}, data/ ${gb(dataSize)} / ${gb(DISK_LIMIT)}, telegram ${TG && TG.token ? 'zapnuty' : 'vypnuty'}`);
});
