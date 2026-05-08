#!/usr/bin/env node
import path from "node:path";
import readline from "node:readline";
import { Command } from "commander";
import { GithubClient, parseGithubUrl } from "./github";
import { runInteractiveSelector } from "./selector";
import { downloadEntries } from "./downloader";
import {
  loadEnv,
  hasEnvFile,
  saveToken,
  promptHiddenToken,
  isPackaged,
  getConfigDir,
} from "./config";
import {
  fetchLatestRelease,
  isNewerVersion,
  pickAssetForPlatform,
  downloadAsset,
  applyUpdate,
  cleanupOldBinary,
  shouldCheckUpdate,
  recordUpdateCheck,
  getReleaseUrl,
  getUpdateTmpPath,
  ReleaseInfo,
} from "./updater";

loadEnv();
cleanupOldBinary();

const C = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
};

interface CliOptions {
  output?: string;
  token?: string;
  ref?: string;
  concurrency?: string;
  updateCheck?: boolean;
}

interface UpdateCommandOptions {
  check?: boolean;
  yes?: boolean;
}

const DEFAULT_CONCURRENCY_AUTH = 16;
const DEFAULT_CONCURRENCY_ANON = 8;
const CURRENT_VERSION = require("../package.json").version as string;

async function main() {
  const program = new Command();

  program
    .name("downgit")
    .description(
      "Interactive CLI to browse a GitHub repository and download selected files/folders"
    )
    .argument("[url]", "GitHub repository or folder URL")
    .option(
      "-o, --output <dir>",
      "output directory (default: <app-dir>/downloads/<owner>/<repo>)"
    )
    .option("-t, --token <token>", "GitHub token (overrides GITHUB_TOKEN env)")
    .option("-r, --ref <branch>", "branch, tag, or commit (overrides URL)")
    .option(
      "-c, --concurrency <n>",
      `parallel downloads/listings (default: ${DEFAULT_CONCURRENCY_AUTH} with token, ${DEFAULT_CONCURRENCY_ANON} without)`
    )
    .option("--no-update-check", "skip the daily background check for new releases")
    .version(CURRENT_VERSION)
    .action(async (urlArg: string | undefined, opts: CliOptions) => {
      const updatePromise =
        opts.updateCheck === false ? null : startBackgroundUpdateCheck();

      const url = urlArg ?? (await promptUrl());
      if (!url) {
        console.error(`${C.red}URL is required.${C.reset}`);
        process.exit(1);
      }

      const parsed = parseGithubUrl(url);
      const token = await ensureToken(opts.token);
      const client = new GithubClient(token);

      const ref =
        opts.ref ?? parsed.ref ?? (await client.getDefaultBranch(parsed.owner, parsed.repo));

      console.log(
        `${C.cyan}${C.bold}DownGit${C.reset} ${C.dim}→${C.reset} ${parsed.owner}/${parsed.repo}@${ref}${
          parsed.subPath ? ` /${parsed.subPath}` : ""
        }${token ? ` ${C.dim}(authenticated)${C.reset}` : ""}`
      );

      const selected = await runInteractiveSelector({
        client,
        owner: parsed.owner,
        repo: parsed.repo,
        ref,
        rootPath: parsed.subPath,
      });

      if (selected.length === 0) {
        console.log(`${C.yellow}Nothing selected. Exiting.${C.reset}`);
        return;
      }

      const outputDir = opts.output
        ? path.resolve(opts.output)
        : path.join(getConfigDir(), "downloads", parsed.owner, parsed.repo);
      const concurrency = resolveConcurrency(opts.concurrency, token);
      console.log(
        `${C.dim}Downloading ${selected.length} item(s) into${C.reset} ${C.bold}${outputDir}${C.reset} ${C.dim}(concurrency: ${concurrency})${C.reset}`
      );

      const result = await downloadEntries(selected, {
        client,
        owner: parsed.owner,
        repo: parsed.repo,
        ref,
        outputDir,
        basePath: parsed.subPath,
        concurrency,
        onProgress: (done, total, file) => {
          process.stdout.write(
            `\r${C.dim}[${done}/${total}]${C.reset} ${truncateLeft(file, 70)}      `
          );
          if (done === total) process.stdout.write("\n");
        },
      });

      console.log(
        `${C.green}✓ Done.${C.reset} ${result.downloaded} downloaded${
          result.skipped ? `, ${result.skipped} skipped` : ""
        }.`
      );

      if (updatePromise) await maybePrintUpdateNotice(updatePromise);
    });

  program
    .command("update")
    .description("Check for and install the latest DownGit release")
    .option("--check", "only check, don't install")
    .option("-y, --yes", "skip confirmation prompt before installing")
    .action(async (opts: UpdateCommandOptions) => {
      await runUpdateCommand(opts);
    });

  await program.parseAsync(process.argv);
}

function startBackgroundUpdateCheck(): Promise<ReleaseInfo | null> | null {
  if (!shouldCheckUpdate()) return null;
  return fetchLatestRelease(process.env.GITHUB_TOKEN)
    .then((release) => {
      recordUpdateCheck(release?.version);
      return release;
    })
    .catch(() => null);
}

async function maybePrintUpdateNotice(
  promise: Promise<ReleaseInfo | null>
): Promise<void> {
  const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), 1500));
  const release = await Promise.race([promise, timeout]);
  if (!release) return;
  if (!isNewerVersion(release.version, CURRENT_VERSION)) return;

  console.log(
    `\n${C.cyan}↑ Update available:${C.reset} ${C.dim}${CURRENT_VERSION} →${C.reset} ${C.bold}${release.version}${C.reset} ${C.dim}· run${C.reset} ${C.bold}downgit update${C.reset} ${C.dim}to install${C.reset}`
  );
}

