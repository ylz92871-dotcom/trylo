import assert from "node:assert/strict";
import { writeFile } from "node:fs/promises";
import test from "node:test";
import { decodeRegistry } from "./index.js";
import {
  EXPECTED,
  issuePass,
  line,
  openRegistryFileHarness,
  readRaw,
} from "./registry-harness.js";

/**
 * durable receipt registry 的**故障语义**证据（WP-F §7 D2 退出门）：
 * 任何形式的损坏都必须 fail closed，而且每一类损坏都要报**可区分**的码，
 * 不能被折叠成同一个「服务不可用」。
 *
 * 每一条都先把合法记录写到盘上，再**直接改字节**，然后同时验证读路径与写路径
 * 返回同一个码——这是「损坏 → 服务不可用」那类缺陷（WP-F §5）的常驻回归面。
 */

test("checksum corruption in the middle fails closed for reads and writes", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const first = await issuePass(harness);

    await issuePass(harness);
    const original = await readRaw(harness);
    const corrupted = original.replace("receipt:agent_method:1", "receipt:agent_method:X");

    assert.notEqual(corrupted, original, "the corruption must actually land on disk");
    await writeFile(harness.file, corrupted, "utf8");

    const verified = await harness.registry.verify({ receiptId: first }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_corrupt");
    }

    // 写路径同样拒绝：损坏的 registry 上不得再追加任何收据。
    const issued = await harness.registry.issue({
      domain: "user_explicit",
      subject: {
        subjectKind: "content_candidate",
        subjectId: "prop-1",
        subjectVersion: "cand-1",
        scope: "ts-unit-fix",
      },
      verifierId: "execution-evidence-recorder",
      generatorId: "learning-user-pipeline",
      issuedAt: "2026-09-13T00:00:00.000Z",
      sourceFactRef: "execution:turn-1",
    });

    assert.equal(issued.ok, false);

    if (!issued.ok) {
      assert.equal(issued.code, "registry_corrupt");
    }

    assert.equal(await readRaw(harness), corrupted);
  } finally {
    await harness.close();
  }
});

test("a torn tail is refused instead of guessed", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);
    const text = await readRaw(harness);

    assert.equal(text.endsWith("\n"), true);
    await writeFile(harness.file, text.slice(0, -1), "utf8");

    const verified = await harness.registry.verify({ receiptId }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_torn_tail");
    }
  } finally {
    await harness.close();
  }
});

test("a sequence gap refuses the whole registry", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const first = await issuePass(harness);

    await issuePass(harness);
    const lines = (await readRaw(harness)).split("\n").filter((entry) => entry !== "");

    assert.equal(lines.length, 2);
    await writeFile(harness.file, `${lines[1] ?? ""}\n`, "utf8");

    const verified = await harness.registry.verify({ receiptId: first }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_corrupt");
      assert.match(verified.message, /sequence gap/);
    }
  } finally {
    await harness.close();
  }
});

test("a correctly checksummed record with an unknown key is still refused", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);
    const decoded = decodeRegistry(await readRaw(harness));

    assert.equal(decoded.ok, true);

    if (!decoded.ok) {
      return;
    }

    const [first] = decoded.events;

    if (first === undefined) {
      return;
    }

    const tampered = { ...first, injectedAuthority: "self-issued" };

    await writeFile(harness.file, `${line(tampered)}\n`, "utf8");

    const verified = await harness.registry.verify({ receiptId }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_corrupt");
      assert.match(verified.message, /unknown keys/);
    }
  } finally {
    await harness.close();
  }
});

test("a hand-written record whose verifier is its generator behind an alias is refused on read-back", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);
    const decoded = decodeRegistry(await readRaw(harness));

    assert.equal(decoded.ok, true);

    if (!decoded.ok) {
      return;
    }

    const [first] = decoded.events;

    if (first === undefined || first.kind !== "receipt_issued") {
      throw new Error("fixture must contain one issued receipt");
    }

    // 校验和正确、形状正确，只有身份带一个尾随空格。若按原始字符串比较
    // （外审 R3 §3 P2-1 的旧行为），这就是两个「不同」身份，会一路通过读取。
    await writeFile(
      harness.file,
      `${line({ ...first, verifierId: "one-agent ", generatorId: "one-agent" })}\n`,
      "utf8",
    );

    const verified = await harness.registry.verify({ receiptId }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "receipt_identity_not_independent");
    }
  } finally {
    await harness.close();
  }
});

