/**
 * git.ts — Auto-commit layer for the velvet-bond project.
 *
 * Every write operation triggers a git commit with a meaningful message.
 * Commits are prefixed with [auto] for per-operation commits and
 * [session] for session-level summaries.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getProjectRoot } from "./store.js";

const exec = promisify(execFile);

async function git(...args: string[]): Promise<string> {
  const cwd = getProjectRoot();
  try {
    const { stdout } = await exec("git", args, { cwd });
    return stdout.trim();
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string };
    // git diff --cached with no changes exits 0 but empty, that's fine
    // git add with nothing to add can error, that's fine too
    if (error.stderr?.includes("nothing to commit")) return "";
    throw new Error(`git ${args.join(" ")} failed: ${error.stderr ?? error.message}`);
  }
}

/**
 * Initialize git repo if not already initialized.
 * Called once at server startup.
 */
export async function ensureGitRepo(): Promise<void> {
  try {
    await git("rev-parse", "--git-dir");
  } catch {
    await git("init");
    await git("add", "-A");
    await git("commit", "-m", "[auto] Initialize velvet-bond project");
  }
}

/**
 * Stage specific files and commit with a descriptive message.
 * All auto-commits are prefixed with [auto].
 */
export async function autoCommit(
  files: string[],
  message: string
): Promise<string | null> {
  if (files.length === 0) return null;

  // Stage the specific files
  for (const file of files) {
    try {
      await git("add", file);
    } catch {
      // File might have been deleted, try staging the deletion
      try {
        await git("add", "-u", file);
      } catch {
        // Skip files that can't be staged
      }
    }
  }

  // Check if there's anything staged
  const diff = await git("diff", "--cached", "--stat");
  if (!diff) return null;

  // Commit
  const commitMsg = `[auto] ${message}`;
  await git("commit", "-m", commitMsg);

  // Return the short hash
  return git("rev-parse", "--short", "HEAD");
}

/**
 * Create a session-level summary commit.
 */
export async function sessionCommit(message: string): Promise<string | null> {
  // Stage everything
  await git("add", "-A");

  const diff = await git("diff", "--cached", "--stat");
  if (!diff) return null;

  await git("commit", "-m", `[session] ${message}`);
  return git("rev-parse", "--short", "HEAD");
}
