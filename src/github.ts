import axios, { AxiosError, AxiosInstance } from "axios";
import { ParsedUrl, RepoEntry } from "./types";

export function parseGithubUrl(input: string): ParsedUrl {
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    throw new Error(`Invalid URL: ${input}`);
  }

  if (!/^(www\.)?github\.com$/i.test(url.hostname)) {
    throw new Error(`Not a github.com URL: ${input}`);
  }

  const segments = url.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    throw new Error(
      "URL must contain at least <owner>/<repo>, e.g. https://github.com/octocat/Hello-World"
    );
  }

  const [owner, repo, kind, ref, ...rest] = segments;

  if (kind && kind !== "tree" && kind !== "blob") {
    throw new Error(`Unsupported URL kind '${kind}'. Expected 'tree' or 'blob'.`);
  }

  return {
    owner,
    repo: repo.replace(/\.git$/, ""),
    ref,
    subPath: rest.join("/"),
  };
}

export class GithubClient {
  private http: AxiosInstance;
  private defaultBranch: string | null = null;

  constructor(private token?: string) {
    const headers: Record<string, string> = {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "DownGit-CLI",
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    this.http = axios.create({
      baseURL: "https://api.github.com",
      headers,
      timeout: 30_000,
    });
  }

  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    if (this.defaultBranch) return this.defaultBranch;
    try {
      const res = await this.http.get(`/repos/${owner}/${repo}`);
      this.defaultBranch = res.data.default_branch as string;
      return this.defaultBranch;
    } catch (err) {
      throw wrapError(err, `Failed to fetch repo ${owner}/${repo}`);
    }
  }

  async listContents(
    owner: string,
    repo: string,
    path: string,
    ref: string
  ): Promise<RepoEntry[]> {
    const url = `/repos/${owner}/${repo}/contents/${encodeURIPath(path)}`;
    try {
      const res = await this.http.get(url, { params: { ref } });
      const data = res.data;
      const items = Array.isArray(data) ? data : [data];
      return items.map(toRepoEntry);
    } catch (err) {
      throw wrapError(err, `Failed to list ${path || "/"} in ${owner}/${repo}@${ref}`);
    }
  }

  async downloadFile(downloadUrl: string): Promise<Buffer> {
    try {
      const res = await axios.get<ArrayBuffer>(downloadUrl, {
        responseType: "arraybuffer",
        headers: this.token
          ? { Authorization: `Bearer ${this.token}`, "User-Agent": "DownGit-CLI" }
          : { "User-Agent": "DownGit-CLI" },
        timeout: 60_000,
      });
      return Buffer.from(res.data);
    } catch (err) {
      throw wrapError(err, `Failed to download ${downloadUrl}`);
    }
  }
}

function toRepoEntry(raw: any): RepoEntry {
  return {
    type: raw.type === "dir" ? "dir" : "file",
    name: raw.name,
    path: raw.path,
    size: raw.size ?? 0,
    download_url: raw.download_url ?? null,
    sha: raw.sha,
  };
}

function encodeURIPath(p: string): string {
  return p
    .split("/")
    .filter(Boolean)
    .map(encodeURIComponent)
    .join("/");
}

function wrapError(err: unknown, prefix: string): Error {
  if (err instanceof AxiosError) {
    const status = err.response?.status;
    const msg = err.response?.data?.message ?? err.message;
    if (status === 403 && /rate limit/i.test(msg)) {
      return new Error(
        `${prefix}: GitHub rate limit exceeded. Set GITHUB_TOKEN in .env to raise the limit.`
      );
    }
    if (status === 404) {
      return new Error(`${prefix}: not found (404). Check the URL/branch.`);
    }
    return new Error(`${prefix}: ${status ?? ""} ${msg}`.trim());
  }
  return new Error(`${prefix}: ${(err as Error).message}`);
}
