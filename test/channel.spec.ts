import { describe, it, expect, vi } from 'vitest';
import * as openpgp from 'openpgp';
import { Channel, type ChannelConfig } from '../src/channel';
import { decryptMail, encryptedMail, pgpConfig } from '../src/chatmail';
import { webimapFetch } from '../src/ip-https';
import type { ChatmailEnv } from '../src/index';
vi.mock('../src/ip-https', () => ({ webimapFetch: vi.fn() }));
class Storage {
  values = new Map<string, unknown>();
  async get<T>(key: string) { return this.values.get(key) as T | undefined; }
  async put(key: string, value: unknown) { this.values.set(key, structuredClone(value)); }
  async delete(key: string) { this.values.delete(key); }
  async list<T>({ prefix }: { prefix: string }) { return new Map([...this.values].filter(([key]) => key.startsWith(prefix))) as Map<string, T>; }
  async transaction<T>(fn: (storage: Storage) => Promise<T>) { return fn(this); }
  async setAlarm() {}
}
describe('Delta Chat broadcast protocol', () => {
  it('authenticates a v3 subscriber, sends membership, and broadcasts once for duplicate delivery IDs', async () => {
    const bot = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Bot' }], config: pgpConfig });
    const peer = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Subscriber' }], config: pgpConfig });
    const botKey = await openpgp.readKey({ armoredKey: bot.publicKey });
    const peerKey = await openpgp.readKey({ armoredKey: peer.publicKey });
    const config: ChannelConfig = { id: 'random-channel-id', name: 'Madmail GitHub', secret: 'random-broadcast-secret', auth: 'random-auth', inviteNumber: 'invite', fingerprint: botKey.getFingerprint().toUpperCase(), sinceUid: 0, inviteUrl: 'https://i.delta.chat/#example' };
    const env = { CHANNEL_CONFIG: JSON.stringify(config), EMAIL_USERNAME: 'bot@example.org', EMAIL_PASSWORD: 'password', WEBIMAP_HOSTNAME: 'https://mail.example.org', BOT_PRIVATE_KEY: bot.privateKey, BOT_PUBLIC_KEY: bot.publicKey } as ChatmailEnv;
    const storage = new Storage(); const actor = new Channel({ storage } as unknown as DurableObjectState, env);
    const sent: string[] = []; let inbox: Array<{ uid: number; body: string }> = [];
    vi.mocked(webimapFetch).mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.includes('/send')) { sent.push(JSON.parse(init!.body as string).body); return Response.json({ status: 'sent' }); }
      if (url.includes('/message/')) return Response.json(inbox.find(message => url.endsWith('/' + message.uid)));
      return Response.json(inbox.filter(message => message.uid > Number(new URL(url).searchParams.get('since_uid'))).map(({ uid }) => ({ uid })));
    });
    const password = `securejoin/${config.fingerprint}/${config.auth}`;
    const target = { email: env.EMAIL_USERNAME, name: 'Bot', fingerprint: config.fingerprint, auth: '', inviteNumber: '', publicKey: bot.publicKey };
    const request = await encryptedMail({ from: 'peer@example.org', contact: target, text: 'Secure-Join', password, extraHeaders: { 'Secure-Join': 'vc-request-pubkey', 'Secure-Join-Auth': config.auth } });
    inbox = [{ uid: 1, body: request.raw }]; await actor.alarm();
    const reply = await decryptMail(sent[0], { password, publicKey: bot.publicKey });
    expect(reply.inner.headers.find(h => h.key === 'secure-join')?.value).toBe('vc-pubkey');
    expect((await storage.list({ prefix: 'subscriber:' })).size).toBe(0);
    const auth = await encryptedMail({ from: 'peer@example.org', contact: target, text: 'Secure-Join', privateKey: peer.privateKey, publicKey: peer.publicKey,
      extraHeaders: { 'Secure-Join': 'vc-request-with-auth', 'Secure-Join-Auth': config.auth, 'Secure-Join-Fingerprint': peerKey.getFingerprint().toUpperCase() } });
    inbox.push({ uid: 2, body: auth.raw }); await actor.alarm();
    expect((await storage.list({ prefix: 'subscriber:' })).size).toBe(1);
    const membership = await decryptMail(sent[1], { privateKey: peer.privateKey, publicKey: bot.publicKey });
    expect(membership.inner.headers.find(h => h.key === 'chat-broadcast-secret')?.value).toBe(config.secret);
    expect(membership.inner.headers.find(h => h.key === 'secure-join')?.value).toBe('vg-member-added');
    const enqueue = () => actor.fetch(new Request('https://channel/enqueue', { method: 'POST', body: JSON.stringify({ id: 'delivery-1', text: 'Commit pushed' }) }));
    expect(await (await enqueue()).json()).toEqual({ status: 'queued' });
    expect(await (await enqueue()).json()).toEqual({ status: 'duplicate' });
    await actor.alarm(); await actor.alarm();
    expect(sent).toHaveLength(3);
    const notification = await decryptMail(sent[2], { password: config.secret, publicKey: bot.publicKey });
    expect(notification.inner.text?.trim()).toBe('Commit pushed');
    expect(notification.inner.headers.find(h => h.key === 'chat-list-id')?.value).toBe(`${config.name} <${config.id}>`);
    expect(sent[2]).not.toContain('peer@example.org');
    expect(notification.inner.headers.some(h => h.key === 'autocrypt-gossip')).toBe(false);
    // A signed but unauthenticated request cannot add a subscriber.
    const wrong = await encryptedMail({ from: 'intruder@example.org', contact: target, text: 'Secure-Join', privateKey: peer.privateKey, publicKey: peer.publicKey,
      extraHeaders: { 'Secure-Join': 'vc-request-with-auth', 'Secure-Join-Auth': 'wrong', 'Secure-Join-Fingerprint': peerKey.getFingerprint().toUpperCase() } });
    inbox.push({ uid: 3, body: wrong.raw }); await actor.alarm();
    expect(sent).toHaveLength(3);
  });
});
