import { readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dir = join(root, "testdata", "licenses");
const required = [
  "apache-c.PASS",
  "gpl.FAIL",
  "unknown.FAIL",
  "notice-missing.FAIL",
];

const names = new Set(
  readdirSync(dir).filter((name) => name.endsWith(".PASS") || name.endsWith(".FAIL")),
);

let failed = false;

for (const name of required) {
  if (!names.has(name)) {
    console.error(`missing ${name}`);
    failed = true;
    continue;
  }

  const expectPass = name.endsWith(".PASS");
  const expectFail = name.endsWith(".FAIL");
  if (expectPass === expectFail) {
    console.error(`bad suffix ${name}`);
    failed = true;
    continue;
  }

  console.log(`OK ${name} assert=${expectPass ? "PASS" : "FAIL"}`);
}

if (failed) {
  process.exit(1);
}
