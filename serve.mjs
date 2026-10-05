#!/usr/bin/env node
// Local server for Backdrop. No dependencies.
//   node serve.mjs            -> http://localhost:8080 (camera works on this computer)
//   node serve.mjs --https    -> https on port 8443 for phones and tablets on the same Wi-Fi
//   node serve.mjs --open     -> also opens the browser
//   node serve.mjs --port=9000
import http from 'node:http';
import https from 'node:https';
import { stat, readFile } from 'node:fs/promises';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { homedir, networkInterfaces } from 'node:os';
import { execFileSync, exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)));
const args = process.argv.slice(2);
const useHttps = args.includes('--https');
const portArg = args.find((a) => a.startsWith('--port='));
const port = Number(portArg?.split('=')[1]) || (useHttps ? 8443 : 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.webmanifest': 'application/manifest+json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.tflite': 'application/octet-stream',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.md': 'text/plain; charset=utf-8',
};

function lanAddresses() {
  const out = [];
  for (const list of Object.values(networkInterfaces())) {
    for (const a of list || []) if (a.family === 'IPv4' && !a.internal) out.push(a.address);
  }
  return out;
}

async function handler(req, res) {
  try {
    const url = new URL(req.url, 'http://localhost');
    let path = decodeURIComponent(url.pathname);
    if (path.endsWith('/')) path += 'index.html';
    // Never serve dotfiles.
    if (path.split('/').some((part) => part.startsWith('.'))) {
      res.writeHead(404).end('Not found');
      return;
    }
    const file = resolve(join(root, normalize(path)));
    if (!file.startsWith(root + sep)) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    const info = await stat(file).catch(() => null);
    if (!info || !info.isFile()) {
      res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found');
      return;
    }
    const heavy = /[\\/](vendor|models)[\\/]/.test(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file).toLowerCase()] || 'application/octet-stream',
      'content-length': info.size,
      'cache-control': heavy ? 'public, max-age=604800' : 'no-cache',
      'x-content-type-options': 'nosniff',
    });
    if (req.method === 'HEAD') {
      res.end();
      return;
    }
    createReadStream(file).pipe(res);
  } catch (err) {
    console.error(err);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  }
}

async function certificate() {
  // Kept outside the app folder so the private key is never deployed along with the site.
  const dir = join(homedir(), '.backdrop', 'cert');
  const keyPath = join(dir, 'key.pem');
  const certPath = join(dir, 'cert.pem');
  if (!existsSync(keyPath) || !existsSync(certPath)) {
    mkdirSync(dir, { recursive: true });
    const san = ['DNS:localhost', 'IP:127.0.0.1', ...lanAddresses().map((ip) => `IP:${ip}`)].join(',');
    const candidates = [
      'openssl',
      'C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe',
      'C:\\Program Files\\Git\\usr\\bin\\openssl.exe',
    ];
    let made = false;
    for (const bin of candidates) {
      try {
        execFileSync(
          bin,
          ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-sha256', '-days', '825',
            '-subj', '/CN=Backdrop local', '-addext', `subjectAltName=${san}`,
            '-keyout', keyPath, '-out', certPath],
          { stdio: 'ignore' },
        );
        made = true;
        break;
      } catch {
        // Try the next OpenSSL location.
      }
    }
    if (!made) {
      throw new Error('HTTPS needs OpenSSL. Install Git for Windows (it includes OpenSSL), or put the folder on an https host.');
    }
  }
  return { key: await readFile(keyPath), cert: await readFile(certPath) };
}

function openBrowser(url) {
  const cmd =
    process.platform === 'win32' ? `start "" "${url}"` : process.platform === 'darwin' ? `open "${url}"` : `xdg-open "${url}"`;
  exec(cmd, () => {});
}

const server = useHttps ? https.createServer(await certificate(), handler) : http.createServer(handler);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`Port ${port} is already in use. Try: node serve.mjs --port=${port + 1}`);
  } else {
    console.error(err);
  }
  process.exit(1);
});

server.listen(port, '0.0.0.0', () => {
  const scheme = useHttps ? 'https' : 'http';
  const local = `${scheme}://localhost:${port}`;
  console.log('\n  Backdrop is running.\n');
  console.log(`  On this computer:   ${local}`);
  const lan = lanAddresses();
  if (useHttps) {
    for (const ip of lan) console.log(`  On your Wi-Fi:      https://${ip}:${port}`);
    console.log('\n  Phones will warn that the certificate is not trusted. Choose "Advanced" ->');
    console.log('  "Proceed" (or "Show details" -> "visit this website" on iPhone) to continue.');
  } else if (lan.length) {
    console.log('\n  Phones and tablets need HTTPS for the camera. Run:  node serve.mjs --https');
  }
  console.log('\n  Press Ctrl+C to stop.\n');
  if (args.includes('--open')) openBrowser(local);
});
