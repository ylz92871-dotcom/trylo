import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { quotaError } from './quota.mjs';

const binding = source => JSON.stringify([source.id, new URL(source.endpoint).href.replace(/\/$/, ''), source.protocol]);
export async function createCredentialVault({ store, directory }) {
  await store.sqlWrite(db => db.exec('CREATE TABLE IF NOT EXISTS model_credentials(upstream_id TEXT PRIMARY KEY,binding TEXT NOT NULL,ciphertext TEXT NOT NULL,updated_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS model_credential_slots(upstream_id TEXT NOT NULL,slot TEXT NOT NULL,binding TEXT NOT NULL,ciphertext TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(upstream_id,slot))'));
  const filename = path.join(directory, 'model-master.key');
  let master;
  try {
    const stat = await fs.lstat(filename);
    if (!stat.isFile() || stat.isSymbolicLink()) throw Error('Invalid model master key file');
    master = await fs.readFile(filename);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    if (store.sqlRead(db => db.prepare('SELECT (SELECT count(*) FROM model_credentials)+(SELECT count(*) FROM model_credential_slots) n').get().n)) throw Error('Existing model credentials require their original master key');
    master = crypto.randomBytes(32);
    await fs.writeFile(filename, master, { flag: 'wx', mode: 0o600 });
  }
  if (master.length !== 32) throw Error('Invalid model master key');
  await fs.chmod(filename, 0o600);
  await store.sqlWrite(db => db.exec('CREATE TABLE IF NOT EXISTS model_credential_slots(upstream_id TEXT NOT NULL,slot TEXT NOT NULL,binding TEXT NOT NULL,ciphertext TEXT NOT NULL,updated_at INTEGER NOT NULL,PRIMARY KEY(upstream_id,slot))'));
  const validSlot = slot => { if (!/^[a-z][a-z0-9-]{0,31}$/.test(slot)) throw quotaError(400, '账号标识须为小写字母、数字或连字符。'); return slot; };
  const aadFor = (source, slot) => slot === 'primary' ? binding(source) : JSON.stringify([binding(source), validSlot(slot)]);
  const row = (id, slot = 'primary') => store.sqlRead(db => slot === 'primary'
    ? db.prepare('SELECT binding,ciphertext FROM model_credentials WHERE upstream_id=?').get(id)
    : db.prepare('SELECT binding,ciphertext FROM model_credential_slots WHERE upstream_id=? AND slot=?').get(id, validSlot(slot)));
  const slots = source => ['primary', ...store.sqlRead(db => db.prepare('SELECT slot FROM model_credential_slots WHERE upstream_id=? ORDER BY slot').all(source.id)).map(item => item.slot)]
    .filter(slot => row(source.id, slot)?.binding === aadFor(source, slot));
  const read = (source, slot = 'primary') => {
    const value = row(source.id, slot);
    if (!value || value.binding !== aadFor(source, slot)) throw quotaError(503, '该上游需要配置与当前 API 地址绑定的密钥。', 'credential_unavailable');
    try {
      const encoded = JSON.parse(value.ciphertext), decipher = crypto.createDecipheriv('aes-256-gcm', master, Buffer.from(encoded.iv, 'base64'));
      decipher.setAAD(Buffer.from(value.binding)); decipher.setAuthTag(Buffer.from(encoded.tag, 'base64'));
      return Buffer.concat([decipher.update(Buffer.from(encoded.data, 'base64')), decipher.final()]).toString('utf8');
    } catch { throw quotaError(503, '上游凭据无法读取，请重新配置。', 'credential_unavailable'); }
  };
  return {
    has(source) { return slots(source).length > 0; },
    slots, read,
    async save(source, secret, slot = 'primary') {
      validSlot(slot);
      if (typeof secret !== 'string' || secret.length < 16 || secret.length > 512 || /[\s\x00-\x1f]/.test(secret)) throw quotaError(400, '密钥格式无效。');
      if (slots(source).some(other => other !== slot && read(source, other) === secret)) throw quotaError(409, '该密钥已在此池中配置。');
      if (!row(source.id, slot) && slots(source).length >= 8) throw quotaError(400, '每个池最多配置 8 个上游账号。');
      const aad = aadFor(source, slot), iv = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', master, iv);
      cipher.setAAD(Buffer.from(aad));
      const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
      const value = JSON.stringify({ v: 1, iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: ciphertext.toString('base64') });
      await store.sqlWrite(db => slot === 'primary'
        ? db.prepare('INSERT INTO model_credentials(upstream_id,binding,ciphertext,updated_at) VALUES(?,?,?,?) ON CONFLICT(upstream_id) DO UPDATE SET binding=excluded.binding,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').run(source.id, aad, value, Date.now())
        : db.prepare('INSERT INTO model_credential_slots(upstream_id,slot,binding,ciphertext,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(upstream_id,slot) DO UPDATE SET binding=excluded.binding,ciphertext=excluded.ciphertext,updated_at=excluded.updated_at').run(source.id, slot, aad, value, Date.now()));
    },
  };
}
