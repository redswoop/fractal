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
// Annotation types
// ---------------------------------------------------------------------------

const ANNOTATION_TYPES = ["note", "dev", "line", "continuity", "query", "flag"] as const;
type AnnotationType = (typeof ANNOTATION_TYPES)[number];
const ANNOTATION_REGEX = /^<!--\s*@(note|dev|line|continuity|query|flag)(?:\((\w+)\))?(?::\s*(.*?))?\s*-->$/;
const BEAT_MARKER_REGEX = /^<!--\s*beat:(\S+)\s*\|\s*(.+?)\s*-->/;

export interface ParsedAnnotation {
  id: string;
  type: AnnotationType;
  author: string;
  message: string | null;
  location: { part: string; chapter: string; beat: string; line_number: number };
  context: { before: string | null; after: string | null };
}

export interface AnnotationSummary {
  total: number;
  by_type: Record<string, number>;
  by_author: Record<string, number>;
}

export interface GetAnnotationsResult {
  notes: ParsedAnnotation[];
  summary: AnnotationSummary;
  versions: Record<string, string>;
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
// Beat variant / reorder helpers
// ---------------------------------------------------------------------------

interface BeatBlock {
  id: string;
  label: string;
  prose: string;
}

function parseBeatsGrouped(markdown: string): {
  preamble: string;
  blocks: BeatBlock[];
  postamble: string;
} {
  const beatRegex = /<!--\s*beat:(\S+)\s*\|\s*(.+?)\s*-->/g;
  const matches: { id: string; label: string; index: number; end: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = beatRegex.exec(markdown)) !== null) {
    matches.push({
      id: match[1]!,
      label: match[2]!,
      index: match.index,
      end: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    return { preamble: markdown, blocks: [], postamble: "" };
  }

  const preamble = markdown.slice(0, matches[0]!.index);

  // Find where postamble starts: the <!-- /chapter --> marker after the last beat
  const lastMatch = matches[matches.length - 1]!;
  const chapterEndIdx = markdown.indexOf("<!-- /chapter -->", lastMatch.end);
  const contentEnd = chapterEndIdx !== -1 ? chapterEndIdx : markdown.length;
  const postamble = chapterEndIdx !== -1 ? markdown.slice(chapterEndIdx) : "";

  const blocks: BeatBlock[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.index : contentEnd;
    const prose = markdown.slice(current.end, nextStart).trim();
    blocks.push({ id: current.id, label: current.label, prose });
  }

  return { preamble, blocks, postamble };
}

function reassembleChapter(
  preamble: string,
  blocks: BeatBlock[],
  postamble: string
): string {
  let result = preamble;
  // Ensure preamble ends with a newline before first beat
  if (result.length > 0 && !result.endsWith("\n")) {
    result += "\n";
  }
  for (const block of blocks) {
    result += `<!-- beat:${block.id} | ${block.label} -->\n`;
    if (block.prose) {
      result += `${block.prose}\n\n`;
    } else {
      result += "\n";
    }
  }
  result += postamble;
  return result;
}

function removeAllBeatMarkers(
  markdown: string,
  beatId: string
): { updated: string; removedBlocks: { label: string; prose: string }[] } {
  const parsed = parseBeatsGrouped(markdown);
  const removedBlocks: { label: string; prose: string }[] = [];
  const kept: BeatBlock[] = [];

  for (const block of parsed.blocks) {
    if (block.id === beatId) {
      removedBlocks.push({ label: block.label, prose: block.prose });
    } else {
      kept.push(block);
    }
  }

  const updated = reassembleChapter(parsed.preamble, kept, parsed.postamble);
  return { updated, removedBlocks };
}

function appendBeatBlock(
  markdown: string,
  beatId: string,
  label: string,
  content: string
): string {
  const parsed = parseBeatsGrouped(markdown);

  // Find the last block with this beat ID
  let lastIdx = -1;
  for (let i = parsed.blocks.length - 1; i >= 0; i--) {
    if (parsed.blocks[i]!.id === beatId) {
      lastIdx = i;
      break;
    }
  }
  if (lastIdx === -1) {
    throw new Error(`Beat marker for ${beatId} not found in chapter file — cannot append variant`);
  }

  // Insert the new block after the last occurrence
  const newBlock: BeatBlock = { id: beatId, label, prose: content };
  parsed.blocks.splice(lastIdx + 1, 0, newBlock);

  return reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble);
}

// ---------------------------------------------------------------------------
// Canon type definitions & templates
// ---------------------------------------------------------------------------

export interface CanonTypeDefinition {
  id: string;
  label: string;
  description: string;
}

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  canon_types: CanonTypeDefinition[];
  themes: string[];
  guide: string | null;
}