test("a blank line between records is corruption, not something to skip", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);

    await issuePass(harness);
    const raw = await readRaw(harness);
    const lines = raw.split("\n");

    // 两行记录之间插入一个空行：行尾换行是记录完整性的一部分，
    // 空白行意味着有人改过文件，必须按损坏拒绝而不是 filter 掉继续读。
    assert.equal(lines.length, 3, "two records plus the trailing terminator");
    await writeFile(harness.file, `${lines[0] ?? ""}\n\n${lines[1] ?? ""}\n`, "utf8");

    const verified = await harness.registry.verify({ receiptId }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_corrupt");
      assert.match(verified.message, /blank line/);
    }

    // 读路径与写路径一致：损坏的 registry 上不得再追加任何收据。
    const issued = await harness.registry.issue({
      domain: "user_explicit",
      subject: {
        subjectKind: "content_candidate",
        subjectId: "prop-1",
        subjectVersion: "cand-1",
        scope: "ts-unit-fix",
      },
      verifierId: "execution-evidence-recorder",
      generatorId: "learning-user-pipeline",
      issuedAt: "2026-09-13T00:00:00.000Z",
      sourceFactRef: "execution:turn-1",
    });

    assert.equal(issued.ok, false);

    if (!issued.ok) {
      assert.equal(issued.code, "registry_corrupt");
    }
  } finally {
    await harness.close();
  }
});

test("an unsupported format version refuses the whole registry", async () => {
  const harness = await openRegistryFileHarness();
  try {
    const receiptId = await issuePass(harness);
    const decoded = decodeRegistry(await readRaw(harness));

    assert.equal(decoded.ok, true);

    if (!decoded.ok) {
      return;
    }

    const [first] = decoded.events;

    if (first === undefined) {
      return;
    }

    await writeFile(harness.file, `${line({ ...first, formatVersion: 99 })}\n`, "utf8");

    const verified = await harness.registry.verify({ receiptId }, EXPECTED);

    assert.equal(verified.ok, false);

    if (!verified.ok) {
      assert.equal(verified.code, "registry_corrupt");
      assert.match(verified.message, /unsupported format version/);
    }
  } finally {
    await harness.close();
  }
});

test("a lock held by another process is reported, not waited out", async () => {
  const harness = await openRegistryFileHarness();
  try {
    await writeFile(`${harness.file}.lock`, `${String(process.pid + 1)}\n`, "utf8");
    const issued = await harness.registry.issue({
      domain: "user_explicit",
      subject: {
        subjectKind: "content_candidate",
        subjectId: "prop-1",
        subjectVersion: "cand-1",
        scope: "ts-unit-fix",
      },
      verifierId: "execution-evidence-recorder",
      generatorId: "learning-user-pipeline",
      issuedAt: "2026-09-13T00:00:00.000Z",
      sourceFactRef: "execution:turn-1",
    });

    assert.equal(issued.ok, false);

    if (!issued.ok) {
      assert.equal(issued.code, "registry_lock_conflict");
    }
  } finally {
    await harness.close();
  }
});

test("same-process reentrancy is reported as a multi-writer defect", async () => {
  const harness = await openRegistryFileHarness();
  try {
    await writeFile(`${harness.file}.lock`, `${String(process.pid)}\n`, "utf8");
    const verified = await harness.registry.verify({ receiptId: "receipt:x" }, EXPECTED);
    assert.equal(verified.ok, false);
    if (!verified.ok) {
      assert.equal(verified.code, "registry_multi_writer");
    }
  } finally {
    await harness.close();
  }
});
