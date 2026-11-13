import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import app from '../src/index.ts';
import { runCron } from '../src/cron.ts';
import { assetResponse, isPublicAsset } from './assets.mjs';
import { openDatabase } from './sqlite.mjs';

const { PORT = '8787', SQLITE_PATH = '.data/vmq.sqlite', SETUP_TOKEN,
  PUBLIC_URL, TRUST_PROXY, ADMIN_ALIAS, RESOURCE_URL = '' } = process.env;
const MAX_BODY = 3 * 1024 * 1024;
const CRON_INTERVAL = 60_000;

function parseOrigin(value) {
  const url = new URL(value);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password ||
      url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Expected an HTTP(S) origin');
  }
  return url.origin;
}

const publicOrigin = PUBLIC_URL ? parseOrigin(PUBLIC_URL) : undefined;
process.umask(0o077);
const db = openDatabase(SQLITE_PATH);
const env = { DB: db, RUNTIME: 'docker', ASSETS: { fetch: assetResponse }, SETUP_TOKEN, ADMIN_ALIAS, RESOURCE_URL };

const background = new Set();
const ctx = {
  waitUntil(promise) {
    const task = Promise.resolve(promise)
      .catch((error) => console.error('Background task failed:', error.name))
      .finally(() => background.delete(task));
    background.add(task);
  },
};

function requestUrl(incoming) {
  if (!incoming.url?.startsWith('/') || incoming.url.startsWith('//') || incoming.url.includes('\\')) {
    throw new Error('Invalid request target');
  }
  const origin = publicOrigin ?? parseOrigin('http://' + incoming.headers.host);
  return new URL(origin + incoming.url);
}

async function requestBody(incoming) {
  if (Number(incoming.headers['content-length']) > MAX_BODY) return null;
  const chunks = [];
  let size = 0;
  for await (const chunk of incoming.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > MAX_BODY) return null;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}

async function handle(incoming) {
  let url;
  try {
    url = requestUrl(incoming);
  } catch {
    return new Response('Bad Request', { status: 400 });
  }
  const method = incoming.method;
  if ((method === 'GET' || method === 'HEAD') && isPublicAsset(url.pathname)) {
    const asset = await assetResponse(url, method === 'HEAD', true);
    if (asset.status !== 404) return asset;
    await asset.body?.cancel();
  }

  const headers = new Headers(incoming.headers);
  for (const name of ['forwarded', 'x-forwarded-host', 'x-forwarded-proto', 'cf-connecting-ip', 'x-real-ip']) {
    headers.delete(name);
  }
  const clientIp = (TRUST_PROXY === '1' && incoming.headers['x-real-ip']) || incoming.socket.remoteAddress;
  if (clientIp) headers.set('x-real-ip', clientIp);
  const body = method === 'GET' || method === 'HEAD' ? undefined : await requestBody(incoming);
  if (body === null) {
    return new Response('Payload Too Large', { status: 413, headers: { connection: 'close' } });
  }
  return app.fetch(new Request(url, { method, headers, body }), env, ctx);
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const response = await handle(incoming);
    const headers = Object.fromEntries(response.headers);
    const cookies = response.headers.getSetCookie();
    if (cookies.length) headers['set-cookie'] = cookies;
    outgoing.writeHead(response.status, headers);
    if (incoming.method === 'HEAD' || !response.body) {
      await response.body?.cancel();
      outgoing.end();
    } else {
      await pipeline(Readable.fromWeb(response.body), outgoing);
    }
  } catch (error) {
    if (outgoing.destroyed) return;
    console.error('Request failed:', error.name);
    if (outgoing.headersSent) {
      outgoing.destroy();
    } else {
      outgoing.writeHead(500).end('Internal Server Error');
    }
  }
});

let stopping = false;
let cronTimer;
function scheduleCron() {
  if (stopping) return;
  ctx.waitUntil(runCron(env).finally(() => {
    if (!stopping) cronTimer = setTimeout(scheduleCron, CRON_INTERVAL);
  }));
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearTimeout(cronTimer);
    server.close(async () => {
      await Promise.allSettled(background);
      db.close();
    });
  });
}

server.listen(Number(PORT), '0.0.0.0', () => {
  console.log('VMQ listening on port', PORT);
  scheduleCron();
});
