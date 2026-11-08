import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.join(process.cwd(), "src", "internal");

const EVALUATION_ROOT = path.join(ROOT, "evaluation");
const METHOD_PROMPT_ROOT = path.join(ROOT, "learning", "agent", "subsystems", "method", "legacy-prompt");
const TOOL_DOMAIN_ROOT = path.join(ROOT, "learning", "agent", "subsystems", "tool", "domain");

/** These migrated responsibilities retain their original peripheral IO owner. */
const PERIPHERAL_ROOTS = [
  path.join(ROOT, "learning", "agent", "subsystems", "method", "adapters"),
  path.join(ROOT, "learning", "agent", "subsystems", "tool", "runtime"),
  path.join(ROOT, "learning", "agent", "subsystems", "tool", "adapters"),
];

function isWithin(file: string, root: string): boolean {
  return file === root || file.startsWith(`${root}${path.sep}`);
}

/** Resolve actual relative targets so moving a domain cannot hide its imports. */
function relativeImportTargets(file: string, source: string): string[] {
  const targets: string[] = [];
  const imports = /(?:from\s+|import\s*\(\s*|^\s*import\s+)["']([^"']+)["']/gm;

  for (const match of source.matchAll(imports)) {
    const specifier = match[1];
    if (specifier !== undefined && specifier.startsWith(".")) {
      targets.push(path.resolve(path.dirname(file), specifier));
    }
  }

  return targets;
}

function walk(dir: string): string[] {
  const out: string[] = [];

  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (full.endsWith(".ts") && full.endsWith(".test.ts") === false) {
      out.push(full);
    }
  }

  return out;
}

test("domain generators do not import evaluator pass or board activation", () => {
  const files = [
    ...walk(path.join(ROOT, "learning", "domains")),
    ...walk(METHOD_PROMPT_ROOT),
    ...walk(TOOL_DOMAIN_ROOT),
  ];

  assert.equal(files.length > 0, true);

  for (const file of files) {
    const source = readFileSync(file, "utf8");

    assert.equal(source.includes("from \"../../evaluation"), false, file);

    for (const target of relativeImportTargets(file, source)) {
      assert.equal(isWithin(target, EVALUATION_ROOT), false, `${file} imports evaluator ${target}`);
    }

    assert.equal(/\bsetActivePointer\s*\(/.test(source), false, file);
    assert.equal(/\bwriteBoardState\s*\(/.test(source), false, file);
    assert.equal(/\bactivate\s*\(/.test(source), false, file);
  }
});

test("user/prompt/skill/workflow domains do not import sibling domains", () => {
  const domains = [
    ["user", path.join(ROOT, "learning", "domains", "user")],
    ["prompt", METHOD_PROMPT_ROOT],
    ["skill", path.join(ROOT, "learning", "domains", "skill")],
    ["workflow", path.join(ROOT, "learning", "domains", "workflow")],
  ] as const;
  for (const [domain, root] of domains) {
    const files = walk(root);
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const targets = relativeImportTargets(file, source);

      for (const [other, otherRoot] of domains) {
        if (other === domain) {
          continue;
        }

        assert.equal(
          source.includes(`from "../${other}/`),
          false,
          `${file} imports sibling domain ${other}`,
        );
        // Both the actual implementation and any old compatibility path are
        // a sibling dependency; the relocation changes neither restriction.
        const oldRoot = path.join(ROOT, "learning", "domains", other);

        for (const target of targets) {
          assert.equal(
            isWithin(target, otherRoot) || isWithin(target, oldRoot),
            false,
            `${file} imports sibling domain ${other} via ${target}`,
          );
        }
      }
    }
  }
});

test("learning and evaluation production sources do not call network", () => {
  const files = [
    ...walk(path.join(ROOT, "learning")),
    ...walk(path.join(ROOT, "evaluation")),
  ].filter((file) => !PERIPHERAL_ROOTS.some((root) => isWithin(file, root)));

  assert.equal(files.length > 0, true);

  for (const file of files) {
    const source = readFileSync(file, "utf8");
    assert.equal(/from ["']node:(http|https|net|dns)["']/.test(source), false, file);
    assert.equal(/\bfetch\s*\(/.test(source), false, file);
    assert.equal(/from ["']undici["']/.test(source), false, file);
  }
});

test("evaluator does not propose or induce assets", () => {
  const files = walk(path.join(ROOT, "evaluation"));
  for (const file of files) {
    const source = readFileSync(file, "utf8");

    assert.equal(source.includes("induceSkill"), false, file);
    assert.equal(source.includes("induceWorkflow"), false, file);
    assert.equal(source.includes("detectPromptPatch"), false, file);
    assert.equal(source.includes("buildUserRule"), false, file);
    assert.equal(/\bactivate\s*\(/.test(source), false, file);
    assert.equal(/\bsetActivePointer\s*\(/.test(source), false, file);
    assert.equal(/\bactivate\s*\(/.test(source), false, file);
  }
});
