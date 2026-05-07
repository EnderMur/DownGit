import fs from "node:fs";
import path from "node:path";
import dotenv from "dotenv";

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

export function loadEnv(): void {
  const envPath = getEnvPath();
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath, quiet: true });
  }
}

export function hasEnvFile(): boolean {
  return fs.existsSync(getEnvPath());
}

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
  if (token) process.env.GITHUB_TOKEN = token;
  return envPath;
}

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
        if (ch < " ") continue;
        buf += ch;
        process.stdout.write("*");
      }
    };

    stdin.on("data", onData);
  });
}
