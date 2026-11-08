// Test-only semantic regressions for proving that the contracts detect lost
// behavior. Never used by product entrypoints. The root records red assertion
// output; a loader/import error is not evidence of a successful red injection.
const selected = process.env.TRYLO_HERMES_RED_CASE;

function replaceRequired(source, before, after) {
  if (!source.includes(before)) throw new Error('regression anchor changed; do not count this import failure as red evidence');
  return source.replace(before, after);
}

export async function load(url, context, nextLoad) {
  const result = await nextLoad(url, context);
  if (!selected || result.source === undefined || result.source === null) return result;
  let source = result.source.toString(), changed = false;
  const marker = `// trylo-hermes-semantic-regression:${selected}\n`;
  // Node's test runner can inherit this loader twice. Inject once per module;
  // duplicate registration must not turn a semantic red into an import error.
  if (source.startsWith(marker)) return result;
  if (url.endsWith('/review-backend.mjs')) {
    if (selected === 'single-pending') {
      source = replaceRequired(source, 'const receipts = execution.proposals;',
        'const receipts = execution.proposals; if (receipts.length > 1) return { status: "failed", candidateId: reviewId, error: "legacy_ambiguous_proposals" };');
      changed = true;
    } else if (selected === 'single-skill-target') {
      source = replaceRequired(source,
        "review.opportunity.trigger === 'explicit' && new Set(receipts.map(item => item?.name)).size > 1",
        'new Set(receipts.map(item => item?.name)).size > 1');
      changed = true;
    } else if (selected === 'legacy-prompt-tail') {
      source = replaceRequired(source, 'loadPrompt = fetchPrompt',
        "loadPrompt = require('../vendor/legacy/learning-loop/prompt-client.js').fetchPrompt");
      changed = true;
    } else if (selected === 'lost-workspace-update') {
      source = replaceRequired(source, 'const previous = saves.get(store.root) ?? Promise.resolve();', 'const previous = Promise.resolve();');
      changed = true;
    } else if (selected === 'global-pending-lock') {
      const declaration = source.match(/const hasUnattributedPending = [^\r\n]+;/)?.[0];
      if (!declaration) throw new Error('regression anchor changed; import failure is not red evidence');
      source = source.replace(declaration, declaration + '\nif (hasUnattributedPending) return { status: "failed", candidateId: reviewId, error: "hermes_review_unattributed_pending" };');
      changed = true;
    } else if (selected === 'no-secret-projection') {
      source = replaceRequired(source, 'function sanitise(value) {', 'function sanitise(value) { return value;');
      changed = true;
    } else if (selected === 'false-no-learning') {
      const declaration = source.match(/const executionFailed = [^\r\n]+;/)?.[0];
      if (!declaration) throw new Error('regression anchor changed; import failure is not red evidence');
      source = source.replace(declaration, 'const executionFailed = false;');
      changed = true;
    }
  } else if (/\/review-process\.(?:ts|js)$/.test(url) && selected === 'lost-release') {
    source = replaceRequired(source, 'await backend.release(prepared.reviewId);', '/* review release intentionally removed by test loader */');
    changed = true;
  }
  return changed ? { ...result, source: marker + source } : result;
}
