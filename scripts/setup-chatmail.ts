import { configureProfile } from './profile';
import * as openpgp from 'openpgp';
import { autocrypt, decryptMail, encryptedMail, mailRequest, pgpConfig, submit, type Contact } from '../src/chatmail';
import { chmodSync } from 'node:fs';

const statePath = '.env.chatmail-setup.json';
const stateFile = Bun.file(statePath);
let state: any;
if (await stateFile.exists()) state = await stateFile.json();
else {
  const inviteUrl = process.env.CHATMAIL_CONTACT_INVITE;
  if (!inviteUrl) throw new Error('Set CHATMAIL_CONTACT_INVITE locally before creating an account.');
  const invite = new URL(inviteUrl);
  const [fingerprint, ...parts] = invite.hash.slice(1).split('&');
  const params = new URLSearchParams(parts.join('&'));
  const email = params.get('a');
  const inviteNumber = params.get('i');
  const auth = params.get('s');
  if (!/^[A-F0-9]{40}$/i.test(fingerprint) || !email || !inviteNumber || !auth || params.has('x')) throw new Error('Expected a Delta Chat contact invitation.');
  const hostname = process.env.WEBIMAP_HOSTNAME || 'https://172.104.241.158';
  const response = await fetch(new URL('/new', hostname), { method: 'POST' });
  if (!response.ok) throw new Error(`Registration HTTP ${response.status}`);
  const account = await response.json() as { email: string; password: string };
  const keys = await openpgp.generateKey({ type: 'ecc', curve: 'curve25519Legacy', userIDs: [{ name: process.env.BOT_NAME || 'Madmail Bot' }], format: 'armored', config: pgpConfig });
  state = {
    WEBIMAP_HOSTNAME: hostname, EMAIL_USERNAME: account.email, EMAIL_PASSWORD: account.password,
    BOT_PRIVATE_KEY: keys.privateKey, BOT_PUBLIC_KEY: keys.publicKey,
    API_TOKEN: crypto.randomUUID() + crypto.randomUUID(),
    CONTACT: { email, name: params.get('n') ?? '', fingerprint: fingerprint.toUpperCase(), inviteNumber, auth } satisfies Contact,
    stage: 'created', sinceUid: 0,
  };
  await save();
  console.log('Created random Chatmail account and OpenPGP identity.');
}
async function save() { await Bun.write(statePath, JSON.stringify(state, null, 2)); chmodSync(statePath, 0o600); }
await configureProfile(state);
await save();
const password = `securejoin/${state.CONTACT.fingerprint}/${state.CONTACT.auth}`;
if (state.stage === 'created') {
  const request = await encryptedMail({ from: state.EMAIL_USERNAME, botName: state.BOT_NAME, botLogo: state.BOT_LOGO, contact: state.CONTACT, text: 'Secure-Join', password,
    extraHeaders: { 'Secure-Join': 'vc-request-pubkey', 'Secure-Join-Auth': state.CONTACT.auth } });
  await submit(state, state.CONTACT, request.raw);
  state.stage = 'requested-key'; await save();
  console.log('Sent SecureJoin v3 public-key request.');
}
if (process.argv.includes('--legacy') && state.stage === 'requested-key' && !state.legacyRequested) {
  const raw = [
    `From: =?UTF-8?B?${Buffer.from(state.BOT_NAME).toString('base64')}?= <${state.EMAIL_USERNAME}>`, `To: <${state.CONTACT.email}>`,
    `Date: ${new Date().toUTCString()}`, `Message-ID: <${crypto.randomUUID()}@${state.EMAIL_USERNAME.split('@')[1]}>`,
    'Subject: Secure-Join', 'Chat-Version: 1.0', 'Auto-Submitted: auto-generated',
    'Secure-Join: vc-request', `Secure-Join-Invitenumber: ${state.CONTACT.inviteNumber}`,
    await autocrypt(state.EMAIL_USERNAME, state.BOT_PUBLIC_KEY),
    'MIME-Version: 1.0', 'Content-Type: multipart/mixed; boundary="securejoin-request"', '', '--securejoin-request', 'Content-Type: text/plain; charset=utf-8', '', 'secure-join: vc-request', '', '--securejoin-request--', '',
  ].join('\r\n');
  await submit(state, state.CONTACT, raw);
  state.legacyRequested = true; await save();
  console.log('Sent legacy-compatible public-key request (auth token remains private).');
}
const deadline = Date.now() + 45000;
while (Date.now() < deadline && state.stage !== 'verified') {
  const messages = await mailRequest<Array<{uid: number}>>(state, `/webimap/messages?since_uid=${state.sinceUid}&wait=5`);
  for (const summary of messages) {
    const detail = await mailRequest<{body: string}>(state, `/webimap/message/${summary.uid}`);
    if (state.stage === 'requested-key') {
      let mode: { password?: string; privateKey?: string } = { password };
      let unverified;
      try { unverified = await decryptMail(detail.body, mode); }
      catch { mode = { privateKey: state.BOT_PRIVATE_KEY }; unverified = await decryptMail(detail.body, mode); }
      const autocrypt = unverified.inner.headers.find(h => h.key === 'autocrypt')?.value ?? unverified.outer.headers.find(h => h.key === 'autocrypt')?.value;
      const keydata = autocrypt?.match(/keydata\s*=\s*([\s\S]+)/i)?.[1].replace(/\s/g, '');
      if (!keydata) throw new Error('Inviter did not provide Autocrypt key');
      const key = await openpgp.readKey({ binaryKey: Uint8Array.from(atob(keydata), c => c.charCodeAt(0)) });
      if (key.getFingerprint().toUpperCase() !== state.CONTACT.fingerprint) throw new Error('Inviter fingerprint mismatch');
      const checked = await decryptMail(detail.body, { ...mode, publicKey: key.armor() });
      if (!['vc-pubkey', 'vc-auth-required'].includes(checked.inner.headers.find(h => h.key === 'secure-join')?.value ?? '')) throw new Error('Expected signed public-key response');
      state.CONTACT.publicKey = key.armor();
      const ownKey = await openpgp.readKey({ armoredKey: state.BOT_PUBLIC_KEY });
      const auth = await encryptedMail({ from: state.EMAIL_USERNAME, botName: state.BOT_NAME, botLogo: state.BOT_LOGO, contact: state.CONTACT, text: 'Secure-Join: vc-request-with-auth', privateKey: state.BOT_PRIVATE_KEY, publicKey: state.BOT_PUBLIC_KEY,
        extraHeaders: { 'Secure-Join': 'vc-request-with-auth', 'Secure-Join-Auth': state.CONTACT.auth, 'Secure-Join-Fingerprint': ownKey.getFingerprint().toUpperCase() } });
      await submit(state, state.CONTACT, auth.raw);
      state.stage = 'requested-auth';
      console.log('Verified inviter fingerprint and signature; sent authenticated response.');
    } else if (state.stage === 'requested-auth') {
      const checked = await decryptMail(detail.body, { privateKey: state.BOT_PRIVATE_KEY, publicKey: state.CONTACT.publicKey });
      if (checked.inner.headers.find(h => h.key === 'secure-join')?.value === 'vc-contact-confirm') {
        state.CONTACT.verified = true; state.stage = 'verified';
        console.log('SecureJoin handshake complete: signed encrypted contact confirmation received.');
      }
    }
    state.sinceUid = Math.max(state.sinceUid, summary.uid); await save();
  }
}
console.log(`Handshake state: ${state.stage}`);
if (state.stage !== 'verified') process.exitCode = 2;
