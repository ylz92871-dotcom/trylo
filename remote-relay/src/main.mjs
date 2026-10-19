import { createRelayServer } from './server.mjs';
async function main() {
const relay = await createRelayServer({ dataDir: process.env.RELAY_DATA_DIR, inviteCode: process.env.RELAY_INVITE_CODE });
await relay.listen(Number(process.env.PORT) || 8788, process.env.RELAY_BIND || '127.0.0.1');
console.log('Trylo relay ready.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
}
main().catch(() => { console.error('Trylo relay could not start. Check configuration and data permissions.'); process.exitCode = 1; });
