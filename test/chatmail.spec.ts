import { describe, it, expect } from 'vitest';
import * as openpgp from 'openpgp';
import { encryptedMail, decryptMail, encryptSecureJoin, pgpConfig } from '../src/chatmail';

describe('Chatmail encryption', () => {
  it('sends signed PGP/MIME with protected headers and recipient gossip', async () => {
    const bot = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Bot' }], config: pgpConfig });
    const peer = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Peer' }], config: pgpConfig });
    const contact = { email: 'peer@example.org', name: 'Peer', fingerprint: '', auth: '', inviteNumber: '', publicKey: peer.publicKey };
    const mail = await encryptedMail({ from: 'bot@example.org', contact, text: 'Hello 👋', botName: 'Madmail Bot 📨', botLogo: 'iVBORw0KGgo=', privateKey: bot.privateKey, publicKey: bot.publicKey, extraHeaders: { 'Secure-Join': 'vc-request-with-auth' } });
    expect(mail.raw).not.toContain('Hello 👋');
    const decrypted = await decryptMail(mail.raw, { privateKey: peer.privateKey, publicKey: bot.publicKey });
    expect(decrypted.inner.from?.name).toBe('Madmail Bot 📨');
    expect(decrypted.inner.headers.find(h => h.key === 'chat-user-avatar')?.value).toBe('base64:iVBORw0KGgo=');
    expect(mail.raw).not.toContain('Chat-User-Avatar');
    expect(decrypted.inner.text?.trim()).toBe('Hello 👋');
    expect(decrypted.inner.headers.find(h => h.key === 'secure-join')?.value).toBe('vc-request-with-auth');
    expect(decrypted.inner.headers.filter(h => h.key === 'autocrypt-gossip')).toHaveLength(2);
    expect(decrypted.signatures).toHaveLength(1);
    await expect(decrypted.signatures[0].verified).resolves.toBe(true);
    const wrong = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: 'Wrong' }], config: pgpConfig });
    await expect(decryptMail(mail.raw, { privateKey: peer.privateKey, publicKey: wrong.publicKey })).rejects.toThrow();
  });
  it('supports the SecureJoin v3 shared secret without leaking auth in outer headers', async () => {
    const password = 'securejoin/FINGERPRINT/auth-token';
    const pgp = await openpgp.readMessage({ armoredMessage: await encryptSecureJoin('test', password) });
    const skesk = pgp.packets[0].write() as Uint8Array;
    expect(Array.from(skesk.slice(0, 4))).toEqual([4, 9, 1, 8]); // v4, AES256, salted S2K, SHA256
    const mail = await encryptedMail({ from: 'bot@example.org', contact: { email: 'peer@example.org', name: '', fingerprint: '', auth: '', inviteNumber: '' }, text: 'Secure-Join', password, extraHeaders: { 'Secure-Join': 'vc-request-pubkey', 'Secure-Join-Auth': 'auth-token' } });
    expect(mail.raw).not.toContain('auth-token');
    const decrypted = await decryptMail(mail.raw, { password });
    expect(decrypted.inner.headers.find(h => h.key === 'secure-join')?.value).toBe('vc-request-pubkey');
  });
});