async function runUpdateCommand(opts: UpdateCommandOptions): Promise<void> {
  if (!isPackaged()) {
    console.error(
      `${C.red}Auto-update only works on packaged binaries.${C.reset} ${C.dim}Run via .exe / Linux/macOS binary, not 'npm run dev'.${C.reset}`
    );
    process.exit(1);
  }

  console.log(`${C.dim}Checking ${getReleaseUrl()} ...${C.reset}`);

  const release = await fetchLatestRelease(process.env.GITHUB_TOKEN);
  recordUpdateCheck(release?.version);

  if (!release) {
    console.log(`${C.yellow}No releases found yet.${C.reset}`);
    return;
  }

  console.log(
    `Current: ${C.bold}${CURRENT_VERSION}${C.reset}   Latest: ${C.bold}${release.version}${C.reset}   ${C.dim}(${release.tag})${C.reset}`
  );

  if (!isNewerVersion(release.version, CURRENT_VERSION)) {
    console.log(`${C.green}✓ You are on the latest version.${C.reset}`);
    return;
  }

  if (opts.check) {
    console.log(
      `${C.cyan}A newer version is available.${C.reset} ${C.dim}Run${C.reset} ${C.bold}downgit update${C.reset} ${C.dim}to install.${C.reset}`
    );
    return;
  }

  const asset = pickAssetForPlatform(release.assets);
  if (!asset) {
    console.error(
      `${C.red}No matching binary found for ${process.platform}/${process.arch}.${C.reset}`
    );
    console.error(`${C.dim}See ${release.htmlUrl} and download manually.${C.reset}`);
    process.exit(1);
  }

  if (!opts.yes && process.stdin.isTTY) {
    const confirmed = await confirm(
      `Install ${C.bold}${asset.name}${C.reset} (${formatBytes(asset.size)})? [Y/n] `
    );
    if (!confirmed) {
      console.log(`${C.yellow}Cancelled.${C.reset}`);
      return;
    }
  }

  const tmpPath = getUpdateTmpPath();
  try {
    let lastReported = 0;
    await downloadAsset(asset.browser_download_url, tmpPath, (downloaded, total) => {
      const now = Date.now();
      if (now - lastReported < 100 && downloaded !== total) return;
      lastReported = now;
      const pct = total ? ((downloaded / total) * 100).toFixed(0).padStart(3) : "  ?";
      const sizes = total
        ? `${formatBytes(downloaded)}/${formatBytes(total)}`
        : formatBytes(downloaded);
      process.stdout.write(`\r${C.dim}Downloading${C.reset} ${pct}%  ${sizes}      `);
    });
    process.stdout.write("\n");

    applyUpdate(tmpPath);

    console.log(
      `${C.green}✓ Updated to ${release.version}.${C.reset} ${C.dim}Re-run downgit to use the new version.${C.reset}`
    );
  } catch (err) {
    try {
      const fs = require("node:fs");
      if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
    } catch {
      void 0;
    }
    throw err;
  }
}

function confirm(prompt: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(prompt, (answer) => {
      rl.close();
      const a = answer.trim().toLowerCase();
      resolve(a === "" || a === "y" || a === "yes");
    });
  });
}

function formatBytes(bytes: number): string {
  if (!bytes) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}

function resolveConcurrency(flag: string | undefined, token: string | undefined): number {
  if (flag !== undefined) {
    const parsed = Number.parseInt(flag, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
      console.error(`${C.red}Invalid --concurrency value: ${flag}${C.reset}`);
      process.exit(1);
    }
    return Math.min(parsed, 64);
  }
  return token ? DEFAULT_CONCURRENCY_AUTH : DEFAULT_CONCURRENCY_ANON;
}

function promptUrl(): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question("GitHub URL: ", (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function ensureToken(cliToken?: string): Promise<string | undefined> {
  if (cliToken) return cliToken;

  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;

  if (!isPackaged() || !process.stdin.isTTY || hasEnvFile()) {
    return undefined;
  }

  console.log(
    `${C.bold}${C.cyan}First-time setup${C.reset}\n` +
      `${C.dim}DownGit can use a GitHub Personal Access Token to lift the public${C.reset}\n` +
      `${C.dim}rate limit (60 → 5000 requests/hour). It is optional.${C.reset}\n` +
      `${C.dim}Create one at https://github.com/settings/tokens (no scopes needed for public repos).${C.reset}\n` +
      `${C.dim}Press Enter to skip.${C.reset}\n`
  );

  const token = (await promptHiddenToken("GitHub token: ")).trim();
  const savedTo = saveToken(token);

  if (token) {
    console.log(`${C.green}✓ Token saved to${C.reset} ${savedTo}\n`);
  } else {
    console.log(
      `${C.yellow}No token set.${C.reset} ${C.dim}Edit ${savedTo} later to add one.${C.reset}\n`
    );
  }

  return token || undefined;
}

function truncateLeft(str: string, max: number): string {
  if (str.length <= max) return str.padEnd(max);
  return "…" + str.slice(-(max - 1));
}

main().catch((err) => {
  console.error(`${C.red}${(err as Error).message}${C.reset}`);
  process.exit(1);
});
