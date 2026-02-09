/**
 * git.ts — Auto-commit layer for Fringe projects.
 *
 * Every write operation triggers a git commit with a meaningful message.
 * Commits are prefixed with [auto] for per-operation commits and
 * [session] for session-level summaries.
 *
 * All functions take a projectRoot path — each project has its own git repo.
 */

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    if (error.stderr?.includes("nothing to commit")) return "";
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}

/**
 * Initialize git repo if not already initialized.
 * Checks that the repo root actually matches the project root —
 * without this, git rev-parse finds a parent repo and we never init.
 */
export async function ensureGitRepo(root: string): Promise<void> {
  try {
    const toplevel = await git(root, "rev-parse", "--show-toplevel");
    const { resolve } = await import("node:path");
    if (resolve(toplevel) !== resolve(root)) {
      throw new Error("parent repo, not ours");
    }
  } catch {
    await git(root, "init");
    await git(root, "add", "-A");
    await git(root, "commit", "-m", "[auto] Initialize project");
  }
}

/**
 * Stage specific files and commit with a descriptive message.
 */
export async function autoCommit(
  root: string,
  files: string[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;

  for (const file of files) {
    try {
      await git(root, "add", file);
    } catch {
      try {
        await git(root, "add", "-u", file);
      } catch {
        // Skip files that can't be staged
      }
    }
  }

  const diff = await git(root, "diff", "--cached", "--stat");
  if (!diff) return null;

  await git(root, "commit", "-m", `[auto] ${message}`);
  return git(root, "rev-parse", "--short", "HEAD");
}

/**
 * Get a version token for a file's current state.
 * Committed files: "g:{shortHash}" (git commit hash)
 * Uncommitted files: "c:{contentHash}" (SHA-256 of content)
 */
export async function getFileVersion(root: string, relPath: string): Promise<string> {
  // Check for uncommitted changes
  const dirty = await git(root, "diff", "--name-only", "--", relPath);
  const untracked = await git(root, "ls-files", "--others", "--exclude-standard", "--", relPath);

  if (dirty || untracked) {
    // File has uncommitted changes — use content hash
    const content = await readFile(join(root, relPath), "utf-8");
    const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
    return `c:${hash}`;
  }

  // Get last commit hash for this file
  try {
    const hash = await git(root, "log", "--format=%h", "-1", "--", relPath);
    if (hash) return `g:${hash}`;
  } catch {
    // No commits yet for this file
  }

  // Fallback: content hash (new file, no commits)
  const content = await readFile(join(root, relPath), "utf-8");
  const hash = createHash("sha256").update(content).digest("hex").slice(0, 8);
  return `c:${hash}`;
}

/**
 * Translate a line number from one file version to another using git diff.
 * Returns the adjusted line number, or null if the line was deleted/rewritten.
 */
export async function translateLineNumber(
  root: string,
  relPath: string,
  fromVersion: string,
  toVersion: string,
  lineNumber: number
): Promise<number | null> {
  // Same version — no translation needed
  if (fromVersion === toVersion) return lineNumber;

  // Can't diff content hashes — caller must re-read
  if (fromVersion.startsWith("c:") || toVersion.startsWith("c:")) return null;

  // Strip g: prefix
  const fromHash = fromVersion.slice(2);
  const toHash = toVersion.slice(2);

  let diffOutput: string;
  try {
    diffOutput = await git(root, "diff", fromHash, toHash, "--", relPath);
  } catch {
    return null; // Can't diff these versions
  }

  if (!diffOutput) return lineNumber; // No changes to this file

  // Parse @@ hunk headers and compute offset
  const hunkRegex = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm;
  let match: RegExpExecArray | null;

  interface Hunk { oldStart: number; oldCount: number; newStart: number; newCount: number }
  const hunks: Hunk[] = [];

  while ((match = hunkRegex.exec(diffOutput)) !== null) {
    hunks.push({
      oldStart: parseInt(match[1]!, 10),
      oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
      newStart: parseInt(match[3]!, 10),
      newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
    });
  }

  // Walk hunks to find where lineNumber maps
  let offset = 0;
  for (const hunk of hunks) {
    const oldEnd = hunk.oldStart + hunk.oldCount;

    if (lineNumber < hunk.oldStart) {
      // Line is before this hunk — apply accumulated offset
      break;
    }

    if (lineNumber >= hunk.oldStart && lineNumber < oldEnd) {
      // Line is inside this hunk — it may have been deleted/modified
      // Check if it's in the deleted portion
      if (hunk.oldCount > 0 && hunk.newCount === 0) {
        // Entire hunk was deleted
        return null;
      }
      // Hunk was modified — can't reliably map
      return null;
    }

    // Line is after this hunk — accumulate offset
    offset += (hunk.newCount - hunk.oldCount);
  }

  return lineNumber + offset;
}

/**
 * Create a session-level summary commit.
 */
export async function sessionCommit(root: string, message: string): Promise<string | null> {
  await git(root, "add", "-A");

  const diff = await git(root, "diff", "--cached", "--stat");
  if (!diff) return null;

  await git(root, "commit", "-m", `[session] ${message}`);
  return git(root, "rev-parse", "--short", "HEAD");
}
