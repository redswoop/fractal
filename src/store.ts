/**
 * store.ts — File-system operations for Fringe projects.
 *
 * Pure read/write against the directory structure defined in claude.md.
 * No MCP awareness, no git awareness. Just files.
 *
 * Multi-project: FRINGE_PROJECTS_ROOT contains one subdirectory per project.
 * Every function takes a projectId as the first parameter.
 */

import { readFile, writeFile, readdir, rename, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Projects root — resolved once at startup
// Test projects (IDs starting with _) route to a separate directory.
// ---------------------------------------------------------------------------

const PROJECTS_ROOT = resolve(
  process.env["FRINGE_PROJECTS_ROOT"] ?? join(import.meta.dirname, "..", "projects")
);

const TEST_PROJECTS_ROOT = resolve(
  process.env["FRINGE_TEST_PROJECTS_ROOT"] ?? join(import.meta.dirname, "..", "test-projects")
);

function isTestProject(projectId: string): boolean {
  return projectId.startsWith("_");
}

function resolveProjectsRoot(projectId: string): string {
  return isTestProject(projectId) ? TEST_PROJECTS_ROOT : PROJECTS_ROOT;
}

export function getProjectsRoot(): string {
  return PROJECTS_ROOT;
}

export function getTestProjectsRoot(): string {
  return TEST_PROJECTS_ROOT;
}

export function projectRoot(projectId: string): string {
  if (!/^_?[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error(`Invalid project ID: "${projectId}". Use lowercase alphanumeric, hyphens, and optional _ prefix for test projects.`);
  }
  const root = join(resolveProjectsRoot(projectId), projectId);
  if (!existsSync(root)) {
    throw new Error(`Project "${projectId}" not found at ${root}`);
  }
  return root;
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
    const afterRegex = new RegExp(
      `(<!--\\s*beat:${afterBeatId}\\s*\\|[^>]*-->[\\s\\S]*?)(?=<!--\\s*(?:beat:\\S|/chapter))`
    );
    const match = afterRegex.exec(markdown);
    if (match) {
      const insertPoint = match.index + match[0].length;
      return markdown.slice(0, insertPoint) + `${marker}\n\n` + markdown.slice(insertPoint);
    }
  }
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
// Project management
// ---------------------------------------------------------------------------

export interface ProjectData {
  title: string;
  subtitle: string | null;
  logline: string;
  status: string;
  themes: string[];
  parts: string[];
}

export async function listProjects(): Promise<{ id: string; title: string; status: string }[]> {
  const projects: { id: string; title: string; status: string }[] = [];
  for (const root of [PROJECTS_ROOT, TEST_PROJECTS_ROOT]) {
    if (!existsSync(root)) continue;
    const entries = await readdir(root, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const projectJsonPath = join(root, entry.name, "project.json");
      if (!existsSync(projectJsonPath)) continue;
      try {
        const data = await readJson<ProjectData>(projectJsonPath);
        projects.push({ id: entry.name, title: data.title, status: data.status });
      } catch {
        projects.push({ id: entry.name, title: "(unreadable)", status: "error" });
      }
    }
  }
  return projects;
}

export async function ensureProjectStructure(
  projectId: string,
  title: string
): Promise<string> {
  if (!/^_?[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error(`Invalid project ID: "${projectId}". Use lowercase alphanumeric, hyphens, and optional _ prefix for test projects.`);
  }
  const root = join(resolveProjectsRoot(projectId), projectId);

  await mkdir(root, { recursive: true });
  await mkdir(join(root, "parts"), { recursive: true });
  await mkdir(join(root, "canon", "characters"), { recursive: true });
  await mkdir(join(root, "canon", "locations"), { recursive: true });
  await mkdir(join(root, "scratch"), { recursive: true });

  const projectJsonPath = join(root, "project.json");
  if (!existsSync(projectJsonPath)) {
    await writeJson(projectJsonPath, {
      title,
      subtitle: null,
      logline: "",
      status: "planning",
      themes: [],
      parts: [],
    });
  }

  const scratchJsonPath = join(root, "scratch", "scratch.json");
  if (!existsSync(scratchJsonPath)) {
    await writeJson(scratchJsonPath, { items: [] });
  }

  return root;
}

// ---------------------------------------------------------------------------
// Part / chapter creation
// ---------------------------------------------------------------------------

export async function createPart(
  projectId: string,
  partId: string,
  title: string,
  summary: string = "",
  arc: string = ""
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const partDir = join(root, "parts", partId);
  await mkdir(partDir, { recursive: true });

  const partJsonPath = join(partDir, "part.json");
  const partData: PartData = { title, summary, arc, status: "planning", chapters: [] };
  await writeJson(partJsonPath, partData);

  // Add to project.json parts list if not already there
  const project = await readJson<ProjectData>(join(root, "project.json"));
  if (!project.parts.includes(partId)) {
    project.parts.push(partId);
    await writeJson(join(root, "project.json"), project);
  }

  return [
    { path: partJsonPath, description: `Created ${partId}/part.json` },
    { path: join(root, "project.json"), description: `Added ${partId} to project.json parts list` },
  ];
}

export async function createChapter(
  projectId: string,
  partId: string,
  chapterId: string,
  title: string,
  summary: string = "",
  pov: string = "",
  location: string = "",
  timelinePosition: string = ""
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const partDir = join(root, "parts", partId);

  // Ensure part directory exists
  if (!existsSync(partDir)) {
    throw new Error(`Part "${partId}" does not exist. Create it first with create_part.`);
  }

  // Create the chapter prose file with a title and closing marker
  const mdPath = join(partDir, `${chapterId}.md`);
  await writeMd(mdPath, `# ${title}\n\n<!-- /chapter -->\n`);

  // Create the chapter meta file
  const metaPath = join(partDir, `${chapterId}.meta.json`);
  const meta: ChapterMeta = {
    title,
    summary,
    pov,
    location,
    timeline_position: timelinePosition,
    status: "planning",
    beats: [],
  };
  await writeJson(metaPath, meta);

  // Add to part.json chapters list if not already there
  const part = await readJson<PartData>(join(partDir, "part.json"));
  if (!part.chapters.includes(chapterId)) {
    part.chapters.push(chapterId);
    await writeJson(join(partDir, "part.json"), part);
  }

  return [
    { path: mdPath, description: `Created ${partId}/${chapterId}.md` },
    { path: metaPath, description: `Created ${partId}/${chapterId}.meta.json` },
    { path: join(partDir, "part.json"), description: `Added ${chapterId} to ${partId} chapters list` },
  ];
}

// ---------------------------------------------------------------------------
// Project-level reads
// ---------------------------------------------------------------------------

export async function getProject(projectId: string): Promise<ProjectData> {
  return readJson<ProjectData>(join(projectRoot(projectId), "project.json"));
}

// ---------------------------------------------------------------------------
// Part-level reads
// ---------------------------------------------------------------------------

export interface PartData {
  title: string;
  summary: string;
  arc: string;
  status: string;
  dirty_reason?: string | null;
  chapters: string[];
}

export async function getPart(projectId: string, partId: string): Promise<PartData> {
  return readJson<PartData>(join(projectRoot(projectId), "parts", partId, "part.json"));
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
  dirty_reason?: string | null;
  beats: BeatMeta[];
}

export async function getChapterMeta(projectId: string, partId: string, chapterId: string): Promise<ChapterMeta> {
  return readJson<ChapterMeta>(
    join(projectRoot(projectId), "parts", partId, `${chapterId}.meta.json`)
  );
}

export async function getChapterProse(projectId: string, partId: string, chapterId: string): Promise<string> {
  return readMd(join(projectRoot(projectId), "parts", partId, `${chapterId}.md`));
}

export async function getBeatProse(
  projectId: string,
  partId: string,
  chapterId: string,
  beatId: string
): Promise<{ label: string; prose: string }> {
  const markdown = await getChapterProse(projectId, partId, chapterId);
  const beats = parseBeats(markdown);
  const beat = beats.find((b) => b.id === beatId);
  if (!beat) throw new Error(`Beat ${beatId} not found in ${partId}/${chapterId}`);
  return { label: beat.label, prose: beat.prose };
}

// ---------------------------------------------------------------------------
// Canon reads
// ---------------------------------------------------------------------------

export async function getCanon(projectId: string, type: string, id: string): Promise<{ content: string; meta: unknown }> {
  const basePath = join(projectRoot(projectId), "canon", type);
  const content = await readMd(join(basePath, `${id}.md`));
  let meta: unknown = null;
  const metaPath = join(basePath, `${id}.meta.json`);
  if (existsSync(metaPath)) {
    meta = await readJson(metaPath);
  }
  return { content, meta };
}

export async function listCanon(projectId: string, type: string): Promise<string[]> {
  const dir = join(projectRoot(projectId), "canon", type);
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

export async function getScratchIndex(projectId: string): Promise<ScratchIndex> {
  return readJson<ScratchIndex>(join(projectRoot(projectId), "scratch", "scratch.json"));
}

export async function getScratch(projectId: string, filename: string): Promise<string> {
  return readMd(join(projectRoot(projectId), "scratch", filename));
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

export async function search(
  projectId: string,
  query: string,
  scope?: "prose" | "canon" | "scratch"
): Promise<{ file: string; line: number; text: string }[]> {
  const results: { file: string; line: number; text: string }[] = [];
  const queryLower = query.toLowerCase();
  const root = projectRoot(projectId);

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
    await searchDir(join(root, "parts"), "parts/");
  }
  if (!scope || scope === "canon") {
    await searchDir(join(root, "canon"), "canon/");
  }
  if (!scope || scope === "scratch") {
    await searchDir(join(root, "scratch"), "scratch/");
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

export async function getDirtyNodes(projectId: string): Promise<DirtyNode[]> {
  const project = await getProject(projectId);
  const dirty: DirtyNode[] = [];

  for (const partId of project.parts) {
    let part: PartData;
    try {
      part = await getPart(projectId, partId);
    } catch {
      continue;
    }
    if (part.status === "dirty" || part.status === "conflict") {
      dirty.push({ ref: partId, status: part.status, dirty_reason: part.dirty_reason ?? null });
    }
    for (const chapterId of part.chapters) {
      let meta: ChapterMeta;
      try {
        meta = await getChapterMeta(projectId, partId, chapterId);
      } catch {
        continue;
      }
      if (meta.status === "dirty" || meta.status === "conflict") {
        dirty.push({ ref: `${partId}/${chapterId}`, status: meta.status, dirty_reason: meta.dirty_reason ?? null });
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

export async function updateProject(projectId: string, patch: Partial<ProjectData>): Promise<WriteResult> {
  const current = await getProject(projectId);
  const updated = { ...current, ...patch };
  const path = join(projectRoot(projectId), "project.json");
  await writeJson(path, updated);
  return { path, description: "Updated project.json" };
}

export async function updatePart(projectId: string, partId: string, patch: Partial<PartData>): Promise<WriteResult> {
  const current = await getPart(projectId, partId);
  const updated = { ...current, ...patch };
  const path = join(projectRoot(projectId), "parts", partId, "part.json");
  await writeJson(path, updated);
  return { path, description: `Updated ${partId}/part.json` };
}

export async function updateChapterMeta(
  projectId: string,
  partId: string,
  chapterId: string,
  patch: Partial<ChapterMeta>
): Promise<WriteResult> {
  const current = await getChapterMeta(projectId, partId, chapterId);
  const updated = { ...current, ...patch };
  if (patch.beats) {
    // Merge each patch beat into the matching current beat by ID,
    // preserving fields not present in the patch beat.
    updated.beats = current.beats.map((currentBeat) => {
      const patchBeat = patch.beats!.find((pb) => pb.id === currentBeat.id);
      return patchBeat ? { ...currentBeat, ...patchBeat } : currentBeat;
    });
  } else {
    updated.beats = current.beats;
  }
  const path = join(projectRoot(projectId), "parts", partId, `${chapterId}.meta.json`);
  await writeJson(path, updated);
  return { path, description: `Updated ${partId}/${chapterId}.meta.json` };
}

export async function writeBeatProse(
  projectId: string,
  partId: string,
  chapterId: string,
  beatId: string,
  content: string
): Promise<WriteResult> {
  const mdPath = join(projectRoot(projectId), "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const updated = replaceOrInsertBeatProse(markdown, beatId, content);
  await writeMd(mdPath, updated);
  return { path: mdPath, description: `Updated prose for ${partId}/${chapterId}:${beatId}` };
}

export async function addBeat(
  projectId: string,
  partId: string,
  chapterId: string,
  beatDef: BeatMeta,
  afterBeatId?: string
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const meta = await getChapterMeta(projectId, partId, chapterId);

  // Reject duplicate beat IDs before making any changes
  if (meta.beats.some((b) => b.id === beatDef.id)) {
    throw new Error(`Beat "${beatDef.id}" already exists in ${partId}/${chapterId}.`);
  }

  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const updated = addBeatMarker(markdown, beatDef.id, beatDef.label, afterBeatId);
  await writeMd(mdPath, updated);

  if (afterBeatId) {
    const idx = meta.beats.findIndex((b) => b.id === afterBeatId);
    meta.beats.splice(idx + 1, 0, beatDef);
  } else {
    meta.beats.push(beatDef);
  }
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(metaPath, meta);

  return [
    { path: mdPath, description: `Added beat marker ${beatDef.id} to ${chapterId}.md` },
    { path: metaPath, description: `Added beat ${beatDef.id} to ${chapterId}.meta.json` },
  ];
}

export async function removeBeat(
  projectId: string,
  partId: string,
  chapterId: string,
  beatId: string
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];

  // Verify the beat exists before attempting removal
  const meta = await getChapterMeta(projectId, partId, chapterId);
  if (!meta.beats.some((b) => b.id === beatId)) {
    throw new Error(`Beat "${beatId}" not found in ${partId}/${chapterId}.`);
  }

  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const { updated, removedProse } = removeBeatMarker(markdown, beatId);
  await writeMd(mdPath, updated);
  results.push({ path: mdPath, description: `Removed beat ${beatId} from ${chapterId}.md` });

  meta.beats = meta.beats.filter((b) => b.id !== beatId);
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(metaPath, meta);
  results.push({ path: metaPath, description: `Removed beat ${beatId} from ${chapterId}.meta.json` });

  if (removedProse) {
    const scratchFile = `removed-${chapterId}-${beatId}.md`;
    const scratchPath = join(root, "scratch", scratchFile);
    await writeMd(scratchPath, `# Removed beat: ${partId}/${chapterId}:${beatId}\n\n${removedProse}\n`);

    const scratchIndex = await getScratchIndex(projectId);
    scratchIndex.items.push({
      file: scratchFile,
      note: `Prose removed from ${partId}/${chapterId}:${beatId}`,
      characters: [],
      mood: "",
      potential_placement: null,
      created: new Date().toISOString().split("T")[0]!,
    });
    await writeJson(join(root, "scratch", "scratch.json"), scratchIndex);
    results.push({ path: scratchPath, description: `Moved removed prose to scratch/${scratchFile}` });
  }

  return results;
}

export async function markDirty(projectId: string, nodeRef: string, reason: string): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];
  const parts = nodeRef.split("/");
  const partId = parts[0]!;

  if (parts.length === 1) {
    const part = await getPart(projectId, partId);
    part.status = "dirty";
    part.dirty_reason = reason;
    const path = join(root, "parts", partId, "part.json");
    await writeJson(path, part);
    results.push({ path, description: `Marked ${partId} dirty: ${reason}` });
  } else {
    const chapterBeat = parts[1]!;
    const [chapterId, beatId] = chapterBeat.split(":");

    if (!beatId) {
      const meta = await getChapterMeta(projectId, partId, chapterId!);
      meta.status = "dirty";
      meta.dirty_reason = reason;
      const path = join(root, "parts", partId, `${chapterId}.meta.json`);
      await writeJson(path, meta);
      results.push({ path, description: `Marked ${partId}/${chapterId} dirty: ${reason}` });
    } else {
      const meta = await getChapterMeta(projectId, partId, chapterId!);
      const beat = meta.beats.find((b) => b.id === beatId);
      if (beat) {
        beat.status = "dirty";
        beat.dirty_reason = reason;
        const path = join(root, "parts", partId, `${chapterId}.meta.json`);
        await writeJson(path, meta);
        results.push({ path, description: `Marked ${partId}/${chapterId}:${beatId} dirty: ${reason}` });
      }
    }
  }

  return results;
}

export async function markClean(projectId: string, nodeRef: string): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];
  const parts = nodeRef.split("/");
  const partId = parts[0]!;

  if (parts.length === 1) {
    const part = await getPart(projectId, partId);
    part.status = "clean";
    part.dirty_reason = null;
    const path = join(root, "parts", partId, "part.json");
    await writeJson(path, part);
    results.push({ path, description: `Marked ${partId} clean` });
  } else {
    const chapterBeat = parts[1]!;
    const [chapterId, beatId] = chapterBeat.split(":");

    if (!beatId) {
      const meta = await getChapterMeta(projectId, partId, chapterId!);
      meta.status = "clean";
      meta.dirty_reason = null;
      const path = join(root, "parts", partId, `${chapterId}.meta.json`);
      await writeJson(path, meta);
      results.push({ path, description: `Marked ${partId}/${chapterId} clean` });
    } else {
      const meta = await getChapterMeta(projectId, partId, chapterId!);
      const beat = meta.beats.find((b) => b.id === beatId);
      if (beat) {
        beat.status = "written";
        beat.dirty_reason = null;
        const path = join(root, "parts", partId, `${chapterId}.meta.json`);
        await writeJson(path, meta);
        results.push({ path, description: `Marked ${partId}/${chapterId}:${beatId} clean` });
      }
    }
  }

  return results;
}

export async function updateCanon(
  projectId: string,
  type: string,
  id: string,
  content: string,
  meta?: unknown
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];
  const basePath = join(root, "canon", type);

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
  projectId: string,
  filename: string,
  content: string,
  note: string,
  characters: string[] = [],
  mood: string = "",
  potentialPlacement: string | null = null
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];
  const scratchPath = join(root, "scratch", filename);
  await writeMd(scratchPath, content);
  results.push({ path: scratchPath, description: `Created scratch/${filename}` });

  const index = await getScratchIndex(projectId);
  index.items.push({
    file: filename,
    note,
    characters,
    mood,
    potential_placement: potentialPlacement,
    created: new Date().toISOString().split("T")[0]!,
  });
  const indexPath = join(root, "scratch", "scratch.json");
  await writeJson(indexPath, index);
  results.push({ path: indexPath, description: "Updated scratch index" });

  return results;
}

export async function promoteScratch(
  projectId: string,
  filename: string,
  targetPartId: string,
  targetChapterId: string,
  targetBeatId: string
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];

  const content = await getScratch(projectId, filename);

  const writeResult = await writeBeatProse(projectId, targetPartId, targetChapterId, targetBeatId, content);
  results.push(writeResult);

  const index = await getScratchIndex(projectId);
  index.items = index.items.filter((item) => item.file !== filename);
  const indexPath = join(root, "scratch", "scratch.json");
  await writeJson(indexPath, index);
  results.push({ path: indexPath, description: `Removed ${filename} from scratch index` });

  const oldPath = join(root, "scratch", filename);
  const newPath = join(root, "scratch", `_promoted_${filename}`);
  await rename(oldPath, newPath);
  results.push({
    path: newPath,
    description: `Promoted scratch/${filename} → ${targetPartId}/${targetChapterId}:${targetBeatId}`,
  });

  return results;
}
