import { connect } from 'cloudflare:sockets';

// Workers fetch() cannot address a literal IP. WebIMAP is HTTPS on a
// certificate with an IP SAN, so use a TLS socket with normal verification.
export const webimapFetch: typeof fetch = async (input, init) => {
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return fetch(input, init);
  if (url.protocol !== 'https:') throw new Error('WebIMAP requires HTTPS');
  const socket = connect({ hostname: url.hostname, port: Number(url.port || 443) }, { secureTransport: 'on', allowHalfOpen: false });
  const timeout = setTimeout(() => void socket.close().catch(() => {}), 25000);
  try {
    await socket.opened;
    const body = typeof init?.body === 'string' ? new TextEncoder().encode(init.body) : new Uint8Array();
    const headers = new Headers(init?.headers);
    headers.set('Host', url.host);
    headers.set('Connection', 'close');
    headers.set('Accept', 'application/json');
    headers.set('Content-Length', String(body.length));
    const lines = [`${init?.method ?? 'GET'} ${url.pathname}${url.search} HTTP/1.1`];
    headers.forEach((value, name) => lines.push(`${name}: ${value}`));
    const head = new TextEncoder().encode(`${lines.join('\r\n')}\r\n\r\n`);
    const request = new Uint8Array(head.length + body.length); request.set(head); request.set(body, head.length);
    const writer = socket.writable.getWriter();
    await writer.write(request); writer.releaseLock();
    const reader = socket.readable.getReader();
    const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > 1024 * 1024) throw new Error('WebIMAP response too large');
      chunks.push(value);
    }
    const bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return parseHttpResponse(bytes);
  } finally {
    clearTimeout(timeout);
    await socket.close().catch(() => {});
  }
};

export function parseHttpResponse(bytes: Uint8Array): Response {
  const end = findCrlf(bytes, 0, true);
  if (end < 0) throw new Error('Invalid WebIMAP HTTP response');
  const lines = new TextDecoder().decode(bytes.slice(0, end)).split('\r\n');
  const status = Number(lines.shift()?.match(/^HTTP\/1\.[01] (\d{3}) /)?.[1]);
  if (!status) throw new Error('Invalid WebIMAP HTTP status');
  const headers = new Headers();
  for (const line of lines) {
    const colon = line.indexOf(':');
    if (colon > 0) headers.append(line.slice(0, colon), line.slice(colon + 1).trim());
  }
  let body = bytes.slice(end + 4);
  if (headers.get('transfer-encoding')?.toLowerCase() === 'chunked') {
    const chunks: Uint8Array[] = []; let offset = 0; let length = 0;
    while (true) {
      const lineEnd = findCrlf(body, offset);
      if (lineEnd < 0) throw new Error('Invalid HTTP chunk');
      const size = Number.parseInt(new TextDecoder().decode(body.slice(offset, lineEnd)).split(';')[0], 16);
      if (!Number.isFinite(size) || size < 0) throw new Error('Invalid HTTP chunk size');
      if (size === 0) break;
      offset = lineEnd + 2;
      if (offset + size + 2 > body.length || body[offset + size] !== 13 || body[offset + size + 1] !== 10) throw new Error('Truncated HTTP chunk');
      chunks.push(body.slice(offset, offset + size)); length += size; offset += size + 2;
    }
    body = new Uint8Array(length); offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
    headers.delete('transfer-encoding');
  } else if (headers.has('content-length') && Number(headers.get('content-length')) !== body.length) {
    throw new Error('Truncated HTTP response');
  }
  return new Response(status === 204 || status === 304 ? null : body, { status, headers });
}
function findCrlf(bytes: Uint8Array, start: number, double = false): number {
  for (let i = start; i + (double ? 3 : 1) < bytes.length; i++) {
    if (bytes[i] === 13 && bytes[i + 1] === 10 && (!double || bytes[i + 2] === 13 && bytes[i + 3] === 10)) return i;
  }
  return -1;
}
