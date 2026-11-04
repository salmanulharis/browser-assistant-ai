/**
 * Creates (once) an RSA key whose public half becomes manifest.key, giving the
 * unpacked extension a stable, predictable ID. The backend then allow-lists the
 * exact origin chrome-extension://<id> (no wildcard CORS).
 *
 *   node scripts/extension-key.mjs          -> prints the extension id
 *   node scripts/extension-key.mjs --sync   -> also writes LBA_ALLOWED_ORIGINS to backend/.env
 *
 * The key file (.extension-key.json) is gitignored and stays on this machine.
 */
import { createHash, generateKeyPairSync } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const extRoot = resolve(here, '..');
const keyFile = resolve(extRoot, '.extension-key.json');
const backendEnv = resolve(extRoot, '..', 'backend', '.env');

export function idFromPublicKeyDer(der) {
  const hex = createHash('sha256').update(der).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode('a'.charCodeAt(0) + parseInt(c, 16))).join('');
}

export function ensureExtensionKey() {
  if (existsSync(keyFile)) return JSON.parse(readFileSync(keyFile, 'utf8'));
  const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const der = publicKey.export({ type: 'spki', format: 'der' });
  const data = {
    key: der.toString('base64'),
    id: idFromPublicKeyDer(der),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }),
    created: new Date().toISOString(),
  };
  writeFileSync(keyFile, JSON.stringify(data, null, 2), 'utf8');
  return data;
}

export function syncBackendOrigin(id) {
  const origin = `chrome-extension://${id}`;
  let lines = existsSync(backendEnv) ? readFileSync(backendEnv, 'utf8').split(/\r?\n/) : [];
  const idx = lines.findIndex((l) => l.startsWith('LBA_ALLOWED_ORIGINS='));
  if (idx >= 0) {
    const existing = lines[idx].slice('LBA_ALLOWED_ORIGINS='.length).split(',').map((s) => s.trim()).filter(Boolean);
    if (existing.includes(origin)) return false;
    lines[idx] = `LBA_ALLOWED_ORIGINS=${[...existing.filter((o) => o !== '*'), origin].join(',')}`;
  } else {
    lines = lines.filter((l, i) => l.trim() || i < lines.length - 1);
    lines.push(`LBA_ALLOWED_ORIGINS=${origin}`);
  }
  writeFileSync(backendEnv, lines.join('\n') + '\n', 'utf8');
  return true;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { id } = ensureExtensionKey();
  if (process.argv.includes('--sync')) syncBackendOrigin(id);
  console.log(id);
}
