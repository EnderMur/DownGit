import fs from "node:fs/promises";
import path from "node:path";
import { GithubClient } from "./github";
import { RepoEntry } from "./types";
import { pMap } from "./concurrency";

interface DownloadOptions {
  client: GithubClient;
  owner: string;
  repo: string;
  ref: string;
  outputDir: string;
  basePath: string;
  concurrency: number;
  onProgress?: (done: number, total: number, file: string) => void;
}

export async function downloadEntries(
  entries: RepoEntry[],
  opts: DownloadOptions
): Promise<{ downloaded: number; skipped: number }> {
  const dirEntries = entries.filter((e) => e.type === "dir");
  const fileEntries = entries.filter((e) => e.type === "file");

  const expandedFromDirs = await Promise.all(
    dirEntries.map((dir) => collectFiles(dir.path, opts))
  );
  const allFiles = fileEntries.concat(...expandedFromDirs);

  let done = 0;
  let downloaded = 0;
  let skipped = 0;

  await pMap(
    allFiles,
    async (file) => {
      try {
        if (!file.download_url) {
          skipped++;
          return;
        }
        const buf = await opts.client.downloadFile(file.download_url);
        const dest = path.join(opts.outputDir, relativePath(file.path, opts.basePath));
        await fs.mkdir(path.dirname(dest), { recursive: true });
        await fs.writeFile(dest, buf);
        downloaded++;
      } finally {
        done++;
        opts.onProgress?.(done, allFiles.length, file.path);
      }
    },
    opts.concurrency
  );

  return { downloaded, skipped };
}

async function collectFiles(
  dirPath: string,
  opts: DownloadOptions
): Promise<RepoEntry[]> {
  const out: RepoEntry[] = [];
  let frontier: string[] = [dirPath];

  while (frontier.length > 0) {
    const listings = await pMap(
      frontier,
      (current) => opts.client.listContents(opts.owner, opts.repo, current, opts.ref),
      opts.concurrency
    );

    const nextFrontier: string[] = [];
    for (const entries of listings) {
      for (const e of entries) {
        if (e.type === "file") out.push(e);
        else nextFrontier.push(e.path);
      }
    }
    frontier = nextFrontier;
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
