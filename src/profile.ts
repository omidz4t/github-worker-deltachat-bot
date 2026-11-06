export function profileName(value: string, fallback: string): string {
  const name = value.trim() || fallback;
  if (/[\r\n\x00-\x1f\x7f]/.test(name) || name.length > 100) throw new Error('Names must contain 1–100 printable characters');
  return name;
}
export function avatarHeader(value: string): string {
  if (!value || value.length > 28000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('Logo must be base64 PNG or JPEG, at most 20 KiB');
  const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
  const png = bytes.length >= 8 && [137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b);
  const jpeg = bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255;
  if (bytes.length > 20480 || (!png && !jpeg)) throw new Error('Logo must be PNG or JPEG, at most 20 KiB');
  return 'base64:' + value;
}
