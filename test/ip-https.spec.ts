import { describe, it, expect } from 'vitest';
import { parseHttpResponse } from '../src/ip-https';
const bytes = (text: string) => new TextEncoder().encode(text);
describe('WebIMAP HTTP response parsing', () => {
  it('handles chunked responses', async () => {
    const response = parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nTransfer-Encoding: chunked\r\n\r\n5\r\n{"ok"\r\n6\r\n:true}\r\n0\r\n\r\n'));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
  });
  it('rejects truncated content-length and chunked bodies', () => {
    expect(() => parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nContent-Length: 20\r\n\r\n{}'))).toThrow('Truncated');
    expect(() => parseHttpResponse(bytes('HTTP/1.1 200 OK\r\nTransfer-Encoding: chunked\r\n\r\n20\r\n{}'))).toThrow('Truncated');
  });
});
