import type { CentralRuntimeMaterial } from "./contracts.js";

export const CENTRAL_RESOURCE_WAIT_PREFIX = "central-semantic-recovery-blocked:";
export const CENTRAL_PROVIDER_WAIT_PREFIX = "central-provider-recovery-blocked:";

/** The first typed-hint candidate used the generic prefix. Preserve its active
 * provider condition while new domain resource returns use that same prefix. */
export function isProviderResourceWait(material: CentralRuntimeMaterial): boolean {
  if (material.ref.startsWith(CENTRAL_PROVIDER_WAIT_PREFIX)) return true;
  if (!material.ref.startsWith(CENTRAL_RESOURCE_WAIT_PREFIX)) return false;
  const value: unknown = JSON.parse(material.text);
  return typeof value === "object" && value !== null && "providerRecovery" in value;
}

export function isLocalResourceWait(material: CentralRuntimeMaterial): boolean {
  return material.ref.startsWith(CENTRAL_RESOURCE_WAIT_PREFIX) && !isProviderResourceWait(material);
}
