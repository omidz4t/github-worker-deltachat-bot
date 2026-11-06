import { avatarHeader, profileName } from './profile';
import * as openpgp from 'openpgp';
import { readToEnd } from '@openpgp/web-stream-tools';
import PostalMime from 'postal-mime';

export interface MailConfig {
  WEBIMAP_HOSTNAME: string;
  EMAIL_USERNAME: string;
  EMAIL_PASSWORD: string;
}
export interface Contact {
  email: string;
  name: string;
  fingerprint: string;
  inviteNumber: string;
  auth: string;
  publicKey?: string;
  verified?: boolean;
}
export const pgpConfig = { preferredCompressionAlgorithm: openpgp.enums.compression.uncompressed, aeadProtect: false, v6Keys: false };

export async function mailRequest<T>(config: MailConfig, path: string, init: RequestInit = {}, transport: typeof fetch = fetch): Promise<T> {
  const response = await transport(new URL(path, config.WEBIMAP_HOSTNAME), {
    ...init,
    headers: { 'X-Email': config.EMAIL_USERNAME, 'X-Password': config.EMAIL_PASSWORD, 'Content-Type': 'application/json', ...init.headers },
    signal: AbortSignal.timeout(25000),
  });
  if (!response.ok) {
    const detail = await response.json().catch(() => ({})) as { error?: string };
    throw new Error(`WebIMAP ${path.split('?')[0]} returned HTTP ${response.status}: ${detail.error ?? 'Request failed'}`);
  }
  return response.json() as Promise<T>;
}

function header(value: string): string {
  if (/[\r\n]/.test(value)) throw new Error('Invalid mail header');
  return value;
}
function base64(bytes: Uint8Array): string {
  return btoa(Array.from(bytes, b => String.fromCharCode(b)).join(''));
}
export async function autocrypt(email: string, publicKey: string, name = 'Autocrypt'): Promise<string> {
  const key = await openpgp.readKey({ armoredKey: publicKey });
  return `${name}: addr=${header(email)}; prefer-encrypt=mutual; keydata=\r\n ${base64(key.write()).match(/.{1,72}/g)!.join('\r\n ')}`;
}

// SecureJoin v3 accepts only RFC 4880 Salted S2K (type 1), not the
// iterated S2K produced by OpenPGP.js's password encryption defaults.
// The invite token is already random. Use a v4 SKESK with no wrapped
// session key: SHA-256(salt || shared secret) directly derives AES-256.
export async function encryptSecureJoin(text: string, password: string, privateKey?: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(8));
  const passwordBytes = new TextEncoder().encode(password);
  const input = new Uint8Array(salt.length + passwordBytes.length);
  input.set(salt); input.set(passwordBytes, salt.length);
  const key = new Uint8Array(await crypto.subtle.digest('SHA-256', input));
  const encrypted = await openpgp.encrypt({
    message: await openpgp.createMessage({ text }),
    sessionKey: { data: key, algorithm: 'aes256' },
    signingKeys: privateKey ? await openpgp.readPrivateKey({ armoredKey: privateKey }) : undefined,
    format: 'binary', config: pgpConfig,
  });
  const skesk = new Uint8Array([0xc3, 12, 4, 9, 1, 8, ...salt]);
  const packetBytes = new Uint8Array(skesk.length + encrypted.length);
  packetBytes.set(skesk); packetBytes.set(encrypted, skesk.length);
  return await readToEnd((await openpgp.readMessage({ binaryMessage: packetBytes })).armor()) as string;
}