const TEMPLATES_ROOT = resolve(
  process.env["FRINGE_TEMPLATES_ROOT"] ?? join(import.meta.dirname, "..", "templates")
);

const DEFAULT_CANON_TYPES: CanonTypeDefinition[] = [
  { id: "characters", label: "Characters", description: "People in the story" },
  { id: "locations", label: "Locations", description: "Places in the story" },
];

export async function listTemplates(): Promise<{ id: string; name: string; description: string }[]> {
  if (!existsSync(TEMPLATES_ROOT)) return [];
  const entries = await readdir(TEMPLATES_ROOT);
  const templates: { id: string; name: string; description: string }[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    try {
      const data = await readJson<ProjectTemplate>(join(TEMPLATES_ROOT, entry));
      templates.push({ id: data.id, name: data.name, description: data.description });
    } catch {
      continue;
    }
  }
  return templates;
}

export async function loadTemplate(templateId: string): Promise<ProjectTemplate> {
  const templatePath = join(TEMPLATES_ROOT, `${templateId}.json`);
  if (!existsSync(templatePath)) {
    throw new Error(
      `Template "${templateId}" not found. Use list_templates to see available templates.`
    );
  }
  return readJson<ProjectTemplate>(templatePath);
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
  canon_types?: CanonTypeDefinition[];
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
  title: string,
  template?: ProjectTemplate
): Promise<string> {
  if (!/^_?[a-z0-9][a-z0-9-]*$/.test(projectId)) {
    throw new Error(`Invalid project ID: "${projectId}". Use lowercase alphanumeric, hyphens, and optional _ prefix for test projects.`);
  }
  const root = join(resolveProjectsRoot(projectId), projectId);

  await mkdir(root, { recursive: true });
  await mkdir(join(root, "parts"), { recursive: true });
  await mkdir(join(root, "scratch"), { recursive: true });

  // Create canon type directories from template, or default to characters + locations
  const canonTypes = template?.canon_types ?? DEFAULT_CANON_TYPES;
  for (const ct of canonTypes) {
    await mkdir(join(root, "canon", ct.id), { recursive: true });
  }

  const projectJsonPath = join(root, "project.json");
  if (!existsSync(projectJsonPath)) {
    const projectData: ProjectData = {
      title,
      subtitle: null,
      logline: "",
      status: "planning",
      themes: template?.themes ?? [],
      parts: [],
      canon_types: canonTypes,
    };
    await writeJson(projectJsonPath, projectData);
  }

  const scratchJsonPath = join(root, "scratch", "scratch.json");
  if (!existsSync(scratchJsonPath)) {
    await writeJson(scratchJsonPath, { items: [] });
  }

  // Write GUIDE.md if template provides one
  if (template?.guide) {
    const guidePath = join(root, "GUIDE.md");
    if (!existsSync(guidePath)) {
      await writeMd(guidePath, template.guide);
    }
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

/**
 * Discover all canon types by scanning subdirectories of canon/.
 * This is the source of truth — works regardless of project.json config.
 */
export async function listCanonTypes(projectId: string): Promise<string[]> {
  const canonDir = join(projectRoot(projectId), "canon");
  if (!existsSync(canonDir)) return [];
  const entries = await readdir(canonDir, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory() && !e.name.startsWith("."))
    .map((e) => e.name)
    .sort();
}

async function resolveCanon(
  projectId: string,
  id: string
): Promise<{ content: string; meta: unknown; type: string } | null> {
  const root = projectRoot(projectId);
  const types = await listCanonTypes(projectId);
  for (const type of types) {
    const mdPath = join(root, "canon", type, `${id}.md`);
    if (existsSync(mdPath)) {
      const content = await readMd(mdPath);
      let meta: unknown = null;
      const metaPath = join(root, "canon", type, `${id}.meta.json`);
      if (existsSync(metaPath)) {
        meta = await readJson(metaPath);
      }
      return { content, meta, type };
    }
  }
  return null;
}

function parseChapterRef(ref: string): { partId: string; chapterId: string } {
  const parts = ref.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid chapter ref "${ref}". Expected format: "part-01/chapter-01"`);
  }
  return { partId: parts[0], chapterId: parts[1] };
}

function parseBeatRef(ref: string): { partId: string; chapterId: string; beatId: string } {
  const parts = ref.split("/");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    throw new Error(`Invalid beat ref "${ref}". Expected format: "part-01/chapter-01:b01"`);
  }
  const [chapterId, beatId] = parts[1].split(":");
  if (!chapterId || !beatId) {
    throw new Error(`Invalid beat ref "${ref}". Expected format: "part-01/chapter-01:b01"`);
  }
  return { partId: parts[0], chapterId, beatId };
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
// Annotation parsing & manipulation
// ---------------------------------------------------------------------------

/**
 * Parse all inline annotations from a chapter's markdown.
 * Pure function — no I/O. Walks lines top-to-bottom tracking beat context.
 */
export function parseAnnotations(
  markdown: string,
  partId: string,
  chapterId: string
): ParsedAnnotation[] {
  const lines = markdown.split("\n");
  const annotations: ParsedAnnotation[] = [];
  let currentBeat = "none";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Track current beat
    const beatMatch = BEAT_MARKER_REGEX.exec(line);
    if (beatMatch) {
      currentBeat = beatMatch[1]!;
      continue;
    }

    // Check for annotation
    const annoMatch = ANNOTATION_REGEX.exec(line);
    if (!annoMatch) continue;

    const lineNumber = i + 1; // 1-based
    const type = annoMatch[1]! as AnnotationType;
    const author = annoMatch[2] ?? "human";
    const message = annoMatch[3] ?? null;

    // Context: scan for nearest non-empty, non-annotation, non-marker prose line
    let before: string | null = null;
    for (let b = i - 1; b >= 0; b--) {
      const bLine = lines[b]!.trim();
      if (!bLine) continue;
      if (ANNOTATION_REGEX.test(bLine)) continue;
      if (BEAT_MARKER_REGEX.test(bLine)) break;
      if (bLine === "<!-- /chapter -->") break;
      before = bLine;
      break;
    }

    let after: string | null = null;
    for (let a = i + 1; a < lines.length; a++) {
      const aLine = lines[a]!.trim();
      if (!aLine) continue;
      if (ANNOTATION_REGEX.test(aLine)) continue;
      if (BEAT_MARKER_REGEX.test(aLine)) break;
      if (aLine === "<!-- /chapter -->") break;
      after = aLine;
      break;
    }

    annotations.push({
      id: `${partId}/${chapterId}:${currentBeat}:n${lineNumber}`,
      type,
      author,
      message,
      location: { part: partId, chapter: chapterId, beat: currentBeat, line_number: lineNumber },
      context: { before, after },
    });
  }

  return annotations;
}

/**
 * Parse a note ID into its components.
 * Format: "part-01/chapter-03:b02:n47"
 */
function parseNoteId(noteId: string): {
  partId: string;
  chapterId: string;
  beatId: string;
  lineNumber: number;
} {
  const slashIdx = noteId.indexOf("/");
  if (slashIdx === -1) {
    throw new Error(`Invalid note ID "${noteId}". Expected format: "part-01/chapter-03:b02:n47"`);
  }
  const partId = noteId.slice(0, slashIdx);
  const rest = noteId.slice(slashIdx + 1);
  const colonParts = rest.split(":");
  if (colonParts.length !== 3) {
    throw new Error(`Invalid note ID "${noteId}". Expected format: "part-01/chapter-03:b02:n47"`);
  }
  const chapterId = colonParts[0]!;
  const beatId = colonParts[1]!;
  const lineStr = colonParts[2]!;
  if (!lineStr.startsWith("n")) {
    throw new Error(`Invalid note ID "${noteId}". Line segment must start with 'n'`);
  }
  const lineNumber = parseInt(lineStr.slice(1), 10);
  if (isNaN(lineNumber) || lineNumber < 1) {
    throw new Error(`Invalid line number in note ID "${noteId}"`);
  }
  return { partId, chapterId, beatId, lineNumber };
}

/**
 * Build an annotation HTML comment string.
 */
function buildAnnotationComment(
  type: AnnotationType,
  author: string,
  message: string | null
): string {
  const authorPart = author !== "human" ? `(${author})` : "";
  if (type === "flag") {
    return authorPart ? `<!-- @flag${authorPart} -->` : `<!-- @flag -->`;
  }
  return `<!-- @${type}${authorPart}: ${message} -->`;
}

/**
 * Parse a scope string into part/chapter/beat components.
 * Accepts: "part-01", "part-01/chapter-03", "part-01/chapter-03:b02"
 */
function parseScopeRef(scope: string): {
  partId: string;
  chapterId?: string;
  beatId?: string;
} {
  const slashIdx = scope.indexOf("/");
  if (slashIdx === -1) {
    return { partId: scope };
  }
  const partId = scope.slice(0, slashIdx);
  const rest = scope.slice(slashIdx + 1);
  const colonIdx = rest.indexOf(":");
  if (colonIdx === -1) {
    return { partId, chapterId: rest };
  }
  return { partId, chapterId: rest.slice(0, colonIdx), beatId: rest.slice(colonIdx + 1) };
}

/**
 * Get annotations across chapters, with optional filtering.
 */
export async function getAnnotations(
  projectId: string,
  scope?: string,
  type?: string,
  author?: string
): Promise<GetAnnotationsResult> {
  const root = projectRoot(projectId);
  let chaptersToScan: { partId: string; chapterId: string }[] = [];
  let beatFilter: string | undefined;

  if (scope) {
    const ref = parseScopeRef(scope);
    beatFilter = ref.beatId;

    if (ref.chapterId) {
      chaptersToScan = [{ partId: ref.partId, chapterId: ref.chapterId }];
    } else {
      // Scan all chapters in a part
      const part = await getPart(projectId, ref.partId);
      chaptersToScan = part.chapters.map((ch: string) => ({ partId: ref.partId, chapterId: ch }));
    }
  } else {
    // Scan entire project
    const project = await getProject(projectId);
    for (const partId of project.parts) {
      try {
        const part = await getPart(projectId, partId);
        for (const chapterId of part.chapters) {
          chaptersToScan.push({ partId, chapterId });
        }
      } catch {
        continue;
      }
    }
  }

  let allNotes: ParsedAnnotation[] = [];
  const versions: Record<string, string> = {};

  for (const { partId, chapterId } of chaptersToScan) {
    try {
      const mdPath = join(root, "parts", partId, `${chapterId}.md`);
      const markdown = await readMd(mdPath);
      const notes = parseAnnotations(markdown, partId, chapterId);
      allNotes.push(...notes);

      const relPath = join("parts", partId, `${chapterId}.md`);
      const { getFileVersion } = await import("./git.js");
      versions[`${partId}/${chapterId}`] = await getFileVersion(root, relPath);
    } catch {
      continue;
    }
  }

  // Apply filters
  if (beatFilter) {
    allNotes = allNotes.filter((n) => n.location.beat === beatFilter);
  }
  if (type) {
    allNotes = allNotes.filter((n) => n.type === type);
  }
  if (author) {
    allNotes = allNotes.filter((n) => n.author === author);
  }

  // Build summary
  const by_type: Record<string, number> = {};
  const by_author: Record<string, number> = {};
  for (const note of allNotes) {
    by_type[note.type] = (by_type[note.type] ?? 0) + 1;
    by_author[note.author] = (by_author[note.author] ?? 0) + 1;
  }

  return {
    notes: allNotes,
    summary: { total: allNotes.length, by_type, by_author },
    versions,
  };
}

/**
 * Insert an annotation after a specific line in a chapter.
 * Optionally accepts a version token for line-number translation.
 */
export async function insertAnnotation(
  projectId: string,
  partId: string,
  chapterId: string,
  lineNumber: number,
  type: AnnotationType,
  message: string | null,
  author: string,
  version?: string
): Promise<WriteResult & { id: string; inserted_after_line: number; version: string }> {
  const root = projectRoot(projectId);
  const relPath = join("parts", partId, `${chapterId}.md`);
  const mdPath = join(root, relPath);
  const markdown = await readMd(mdPath);

  const { getFileVersion, translateLineNumber } = await import("./git.js");
  const currentVersion = await getFileVersion(root, relPath);

  let targetLine = lineNumber;

  // Version-based line translation
  if (version && version !== currentVersion) {
    const translated = await translateLineNumber(root, relPath, version, currentVersion, lineNumber);
    if (translated === null) {
      throw new Error(
        `Line ${lineNumber} in version ${version} cannot be mapped to current file (${currentVersion}) — re-read the chapter.`
      );
    }
    targetLine = translated;
  }

  const lines = markdown.split("\n");

  // Validate line range
  if (targetLine < 1 || targetLine > lines.length) {
    throw new Error(
      `Line ${targetLine} is out of range. File has ${lines.length} lines.`
    );
  }

  // Determine which beat this line falls in (scan backwards)
  let beatId = "none";
  for (let i = targetLine - 1; i >= 0; i--) {
    const match = BEAT_MARKER_REGEX.exec(lines[i]!.trim());
    if (match) {
      beatId = match[1]!;
      break;
    }
  }

  // Build and insert annotation
  const comment = buildAnnotationComment(type, author, message);
  // Insert after the target line (index = targetLine since lines are 0-indexed)
  lines.splice(targetLine, 0, comment);

  await writeMd(mdPath, lines.join("\n"));

  const insertedLine = targetLine + 1; // 1-based line number of the inserted annotation
  const id = `${partId}/${chapterId}:${beatId}:n${insertedLine}`;

  return {
    path: mdPath,
    description: `Added @${type}(${author}) annotation to ${partId}/${chapterId}:${beatId}`,
    id,
    inserted_after_line: targetLine,
    version: currentVersion, // Will be updated to post-commit version by server handler
  };
}

/**
 * Remove annotation lines from chapter files by note IDs.
 * Uses filtering (not sequential deletion) to avoid line-shifting issues.
 */
export async function removeAnnotationLines(
  projectId: string,
  noteIds: string[]
): Promise<WriteResult[]> {
  if (noteIds.length === 0) return [];

  const root = projectRoot(projectId);

  // Group by chapter file
  const byChapter = new Map<string, { partId: string; chapterId: string; lineNumbers: number[] }>();
  for (const noteId of noteIds) {
    const { partId, chapterId, lineNumber } = parseNoteId(noteId);
    const key = `${partId}/${chapterId}`;
    if (!byChapter.has(key)) {
      byChapter.set(key, { partId, chapterId, lineNumbers: [] });
    }
    byChapter.get(key)!.lineNumbers.push(lineNumber);
  }

  const results: WriteResult[] = [];

  for (const [, { partId, chapterId, lineNumbers }] of byChapter) {
    const mdPath = join(root, "parts", partId, `${chapterId}.md`);
    const markdown = await readMd(mdPath);
    const lines = markdown.split("\n");

    // Verify each target line is actually an annotation
    for (const ln of lineNumbers) {
      if (ln < 1 || ln > lines.length) {
        throw new Error(
          `Line ${ln} is out of range in ${partId}/${chapterId}. File has ${lines.length} lines.`
        );
      }
      const content = lines[ln - 1]!.trim();
      if (!ANNOTATION_REGEX.test(content)) {
        throw new Error(
          `Line ${ln} is not an annotation: '${content}'. Notes may have shifted — re-read with get_notes.`
        );
      }
    }

    // Filter out annotation lines
    const toRemove = new Set(lineNumbers);
    const filtered = lines.filter((_, i) => !toRemove.has(i + 1));
    await writeMd(mdPath, filtered.join("\n"));

    results.push({
      path: mdPath,
      description: `Resolved ${lineNumbers.length} annotation(s) in ${partId}/${chapterId}`,
    });
  }

  return results;
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
  content: string,
  append: boolean = false
): Promise<WriteResult> {
  const mdPath = join(projectRoot(projectId), "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);

  let updated: string;
  if (append) {
    const beats = parseBeats(markdown);
    const existing = beats.find((b) => b.id === beatId);
    if (!existing) {
      throw new Error(`Beat marker for ${beatId} not found in chapter file — cannot append variant`);
    }
    updated = appendBeatBlock(markdown, beatId, existing.label, content);
  } else {
    updated = replaceOrInsertBeatProse(markdown, beatId, content);
  }
  await writeMd(mdPath, updated);
  return {
    path: mdPath,
    description: `${append ? "Appended variant" : "Updated"} prose for ${partId}/${chapterId}:${beatId}`,
  };
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

  // Remove ALL blocks for this beat ID from prose
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const { updated, removedBlocks } = removeAllBeatMarkers(markdown, beatId);
  await writeMd(mdPath, updated);
  results.push({ path: mdPath, description: `Removed all blocks for beat ${beatId} from ${chapterId}.md` });

  meta.beats = meta.beats.filter((b) => b.id !== beatId);
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(metaPath, meta);
  results.push({ path: metaPath, description: `Removed beat ${beatId} from ${chapterId}.meta.json` });

  if (removedBlocks.length > 0) {
    const combinedProse = removedBlocks
      .map((block, i) => {
        if (removedBlocks.length === 1) return block.prose;
        return `## Variant ${i}\n\n${block.prose}`;
      })
      .join("\n\n---\n\n");

    const scratchFile = `removed-${chapterId}-${beatId}.md`;
    const scratchPath = join(root, "scratch", scratchFile);
    await writeMd(scratchPath, `# Removed beat: ${partId}/${chapterId}:${beatId}\n\n${combinedProse}\n`);

    const scratchIndex = await getScratchIndex(projectId);
    scratchIndex.items.push({
      file: scratchFile,
      note: `Prose removed from ${partId}/${chapterId}:${beatId} (${removedBlocks.length} block(s))`,
      characters: [],
      mood: "",
      potential_placement: null,
      created: new Date().toISOString().split("T")[0]!,
    });
    await writeJson(join(root, "scratch", "scratch.json"), scratchIndex);
    results.push({ path: scratchPath, description: `Moved ${removedBlocks.length} removed block(s) to scratch/${scratchFile}` });
  }

  return results;
}

