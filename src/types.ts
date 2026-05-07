export type EntryType = "file" | "dir";

export interface RepoEntry {
  type: EntryType;
  name: string;
  path: string;
  size: number;
  download_url: string | null;
  sha: string;
}

export interface ParsedUrl {
  owner: string;
  repo: string;
  ref?: string;
  subPath: string;
}