export async function encryptedMail(options: {
  from: string; contact: Contact; text: string; privateKey?: string; publicKey?: string;
  botName?: string; botLogo?: string;
  password?: string; hideRecipients?: boolean; extraHeaders?: Record<string, string>;
}): Promise<{ id: string; raw: string }> {
  const { from, contact, text, privateKey, publicKey, password, hideRecipients, extraHeaders = {} } = options;
  const displayName = '=?UTF-8?B?' + base64(new TextEncoder().encode(profileName(options.botName ?? '', 'Madmail Bot'))) + '?=';
  const id = `${crypto.randomUUID()}@${from.split('@')[1]}`;
  const innerHeaders = [
    `From: ${displayName} <${header(from)}>`, hideRecipients ? 'To: "hidden-recipients": ;' : `To: <${header(contact.email)}>`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${id}>`, 'Subject: Message', 'Chat-Version: 1.0', 'Auto-Submitted: auto-generated',
    ...Object.entries(extraHeaders).map(([key, value]) => `${header(key)}: ${header(value)}`),
  ];
  if (options.botLogo && privateKey) innerHeaders.push(`Chat-User-Avatar: ${avatarHeader(options.botLogo)}`);
  if (publicKey) innerHeaders.push(await autocrypt(from, publicKey));
  if (!password && publicKey && contact.publicKey) innerHeaders.push(await autocrypt(contact.email, contact.publicKey, 'Autocrypt-Gossip'), await autocrypt(from, publicKey, 'Autocrypt-Gossip'));
  innerHeaders.push('MIME-Version: 1.0', 'Content-Type: text/plain; charset=utf-8; protected-headers="v1"', 'Content-Transfer-Encoding: base64');
  const inner = `${innerHeaders.map(line => line.startsWith('Chat-User-Avatar: base64:') || line.startsWith('Chat-Group-Avatar: base64:') ? line.slice(0, line.indexOf('base64:') + 7) + line.slice(line.indexOf('base64:') + 7).match(/.{1,72}/g)!.join('\r\n ') : line).join('\r\n')}\r\n\r\n${base64(new TextEncoder().encode(text)).match(/.{1,76}/g)?.join('\r\n') ?? ''}\r\n`;
  const signingKeys = privateKey ? await openpgp.readPrivateKey({ armoredKey: privateKey }) : undefined;
  const encrypted = password ? await encryptSecureJoin(inner, password, privateKey) : await openpgp.encrypt({
    message: await openpgp.createMessage({ text: inner }),
    encryptionKeys: await Promise.all([contact.publicKey!, publicKey!].map(armoredKey => openpgp.readKey({ armoredKey }))),
    signingKeys, config: pgpConfig, format: 'armored',
  });
  const boundary = `=_${crypto.randomUUID()}`;
  const outerHeaders = [
    `From: ${displayName} <${header(from)}>`, hideRecipients ? 'To: "hidden-recipients": ;' : `To: <${header(contact.email)}>`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${id}>`, 'Subject: ...',
    'Chat-Version: 1.0', 'Auto-Submitted: auto-generated',
    ...(publicKey ? [await autocrypt(from, publicKey)] : []),
    'MIME-Version: 1.0', `Content-Type: multipart/encrypted; protocol="application/pgp-encrypted"; boundary="${boundary}"`,
  ];
  return { id, raw: `${outerHeaders.join('\r\n')}\r\n\r\n--${boundary}\r\nContent-Type: application/pgp-encrypted\r\n\r\nVersion: 1\r\n\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n${encrypted}\r\n--${boundary}--\r\n` };
}

export async function submit(config: MailConfig, contact: Contact, raw: string, transport: typeof fetch = fetch): Promise<void> {
  await mailRequest(config, '/webimap/send', { method: 'POST', body: JSON.stringify({ from: config.EMAIL_USERNAME, to: [contact.email], body: raw }) }, transport);
}

export async function decryptMail(raw: string, options: { password?: string; privateKey?: string; publicKey?: string }) {
  const outer = await PostalMime.parse(raw);
  const part = outer.attachments.find(a => a.mimeType === 'application/octet-stream' || a.mimeType === 'application/pgp-encrypted' && a.filename);
  if (!part) throw new Error('Missing encrypted MIME part');
  const content = typeof part.content === 'string' ? part.content : new TextDecoder().decode(part.content);
  const result = await openpgp.decrypt({
    message: await openpgp.readMessage({ armoredMessage: content }),
    ...(options.password ? { passwords: [options.password] } : { decryptionKeys: await openpgp.readPrivateKey({ armoredKey: options.privateKey! }) }),
    ...(options.publicKey ? { verificationKeys: await openpgp.readKey({ armoredKey: options.publicKey }), expectSigned: true } : {}),
    format: 'utf8', config: pgpConfig,
  });
  return { outer, inner: await PostalMime.parse(result.data), signatures: result.signatures, plaintext: result.data };
}
