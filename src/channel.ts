import { avatarHeader } from './profile';
import * as openpgp from 'openpgp';
import PostalMime, { type Email } from 'postal-mime';
import { decryptMail, encryptedMail, mailRequest, submit, type Contact } from './chatmail';
import { webimapFetch } from './ip-https';
import type { ChatmailEnv } from './index';

export interface ChannelConfig {
  id: string; name: string; secret: string; auth: string; inviteNumber: string;
  nameUpdatedAt?: number; fingerprint: string; sinceUid: number; inviteUrl: string;
}
interface Job { text: string; created: number; status: 'queued' | 'sent'; raw?: string; recipients?: string[]; sent?: string[] }
const h = (email: Email, name: string) => email.headers.find(header => header.key === name)?.value;

export class Channel {
  private config: ChannelConfig;
  constructor(private ctx: DurableObjectState, private env: ChatmailEnv) {
    this.config = JSON.parse(env.CHANNEL_CONFIG);
    this.config.name = env.CHANNEL_NAME || this.config.name;
    if (!this.config.id || !this.config.secret || !this.config.inviteUrl) throw new Error('Invalid channel configuration');
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/info') {
      const subscribers = await this.ctx.storage.list<Contact>({ prefix: 'subscriber:' });
      const jobs = await this.ctx.storage.list<Job>({ prefix: 'job:' });
      return Response.json({ name: this.config.name, inviteUrl: this.config.inviteUrl, subscribers: subscribers.size, pendingNotifications: [...jobs.values()].filter(job => job.status === 'queued').length, sentNotifications: [...jobs.values()].filter(job => job.status === 'sent').length });
    }
    if (path === '/bootstrap') {
      if (!await this.ctx.storage.get(`bootstrapped:${this.config.id}`)) {
        const contact = JSON.parse(this.env.CONTACT) as Contact;
        if (!contact.verified || !contact.publicKey) return Response.json({ error: 'Unverified owner contact' }, { status: 409 });
        await this.addSubscriber(contact);
        await this.ctx.storage.put(`bootstrapped:${this.config.id}`, true);
      }
      await this.ctx.storage.setAlarm(Date.now());
      return this.fetch(new Request('https://channel/info'));
    }
    if (path === '/enqueue') {
      const { id, text } = await request.json() as { id: string; text: string };
      const duplicate = await this.ctx.storage.transaction(async tx => {
        if (await tx.get(`job:${id}`)) return true;
        await tx.put(`job:${id}`, { text, created: Date.now(), status: 'queued' } satisfies Job);
        return false;
      });
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ status: duplicate ? 'duplicate' : 'queued' }, { status: 202 });
    }
    if (path === '/retry') {
      const { uid } = await request.json() as { uid: number };
      if (!Number.isSafeInteger(uid) || uid < 1) return Response.json({ error: 'Invalid message UID' }, { status: 400 });
      const { body } = await mailRequest<{ body: string }>(this.env, `/webimap/message/${uid}`, {}, webimapFetch);
      await this.handleMessage(body);
      return Response.json({ status: 'reprocessed' });
    }
    if (path === '/poll') {
      await this.ctx.storage.setAlarm(Date.now());
      return Response.json({ status: 'scheduled' });
    }
    return new Response('Not found', { status: 404 });
  }
  async alarm(): Promise<void> {
    try {
      await this.poll();
      await this.syncProfile();
      const jobs = await this.ctx.storage.list<Job>({ prefix: 'job:' });
      let count = 0;
      for (const [key, job] of jobs) {
        if (job.status === 'sent') {
          if (job.created < Date.now() - 7 * 86400000) await this.ctx.storage.delete(key);
          continue;
        }
        if (count++ >= 10) break;
        const subscribers = await this.ctx.storage.list<Contact>({ prefix: 'subscriber:' });
        if (!job.raw) {
          const first = subscribers.values().next().value;
          if (!first) continue;
          const message = await encryptedMail({ from: this.env.EMAIL_USERNAME, botName: this.env.BOT_NAME, botLogo: this.env.BOT_LOGO, contact: first, text: job.text,
            privateKey: this.env.BOT_PRIVATE_KEY, publicKey: this.env.BOT_PUBLIC_KEY,
            password: this.config.secret, hideRecipients: true, extraHeaders: this.channelHeaders() });
          job.raw = message.raw; job.recipients = [...subscribers.keys()]; job.sent = [];
          await this.ctx.storage.put(key, job);
        }
        for (const recipient of job.recipients!) {
          if (job.sent!.includes(recipient)) continue;
          const contact = subscribers.get(recipient);
          if (contact) await submit(this.env, contact, job.raw, webimapFetch);
          job.sent!.push(recipient); await this.ctx.storage.put(key, job);
        }
        job.status = 'sent'; await this.ctx.storage.put(key, job);
        const history = await this.ctx.storage.get<string[]>('history') ?? [];
        await this.ctx.storage.put('history', [...history, job.raw].slice(-5));
      }
    } finally {
      // Polling and queued delivery resume after failures or Worker restarts.
      await this.ctx.storage.setAlarm(Date.now() + 10 * 60 * 1000);
    }
  }
  private channelHeaders(): Record<string, string> {
    return { 'Chat-List-ID': `${this.config.name} <${this.config.id}>`, 'Chat-Group-Name': this.config.name, 'Chat-Group-Name-Timestamp': String(this.config.nameUpdatedAt ?? 0), ...(this.env.CHANNEL_LOGO ? { 'Chat-Group-Avatar': avatarHeader(this.env.CHANNEL_LOGO) } : {}) };
  }
  private async addSubscriber(contact: Contact) {
    const message = await encryptedMail({ from: this.env.EMAIL_USERNAME, botName: this.env.BOT_NAME, botLogo: this.env.BOT_LOGO, contact, text: `You joined ${this.config.name}.`,
      privateKey: this.env.BOT_PRIVATE_KEY, publicKey: this.env.BOT_PUBLIC_KEY,
      extraHeaders: { ...this.channelHeaders(), 'Chat-Broadcast-Secret': this.config.secret,
        'Chat-Group-Member-Added': contact.email, 'Chat-Group-Member-Added-Fpr': contact.fingerprint, 'Secure-Join': 'vg-member-added' } });
    await submit(this.env, contact, message.raw, webimapFetch);
    await this.ctx.storage.put(`subscriber:${contact.fingerprint}`, contact);
    for (const raw of await this.ctx.storage.get<string[]>('history') ?? []) await submit(this.env, contact, raw, webimapFetch);
  }
  private async syncProfile() {
    if (!this.env.BOT_NAME && !this.env.BOT_LOGO && !this.env.CHANNEL_NAME && !this.env.CHANNEL_LOGO) return;
    const revision = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([this.env.BOT_NAME, this.env.BOT_LOGO, this.config.name, this.env.CHANNEL_LOGO])))), b => b.toString(16).padStart(2, '0')).join('');
    const contacts = await this.ctx.storage.list<Contact>({ prefix: 'subscriber:' });
    for (const contact of contacts.values()) {
      const key = `profile:${contact.fingerprint}`;
      if (await this.ctx.storage.get(key) === revision) continue;
      const message = await encryptedMail({ from: this.env.EMAIL_USERNAME, botName: this.env.BOT_NAME, botLogo: this.env.BOT_LOGO, contact,
        text: `${this.config.name} channel profile updated.`, privateKey: this.env.BOT_PRIVATE_KEY, publicKey: this.env.BOT_PUBLIC_KEY,
        extraHeaders: { ...this.channelHeaders(), 'Chat-Content': 'group-avatar-changed' } });
      await submit(this.env, contact, message.raw, webimapFetch);
      await this.ctx.storage.put(key, revision);
    }
  }
  private async publicKey(email: Email): Promise<openpgp.PublicKey | undefined> {
    const data = h(email, 'autocrypt')?.match(/keydata\s*=\s*([\s\S]+)/i)?.[1].replace(/\s/g, '');
    return data ? openpgp.readKey({ binaryKey: Uint8Array.from(atob(data), c => c.charCodeAt(0)) }) : undefined;
  }
  private async poll() {
    let since = await this.ctx.storage.get<number>('sinceUid') ?? this.config.sinceUid;
    const messages = await mailRequest<Array<{ uid: number }>>(this.env, `/webimap/messages?since_uid=${since}`, {}, webimapFetch);
    for (const { uid } of messages.sort((a, b) => a.uid - b.uid).slice(0, 20)) {
      const { body } = await mailRequest<{ body: string }>(this.env, `/webimap/message/${uid}`, {}, webimapFetch);
      try {
        await this.handleMessage(body);
      } catch (error) {
        // Transport failures must retry; malformed or unauthenticated mail must
        // not prevent later valid join requests from being processed.
        if (error instanceof DeliveryError) throw error;
        console.warn('Ignored invalid channel inbox message', uid);
      }
      since = uid; await this.ctx.storage.put('sinceUid', since);
    }
  }
  private async handleMessage(raw: string) {
    const shared = `securejoin/${this.config.fingerprint}/${this.config.auth}`;
    const outer = await PostalMime.parse(raw);
    let inner: Email; let mode: { password?: string; privateKey?: string };
    try { mode = { password: shared }; inner = (await decryptMail(raw, mode)).inner; }
    catch {
      try { mode = { privateKey: this.env.BOT_PRIVATE_KEY }; inner = (await decryptMail(raw, mode)).inner; }
      catch { mode = {}; inner = outer; }
    }
    const step = h(inner, 'secure-join');
    const email = inner.from?.address;
    if (!email || /[\r\n]/.test(email)) return;
    const contact: Contact = { email, name: inner.from?.name ?? '', fingerprint: '', auth: '', inviteNumber: '' };
    if (step === 'vc-request-pubkey' && mode.password && h(inner, 'secure-join-auth') === this.config.auth) {
      const message = await encryptedMail({ from: this.env.EMAIL_USERNAME, botName: this.env.BOT_NAME, botLogo: this.env.BOT_LOGO, contact, text: 'Secure-Join', password: shared,
        privateKey: this.env.BOT_PRIVATE_KEY, publicKey: this.env.BOT_PUBLIC_KEY,
        extraHeaders: { 'Secure-Join': 'vc-pubkey', 'Secure-Join-Auth': this.config.auth } });
      await this.deliver(contact, message.raw); return;
    }
    if (['vc-request', 'vg-request'].includes(step ?? '') && h(inner, 'secure-join-invitenumber') === this.config.inviteNumber) {
      const key = await this.publicKey(inner); if (!key) return;
      contact.publicKey = key.armor(); contact.fingerprint = key.getFingerprint().toUpperCase();
      const message = await encryptedMail({ from: this.env.EMAIL_USERNAME, botName: this.env.BOT_NAME, botLogo: this.env.BOT_LOGO, contact, text: 'Secure-Join: vc-auth-required',
        privateKey: this.env.BOT_PRIVATE_KEY, publicKey: this.env.BOT_PUBLIC_KEY, extraHeaders: { 'Secure-Join': 'vc-auth-required' } });
      await this.deliver(contact, message.raw); return;
    }
    if (!mode.privateKey) return;
    const key = await this.publicKey(inner) ?? await this.publicKey(outer); if (!key) return;
    const verified = await decryptMail(raw, { privateKey: this.env.BOT_PRIVATE_KEY, publicKey: key.armor() });
    contact.publicKey = key.armor(); contact.fingerprint = key.getFingerprint().toUpperCase();
    if (['vc-request-with-auth', 'vg-request-with-auth'].includes(h(verified.inner, 'secure-join') ?? '')
      && h(verified.inner, 'secure-join-auth') === this.config.auth
      && h(verified.inner, 'secure-join-fingerprint')?.toUpperCase() === contact.fingerprint) {
      const gossip = verified.inner.headers.filter(header => header.key === 'autocrypt-gossip');
      let intended = false;
      for (const { value } of gossip) {
        const data = value.match(/keydata\s*=\s*([\s\S]+)/i)?.[1].replace(/\s/g, '');
        if (data && (await openpgp.readKey({ binaryKey: Uint8Array.from(atob(data), c => c.charCodeAt(0)) })).getFingerprint().toUpperCase() === this.config.fingerprint) intended = true;
      }
      if (!intended) return;
      contact.verified = true;
      try { await this.addSubscriber(contact); } catch { throw new DeliveryError(); }
    } else if (h(verified.inner, 'chat-list-id')?.includes(`<${this.config.id}>`)
      && h(verified.inner, 'chat-group-member-removed') === contact.email) {
      await this.ctx.storage.delete(`subscriber:${contact.fingerprint}`);
    }
  }
  private async deliver(contact: Contact, raw: string) {
    try { await submit(this.env, contact, raw, webimapFetch); } catch { throw new DeliveryError(); }
  }
}
class DeliveryError extends Error {}
