import { createStore } from '../src/store.mjs';
async function main() {
const [directory, username, expectedId] = process.argv.slice(2);
if (!directory || !/^[a-z0-9_.-]{3,64}$/.test(username || '') || !expectedId) throw new Error('Usage: admin-account DATA_DIR EXISTING_USERNAME EXPECTED_USER_ID');
const store = await createStore(directory);
try {
  await store.change(state => {
    const user = state.users.find(item => item.username === username && item.id === expectedId && !item.disabled);
    if (!user) throw new Error('Exact existing identity not found; no privileges changed.');
    user.role = 'admin'; state.audit ??= [];
    state.audit.push({ id: crypto.randomUUID(), at: Date.now(), actor: 'server-operator', action: 'admin.grant', target: user.id });
  });
  console.log('Existing account granted administrator role. No credentials changed.');
} finally { await store.close(); }
}
main().catch(failure => { console.error(failure.message); process.exitCode = 1; });
