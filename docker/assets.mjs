import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../public', import.meta.url));
const contentTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.ico', 'image/x-icon'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.woff2', 'font/woff2'],
]);

export function isPublicAsset(path) {
  return /^\/(?:console\/|site\/)?(?:favicon\.(?:ico|svg)|apple-touch-icon\.png)$/.test(path) ||
    /^\/(?:static|console\/assets|site\/(?:assets|images))\//.test(path);
}

export async function assetResponse(url, head = false, publicOnly = false) {
  let path;
  try {
    path = decodeURIComponent(url.pathname);
  } catch {
    return new Response(null, { status: 400 });
  }
  if (path.includes('\\') || path.includes('\0') || path.split('/').some((part) => part.startsWith('.'))) {
    return new Response(null, { status: 404 });
  }
  if (publicOnly && !isPublicAsset(path)) return new Response(null, { status: 404 });
  const file = resolve(root, '.' + path);
  if (!file.startsWith(root + sep)) return new Response(null, { status: 404 });

  const info = await stat(file).catch((error) => {
    if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
  });
  if (!info?.isFile()) return new Response(null, { status: 404 });

  const headers = new Headers({
    'content-type': contentTypes.get(extname(file)) ?? 'application/octet-stream',
    'content-length': String(info.size),
    'cache-control': path.endsWith('.html') ? 'no-store' : 'public, max-age=86400',
  });
  if (path.startsWith('/static/')) headers.set('access-control-allow-origin', '*');
  return new Response(head ? null : Readable.toWeb(createReadStream(file)), { headers });
}
