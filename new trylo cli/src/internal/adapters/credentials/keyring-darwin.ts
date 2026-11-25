import { spawnSync } from "node:child_process";
import { KEYRING_SERVICE, type KeyringAvailability, type OsKeyringDriver } from "../../credentials/keyring-driver.js";

const SECURITY = "/usr/bin/security";
const ITEM_NOT_FOUND = 44;
const BLOB_PREFIX = "trylo1:";

export function createDarwinKeychainDriver(keychainPath?: string): OsKeyringDriver {
  let keychain: string | undefined;
  let availability: KeyringAvailability | undefined;

  function security(args: readonly string[], input?: string) {
    return spawnSync(SECURITY, args, { encoding: "utf8", input, timeout: 5_000, maxBuffer: 256 * 1024 });
  }

  function probe(): KeyringAvailability {
    if (availability !== undefined) return availability;
    const result = keychainPath === undefined
      ? security(["default-keychain", "-d", "user"])
      : security(["show-keychain-info", keychainPath]);
    const selected = keychainPath ?? result.stdout?.trim().match(/^"([^"\r\n]+)"$/)?.[1];
    if (result.status === 0 && selected !== undefined && !/[\0\r\n]/.test(selected)) {
      keychain = selected;
      availability = { available: true };
    } else {
      availability = { available: false, reason: "the macOS user Keychain could not be selected" };
    }
    return availability;
  }

  function itemArgs(target: string): [string, string, string, string, string] {
    if (!probe().available || keychain === undefined) throw new Error("the macOS Keychain is unavailable");
    return ["-s", KEYRING_SERVICE, "-a", target, keychain];
  }

  function read(target: string): string | undefined {
    const result = security(["find-generic-password", "-w", ...itemArgs(target)]);
    if (result.status === ITEM_NOT_FOUND) return undefined;
    if (result.status !== 0) throw new Error(`macOS Keychain read failed (status ${result.status ?? "unknown"})`);
    const encoded = result.stdout.trimEnd();
    const payload = encoded.slice(BLOB_PREFIX.length);
    const blob = Buffer.from(payload, "base64");
    if (!encoded.startsWith(BLOB_PREFIX) || blob.toString("base64") !== payload) {
      throw new Error("macOS Keychain item has an invalid format");
    }
    return blob.toString("utf8");
  }

  return {
    id: "darwin-keychain",
    probe,
    read,
    write(target, blob) {
      const item = itemArgs(target);
      const encoded = BLOB_PREFIX + Buffer.from(blob, "utf8").toString("base64");
      // The interactive command is supplied over stdin so the blob stays off argv.
      // The security REPL exit status alone does not confirm its command ran.
      if (/[\0\r\n]/.test(target)) throw new Error("invalid macOS Keychain account");
      const command = ["add-generic-password", "-U", "-w", encoded, ...item];
      const result = security(["-i"], command.map(arg => JSON.stringify(arg)).join(" ") + "\n");
      if (result.status !== 0 || read(target) !== blob) throw new Error("macOS Keychain write could not be verified");
    },
    remove(target) {
      const result = security(["delete-generic-password", ...itemArgs(target)]);
      if (result.status !== 0 && result.status !== ITEM_NOT_FOUND) {
        throw new Error(`macOS Keychain delete failed (status ${result.status ?? "unknown"})`);
      }
    },
  };
}
