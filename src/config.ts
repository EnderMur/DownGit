import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

/**
 * Where to keep the .env file.
 *
 * - When running as a pkg-bundled binary, `.env` lives next to the executable
 *   so the user can edit it without unpacking anything.
 * - In dev (running `npm run dev` or compiled `dist`), use the current working
 *   directory, which keeps the project-local `.env` working as before.
 */
export function getConfigDir(): string {
  if (isPackaged()) {
    return path.dirname(process.execPath);
  }
  return process.cwd();
}

export function isPackaged(): boolean {
  return Boolean((process as unknown as { pkg?: unknown }).pkg);
}

export function getEnvPath(): string {
  return path.join(getConfigDir(), ".env");
}

/** Load `.env` from the executable directory into `process.env`. */
export function loadEnv(): void {
  const envPath = getEnvPath();
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }
}

/** True if the user has already gone through the token setup at least once. */
export function hasEnvFile(): boolean {
  return fs.existsSync(getEnvPath());
}

/**
 * Save a `GITHUB_TOKEN=...` line to the .env file next to the executable,
 * creating it if it doesn't exist or replacing the existing line if it does.
 * Pass an empty string to record "user chose to skip" so we don't ask again.
 */
export function saveToken(token: string): string {
  const envPath = getEnvPath();
  const line = `GITHUB_TOKEN=${token}`;

  let content = "";
  if (fs.existsSync(envPath)) {
    content = fs.readFileSync(envPath, "utf-8");
    if (/^GITHUB_TOKEN=.*$/m.test(content)) {
      content = content.replace(/^GITHUB_TOKEN=.*$/m, line);
    } else {
      if (content.length && !content.endsWith("\n")) content += "\n";
      content += line + "\n";
    }
  } else {
    content =
      "# DownGit configuration\n" +
      "# Optional: GitHub Personal Access Token (raises rate limit from 60 to 5000 req/hour)\n" +
      "# Create one at https://github.com/settings/tokens (no scopes needed for public repos)\n" +
      line +
      "\n";
  }

  fs.writeFileSync(envPath, content, { mode: 0o600 });
  // Reflect the change in the current process too.
  if (token) process.env.GITHUB_TOKEN = token;
  return envPath;
}

/**
 * Prompt the user for a token with masked input (echoes "*" per character).
 * Resolves with an empty string if the user just presses Enter.
 * Rejects if there is no TTY available.
 */
export function promptHiddenToken(question: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin;
    if (!stdin.isTTY) {
      reject(new Error("Cannot prompt for token: not running in a TTY."));
      return;
    }

    process.stdout.write(question);
    stdin.setRawMode(true);
    stdin.resume();
    stdin.setEncoding("utf-8");

    let buf = "";

    const finish = (value: string) => {
      stdin.removeListener("data", onData);
      stdin.setRawMode(false);
      stdin.pause();
      process.stdout.write("\n");
      resolve(value);
    };

    const onData = (chunk: string) => {
      for (const ch of chunk) {
        if (ch === "\u0003") {
          // Ctrl+C
          stdin.removeListener("data", onData);
          stdin.setRawMode(false);
          process.stdout.write("\n");
          process.exit(130);
        }
        if (ch === "\r" || ch === "\n") {
          finish(buf);
          return;
        }
        if (ch === "\u007f" || ch === "\b") {
          if (buf.length > 0) {
            buf = buf.slice(0, -1);
            process.stdout.write("\b \b");
          }
          continue;
        }
        // Ignore other control characters
        if (ch < " ") continue;
        buf += ch;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}
