import { validSignature, githubMessage, shouldNotify } from './github';
export { Channel } from './channel';
import { webimapFetch } from './ip-https';
import { encryptedMail, submit, type Contact, type MailConfig } from './chatmail';

export interface ChatmailEnv extends MailConfig {
  BOT_PRIVATE_KEY: string;
  BOT_PUBLIC_KEY: string;
  BOT_NAME?: string;
  BOT_LOGO?: string;
  CHANNEL_NAME?: string;
  CHANNEL_LOGO?: string;
  CONTACT: string;
  API_TOKEN: string;
  GITHUB_WEBHOOK_SECRET: string;
  GITHUB_REPOSITORY: string;
  PIPELINE_NOTIFICATIONS?: 'failures' | 'all' | 'off';
  CHANNEL_CONFIG: string;
  NOTIFICATIONS: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: ChatmailEnv): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/' && request.method === 'GET') return Response.json({ message: 'Hello World!' });
    if (path === '/github/webhook') return githubWebhook(request, env);
    if (path === '/channel' || path === '/channel/poll' || path === '/channel/retry') {
      if (!env.API_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.API_TOKEN}`) return Response.json({ error: 'Unauthorized' }, { status: 401 });
      if (path === '/channel/retry') {
        if (request.method !== 'POST') return new Response('Use POST', { status: 405 });
        const body = await readBounded(request, 256);
        if (!body) return new Response('Request too large', { status: 413 });
        return channel(env).fetch('https://channel/retry', { method: 'POST', body: new TextDecoder().decode(body) });
      }
      const target = path === '/channel/poll' && request.method === 'POST' ? '/poll' : request.method === 'POST' ? '/bootstrap' : request.method === 'GET' ? '/info' : '';
      if (!target) return new Response('Method not allowed', { status: 405 });
      return channel(env).fetch(`https://channel${target}`, { method: target === '/info' ? 'GET' : 'POST' });
    }
    if (path !== '/send') return Response.json({ error: 'Not found' }, { status: 404 });
    if (request.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405, headers: { Allow: 'POST' } });
    if (!env.API_TOKEN || request.headers.get('Authorization') !== `Bearer ${env.API_TOKEN}`) {
      return Response.json({ error: 'Unauthorized' }, { status: 401 });
    }
    const rawBody = await request.text();
    if (new TextEncoder().encode(rawBody).length > 8192) return Response.json({ error: 'Request too large' }, { status: 413 });
    let body: unknown;
    try { body = rawBody ? JSON.parse(rawBody) : {}; }
    catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return Response.json({ error: 'Expected a JSON object' }, { status: 400 });
    const text = (body as { text?: unknown }).text ?? 'Hello from the Cloudflare Worker!';
    if (typeof text !== 'string' || !text.trim() || text.length > 4000) return Response.json({ error: 'text must contain 1–4000 characters' }, { status: 400 });
    try {
      const contact = JSON.parse(env.CONTACT) as Contact;
      if (!contact.verified || !contact.publicKey) return Response.json({ error: 'Contact handshake is incomplete' }, { status: 409 });
      const message = await encryptedMail({ from: env.EMAIL_USERNAME, contact, text, botName: env.BOT_NAME, botLogo: env.BOT_LOGO, privateKey: env.BOT_PRIVATE_KEY, publicKey: env.BOT_PUBLIC_KEY });
      await submit(env, contact, message.raw, webimapFetch);
      return Response.json({ status: 'submitted', messageId: message.id });
    } catch (error) {
      console.error('Message submission failed:', error instanceof Error ? error.message : 'Unknown error');
      return Response.json({ error: 'Message submission failed' }, { status: 502 });
    }
  },
  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(channel(env).fetch('https://channel/poll', { method: 'POST' }));
  },
} satisfies ExportedHandler<ChatmailEnv>;

function channel(env: ChatmailEnv) {
  return env.NOTIFICATIONS.get(env.NOTIFICATIONS.idFromName('madmail-github'));
}
async function readBounded(request: Request, max: number): Promise<Uint8Array | null> {
  if (Number(request.headers.get('content-length')) > max) return null;
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) { await reader.cancel(); return null; }
    chunks.push(value);
  }
  const body = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body;
}
export async function githubWebhook(request: Request, env: ChatmailEnv): Promise<Response> {
  if (request.method !== 'POST') return Response.json({ error: 'Use POST' }, { status: 405, headers: { Allow: 'POST' } });
  if (!env.GITHUB_WEBHOOK_SECRET) return Response.json({ error: 'Webhook is not configured' }, { status: 503 });
  const raw = await readBounded(request, 1024 * 1024);
  if (!raw) return Response.json({ error: 'Payload exceeds 1 MiB' }, { status: 413 });
  if (!await validSignature(raw, request.headers.get('x-hub-signature-256'), env.GITHUB_WEBHOOK_SECRET)) return Response.json({ error: 'Invalid signature' }, { status: 401 });
  let payload;
  try { payload = JSON.parse(new TextDecoder().decode(raw)); }
  catch { return Response.json({ error: 'Invalid JSON' }, { status: 400 }); }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return Response.json({ error: 'Expected JSON object' }, { status: 400 });
  if (payload.repository?.full_name?.toLowerCase() !== env.GITHUB_REPOSITORY.toLowerCase()) return Response.json({ error: 'Repository not allowed' }, { status: 403 });
  const event = request.headers.get('x-github-event');
  if (!event || !/^[a-z_]+$/.test(event)) return Response.json({ error: 'Missing or invalid GitHub event' }, { status: 400 });
  if (event === 'ping') return Response.json({ status: 'pong' });
  if (!shouldNotify(event, payload, env.PIPELINE_NOTIFICATIONS)) return Response.json({ status: 'ignored', reason: 'pipeline notification filter' });
  const id = request.headers.get('x-github-delivery');
  if (!id || !/^[a-f0-9-]{36}$/i.test(id)) return Response.json({ error: 'Missing or invalid delivery ID' }, { status: 400 });
  return channel(env).fetch('https://channel/enqueue', { method: 'POST', body: JSON.stringify({ id, text: githubMessage(event, payload) }) });
}
