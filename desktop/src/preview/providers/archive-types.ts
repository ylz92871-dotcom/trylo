export interface ArchiveEntry {
  id: number;
  name: string;
  size: number;
  directory: boolean;
  encrypted: boolean;
  readable?: boolean;
}
export interface ArchiveContents {
  entries: readonly ArchiveEntry[];
  read: (id: number, signal: AbortSignal) => Promise<Uint8Array>;
}