export async function getBeatVariants(
  projectId: string,
  partId: string,
  chapterId: string,
  beatId: string
): Promise<{ beat_id: string; variants: { index: number; label: string; content: string }[] }> {
  const meta = await getChapterMeta(projectId, partId, chapterId);
  if (!meta.beats.some((b) => b.id === beatId)) {
    throw new Error(`Beat "${beatId}" not found in ${partId}/${chapterId} meta.`);
  }

  const markdown = await getChapterProse(projectId, partId, chapterId);
  const beats = parseBeats(markdown);
  const variants = beats
    .filter((b) => b.id === beatId)
    .map((b, i) => ({ index: i, label: b.label, content: b.prose }));

  return { beat_id: beatId, variants };
}

export async function reorderBeats(
  projectId: string,
  partId: string,
  chapterId: string,
  beatOrder: string[]
): Promise<{ results: WriteResult[]; previous_order: string[]; new_order: string[] }> {
  const root = projectRoot(projectId);
  const meta = await getChapterMeta(projectId, partId, chapterId);
  const results: WriteResult[] = [];

  // Validate: no duplicates in beatOrder
  const seen = new Set<string>();
  for (const id of beatOrder) {
    if (seen.has(id)) throw new Error(`Duplicate beat ID "${id}" in beat_order.`);
    seen.add(id);
  }

  // Validate: every beatOrder ID exists in meta
  const metaIds = new Set(meta.beats.map((b) => b.id));
  const unknownIds = beatOrder.filter((id) => !metaIds.has(id));
  if (unknownIds.length > 0) {
    throw new Error(`Beat IDs not found in chapter meta: ${unknownIds.join(", ")}`);
  }

  // Validate: every meta ID is in beatOrder
  const orderSet = new Set(beatOrder);
  const missingIds = meta.beats.filter((b) => !orderSet.has(b.id)).map((b) => b.id);
  if (missingIds.length > 0) {
    throw new Error(`Beat IDs missing from beat_order: ${missingIds.join(", ")}. Provide all beats.`);
  }

  const previous_order = meta.beats.map((b) => b.id);

  // Reorder meta beats
  const beatMap = new Map(meta.beats.map((b) => [b.id, b]));
  meta.beats = beatOrder.map((id) => beatMap.get(id)!);
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  await writeJson(metaPath, meta);
  results.push({ path: metaPath, description: `Reordered beats in ${partId}/${chapterId}.meta.json` });

  // Reorder prose blocks (variants stay grouped in original internal order)
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const parsed = parseBeatsGrouped(markdown);

  const blockGroups = new Map<string, BeatBlock[]>();
  for (const block of parsed.blocks) {
    if (!blockGroups.has(block.id)) blockGroups.set(block.id, []);
    blockGroups.get(block.id)!.push(block);
  }

  const newBlocks: BeatBlock[] = [];
  for (const id of beatOrder) {
    const group = blockGroups.get(id);
    if (group) newBlocks.push(...group);
  }

  const updated = reassembleChapter(parsed.preamble, newBlocks, parsed.postamble);
  await writeMd(mdPath, updated);
  results.push({ path: mdPath, description: `Reordered beat markers in ${partId}/${chapterId}.md` });

  return { results, previous_order, new_order: beatOrder };
}

