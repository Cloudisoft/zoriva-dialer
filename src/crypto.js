const crypto = require('crypto');

function key() {
  const k = process.env.APP_KEY || '';
  if (!/^[0-9a-fA-F]{64}$/.test(k)) {
    throw new Error('APP_KEY must be 64 hex characters. Generate one with: node -e "console.log(require(\'crypto\').randomBytes(32).toString(\'hex\'))"');
  }
  return Buffer.from(k, 'hex');
}

function encrypt(plain) {
  if (plain === null || plain === undefined || plain === '') return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return [iv.toString('base64'), tag.toString('base64'), enc.toString('base64')].join('.');
}

function decrypt(blob) {
  if (!blob) return null;
  const [iv, tag, data] = String(blob).split('.');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'));
  decipher.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8');
}

// Show the operator enough to recognise a key without exposing it.
function mask(plain) {
  if (!plain) return null;
  const s = String(plain);
  if (s.length <= 8) return '••••';
  return '••••••••' + s.slice(-4);
}

module.exports = { encrypt, decrypt, mask };
