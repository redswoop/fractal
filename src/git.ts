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
 * Create a session-level summary commit.
 */
export async function sessionCommit(root: string, message: string): Promise<string | null> {
  await git(root, "add", "-A");

  const diff = await git(root, "diff", "--cached", "--stat");
  if (!diff) return null;

  await git(root, "commit", "-m", `[session] ${message}`);
  return git(root, "rev-parse", "--short", "HEAD");
}