export async function selectBeatVariant(
  projectId: string,
  partId: string,
  chapterId: string,
  beatId: string,
  keepIndex: number
): Promise<{
  results: WriteResult[];
  kept: { index: number; preview: string };
  archived: { index: number; scratch_file: string }[];
}> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];

  // Verify beat exists in meta
  const meta = await getChapterMeta(projectId, partId, chapterId);
  const beatMeta = meta.beats.find((b) => b.id === beatId);
  if (!beatMeta) {
    throw new Error(`Beat "${beatId}" not found in ${partId}/${chapterId} meta.`);
  }

  // Parse prose and collect variants
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const parsed = parseBeatsGrouped(markdown);
  const variants = parsed.blocks
    .map((block, globalIdx) => ({ block, globalIdx }))
    .filter(({ block }) => block.id === beatId);

  if (variants.length === 0) {
    throw new Error(`Beat "${beatId}" has no prose blocks in the chapter file.`);
  }

  // No-op: only one variant and keepIndex is 0
  if (variants.length === 1 && keepIndex === 0) {
    return {
      results: [],
      kept: { index: 0, preview: variants[0]!.block.prose.slice(0, 100) },
      archived: [],
    };
  }

  if (keepIndex < 0 || keepIndex >= variants.length) {
    throw new Error(
      `keep_index ${keepIndex} is out of range. Beat "${beatId}" has ${variants.length} variant(s) (indices 0–${variants.length - 1}).`
    );
  }

  // Archive non-selected variants to scratch
  const archived: { index: number; scratch_file: string }[] = [];
  const scratchIndex = await getScratchIndex(projectId);

  for (let i = 0; i < variants.length; i++) {
    if (i === keepIndex) continue;
    const variant = variants[i]!;
    const scratchFile = `${chapterId}-${beatId}-alt-${i}.md`;
    const scratchPath = join(root, "scratch", scratchFile);
    await writeMd(
      scratchPath,
      `# Archived variant ${i} from ${partId}/${chapterId}:${beatId}\n\n${variant.block.prose}\n`
    );
    scratchIndex.items.push({
      file: scratchFile,
      note: `Archived variant ${i} from ${partId}/${chapterId}:${beatId}`,
      characters: beatMeta.characters,
      mood: "",
      potential_placement: null,
      created: new Date().toISOString().split("T")[0]!,
    });
    archived.push({ index: i, scratch_file: scratchFile });
    results.push({ path: scratchPath, description: `Archived variant ${i} to scratch/${scratchFile}` });
  }

  await writeJson(join(root, "scratch", "scratch.json"), scratchIndex);
  results.push({ path: join(root, "scratch", "scratch.json"), description: "Updated scratch index" });

  // Rebuild chapter with only the winning block
  const keptBlock = variants[keepIndex]!.block;
  const newBlocks: BeatBlock[] = [];
  let inserted = false;
  for (const block of parsed.blocks) {
    if (block.id === beatId) {
      if (!inserted) {
        newBlocks.push(keptBlock);
        inserted = true;
      }
      // Skip all other variants
    } else {
      newBlocks.push(block);
    }
  }

  const updated = reassembleChapter(parsed.preamble, newBlocks, parsed.postamble);
  await writeMd(mdPath, updated);
  results.push({ path: mdPath, description: `Selected variant ${keepIndex} for ${beatId} in ${chapterId}.md` });

  return {
    results,
    kept: { index: keepIndex, preview: keptBlock.prose.slice(0, 100) },
    archived,
  };
}

