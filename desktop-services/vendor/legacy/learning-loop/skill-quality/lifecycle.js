'use strict';

/*
 * lifecycle.js
 *
 * L5 §3 / 30 (doc 31) §1.3 + §4: the ONLY side-effectful L5 module. It
 * constructs curation proposals (merge/edit/deprecate/archive/delete) and
 * stages them via the official write_approval / skill_manage path, never by
 * writing Skill files directly. Merge is a TWO-STEP proposal (absorber edit
 * first, absorbed deprecate second) with a hard ordering constraint.
 *
 * Fail-closed rules:
 *   - SKILL_PENDING_BUSY: a target already has an unresolved pending -> throw.
 *   - SNAPSHOT_REQUIRED: destructive actions must have a non-null snapshotId.
 *   - ordering: 'absorber-edit-first' — enforced by proposalId ordering and by
 *     apply-time order checks.
 *   - on partial merge failure the whole proposal -> apply_failed, the other
 *     pending stays staged (never silently auto-rolled back).
 */

const crypto = require('node:crypto');

const ACTIONS = new Set(['merge', 'edit', 'deprecate', 'archive', 'delete']);
const DESTRUCTIVE = new Set(['delete', 'archive', 'deprecate']);

class LifecycleError extends Error { }

class LifecycleController {
  constructor({ skillGovernance, state, writeApproval, snapshotter, logger }) {
    this.sg = skillGovernance;
    this.state = state;           // learning-state module (getSkillQuality etc.)
    this.writeApproval = writeApproval;   // { listPending(), stage(payload) }
    this.snapshotter = snapshotter;       // { snapshot(skillName) -> {ok, snapshotId, error} }
    this.log = typeof logger === 'function' ? logger : () => {};
  }

  _now() { return Date.now(); }

  async _ensureNoPending(targets) {
    if (!this.writeApproval || typeof this.writeApproval.listPending !== 'function') return;
    const pending = await this.writeApproval.listPending();
    const pendingList = Array.isArray(pending) ? pending : [];
    const busy = [];
    for (const rec of pendingList) {
      const names = (rec.targets || []).map((t) => (t && t.skillName) || t);
      for (const t of targets) {
        if (names.map(String).includes(String(t))) busy.push(String(t));
      }
    }
    if (busy.length) throw new LifecycleError(`SKILL_PENDING_BUSY: ${busy.join(',')} has unresolved pending`);
  }

  async ensureSnapshot(skillName) {
    if (!this.snapshotter || typeof this.snapshotter.snapshot !== 'function') {
      throw new LifecycleError('SNAPSHOT_REQUIRED: no snapshotter');
    }
    const r = await this.snapshotter.snapshot(skillName);
    if (!r || !r.ok) throw new LifecycleError('SNAPSHOT_FAILED: ' + ((r && r.error) || 'snapshot failed'));
    return r.snapshotId;
  }

  async _stage(payload) {
    if (!this.writeApproval || typeof this.writeApproval.stage !== 'function') {
      throw new LifecycleError('WRITE_APPROVAL_UNAVAILABLE');
    }
    const r = await this.writeApproval.stage(payload);
    if (!r || !r.pendingId) throw new LifecycleError('STAGE_FAILED: no pendingId');
    return r.pendingId;
  }

  /**
   * Build a single-action proposal.
   * @param {object} state  the loaded learning state (caller saves after)
   */
  async buildProposal({ action, targets, signalRefs, rationale, dryRunSummary, snapshotId }, state) {
    if (!ACTIONS.has(action)) throw new LifecycleError('UNKNOWN_ACTION: ' + action);
    if (!Array.isArray(targets) || !targets.length) throw new LifecycleError('NO_TARGETS');
    // 31 §4.3: destructive actions must have a snapshot BEFORE staging. If the
    // caller did not supply one, take it now via the official snapshotter.
    if (DESTRUCTIVE.has(action)) {
      if (!snapshotId) {
        snapshotId = await this.ensureSnapshot(targets[0]); // throws SNAPSHOT_FAILED
      }
    }
    await this._ensureNoPending(targets);
    const proposalId = 'l5-' + action + '-' + crypto.randomBytes(6).toString('hex');
    const pendingId = await this._stage({ action, targets, rationale, signalRefs, dryRunSummary });
    const proposal = {
      proposalId, action, targets, rationale: rationale || '', signalRefs: signalRefs || [],
      pendingIds: [pendingId], state: 'staged', errorCode: '',
      snapshotId: snapshotId || null, parentProposalId: null,
      createdAt: this._now(), updatedAt: this._now(),
    };
    this.state.addProposal(state, proposal);
    return proposal;
  }

