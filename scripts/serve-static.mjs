/** 只读静态服务器：用于验证导出目录可独立部署（与主应用无关） */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, resolve, extname, sep } from 'node:path';

const rootDir = resolve(process.argv[2]);
const port = Number(process.argv[3] ?? 3211);

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.txt': 'text/plain; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
};

createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${port}`);
  const rel = decodeURIComponent(url.pathname === '/' ? '/index.html' : url.pathname);
  const full = resolve(join(rootDir, rel));

  if (!full.startsWith(rootDir + sep)) { res.writeHead(403).end('forbidden'); return; }

  try {
    const info = await stat(full);
    if (info.isDirectory()) { res.writeHead(404).end('not found'); return; }
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[extname(full).toLowerCase()] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`static server on http://127.0.0.1:${port}`));