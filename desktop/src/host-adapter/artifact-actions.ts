/** Desktop file actions. The native adapter owns path checks and IPC. */
export interface ExternalApplication {
  readonly name: string;
  readonly identifier: string;
}

export interface ArtifactHost {
  quickLookFile?(filePath: string): Promise<void>;
  openFile(filePath: string): Promise<void>;
  openFileWithApp(filePath: string, application: ExternalApplication): Promise<void>;
  showInFolder(filePath: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
}
