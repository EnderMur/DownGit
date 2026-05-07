import fs from "node:fs/promises";
import path from "node:path";
import { GithubClient } from "./github";
import { RepoEntry } from "./types";

interface DownloadOptions {
  client: GithubClient;
  owner: string;
  repo: string;
  ref: string;
  outputDir: string;
  basePath: string;
  onProgress?: (current: number, total: number, file: string) => void;
}

export async function downloadEntries(
  entries: RepoEntry[],
  opts: DownloadOptions
): Promise<{ downloaded: number; skipped: number }> {
  const allFiles: RepoEntry[] = [];
  for (const entry of entries) {
    if (entry.type === "file") {
      allFiles.push(entry);
    } else {
      const files = await collectFiles(entry.path, opts);
      allFiles.push(...files);
    }
  }

  let downloaded = 0;
  let skipped = 0;

  for (let i = 0; i < allFiles.length; i++) {
    const file = allFiles[i];
    opts.onProgress?.(i + 1, allFiles.length, file.path);

    if (!file.download_url) {
      skipped++;
      continue;
    }

    const buf = await opts.client.downloadFile(file.download_url);
    const dest = path.join(opts.outputDir, relativePath(file.path, opts.basePath));
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.writeFile(dest, buf);
    downloaded++;
  }

  return { downloaded, skipped };
}

async function collectFiles(
  dirPath: string,
  opts: DownloadOptions
): Promise<RepoEntry[]> {
  const out: RepoEntry[] = [];
  const queue: string[] = [dirPath];

  while (queue.length) {
    const current = queue.shift()!;
    const entries = await opts.client.listContents(
      opts.owner,
      opts.repo,
      current,
      opts.ref
    );
    for (const e of entries) {
      if (e.type === "file") out.push(e);
      else queue.push(e.path);
    }
  }

  return out;
}

function relativePath(filePath: string, basePath: string): string {
  if (!basePath) return filePath;
  if (filePath === basePath) return path.basename(filePath);
  if (filePath.startsWith(basePath + "/")) {
    return filePath.slice(basePath.length + 1);
  }
  return filePath;
}