// ---------------------------------------------------------------------------
// Batch context read
// ---------------------------------------------------------------------------

export interface ContextInclude {
  canon?: string[];
  scratch?: string[];
  parts?: string[];
  chapter_meta?: string[];
  chapter_prose?: string[];
  beats?: string[];
  beat_variants?: string[];
  dirty_nodes?: boolean;
  project_meta?: boolean;
  guide?: boolean;
}

export async function getContext(
  projectId: string,
  include: ContextInclude
): Promise<Record<string, unknown>> {
  const response: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  // Canon — resolve type automatically
  if (include.canon && include.canon.length > 0) {
    const canon: Record<string, unknown> = {};
    await Promise.all(include.canon.map(async (id) => {
      try {
        const result = await resolveCanon(projectId, id);
        if (result) {
          canon[id] = result;
        } else {
          errors[`canon:${id}`] = `Canon entry "${id}" not found in any canon type`;
        }
      } catch (err) {
        errors[`canon:${id}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(canon).length > 0) response.canon = canon;
  }

  // Scratch files
  if (include.scratch && include.scratch.length > 0) {
    const scratch: Record<string, string> = {};
    await Promise.all(include.scratch.map(async (filename) => {
      try {
        scratch[filename] = await getScratch(projectId, filename);
      } catch (err) {
        errors[`scratch:${filename}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(scratch).length > 0) response.scratch = scratch;
  }

  // Parts
  if (include.parts && include.parts.length > 0) {
    const parts: Record<string, unknown> = {};
    await Promise.all(include.parts.map(async (partId) => {
      try {
        parts[partId] = await getPart(projectId, partId);
      } catch (err) {
        errors[`parts:${partId}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(parts).length > 0) response.parts = parts;
  }

  // Chapter meta
  if (include.chapter_meta && include.chapter_meta.length > 0) {
    const chapterMeta: Record<string, unknown> = {};
    await Promise.all(include.chapter_meta.map(async (ref) => {
      try {
        const { partId, chapterId } = parseChapterRef(ref);
        chapterMeta[ref] = await getChapterMeta(projectId, partId, chapterId);
      } catch (err) {
        errors[`chapter_meta:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(chapterMeta).length > 0) response.chapter_meta = chapterMeta;
  }

  // Chapter prose
  if (include.chapter_prose && include.chapter_prose.length > 0) {
    const chapterProse: Record<string, string> = {};
    await Promise.all(include.chapter_prose.map(async (ref) => {
      try {
        const { partId, chapterId } = parseChapterRef(ref);
        chapterProse[ref] = await getChapterProse(projectId, partId, chapterId);
      } catch (err) {
        errors[`chapter_prose:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(chapterProse).length > 0) response.chapter_prose = chapterProse;
  }

  // Individual beats
  if (include.beats && include.beats.length > 0) {
    const beats: Record<string, unknown> = {};
    await Promise.all(include.beats.map(async (ref) => {
      try {
        const { partId, chapterId, beatId } = parseBeatRef(ref);
        beats[ref] = await getBeatProse(projectId, partId, chapterId, beatId);
      } catch (err) {
        errors[`beats:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(beats).length > 0) response.beats = beats;
  }

  // Beat variants
  if (include.beat_variants && include.beat_variants.length > 0) {
    const beatVariants: Record<string, unknown> = {};
    await Promise.all(include.beat_variants.map(async (ref) => {
      try {
        const { partId, chapterId, beatId } = parseBeatRef(ref);
        const result = await getBeatVariants(projectId, partId, chapterId, beatId);
        beatVariants[ref] = result.variants;
      } catch (err) {
        errors[`beat_variants:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(beatVariants).length > 0) response.beat_variants = beatVariants;
  }

  // Dirty nodes
  if (include.dirty_nodes) {
    try {
      response.dirty_nodes = await getDirtyNodes(projectId);
    } catch (err) {
      errors["dirty_nodes"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Project meta
  if (include.project_meta) {
    try {
      response.project_meta = await getProject(projectId);
    } catch (err) {
      errors["project_meta"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Guide
  if (include.guide) {
    try {
      const guidePath = join(projectRoot(projectId), "GUIDE.md");
      if (existsSync(guidePath)) {
        response.guide = await readMd(guidePath);
      } else {
        response.guide = null;
      }
    } catch (err) {
      errors["guide"] = err instanceof Error ? err.message : String(err);
    }
  }

  if (Object.keys(errors).length > 0) {
    response.errors = errors;
  }

  return response;
}

// ---------------------------------------------------------------------------
// Surgical beat prose editing
// ---------------------------------------------------------------------------

export async function editBeatProse(
  projectId: string,
  partId: string,
  chapterId: string,
  beatId: string,
  edits: { old_str: string; new_str: string }[],
  variantIndex: number = 0
): Promise<{
  result: WriteResult;
  edits_applied: number;
  changes: { old_str: string; new_str: string; context: string }[];
}> {
  // Validate beat exists in meta
  const meta = await getChapterMeta(projectId, partId, chapterId);
  if (!meta.beats.some((b) => b.id === beatId)) {
    throw new Error(`Beat "${beatId}" not found in ${partId}/${chapterId} meta.`);
  }

  const mdPath = join(projectRoot(projectId), "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const parsed = parseBeatsGrouped(markdown);

  // Collect variants for this beat
  const variantEntries = parsed.blocks
    .map((block, idx) => ({ block, idx }))
    .filter(({ block }) => block.id === beatId);

  if (variantEntries.length === 0) {
    throw new Error(`Beat "${beatId}" has no prose content in ${partId}/${chapterId}.`);
  }

  if (variantIndex < 0 || variantIndex >= variantEntries.length) {
    throw new Error(
      `Beat "${beatId}" has ${variantEntries.length} variant(s), index ${variantIndex} is out of range.`
    );
  }

  // Empty edits → no-op
  if (edits.length === 0) {
    return {
      result: { path: mdPath, description: `No edits applied to ${partId}/${chapterId}:${beatId}` },
      edits_applied: 0,
      changes: [],
    };
  }

  // Work on a copy of the prose text — nothing touches disk until all edits pass
  const target = variantEntries[variantIndex]!;
  let text = target.block.prose;
  const changes: { old_str: string; new_str: string; context: string }[] = [];

  for (const edit of edits) {
    const firstIdx = text.indexOf(edit.old_str);
    if (firstIdx === -1) {
      const preview = edit.old_str.length > 100 ? edit.old_str.slice(0, 100) + "..." : edit.old_str;
      throw new Error(`No match for old_str in beat ${beatId}: "${preview}"`);
    }

    // Check for duplicate matches
    const secondIdx = text.indexOf(edit.old_str, firstIdx + 1);
    if (secondIdx !== -1) {
      // Count total occurrences
      let count = 2;
      let searchFrom = secondIdx + 1;
      while (true) {
        const nextIdx = text.indexOf(edit.old_str, searchFrom);
        if (nextIdx === -1) break;
        count++;
        searchFrom = nextIdx + 1;
      }
      const preview = edit.old_str.length > 100 ? edit.old_str.slice(0, 100) + "..." : edit.old_str;
      throw new Error(
        `old_str matches ${count} locations in beat ${beatId}. Include more context to make it unique: "${preview}"`
      );
    }

    // Apply the replacement
    const before = text.slice(Math.max(0, firstIdx - 50), firstIdx);
    const afterStart = firstIdx + edit.old_str.length;
    const after = text.slice(afterStart, afterStart + 50);
    const context = `...${before}${edit.new_str}${after}...`;

    text = text.slice(0, firstIdx) + edit.new_str + text.slice(firstIdx + edit.old_str.length);
    changes.push({ old_str: edit.old_str, new_str: edit.new_str, context });
  }

  // All edits passed — update the block and write to disk
  parsed.blocks[target.idx]! = { ...target.block, prose: text };
  const updated = reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble);
  await writeMd(mdPath, updated);

  return {
    result: { path: mdPath, description: `Applied ${edits.length} edit(s) to ${partId}/${chapterId}:${beatId}` },
    edits_applied: edits.length,
    changes,
  };
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
