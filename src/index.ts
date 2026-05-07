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
} from "./config";

loadEnv();

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
  output: string;
  token?: string;
  ref?: string;
}

async function main() {
  const program = new Command();

  program
    .name("downgit")
    .description(
      "Interactive CLI to browse a GitHub repository and download selected files/folders"
    )
    .argument("[url]", "GitHub repository or folder URL")
    .option("-o, --output <dir>", "output directory", process.cwd())
    .option("-t, --token <token>", "GitHub token (overrides GITHUB_TOKEN env)")
    .option("-r, --ref <branch>", "branch, tag, or commit (overrides URL)")
    .version(require("../package.json").version)
    .action(async (urlArg: string | undefined, opts: CliOptions) => {
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

      const outputDir = path.resolve(opts.output);
      console.log(
        `${C.dim}Downloading ${selected.length} item(s) into${C.reset} ${C.bold}${outputDir}${C.reset}`
      );

      const result = await downloadEntries(selected, {
        client,
        owner: parsed.owner,
        repo: parsed.repo,
        ref,
        outputDir,
        basePath: parsed.subPath,
        onProgress: (current, total, file) => {
          process.stdout.write(
            `\r${C.dim}[${current}/${total}]${C.reset} ${truncateLeft(file, 70)}      `
          );
          if (current === total) process.stdout.write("\n");
        },
      });

      console.log(
        `${C.green}✓ Done.${C.reset} ${result.downloaded} downloaded${
          result.skipped ? `, ${result.skipped} skipped` : ""
        }.`
      );
    });

  await program.parseAsync(process.argv);
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

/**
 * Resolve which GitHub token to use, prompting the user the first time the
 * packaged binary is run and persisting the answer to a `.env` file next to
 * the executable. Subsequent runs reuse the saved value silently.
 *
 * Order of preference:
 *   1. --token CLI flag
 *   2. GITHUB_TOKEN env var (also covers the persisted .env file)
 *   3. Interactive prompt (only when packaged + TTY + no .env yet)
 */
async function ensureToken(cliToken?: string): Promise<string | undefined> {
  if (cliToken) return cliToken;

  const fromEnv = process.env.GITHUB_TOKEN;
  if (fromEnv) return fromEnv;

  // Don't pester the user during dev or when stdin isn't interactive.
  // Once the .env file exists the user already made a choice (token or skip).
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
