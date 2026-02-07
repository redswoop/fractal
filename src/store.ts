/**
 * store.ts — File-system operations for the velvet-bond project.
 *
 * Pure read/write against the directory structure defined in claude.md.
 * No MCP awareness, no git awareness. Just files.
 */

import { readFile, writeFile, readdir, rename, mkdir, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Project root — resolved once at startup
// ---------------------------------------------------------------------------

const PROJECT_ROOT = resolve(
  process.env["FRINGE_PROJECT_ROOT"] ?? join(import.meta.dirname, "..", "velvet-bond")
);

export function getProjectRoot(): string {
  return PROJECT_ROOT;
}

// ---------------------------------------------------------------------------
// Low-level helpers
// ---------------------------------------------------------------------------

async function readJson<T = unknown>(path: string): Promise<T> {
  const raw = await readFile(path, "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJson(path: string, data: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

async function readMd(path: string): Promise<string> {
  return readFile(path, "utf-8");
}

async function writeMd(path: string, content: string): Promise<void> {
  await writeFile(path, content, "utf-8");
}

// ---------------------------------------------------------------------------
// Beat prose parsing
// ---------------------------------------------------------------------------

interface ParsedBeat {
  id: string;
  label: string;
  prose: string;
}

function parseBeats(markdown: string): ParsedBeat[] {
  const beatRegex = /<!--\s*beat:(\S+)\s*\|\s*(.+?)\s*-->/g;
  const beats: ParsedBeat[] = [];
  let match: RegExpExecArray | null;
  const matches: { id: string; label: string; index: number; end: number }[] = [];

  while ((match = beatRegex.exec(markdown)) !== null) {
    matches.push({
      id: match[1]!,
      label: match[2]!,
      index: match.index,
      end: match.index + match[0].length,
    });
  }

  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.index : markdown.length;
    // Find end: either next beat marker, or <!-- /chapter -->, or EOF
    let proseEnd = nextStart;
    const chapterEnd = markdown.indexOf("<!-- /chapter -->", current.end);
    if (chapterEnd !== -1 && chapterEnd < proseEnd) {
      proseEnd = chapterEnd;
    }
    const prose = markdown.slice(current.end, proseEnd).trim();
    beats.push({ id: current.id, label: current.label, prose });
  }

  return beats;
}

function replaceOrInsertBeatProse(
  markdown: string,
  beatId: string,
  newProse: string
): string {
  const beatRegex = new RegExp(
    `(<!--\\s*beat:${beatId}\\s*\\|[^>]*-->)([\\s\\S]*?)(?=<!--\\s*(?:beat:\\S|/chapter))`
  );
  const match = beatRegex.exec(markdown);
  if (match) {
    return markdown.replace(beatRegex, `$1\n${newProse}\n\n`);
  }
  // Beat marker doesn't exist — shouldn't happen if structure is maintained
  throw new Error(`Beat marker for ${beatId} not found in chapter file`);
}

function addBeatMarker(
  markdown: string,
  beatId: string,
  label: string,
  afterBeatId?: string
): string {
  const marker = `<!-- beat:${beatId} | ${label} -->`;
  if (afterBeatId) {
    // Insert after the specified beat's prose section
    const afterRegex = new RegExp(
      `(<!--\\s*beat:${afterBeatId}\\s*\\|[^>]*-->[\\s\\S]*?)(?=<!--\\s*(?:beat:\\S|/chapter))`
    );
    const match = afterRegex.exec(markdown);
    if (match) {
      const insertPoint = match.index + match[0].length;
      return markdown.slice(0, insertPoint) + `${marker}\n\n` + markdown.slice(insertPoint);
    }
  }
  // Insert before <!-- /chapter --> or at end
  const chapterEnd = markdown.indexOf("<!-- /chapter -->");
  if (chapterEnd !== -1) {
    return markdown.slice(0, chapterEnd) + `${marker}\n\n` + markdown.slice(chapterEnd);
  }
  return markdown + `\n${marker}\n\n<!-- /chapter -->\n`;
}

function removeBeatMarker(markdown: string, beatId: string): { updated: string; removedProse: string } {
  const beatRegex = new RegExp(
    `<!--\\s*beat:${beatId}\\s*\\|[^>]*-->([\\s\\S]*?)(?=<!--\\s*(?:beat:\\S|/chapter)|$)`
  );
  const match = beatRegex.exec(markdown);
  const removedProse = match ? match[1]!.trim() : "";
  const updated = markdown.replace(beatRegex, "");
  return { updated, removedProse };
}

// ---------------------------------------------------------------------------
// Project-level reads
// ---------------------------------------------------------------------------

export interface ProjectData {
  title: string;
  subtitle: string | null;
  logline: string;
  status: string;
  themes: string[];
  parts: string[];
}

export async function getProject(): Promise<ProjectData> {
  return readJson<ProjectData>(join(PROJECT_ROOT, "project.json"));
}

// ---------------------------------------------------------------------------
// Part-level reads
// ---------------------------------------------------------------------------

export interface PartData {
  title: string;
  summary: string;
  arc: string;
  status: string;
  chapters: string[];
}

export async function getPart(partId: string): Promise<PartData> {
  return readJson<PartData>(join(PROJECT_ROOT, "parts", partId, "part.json"));
}

// ---------------------------------------------------------------------------
// Chapter-level reads
// ---------------------------------------------------------------------------

export interface BeatMeta {
  id: string;
  label: string;
  summary: string;
  status: string;
  dirty_reason: string | null;
  characters: string[];
  depends_on: string[];
  depended_by: string[];
}

export interface ChapterMeta {
  title: string;
  summary: string;
  pov: string;
  location: string;
  timeline_position: string;
  status: string;
  beats: BeatMeta[];
}

export async function getChapterMeta(partId: string, chapterId: string): Promise<ChapterMeta> {
  return readJson<ChapterMeta>(
    join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`)
  );
}

export async function getChapterProse(partId: string, chapterId: string): Promise<string> {
  return readMd(join(PROJECT_ROOT, "parts", partId, `${chapterId}.md`));
}

export async function getBeatProse(
  partId: string,
  chapterId: string,
  beatId: string
): Promise<{ label: string; prose: string }> {
  const markdown = await getChapterProse(partId, chapterId);
  const beats = parseBeats(markdown);
  const beat = beats.find((b) => b.id === beatId);
  if (!beat) throw new Error(`Beat ${beatId} not found in ${partId}/${chapterId}`);
  return { label: beat.label, prose: beat.prose };
}

// ---------------------------------------------------------------------------
// Canon reads
// ---------------------------------------------------------------------------

export async function getCanon(type: string, id: string): Promise<{ content: string; meta: unknown }> {
  const basePath = join(PROJECT_ROOT, "canon", type);
  const content = await readMd(join(basePath, `${id}.md`));
  let meta: unknown = null;
  const metaPath = join(basePath, `${id}.meta.json`);
  if (existsSync(metaPath)) {
    meta = await readJson(metaPath);
  }
  return { content, meta };
}

export async function listCanon(type: string): Promise<string[]> {
  const dir = join(PROJECT_ROOT, "canon", type);
  if (!existsSync(dir)) return [];
  const files = await readdir(dir);
  return files
    .filter((f) => f.endsWith(".md"))
    .map((f) => f.replace(/\.md$/, ""));
}

// ---------------------------------------------------------------------------
// Scratch reads
// ---------------------------------------------------------------------------

export interface ScratchItem {
  file: string;
  note: string;
  characters: string[];
  mood: string;
  potential_placement: string | null;
  created: string;
}

export interface ScratchIndex {
  items: ScratchItem[];
}

export async function getScratchIndex(): Promise<ScratchIndex> {
  return readJson<ScratchIndex>(join(PROJECT_ROOT, "scratch", "scratch.json"));
}

export async function getScratch(filename: string): Promise<string> {
  return readMd(join(PROJECT_ROOT, "scratch", filename));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(
  query: string,
  scope?: "prose" | "canon" | "scratch"
): Promise<{ file: string; line: number; text: string }[]> {
  const results: { file: string; line: number; text: string }[] = [];
  const queryLower = query.toLowerCase();

  async function searchDir(dir: string, prefix: string) {
    if (!existsSync(dir)) return;
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        await searchDir(fullPath, `${prefix}${entry.name}/`);
      } else if (entry.name.endsWith(".md")) {
        const content = await readFile(fullPath, "utf-8");
        const lines = content.split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(queryLower)) {
            results.push({
              file: `${prefix}${entry.name}`,
              line: i + 1,
              text: lines[i]!,
            });
          }
        }
      }
    }
  }

  if (!scope || scope === "prose") {
    await searchDir(join(PROJECT_ROOT, "parts"), "parts/");
  }
  if (!scope || scope === "canon") {
    await searchDir(join(PROJECT_ROOT, "canon"), "canon/");
  }
  if (!scope || scope === "scratch") {
    await searchDir(join(PROJECT_ROOT, "scratch"), "scratch/");
  }

  return results;
}

// ---------------------------------------------------------------------------
// Dirty nodes
// ---------------------------------------------------------------------------

export interface DirtyNode {
  ref: string;
  status: string;
  dirty_reason: string | null;
}

export async function getDirtyNodes(): Promise<DirtyNode[]> {
  const project = await getProject();
  const dirty: DirtyNode[] = [];

  for (const partId of project.parts) {
    let part: PartData;
    try {
      part = await getPart(partId);
    } catch {
      continue;
    }
    if (part.status === "dirty" || part.status === "conflict") {
      dirty.push({ ref: partId, status: part.status, dirty_reason: null });
    }
    for (const chapterId of part.chapters) {
      let meta: ChapterMeta;
      try {
        meta = await getChapterMeta(partId, chapterId);
      } catch {
        continue;
      }
      if (meta.status === "dirty" || meta.status === "conflict") {
        dirty.push({ ref: `${partId}/${chapterId}`, status: meta.status, dirty_reason: null });
      }
      for (const beat of meta.beats) {
        if (beat.status === "dirty" || beat.status === "conflict") {
          dirty.push({
            ref: `${partId}/${chapterId}:${beat.id}`,
            status: beat.status,
            dirty_reason: beat.dirty_reason,
          });
        }
      }
    }
  }

  return dirty;
}

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

export interface WriteResult {
  path: string;
  description: string;
}

export async function updateProject(patch: Partial<ProjectData>): Promise<WriteResult> {
  const current = await getProject();
  const updated = { ...current, ...patch };
  const path = join(PROJECT_ROOT, "project.json");
  await writeJson(path, updated);
  return { path, description: "Updated project.json" };
}

export async function updatePart(partId: string, patch: Partial<PartData>): Promise<WriteResult> {
  const current = await getPart(partId);
  const updated = { ...current, ...patch };
  const path = join(PROJECT_ROOT, "parts", partId, "part.json");
  await writeJson(path, updated);
  return { path, description: `Updated ${partId}/part.json` };
}

export async function updateChapterMeta(
  partId: string,
  chapterId: string,
  patch: Partial<ChapterMeta>
): Promise<WriteResult> {
  const current = await getChapterMeta(partId, chapterId);
  const updated = { ...current, ...patch };
  // If beats are in the patch, merge them intelligently
  if (patch.beats) {
    updated.beats = patch.beats;
  }
  const path = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(path, updated);
  return { path, description: `Updated ${partId}/${chapterId}.meta.json` };
}

export async function writeBeatProse(
  partId: string,
  chapterId: string,
  beatId: string,
  content: string
): Promise<WriteResult> {
  const mdPath = join(PROJECT_ROOT, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const updated = replaceOrInsertBeatProse(markdown, beatId, content);
  await writeMd(mdPath, updated);
  return { path: mdPath, description: `Updated prose for ${partId}/${chapterId}:${beatId}` };
}

export async function addBeat(
  partId: string,
  chapterId: string,
  beatDef: BeatMeta,
  afterBeatId?: string
): Promise<WriteResult[]> {
  // Update the chapter prose file with a new beat marker
  const mdPath = join(PROJECT_ROOT, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const updated = addBeatMarker(markdown, beatDef.id, beatDef.label, afterBeatId);
  await writeMd(mdPath, updated);

  // Update the meta file
  const meta = await getChapterMeta(partId, chapterId);
  if (afterBeatId) {
    const idx = meta.beats.findIndex((b) => b.id === afterBeatId);
    meta.beats.splice(idx + 1, 0, beatDef);
  } else {
    meta.beats.push(beatDef);
  }
  const metaPath = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(metaPath, meta);

  return [
    { path: mdPath, description: `Added beat marker ${beatDef.id} to ${chapterId}.md` },
    { path: metaPath, description: `Added beat ${beatDef.id} to ${chapterId}.meta.json` },
  ];
}

export async function removeBeat(
  partId: string,
  chapterId: string,
  beatId: string
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  // Remove from prose file, capture removed prose
  const mdPath = join(PROJECT_ROOT, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const { updated, removedProse } = removeBeatMarker(markdown, beatId);
  await writeMd(mdPath, updated);
  results.push({ path: mdPath, description: `Removed beat ${beatId} from ${chapterId}.md` });

  // Remove from meta file
  const meta = await getChapterMeta(partId, chapterId);
  meta.beats = meta.beats.filter((b) => b.id !== beatId);
  const metaPath = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(metaPath, meta);
  results.push({ path: metaPath, description: `Removed beat ${beatId} from ${chapterId}.meta.json` });

  // Move removed prose to scratch if non-empty
  if (removedProse) {
    const scratchFile = `removed-${chapterId}-${beatId}.md`;
    const scratchPath = join(PROJECT_ROOT, "scratch", scratchFile);
    await writeMd(scratchPath, `# Removed beat: ${partId}/${chapterId}:${beatId}\n\n${removedProse}\n`);

    const scratchIndex = await getScratchIndex();
    scratchIndex.items.push({
      file: scratchFile,
      note: `Prose removed from ${partId}/${chapterId}:${beatId}`,
      characters: [],
      mood: "",
      potential_placement: null,
      created: new Date().toISOString().split("T")[0]!,
    });
    await writeJson(join(PROJECT_ROOT, "scratch", "scratch.json"), scratchIndex);
    results.push({ path: scratchPath, description: `Moved removed prose to scratch/${scratchFile}` });
  }

  return results;
}

export async function markDirty(nodeRef: string, reason: string): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  // nodeRef can be: "part-01", "part-01/chapter-01", "part-01/chapter-01:b01"
  const parts = nodeRef.split("/");
  const partId = parts[0]!;

  if (parts.length === 1) {
    // Part-level
    const part = await getPart(partId);
    part.status = "dirty";
    const path = join(PROJECT_ROOT, "parts", partId, "part.json");
    await writeJson(path, part);
    results.push({ path, description: `Marked ${partId} dirty: ${reason}` });
  } else {
    const chapterBeat = parts[1]!;
    const [chapterId, beatId] = chapterBeat.split(":");

    if (!beatId) {
      // Chapter-level
      const meta = await getChapterMeta(partId, chapterId!);
      meta.status = "dirty";
      const path = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
      await writeJson(path, meta);
      results.push({ path, description: `Marked ${partId}/${chapterId} dirty: ${reason}` });
    } else {
      // Beat-level
      const meta = await getChapterMeta(partId, chapterId!);
      const beat = meta.beats.find((b) => b.id === beatId);
      if (beat) {
        beat.status = "dirty";
        beat.dirty_reason = reason;
        const path = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
        await writeJson(path, meta);
        results.push({ path, description: `Marked ${partId}/${chapterId}:${beatId} dirty: ${reason}` });
      }
    }
  }

  return results;
}

export async function markClean(nodeRef: string): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const parts = nodeRef.split("/");
  const partId = parts[0]!;

  if (parts.length === 1) {
    const part = await getPart(partId);
    part.status = "clean";
    const path = join(PROJECT_ROOT, "parts", partId, "part.json");
    await writeJson(path, part);
    results.push({ path, description: `Marked ${partId} clean` });
  } else {
    const chapterBeat = parts[1]!;
    const [chapterId, beatId] = chapterBeat.split(":");

    if (!beatId) {
      const meta = await getChapterMeta(partId, chapterId!);
      meta.status = "clean";
      const path = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
      await writeJson(path, meta);
      results.push({ path, description: `Marked ${partId}/${chapterId} clean` });
    } else {
      const meta = await getChapterMeta(partId, chapterId!);
      const beat = meta.beats.find((b) => b.id === beatId);
      if (beat) {
        beat.status = "written";
        beat.dirty_reason = null;
        const path = join(PROJECT_ROOT, "parts", partId, `${chapterId}.meta.json`);
        await writeJson(path, meta);
        results.push({ path, description: `Marked ${partId}/${chapterId}:${beatId} clean` });
      }
    }
  }

  return results;
}

