# DownGit

Interactive CLI to browse a GitHub repository and download selected files or folders by URL — pick what you want with arrow keys instead of typing paths.

## Features

- Paste any GitHub URL (`/owner/repo`, `/owner/repo/tree/branch`, `/owner/repo/tree/branch/sub/path`, or a `/blob/...` link)
- Browse the repo like a file manager — `↑/↓` to move, `Enter` to enter a folder, `Backspace` to go up
- Multi-select with `Space` (works on both files and whole folders)
- Press `d` to download everything you've checked
- Recursive folder downloads via the GitHub Contents API
- Optional `GITHUB_TOKEN` from `.env` to lift the public 60-req/h rate limit


## Install

```bash
npm install
npm run build
```

For local development without compiling:

```bash
npm run dev -- <github-url>
```

## Build a single .exe (no Node.js required)

```bash
npm run package:win      # → build/downgit.exe   (Windows x64)
npm run package:linux    # → build/downgit-linux (Linux x64)
npm run package:macos    # → build/downgit-macos (macOS x64)
```

The first run downloads a Node 22 base binary into pkg's cache (~30 MB), subsequent runs are fast. The resulting executable is ~55 MB and bundles Node, all dependencies, and the compiled CLI — copy it anywhere and run `downgit.exe <github-url>` without installing Node.

`.env` is **not** baked into the binary — place it next to `downgit.exe` (or set `GITHUB_TOKEN` in the environment / pass `-t <token>`).

## Configuration

Copy `.env.example` to `.env` and add a token if you want a higher rate limit:

```bash
cp .env.example .env
# then edit .env and set GITHUB_TOKEN=...
```

A token is **optional** — public repos work without one, but you're limited to 60 requests/hour.

## Usage

```bash
# Run after build
node dist/index.js https://github.com/octocat/Hello-World

# Or via the bin shortcut after `npm link`
downgit https://github.com/octocat/Hello-World

# By default, files are saved next to the executable in:
#   <app-dir>/downloads/<owner>/<repo>/
# Override with -o:
downgit https://github.com/octocat/Hello-World -o ./somewhere-else

# Pin a specific branch / tag / commit
downgit https://github.com/octocat/Hello-World -r main

# Start in a subfolder
downgit https://github.com/expressjs/express/tree/master/lib

# Override token from CLI
downgit <url> -t ghp_xxx

# Tune parallelism (defaults: 16 with token, 8 without)
downgit <url> -c 24
```

### Performance / parallelism

Both directory listings and file downloads run in parallel up to `--concurrency <n>`:

- **With a GitHub token** the default is **16** — well within the 5000 req/h budget for typical selections.
- **Without a token** the default is **8** — the public 60 req/h limit is tight, and a higher fan-out risks getting `403` mid-download.
- The flag is clamped to `[1, 64]`.

For ~50 files this gives roughly an 8-10× speedup over the previous sequential implementation; for deeper trees the gain compounds because directory listing is also parallelized BFS-style.

If you run `downgit` without a URL it will prompt you to paste one.

## Controls

| Key                       | Action                              |
| ------------------------- | ----------------------------------- |
| `↑` / `↓` (or `k` / `j`)  | Move cursor                         |
| `→`                       | Enter the folder under the cursor   |
| `←` / `Backspace`         | Go up one folder                    |
| `Space`                   | Toggle selection of file or folder  |
| `Enter` (or `d`)          | Done — download everything selected |
| `q` / `Ctrl+C`            | Cancel                              |

If a key doesn't seem to work in your terminal, run with `DOWNGIT_DEBUG_KEYS=1` to print the raw key name + escape sequence next to each keypress, so the binding can be reported and added.

Selecting a folder marks the **whole tree** for download. If you also try to select children of an already-selected folder they are silently ignored (the parent already covers them).

## How paths are saved

The path you initially navigated to becomes the "base". Files keep their layout relative to that base:

- Selecting `src/utils/foo.ts` while standing in `src/utils/` → saved as `foo.ts`
- Selecting the whole folder `src/utils/` while standing at the repo root → saved as `src/utils/foo.ts` (structure preserved)

## Project structure

```
src/
  index.ts        # CLI entry (commander + dotenv)
  github.ts       # URL parser + GitHub Contents API client (axios)
  selector.ts     # Interactive arrow-key TUI on top of node:readline
  downloader.ts   # Recursive expansion + parallel-safe file writer
  types.ts        # Shared type definitions
```

## Limits & Notes

- Files larger than 1 MB are returned by the GitHub Contents API with a `download_url` pointing to `raw.githubusercontent.com`, which the downloader uses directly — no special handling needed.
- Files larger than 100 MB cannot be served via the Contents API and will be skipped (a count is reported at the end).
- The selector requires a TTY — running `downgit` through a non-interactive pipe will fail intentionally.
