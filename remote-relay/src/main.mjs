import { createRelayServer } from './server.mjs';
async function main() {
const relay = await createRelayServer({ dataDir: process.env.RELAY_DATA_DIR, webOrigin: process.env.TRYLO_WEB_ORIGIN || 'https://trylocode.me', webDir: process.env.TRYLO_WEB_DIR || '/app/web' });
await relay.listen(Number(process.env.PORT) || 8788, process.env.RELAY_BIND || '127.0.0.1');
console.log('Trylo relay ready.');
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => { void relay.close().then(() => process.exit(0)); });
}
main().catch(() => { console.error('Trylo relay could not start. Check configuration and data permissions.'); process.exitCode = 1; });