export async function updateCanon(
  type: string,
  id: string,
  content: string,
  meta?: unknown
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const basePath = join(PROJECT_ROOT, "canon", type);

  // Ensure directory exists
  if (!existsSync(basePath)) {
    await mkdir(basePath, { recursive: true });
  }

  const mdPath = join(basePath, `${id}.md`);
  await writeMd(mdPath, content);
  results.push({ path: mdPath, description: `Updated canon/${type}/${id}.md` });

  if (meta) {
    const metaPath = join(basePath, `${id}.meta.json`);
    await writeJson(metaPath, meta);
    results.push({ path: metaPath, description: `Updated canon/${type}/${id}.meta.json` });
  }

  return results;
}

export async function addScratch(
  filename: string,
  content: string,
  note: string,
  characters: string[] = [],
  mood: string = "",
  potentialPlacement: string | null = null
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];
  const scratchPath = join(PROJECT_ROOT, "scratch", filename);
  await writeMd(scratchPath, content);
  results.push({ path: scratchPath, description: `Created scratch/${filename}` });

  const index = await getScratchIndex();
  index.items.push({
    file: filename,
    note,
    characters,
    mood,
    potential_placement: potentialPlacement,
    created: new Date().toISOString().split("T")[0]!,
  });
  const indexPath = join(PROJECT_ROOT, "scratch", "scratch.json");
  await writeJson(indexPath, index);
  results.push({ path: indexPath, description: "Updated scratch index" });

  return results;
}

export async function promoteScratch(
  filename: string,
  targetPartId: string,
  targetChapterId: string,
  targetBeatId: string
): Promise<WriteResult[]> {
  const results: WriteResult[] = [];

  // Read the scratch content
  const content = await getScratch(filename);

  // Write it as beat prose
  const writeResult = await writeBeatProse(targetPartId, targetChapterId, targetBeatId, content);
  results.push(writeResult);

  // Remove from scratch index (but keep the file — git has history)
  const index = await getScratchIndex();
  index.items = index.items.filter((item) => item.file !== filename);
  const indexPath = join(PROJECT_ROOT, "scratch", "scratch.json");
  await writeJson(indexPath, index);
  results.push({ path: indexPath, description: `Removed ${filename} from scratch index` });

  // Rename the scratch file to indicate it was promoted
  const oldPath = join(PROJECT_ROOT, "scratch", filename);
  const newPath = join(PROJECT_ROOT, "scratch", `_promoted_${filename}`);
  await rename(oldPath, newPath);
  results.push({
    path: newPath,
    description: `Promoted scratch/${filename} → ${targetPartId}/${targetChapterId}:${targetBeatId}`,
  });

  return results;
}