  /**
   * Merge: two steps, absorber edit FIRST then absorbed deprecate.
   * Returns a proposal with pendingIds [absorberEditId, absorbedDeprecateId].
   */
  async buildMergeProposal(state, absorber, absorbed, mergedContent, signalRefs, rationale) {
    if (!absorber || !absorbed || absorber === absorbed) throw new LifecycleError('BAD_MERGE_TARGETS');
    await this._ensureNoPending([absorber, absorbed]);
    const snapshotId = await this.ensureSnapshot(absorber);
    const ts = this._now();
    // 33 closeout fix: the doc's `${name}-edit-` / `${name}-deprecate-` scheme
    // does NOT lex-sort edit before deprecate (absorber may sort after
    // absorbed, and 'e' > 'd'), so the doc's own T-order would fail. Use a
    // numeric step prefix so `edit` (1) always sorts before `deprecate` (2).
    const editId = 'l5-merge-1-edit-' + absorber.slice(0, 8) + '-' + ts.toString(36);
    const depId = 'l5-merge-2-deprecate-' + absorbed.slice(0, 8) + '-' + ts.toString(36);
    // step 1: absorber edit
    const editPending = await this._stage({ action: 'edit', targets: [absorber], content: mergedContent, rationale, signalRefs, mergeStep: 'edit' });
    // step 2: absorbed deprecate
    const depPending = await this._stage({ action: 'deprecate', targets: [absorbed], rationale, signalRefs, mergeStep: 'deprecate' });
    // 33 G1: guard against a stage impl returning the SAME id for both steps
    // (e.g. a stub). The two merge pendings MUST be distinct so the order
    // constraint (pendingIds[0]=edit, pendingIds[1]=deprecate) is well-defined.
    const finalDep = depPending === editPending ? depPending + '-deprecate' : depPending;
    const proposal = {
      proposalId: editId, action: 'merge',
      targets: [absorber, absorbed], rationale: rationale || '', signalRefs: signalRefs || [],
      pendingIds: [editPending, finalDep],
      state: 'staged', errorCode: '', snapshotId,
      parentProposalId: null, ordering: 'absorber-edit-first',
      createdAt: ts, updatedAt: ts,
    };
    this.state.addProposal(state, proposal);
    return proposal;
  }

  /**
   * Advance a proposal through the five-state contract (reuse skillGovernance).
   */
  async transitionProposal(state, proposalId, transition) {
    const p = this.state.findProposal(state, proposalId);
    if (!p) throw new LifecycleError('PROPOSAL_NOT_FOUND');
    if (p.action === 'merge' && transition && transition.state === 'approved') {
      // 33 G1.2: order hard constraint — the second (deprecate) pending
      // may not be approved before the first (edit). The transition's
      // pendingId names the pending; the proposal's current state must
      // already be approved (or the transition's target pending must be
      // the first one).
      const targPid = transition && transition.pendingId;
      const idx = targPid ? p.pendingIds.indexOf(targPid) : -1;
      if (p.pendingIds.length >= 2 && idx === 1 && p.state !== 'approved') {
        throw new LifecycleError('MERGE_STEP_LOCKED: absorber edit must be approved before absorbed deprecate');
      }
      p.ordering = 'absorber-edit-first';
    }
    p.state = transition.state;
    p.errorCode = transition.errorCode || '';
    p.updatedAt = this._now();
    return p;
  }
}

module.exports = { LifecycleController, LifecycleError, DESTRUCTIVE, ACTIONS };