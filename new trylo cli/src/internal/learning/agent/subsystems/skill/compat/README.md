# Hermes peripheral compatibility

Owner: skill subsystem. Consumer: its Node worker. This entry does not import
Desktop, UI or Service Host code, and introduces no Board or SkillDraft schema.

`createHermesSkillCompatibility({ storageRoot, capabilitiesDir })` exposes the
existing `skillsQuery`, `list`, `view`, `pendingProposeSkill`, `pendingList`,
`pendingDetail`, `pendingApply`, `pendingDiscard`, `pendingBackupList` and
`pendingRollback` operations. Parameters, response bodies, rejection codes and
envelopes are forwarded as before. In particular, apply still requires the
reviewed `expectedHash`, and backups/rollback still use official Hermes snapshots.
The shared pending wrapper retains its original memory/skills subsystem handling;
this compatibility layer does not filter or reinterpret that existing queue.

The three implementation wrappers are byte-for-byte copies of
`desktop-services/src/learning/{skills-client,pending-admin-service,file-memento}.mjs`.
Their source hashes are recorded in `PROVENANCE.json`. Only `vendor-path.mjs`
adapts module resolution: it resolves exclusively under `../vendor/legacy`.
`index.mjs` contains the original skills-query dispatch and method forwarding.

Exact non-built-in dependencies:

- `skills-client.mjs` → `vendor-path.mjs` → `hermes-python-resolver.js` and
  `hermes-capability-manager.js`; invokes `skills_adapter.py`.
- `pending-admin-service.mjs` → `vendor-path.mjs` → `hermes-pending-admin.js`,
  whose direct local helpers are the resolver and capability manager; invokes
  `admin.py`. It has no jobs/history dependency.
- `file-memento.mjs` uses only Node fs/path. `createFileMemento` is re-exported
  separately and retains `learning/state-v1.json` and the original Memento key.

The factory configures the two original capabilities-path environment variables
before the first lazy CJS require. One capabilities installation belongs to each
worker; legacy CJS module caching has the same first-load behavior as before.
An omitted capabilities directory retains the original env/vendor fallback.
The worker still supplies the runtime storage root and manages authorization.

Production staging must include the `.mjs` runtime and its local CJS, Python,
metadata and license closure. `index.d.mts` supplies compile-time declarations;
`tsc` alone does not copy the runtime files.
There is no npm installation or new dependency in this wrapper migration.

Removal condition: replace this forwarding entry only when the internal Hermes
owner can preserve every existing peripheral contract; callers then migrate to
that owner. No second learning-state or skill-content store is created here.
