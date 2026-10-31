// /media/* is served here, not by the static-assets layer, because Workers assets answer a Range
// request with a full 200 and no Content-Range, and iOS Safari refuses to play <video> without 206s.
// The asset is fetched whole (never with the client's Range or conditional headers) and a single
// RFC 9110 byte range is cut out of it. Anything else gets the full body.
interface Assets { fetch(r: Request | string): Promise<Response> }

const TYPES: Record<string, string> = { mp4: 'video/mp4', webp: 'image/webp' };
const CACHE = 'public, max-age=31536000, immutable';

type Range = { start: number; end: number } | 'unsatisfiable' | null; // null: no usable range, send everything

/** One `bytes=` range spec against a known size. Invalid or multiple specs are ignored (null), as RFC 9110 says. */
export function parseRange(header: string | null, size: number): Range {
  const m = /^bytes=\s*(\d*)\s*-\s*(\d*)\s*$/i.exec(header ?? '');
  if (!m || (m[1] === '' && m[2] === '')) return null;
  if (m[1] === '') { // suffix: the last n bytes
    const n = Number(m[2]);
    return n === 0 || size === 0 ? 'unsatisfiable' : { start: Math.max(size - n, 0), end: size - 1 };
  }
  const start = Number(m[1]);
  if (m[2] !== '' && Number(m[2]) < start) return null; // last < first: invalid, ignored
  return start >= size ? 'unsatisfiable' : { start, end: m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1) };
}

export const isMediaRequest = (request: Request, url: URL) =>
  (request.method === 'GET' || request.method === 'HEAD') && url.pathname.startsWith('/media/');

export async function serveMedia(request: Request, assets: Assets, url: URL): Promise<Response> {
  const res = await assets.fetch(new Request(url.toString())); // plain GET: no Range, no If-* headers
  if (res.status !== 200 || res.headers.has('content-encoding')) return res; // 404 page etc.: not ours to touch
  const head = request.method === 'HEAD';
  const ext = url.pathname.split('.').pop() ?? '';
  const base: Record<string, string> = {
    'Accept-Ranges': 'bytes',
    'Content-Type': TYPES[ext] ?? res.headers.get('content-type') ?? 'application/octet-stream',
    'Cache-Control': CACHE,
  };
  const etag = res.headers.get('etag');
  if (etag) base.ETag = etag;

  let size = Number(res.headers.get('content-length'));
  let bytes: Uint8Array | null = null;
  if (!Number.isFinite(size) || res.headers.get('content-length') === null) { bytes = new Uint8Array(await res.arrayBuffer()); size = bytes.length; }

  const range = parseRange(request.headers.get('range'), size);
  if (range === 'unsatisfiable') {
    await res.body?.cancel();
    return new Response(null, { status: 416, headers: { ...base, 'Content-Range': `bytes */${size}`, 'Content-Length': '0' } });
  }
  if (!range) {
    const headers = { ...base, 'Content-Length': String(size) };
    if (head) { await res.body?.cancel(); return new Response(null, { status: 200, headers }); }
    return new Response(bytes ?? res.body, { status: 200, headers });
  }
  const length = range.end - range.start + 1;
  const headers = { ...base, 'Content-Range': `bytes ${range.start}-${range.end}/${size}`, 'Content-Length': String(length) };
  if (head) { await res.body?.cancel(); return new Response(null, { status: 206, headers }); }
  bytes ??= new Uint8Array(await res.arrayBuffer());
  return new Response(bytes.subarray(range.start, range.end + 1), { status: 206, headers });
}
