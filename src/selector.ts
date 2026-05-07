import readline from "node:readline";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GithubClient } from "./github";
import { RepoEntry } from "./types";

const debugLogPath = process.env.DOWNGIT_DEBUG_KEYS
  ? path.join(os.tmpdir(), "downgit-debug.log")
  : null;
if (debugLogPath) {
  try {
    fs.writeFileSync(debugLogPath, `--- DownGit debug log @ ${new Date().toISOString()} ---\n`);
  } catch {
    void 0;
  }
}
function debugLog(line: string): void {
  if (!debugLogPath) return;
  try {
    fs.appendFileSync(debugLogPath, line + "\n");
  } catch {
    void 0;
  }
}

interface SelectorOptions {
  client: GithubClient;
  owner: string;
  repo: string;
  ref: string;
  rootPath: string;
}

interface SelectorState {
  currentPath: string;
  entries: RepoEntry[];
  cursor: number;
  loading: boolean;
  error: string | null;
}

const C = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  gray: "\x1b[90m",
};

export async function runInteractiveSelector(
  opts: SelectorOptions
): Promise<RepoEntry[]> {
  const cache = new Map<string, RepoEntry[]>();
  const selected = new Map<string, RepoEntry>();

  const state: SelectorState = {
    currentPath: opts.rootPath,
    entries: [],
    cursor: 0,
    loading: true,
    error: null,
  };

  let lastRenderedLines = 0;

  async function loadDir(path: string): Promise<void> {
    state.currentPath = path;
    state.loading = true;
    state.error = null;
    render();
    try {
      let entries = cache.get(path);
      if (!entries) {
        entries = await opts.client.listContents(opts.owner, opts.repo, path, opts.ref);
        entries.sort((a, b) => {
          if (a.type !== b.type) return a.type === "dir" ? -1 : 1;
          return a.name.localeCompare(b.name);
        });
        cache.set(path, entries);
      }
      state.entries = entries;
      state.cursor = 0;
      state.loading = false;
      render();
    } catch (err) {
      state.error = (err as Error).message;
      state.loading = false;
      render();
    }
  }

  function isAncestorSelected(path: string): boolean {
    for (const sel of selected.values()) {
      if (sel.type === "dir" && (path === sel.path || path.startsWith(sel.path + "/"))) {
        return true;
      }
    }
    return false;
  }

  function toggleEntry(entry: RepoEntry): void {
    if (selected.has(entry.path)) {
      selected.delete(entry.path);
      return;
    }
    if (entry.type === "dir") {
      for (const key of [...selected.keys()]) {
        if (key.startsWith(entry.path + "/")) selected.delete(key);
      }
    }
    if (isAncestorSelected(entry.path)) return;
    selected.set(entry.path, entry);
  }

  function visibleItems(): Array<{ kind: "up" } | { kind: "entry"; entry: RepoEntry }> {
    const items: Array<{ kind: "up" } | { kind: "entry"; entry: RepoEntry }> = [];
    if (state.currentPath !== "") items.push({ kind: "up" });
    for (const entry of state.entries) items.push({ kind: "entry", entry });
    return items;
  }

  function clearRender(): void {
    if (lastRenderedLines === 0) return;
    for (let i = 0; i < lastRenderedLines; i++) {
      readline.moveCursor(process.stdout, 0, -1);
      readline.clearLine(process.stdout, 0);
    }
    readline.cursorTo(process.stdout, 0);
  }

  function render(): void {
    clearRender();
    const lines: string[] = [];
    const repoLabel = `${opts.owner}/${opts.repo}@${opts.ref}`;
    const pathLabel = state.currentPath
      ? ` ${C.dim}/${C.reset} ${state.currentPath}`
      : ` ${C.dim}/ (repo root)${C.reset}`;
    const header = `${C.bold}${C.cyan}DownGit${C.reset} ${C.dim}|${C.reset} ${repoLabel}${pathLabel}`;
    lines.push(header);
    lines.push(
      `${C.dim}↑/↓ move  ·  → enter dir  ·  ← / Backspace back  ·  Space toggle  ·  Enter download  ·  q quit${C.reset}`
    );
    lines.push("");

    if (state.loading) {
      lines.push(`${C.yellow}Loading…${C.reset}`);
    } else if (state.error) {
      lines.push(`${C.red}${state.error}${C.reset}`);
    } else {
      const items = visibleItems();
      if (items.length === 0) {
        lines.push(`${C.dim}(empty directory)${C.reset}`);
      }
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        const isCursor = i === state.cursor;
        const pointer = isCursor ? `${C.cyan}❯${C.reset}` : " ";

        if (item.kind === "up") {
          lines.push(`${pointer}     ${C.dim}..  (up)${C.reset}`);
          continue;
        }
        const e = item.entry;
        const ancestor = isAncestorSelected(e.path);
        const checked = selected.has(e.path) || ancestor;
        const box = checked
          ? `${C.green}[x]${C.reset}`
          : ancestor
            ? `${C.gray}[x]${C.reset}`
            : "[ ]";
        const icon =
          e.type === "dir" ? `${C.blue}📁${C.reset}` : `${C.magenta}📄${C.reset}`;
        const nameColor = e.type === "dir" ? C.blue : "";
        const sizeStr = e.type === "file" ? ` ${C.dim}${formatSize(e.size)}${C.reset}` : "";
        const name = `${nameColor}${e.name}${e.type === "dir" ? "/" : ""}${C.reset}`;
        lines.push(`${pointer} ${box} ${icon} ${name}${sizeStr}`);
      }
    }
    lines.push("");
    lines.push(
      `${C.dim}Selected: ${C.reset}${C.bold}${selected.size}${C.reset}${C.dim} item(s)${C.reset}`
    );

    process.stdout.write(lines.join("\n") + "\n");
    lastRenderedLines = lines.length;
  }

  return new Promise<RepoEntry[]>((resolve, reject) => {
    if (!process.stdin.isTTY) {
      reject(new Error("Interactive selector requires a TTY (run in a terminal)."));
      return;
    }

    readline.emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();

    let busy = false;

    const cleanup = () => {
      process.stdin.removeListener("keypress", onKeypress);
      process.stdin.setRawMode(false);
      process.stdin.pause();
    };

    const finish = (result: RepoEntry[]) => {
      cleanup();
      resolve(result);
    };

    const fail = (err: Error) => {
      cleanup();
      reject(err);
    };

    const onKeypress = async (
      _str: string,
      key: { name?: string; ctrl?: boolean; sequence?: string }
    ) => {
      if (busy) return;
      if (key.ctrl && key.name === "c") {
        clearRender();
        process.stdout.write(`${C.yellow}Cancelled.${C.reset}\n`);
        finish([]);
        return;
      }

      if (state.loading) return;

      const action = resolveAction(key);
      debugLog(
        `key name=${key.name} seq=${JSON.stringify(key.sequence)} -> ${action} (path="${state.currentPath}")`
      );

      const items = visibleItems();

      switch (action) {
        case "up":
          if (items.length === 0) break;
          state.cursor = (state.cursor - 1 + items.length) % items.length;
          render();
          break;

        case "down":
          if (items.length === 0) break;
          state.cursor = (state.cursor + 1) % items.length;
          render();
          break;

        case "toggle": {
          const item = items[state.cursor];
          if (!item || item.kind === "up") break;
          toggleEntry(item.entry);
          render();
          break;
        }

        case "enter-dir": {
          const item = items[state.cursor];
          if (!item) break;
          if (item.kind === "up") {
            await goUp();
            break;
          }
          if (item.entry.type === "dir") {
            busy = true;
            await loadDir(item.entry.path);
            busy = false;
          }
          break;
        }

        case "go-up":
          await goUp();
          break;

        case "done":
          clearRender();
          finish([...selected.values()]);
          return;

        case "cancel":
          clearRender();
          process.stdout.write(`${C.yellow}Cancelled.${C.reset}\n`);
          finish([]);
          return;
      }
    };

    async function goUp() {
      if (state.currentPath === "") return;
      const parent = state.currentPath.split("/").slice(0, -1).join("/");
      busy = true;
      await loadDir(parent);
      busy = false;
    }

    process.stdin.on("keypress", (str, key) => {
      onKeypress(str, key).catch(fail);
    });

    loadDir(state.currentPath).catch(fail);
  });
}

type Action =
  | "up"
  | "down"
  | "toggle"
  | "enter-dir"
  | "go-up"
  | "done"
  | "cancel"
  | "noop";

function resolveAction(key: { name?: string; sequence?: string }): Action {
  const seq = key.sequence ?? "";
  const csi = /^\x1b(\[|O)?([ABCD])$/.exec(seq);
  if (csi) {
    switch (csi[2]) {
      case "A":
        return "up";
      case "B":
        return "down";
      case "C":
        return "enter-dir";
      case "D":
        return "go-up";
    }
  }

  switch (key.name) {
    case "up":
    case "k":
      return "up";

    case "down":
    case "j":
      return "down";

    case "right":
    case "l":
      return "enter-dir";

    case "left":
    case "h":
    case "backspace":
      return "go-up";

    case "space":
      return "toggle";

    case "return":
    case "d":
      return "done";

    case "q":
      return "cancel";
  }

  return "noop";
}

function formatSize(bytes: number): string {
  if (!bytes) return "";
  const units = ["B", "KB", "MB", "GB"];
  let i = 0;
  let n = bytes;
  while (n >= 1024 && i < units.length - 1) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(n >= 10 || i === 0 ? 0 : 1)} ${units[i]}`;
}
