import { avatarHeader, profileName } from '../src/profile';
export const DEFAULT_LOGO = 'https://madmail.chat/favicon.png';
export async function readLogo(source: string): Promise<string> {
  let bytes: Uint8Array;
  if (/^https:\/\//.test(source)) {
    const response = await fetch(source, { signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Logo download HTTP ${response.status}`);
    const reader = response.body!.getReader(); const chunks: Uint8Array[] = []; let length = 0;
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      length += value.length;
      if (length > 3840) { await reader.cancel(); throw new Error('Logo exceeds 3.75 KiB; use a smaller PNG or JPEG'); }
      chunks.push(value);
    }
    bytes = new Uint8Array(length); let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
  } else {
    const file = Bun.file(source);
    if (file.size > 3840) throw new Error('Logo exceeds 3.75 KiB; use a smaller PNG or JPEG');
    bytes = new Uint8Array(await file.arrayBuffer());
  }
  const encoded = Buffer.from(bytes).toString('base64'); avatarHeader(encoded); return encoded;
}
export async function configureProfile(state: Record<string, any>, variables: Record<string, string | undefined> = process.env) {
  state.BOT_NAME = profileName(variables.BOT_NAME ?? state.BOT_NAME ?? '', 'Madmail Bot');
  state.CHANNEL_NAME = profileName(variables.CHANNEL_NAME ?? state.CHANNEL_NAME ?? state.CHANNEL_CONFIG?.name ?? '', 'Madmail GitHub');
  state.BOT_LOGO = variables.BOT_LOGO ? await readLogo(variables.BOT_LOGO) : state.BOT_LOGO || await readLogo(DEFAULT_LOGO);
  state.CHANNEL_LOGO = variables.CHANNEL_LOGO ? await readLogo(variables.CHANNEL_LOGO) : state.CHANNEL_LOGO || state.BOT_LOGO;
  avatarHeader(state.BOT_LOGO); avatarHeader(state.CHANNEL_LOGO);
}
