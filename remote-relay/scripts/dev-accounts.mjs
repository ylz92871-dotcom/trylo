// Explicit loopback-only integration harness. Never deploy these fixtures.
import path from 'node:path';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { createStore } from '../src/store.mjs';
import { createRelayServer } from '../src/server.mjs';
const directory = process.argv[2];
if (!directory) throw new Error('Pass a dedicated disposable data directory.');
const store = await createStore(directory);
const salt = crypto.randomBytes(16).toString('hex');
const passwordHash = (await promisify(crypto.scrypt)('local-ui-test-password-123', salt, 64)).toString('hex');
await store.change(state => { if (!state.users.length) state.users.push({ id: 'ui-operator', username: 'ui.operator', salt, passwordHash, role: 'admin' }); });
await store.close();
const relay = await createRelayServer({ dataDir: directory, webOrigin: 'http://127.0.0.1:5197', secureCookies: false, webDir: path.resolve('../trylocode-site/console') });
await relay.listen(5197);
console.log('Loopback account harness ready on port 5197 (synthetic fixtures only).');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
