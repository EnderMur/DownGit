import fs from "node:fs";
import path from "node:path";
import axios from "axios";
import { getConfigDir, isPackaged } from "./config";

const OWNER = "EnderMur";
const REPO = "DownGit";
const STATE_FILE = ".downgit-state.json";
const UPDATE_CHECK_TTL_MS = 24 * 60 * 60 * 1000;

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface ReleaseInfo {
  tag: string;
  version: string;
  htmlUrl: string;
  publishedAt: string;
  assets: ReleaseAsset[];
  body: string;
}

interface State {
  lastCheckTs?: number;
  lastSeenVersion?: string;
}

export class UpdateError extends Error {}

export async function fetchLatestRelease(token?: string): Promise<ReleaseInfo | null> {
  const headers: Record<string, string> = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "DownGit-Updater",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  try {
    const res = await axios.get(
      `https://api.github.com/repos/${OWNER}/${REPO}/releases/latest`,
      { headers, timeout: 15_000 }
    );
    const data = res.data;
    return {
      tag: data.tag_name,
      version: String(data.tag_name).replace(/^v/i, ""),
      htmlUrl: data.html_url,
      publishedAt: data.published_at,
      assets: data.assets ?? [],
      body: data.body ?? "",
    };
  } catch (err) {
    const e = err as { response?: { status?: number }; message?: string };
    if (e.response?.status === 404) return null;
    throw new UpdateError(`Failed to query GitHub releases: ${e.message ?? "unknown"}`);
  }
}

export function isNewerVersion(remote: string, current: string): boolean {
  const r = parseSemver(remote);
  const c = parseSemver(current);
  if (!r || !c) return false;
  for (let i = 0; i < 3; i++) {
    if (r[i] > c[i]) return true;
    if (r[i] < c[i]) return false;
  }
  return false;
}

function parseSemver(v: string): [number, number, number] | null {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(String(v).trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

export function pickAssetForPlatform(assets: ReleaseAsset[]): ReleaseAsset | null {
  const platform = process.platform;
  const arch = process.arch;

  let best: { asset: ReleaseAsset; score: number } | null = null;

  for (const asset of assets) {
    const name = asset.name.toLowerCase();
    let score = 0;

    if (platform === "win32") {
      if (!name.endsWith(".exe")) continue;
      score += 10;
      if (name.includes("win")) score += 5;
    } else {
      if (name.endsWith(".exe")) continue;
      if (platform === "darwin" && (name.includes("macos") || name.includes("darwin"))) {
        score += 10;
      } else if (platform === "linux" && name.includes("linux")) {
        score += 10;
      } else {
        continue;
      }
    }

    if (name.includes(arch)) score += 4;
    else if (arch === "x64" && (name.includes("amd64") || name.includes("x86_64"))) score += 4;
    else if (arch === "arm64" && name.includes("aarch64")) score += 4;

    if (!best || score > best.score) {
      best = { asset, score };
    }
  }

  return best?.asset ?? null;
}

export async function downloadAsset(
  url: string,
  dest: string,
  onProgress?: (downloaded: number, total: number) => void
): Promise<void> {
  const res = await axios.get(url, {
    responseType: "stream",
    headers: { "User-Agent": "DownGit-Updater" },
    timeout: 120_000,
    maxRedirects: 5,
  });
  const total = Number(res.headers["content-length"] ?? 0);
  let downloaded = 0;

  await new Promise<void>((resolve, reject) => {
    const writer = fs.createWriteStream(dest);
    res.data.on("data", (chunk: Buffer) => {
      downloaded += chunk.length;
      if (onProgress) onProgress(downloaded, total);
    });
    res.data.on("error", (err: Error) => {
      writer.destroy();
      reject(err);
    });
    writer.on("error", reject);
    writer.on("close", resolve);
    res.data.pipe(writer);
  });
}

export function getUpdateTmpPath(): string {
  const dir = isPackaged() ? path.dirname(process.execPath) : process.cwd();
  return path.join(dir, `.downgit-update.${Date.now()}.tmp`);
}

function safeRename(src: string, dst: string): void {
  try {
    fs.renameSync(src, dst);
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code === "EXDEV" || code === "EPERM") {
      fs.copyFileSync(src, dst);
      try {
        fs.unlinkSync(src);
      } catch {
        void 0;
      }
    } else {
      throw err;
    }
  }
}

export function applyUpdate(newBinaryPath: string): void {
  if (!isPackaged()) {
    throw new UpdateError("Auto-update only works on packaged binaries.");
  }
  const currentExe = process.execPath;

  if (process.platform === "win32") {
    const oldPath = currentExe + ".old";
    try {
      fs.unlinkSync(oldPath);
    } catch {
      void 0;
    }
    safeRename(currentExe, oldPath);
    safeRename(newBinaryPath, currentExe);
  } else {
    fs.chmodSync(newBinaryPath, 0o755);
    safeRename(newBinaryPath, currentExe);
  }
}

export function cleanupOldBinary(): void {
  if (!isPackaged()) return;
  const dir = path.dirname(process.execPath);

  if (process.platform === "win32") {
    const oldPath = process.execPath + ".old";
    try {
      if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
    } catch {
      void 0;
    }
  }

  try {
    for (const name of fs.readdirSync(dir)) {
      if (name.startsWith(".downgit-update.") && name.endsWith(".tmp")) {
        try {
          fs.unlinkSync(path.join(dir, name));
        } catch {
          void 0;
        }
      }
    }
  } catch {
    void 0;
  }
}

function getStatePath(): string {
  return path.join(getConfigDir(), STATE_FILE);
}

function readState(): State {
  try {
    return JSON.parse(fs.readFileSync(getStatePath(), "utf-8"));
  } catch {
    return {};
  }
}

function writeState(state: State): void {
  try {
    fs.writeFileSync(getStatePath(), JSON.stringify(state, null, 2));
  } catch {
    void 0;
  }
}

export function shouldCheckUpdate(): boolean {
  if (!isPackaged()) return false;
  const state = readState();
  if (!state.lastCheckTs) return true;
  return Date.now() - state.lastCheckTs > UPDATE_CHECK_TTL_MS;
}

export function recordUpdateCheck(seenVersion?: string): void {
  const state = readState();
  state.lastCheckTs = Date.now();
  if (seenVersion) state.lastSeenVersion = seenVersion;
  writeState(state);
}

export function getReleaseUrl(): string {
  return `https://github.com/${OWNER}/${REPO}/releases/latest`;
}
