import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

// Deployment credentials and host trust remain outside the public checkout.
const host = process.env.TRYLO_SSH_HOST;
const known = process.env.TRYLO_SSH_KNOWN_HOSTS;
const key = process.env.TRYLO_SSH_KEY;
const expected = process.env.TRYLO_SSH_HOST_FINGERPRINT;
if (!host || !known || !key || !expected || !/^[a-zA-Z0-9.-]+$/.test(host)) throw Error('Set TRYLO_SSH_HOST, TRYLO_SSH_KNOWN_HOSTS, TRYLO_SSH_KEY and TRYLO_SSH_HOST_FINGERPRINT.');
const record = fs.readFileSync(known, 'utf8').split(/\r?\n/).find(line => line.startsWith(host + ' ssh-ed25519 '));
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const fingerprint = record && 'SHA256:' + createHash('sha256').update(Buffer.from(record.split(' ')[2], 'base64')).digest('base64').replace(/=+$/, '');
if (fingerprint !== expected) throw Error('Pinned deployment host key mismatch');
const options = ['-i', key, '-o', 'IdentitiesOnly=yes', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${known}`, '-o', 'KexAlgorithms=curve25519-sha256', '-o', 'ConnectTimeout=10'];
export function ssh(command, { input, timeout = 60000 } = {}) {
  const result = spawnSync('ssh', [...options, `admin@${host}`, ...command], { input, encoding: 'utf8', timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024 });
  if (result.status !== 0) throw Error((result.stderr || result.error?.message || 'SSH failed').trim());
  return result.stdout;
}
export function upload(source, destination) {
  if (!/^\/home\/admin\/trylo-site\/[\w/.-]+$/.test(destination) || destination.includes('..')) throw Error('Unexpected upload destination');
  const bytes = fs.readFileSync(source);
  const size = Number(ssh(['sh', '-c', `'if test -f ${destination}; then stat -c %s ${destination}; else echo 0; fi'`]));
  if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length) throw Error('Unexpected partial upload length');
  if (size && ssh(['sha256sum', destination]).split(/\s/)[0] !== hash(bytes.subarray(0, size))) throw Error('Partial upload differs; refusing to overwrite');
  if (size < bytes.length) ssh(['dd', `of=${destination}`, 'oflag=append', 'conv=notrunc', 'status=none'], { input: bytes.subarray(size), timeout: 600000 });
  if (ssh(['sha256sum', destination]).split(/\s/)[0] !== hash(bytes)) throw Error('Uploaded bytes differ');
}
