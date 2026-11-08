import { contentHashOf } from "../../../../../control/hash.js";

export function toolAcquisitionPlanVersion(approvalId: string): string {
  return `tool-acquisition-plan_v1_${contentHashOf(approvalId)}`;
}

export function toolAcquisitionInstalledVersion(approvalId: string, installationId: string): string {
  return `tool-acquired_v1_${contentHashOf([approvalId, installationId])}`;
}

export function acquisitionAdaptationJobId(jobId: string, approvalId: string, installationId: string): string {
  return `tool-adaptation_v1_${contentHashOf([jobId, approvalId, installationId])}`;
}

export function acquisitionAdaptationResultId(jobId: string, attempt: number) { return `adaptation-result:${jobId}:${attempt}`; }
