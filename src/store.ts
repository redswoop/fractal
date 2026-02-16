/**
 * store.ts — File-system operations for Fractal projects.
 *
 * Pure read/write against the directory structure defined in claude.md.
 * No MCP awareness, no git awareness. Just files.
 *
 * Multi-project: FRACTAL_PROJECTS_ROOT contains one subdirectory per project.
 * Every function takes a projectId as the first parameter.
 */

import { readFile, writeFile, readdir, rename, mkdir, stat } from "node:fs/promises";
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// Projects root — resolved once at startup
// Test projects (IDs starting with _) route to a separate directory.
// ---------------------------------------------------------------------------

const PROJECTS_ROOT = resolve(
  process.env["FRACTAL_PROJECTS_ROOT"] ?? join(import.meta.dirname, "..", "projects")
);

const TEST_PROJECTS_ROOT = resolve(
  process.env["FRACTAL_TEST_PROJECTS_ROOT"] ?? join(import.meta.dirname, "..", "test-projects")
);

// ---------------------------------------------------------------------------
// Ignore patterns — loaded once at startup from .fractalignore
// ---------------------------------------------------------------------------

const PACKAGE_ROOT = resolve(import.meta.dirname, "..");

function loadIgnorePatterns(): Set<string> {
  const userPath = join(PROJECTS_ROOT, "fractalignore");
  const defaultPath = join(PACKAGE_ROOT, "fractalignore");
  const filePath = existsSync(userPath) ? userPath : existsSync(defaultPath) ? defaultPath : null;
  if (!filePath) return new Set();
  const content = readFileSync(filePath, "utf-8");
  const patterns = new Set<string>();
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith("#")) patterns.add(trimmed);
  }
  console.log(`[fractal] Loaded ${patterns.size} ignore patterns from ${filePath}`);
  return patterns;
}

const IGNORE_SET = loadIgnorePatterns();

function shouldIgnore(name: string): boolean {
  return IGNORE_SET.has(name);
}

export function getIgnorePatterns(): string[] {
  return [...IGNORE_SET];
}

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
// Detects annotation opening that may not close on the same line
const ANNOTATION_START_REGEX = /^<!--\s*@(note|dev|line|continuity|query|flag)(?:\((\w+)\))?(?::\s*(.*))?$/;
const BEAT_MARKER_REGEX = /^<!--\s*beat:(\S+)\s*(?:\[([^\]]+)\]\s*)?\|\s*(.+?)\s*-->/;
const SUMMARY_COMMENT_REGEX = /^<!--\s*summary:\s*(.*?)\s*-->$/;
const SUMMARY_START_REGEX = /^<!--\s*summary:\s*(.*)$/;
const CHAPTER_SUMMARY_REGEX = /^<!--\s*chapter-summary:\s*(.*?)\s*-->$/;
const CHAPTER_SUMMARY_START_REGEX = /^<!--\s*chapter-summary:\s*(.*)$/;

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

export interface AnnotationWarning {
  line: number;
  beat: string;
  content: string;
  issue: string;
}

export interface GetAnnotationsResult {
  notes: ParsedAnnotation[];
  summary: AnnotationSummary;
  versions: Record<string, string>;
  warnings: AnnotationWarning[];
}

// ---------------------------------------------------------------------------
// Summary comment helpers — word-wrap for markdown readability
// ---------------------------------------------------------------------------

/**
 * Build a word-wrapped summary comment: <!-- summary: text -->
 * Wraps at ~80 columns for human readability.
 */
function buildSummaryBlock(summary: string): string {
  if (!summary) return "";
  const safeMessage = summary.replace(/\s+/g, " ").trim();
  const singleLine = `<!-- summary: ${safeMessage} -->`;
  if (singleLine.length <= 80) return singleLine;

  const prefix = "<!-- summary: ";
  const suffix = " -->";
  const words = safeMessage.split(" ");
  const lines: string[] = [];
  let current = prefix;

  for (const word of words) {
    const candidate = current + (current === prefix ? "" : " ") + word;
    if (candidate.length > 80 && current !== prefix) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current + suffix);
  return lines.join("\n");
}

/**
 * Build a word-wrapped chapter-summary comment.
 */
function buildChapterSummaryBlock(summary: string): string {
  if (!summary) return "";
  const safeMessage = summary.replace(/\s+/g, " ").trim();
  const singleLine = `<!-- chapter-summary: ${safeMessage} -->`;
  if (singleLine.length <= 80) return singleLine;

  const prefix = "<!-- chapter-summary: ";
  const suffix = " -->";
  const words = safeMessage.split(" ");
  const lines: string[] = [];
  let current = prefix;

  for (const word of words) {
    const candidate = current + (current === prefix ? "" : " ") + word;
    if (candidate.length > 80 && current !== prefix) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current + suffix);
  return lines.join("\n");
}

/**
 * Build a beat marker line with embedded status.
 */
function buildBeatMarker(id: string, status: string, label: string): string {
  return `<!-- beat:${id} [${status}] | ${label} -->`;
}

// ---------------------------------------------------------------------------
// Chapter-summary and summary comment parsing from markdown
// ---------------------------------------------------------------------------

/**
 * Parse a multi-line comment block starting at line i.
 * Returns the joined text content and the end line index, or null if not found.
 */
function parseMultiLineComment(lines: string[], startLine: number, firstLineContent: string): { text: string; endLine: number } | null {
  let joined = firstLineContent;
  for (let j = startLine + 1; j < lines.length; j++) {
    const scanLine = lines[j]!.trim();
    // Abort at structural boundaries
    if (BEAT_MARKER_REGEX.test(scanLine)) return null;
    if (scanLine === "<!-- /chapter -->") return null;
    if (scanLine.includes("-->")) {
      // Strip the closing -->
      joined += " " + scanLine.replace(/\s*-->\s*$/, "");
      return { text: joined.replace(/\s+/g, " ").trim(), endLine: j };
    }
    joined += " " + scanLine;
  }
  return null; // Never found closing -->
}

/**
 * Extract chapter-summary from preamble lines (before any beat marker).
 * Returns the summary text and the preamble with the comment stripped.
 */
function extractChapterSummary(preamble: string): { summary: string | null; preamble: string } {
  const lines = preamble.split("\n");
  let summary: string | null = null;
  const toRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Single-line chapter-summary
    const singleMatch = CHAPTER_SUMMARY_REGEX.exec(line);
    if (singleMatch) {
      summary = singleMatch[1]!.trim();
      toRemove.add(i);
      continue;
    }
    // Multi-line chapter-summary
    const startMatch = CHAPTER_SUMMARY_START_REGEX.exec(line);
    if (startMatch) {
      const result = parseMultiLineComment(lines, i, startMatch[1] ?? "");
      if (result) {
        summary = result.text;
        for (let k = i; k <= result.endLine; k++) toRemove.add(k);
        i = result.endLine;
      }
    }
    // Also strip legacy chapter-brief comments during migration
    if (/^<!--\s*chapter-brief\s*\[/.test(line)) {
      // Find end of this comment (may be multi-line)
      if (line.includes("-->")) {
        toRemove.add(i);
      } else {
        toRemove.add(i);
        for (let j = i + 1; j < lines.length; j++) {
          toRemove.add(j);
          if (lines[j]!.includes("-->")) { i = j; break; }
        }
      }
    }
  }

  if (summary === null && toRemove.size === 0) return { summary: null, preamble };
  const cleaned = lines.filter((_, i) => !toRemove.has(i)).join("\n").replace(/\n{3,}/g, "\n\n");
  return { summary, preamble: cleaned };
}

/**
 * Extract a <!-- summary: ... --> comment from raw beat prose.
 * Returns the summary text and the prose with the comment stripped.
 */
function extractBeatSummary(raw: string): { summary: string | null; prose: string } {
  const lines = raw.split("\n");
  let summary: string | null = null;
  const toRemove = new Set<number>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Single-line summary
    const singleMatch = SUMMARY_COMMENT_REGEX.exec(line);
    if (singleMatch) {
      summary = singleMatch[1]!.trim();
      toRemove.add(i);
      break; // Only one summary per beat
    }

    // Multi-line summary
    const startMatch = SUMMARY_START_REGEX.exec(line);
    if (startMatch) {
      const result = parseMultiLineComment(lines, i, startMatch[1] ?? "");
      if (result) {
        summary = result.text;
        for (let k = i; k <= result.endLine; k++) toRemove.add(k);
      }
      break;
    }

    // Also strip legacy beat-brief comments
    if (/^<!--\s*beat-brief:\S+\s*\[/.test(line)) {
      if (line.includes("-->")) {
        toRemove.add(i);
      } else {
        toRemove.add(i);
        for (let j = i + 1; j < lines.length; j++) {
          toRemove.add(j);
          if (lines[j]!.includes("-->")) { i = j; break; }
        }
      }
      continue; // Keep looking for a real summary after legacy brief
    }

    // Stop at first non-empty, non-comment line (we're past the metadata zone)
    if (line && !line.startsWith("<!--")) break;
  }

  if (summary === null && toRemove.size === 0) return { summary: null, prose: raw };
  const cleaned = lines.filter((_, i) => !toRemove.has(i)).join("\n").trim();
  return { summary, prose: cleaned };
}

/**
 * Inject a chapter-summary comment into the preamble, after the heading.
 */
function injectChapterSummary(preamble: string, summary: string | null): string {
  if (!summary) return preamble;
  const comment = buildChapterSummaryBlock(summary);
  const lines = preamble.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.startsWith("# ")) {
      lines.splice(i + 1, 0, comment);
      return lines.join("\n");
    }
  }
  return comment + "\n" + preamble;
}

// ---------------------------------------------------------------------------
// Beat prose parsing
// ---------------------------------------------------------------------------

interface ParsedBeat {
  id: string;
  label: string;
  status: string | null;
  prose: string;
}

function parseBeats(markdown: string): ParsedBeat[] {
  const beatRegex = /<!--\s*beat:(\S+)\s*(?:\[([^\]]+)\]\s*)?\|\s*(.+?)\s*-->/g;
  const beats: ParsedBeat[] = [];
  let match: RegExpExecArray | null;
  const matches: { id: string; status: string | null; label: string; index: number; end: number }[] = [];

  while ((match = beatRegex.exec(markdown)) !== null) {
    matches.push({
      id: match[1]!,
      status: match[2] ?? null,
      label: match[3]!,
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
    const rawProse = markdown.slice(current.end, proseEnd).trim();
    const { prose } = extractBeatSummary(rawProse);
    beats.push({ id: current.id, status: current.status, label: current.label, prose });
  }

  return beats;
}

function replaceOrInsertBeatProse(
  markdown: string,
  beatId: string,
  newProse: string
): string {
  const parsed = parseBeatsGrouped(markdown);
  const idx = parsed.blocks.findIndex((b) => b.id === beatId);
  if (idx === -1) {
    throw new Error(`Beat marker for ${beatId} not found in chapter file`);
  }
  parsed.blocks[idx] = { ...parsed.blocks[idx]!, prose: newProse };
  return reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble, parsed.chapterSummary);
}

function addBeatMarkerToMarkdown(
  markdown: string,
  beatId: string,
  status: string,
  label: string,
  summary: string,
  afterBeatId?: string
): string {
  const marker = buildBeatMarker(beatId, status, label);
  const summaryBlock = buildSummaryBlock(summary);
  const insertion = summaryBlock ? `${marker}\n${summaryBlock}\n\n` : `${marker}\n\n`;
  if (afterBeatId) {
    const afterRegex = new RegExp(
      `(<!--\\s*beat:${afterBeatId}\\s*(?:\\[[^\\]]+\\]\\s*)?\\|[^>]*-->[\\s\\S]*?)(?=<!--\\s*(?:beat:\\S|/chapter))`
    );
    const match = afterRegex.exec(markdown);
    if (match) {
      const insertPoint = match.index + match[0].length;
      return markdown.slice(0, insertPoint) + insertion + markdown.slice(insertPoint);
    }
  }
  const chapterEnd = markdown.indexOf("<!-- /chapter -->");
  if (chapterEnd !== -1) {
    return markdown.slice(0, chapterEnd) + insertion + markdown.slice(chapterEnd);
  }
  return markdown + `\n${insertion}<!-- /chapter -->\n`;
}

function removeBeatMarker(markdown: string, beatId: string): { updated: string; removedProse: string } {
  const beatRegex = new RegExp(
    `<!--\\s*beat:${beatId}\\s*(?:\\[[^\\]]+\\]\\s*)?\\|[^>]*-->([\\s\\S]*?)(?=<!--\\s*(?:beat:\\S|/chapter)|$)`
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
  status: string | null;
  summary: string | null;
  prose: string;
}

function parseBeatsGrouped(markdown: string): {
  preamble: string;
  chapterSummary: string | null;
  blocks: BeatBlock[];
  postamble: string;
} {
  const beatRegex = /<!--\s*beat:(\S+)\s*(?:\[([^\]]+)\]\s*)?\|\s*(.+?)\s*-->/g;
  const matches: { id: string; status: string | null; label: string; index: number; end: number }[] = [];
  let match: RegExpExecArray | null;

  while ((match = beatRegex.exec(markdown)) !== null) {
    matches.push({
      id: match[1]!,
      status: match[2] ?? null,
      label: match[3]!,
      index: match.index,
      end: match.index + match[0].length,
    });
  }

  if (matches.length === 0) {
    const { summary: chapterSummary, preamble: cleanPreamble } = extractChapterSummary(markdown);
    return { preamble: cleanPreamble, chapterSummary, blocks: [], postamble: "" };
  }

  const rawPreamble = markdown.slice(0, matches[0]!.index);
  const { summary: chapterSummary, preamble } = extractChapterSummary(rawPreamble);

  // Find where postamble starts: the <!-- /chapter --> marker after the last beat
  const lastMatch = matches[matches.length - 1]!;
  const chapterEndIdx = markdown.indexOf("<!-- /chapter -->", lastMatch.end);
  const contentEnd = chapterEndIdx !== -1 ? chapterEndIdx : markdown.length;
  const postamble = chapterEndIdx !== -1 ? markdown.slice(chapterEndIdx) : "";

  const blocks: BeatBlock[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i]!;
    const nextStart = i + 1 < matches.length ? matches[i + 1]!.index : contentEnd;
    const rawProse = markdown.slice(current.end, nextStart).trim();
    const { summary, prose } = extractBeatSummary(rawProse);
    blocks.push({ id: current.id, label: current.label, status: current.status, summary, prose });
  }

  return { preamble, chapterSummary, blocks, postamble };
}

function reassembleChapter(
  preamble: string,
  blocks: BeatBlock[],
  postamble: string,
  chapterSummary?: string | null
): string {
  let result = injectChapterSummary(preamble, chapterSummary ?? null);
  // Ensure preamble ends with a newline before first beat
  if (result.length > 0 && !result.endsWith("\n")) {
    result += "\n";
  }
  const emittedSummaries = new Set<string>();
  for (const block of blocks) {
    const status = block.status ?? "planned";
    result += `${buildBeatMarker(block.id, status, block.label)}\n`;
    // Emit summary comment only for the first block per beat ID (variant dedup)
    if (block.summary && !emittedSummaries.has(block.id)) {
      result += `${buildSummaryBlock(block.summary)}\n`;
      emittedSummaries.add(block.id);
    }
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

  const updated = reassembleChapter(parsed.preamble, kept, parsed.postamble, parsed.chapterSummary);
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

  // Insert the new block after the last occurrence (variant — no summary)
  const existingBlock = parsed.blocks[lastIdx]!;
  const newBlock: BeatBlock = { id: beatId, label, status: existingBlock.status, summary: null, prose: content };
  parsed.blocks.splice(lastIdx + 1, 0, newBlock);

  return reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble, parsed.chapterSummary);
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
  process.env["FRACTAL_TEMPLATES_ROOT"] ?? join(import.meta.dirname, "..", "templates")
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
    if (shouldIgnore(entry)) continue;
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
      `Template "${templateId}" not found. Use template(action='list') to see available templates.`
    );
  }
  return readJson<ProjectTemplate>(templatePath);
}

export async function saveTemplate(template: ProjectTemplate): Promise<void> {
  await mkdir(TEMPLATES_ROOT, { recursive: true });
  const templatePath = join(TEMPLATES_ROOT, `${template.id}.json`);
  await writeJson(templatePath, template);
}

export async function applyTemplateToProject(
  projectId: string,
  template: ProjectTemplate
): Promise<{ root: string; created_dirs: string[]; guide_updated: boolean; changed_files: string[] }> {
  const root = projectRoot(projectId);
  const changedFiles: string[] = [];

  // Create any missing canon directories
  const createdDirs: string[] = [];
  for (const ct of template.canon_types) {
    const dir = join(root, "canon", ct.id);
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true });
      createdDirs.push(`canon/${ct.id}`);
    }
  }

  // Update canon_types in project.json (merge — keep existing, add new)
  const projectJsonPath = join(root, "project.json");
  const projectData = await readJson<ProjectData>(projectJsonPath);
  const existingIds = new Set((projectData.canon_types ?? []).map(ct => ct.id));
  let typesAdded = false;
  for (const ct of template.canon_types) {
    if (!existingIds.has(ct.id)) {
      projectData.canon_types = [...(projectData.canon_types ?? []), ct];
      typesAdded = true;
    }
  }
  if (typesAdded) {
    await writeJson(projectJsonPath, projectData);
    changedFiles.push("project.json");
  }

  // Write or overwrite GUIDE.md
  let guideUpdated = false;
  if (template.guide) {
    await writeMd(join(root, "GUIDE.md"), template.guide);
    changedFiles.push("GUIDE.md");
    guideUpdated = true;
  }

  return { root, created_dirs: createdDirs, guide_updated: guideUpdated, changed_files: changedFiles };
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
      if (!entry.isDirectory() || entry.name.startsWith(".") || shouldIgnore(entry.name)) continue;
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
    throw new Error(`Part "${partId}" does not exist. Create it first with create(target='part').`);
  }

  // Create the slim meta sidecar (navigation index only)
  const metaPath = join(partDir, `${chapterId}.meta.json`);
  const slimMeta: SlimChapterMeta = {
    title,
    pov,
    location,
    timeline_position: timelinePosition,
    beats: [],
  };
  await writeJson(metaPath, slimMeta);

  // Create the chapter prose file with title, optional chapter-summary, and closing marker
  const mdPath = join(partDir, `${chapterId}.md`);
  const chapterSummaryComment = summary ? buildChapterSummaryBlock(summary) : "";
  const mdContent = chapterSummaryComment
    ? `# ${title}\n${chapterSummaryComment}\n\n<!-- /chapter -->\n`
    : `# ${title}\n\n<!-- /chapter -->\n`;
  await writeMd(mdPath, mdContent);

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

// Slim sidecar — only fields the tool needs for indexing
interface SlimBeatMeta {
  id: string;
  characters: string[];
  dirty_reason: string | null;
}

interface SlimChapterMeta {
  title: string;
  pov: string;
  location: string;
  timeline_position: string;
  beats: SlimBeatMeta[];
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

/**
 * Read chapter metadata by merging markdown (source of truth for summaries,
 * labels, status) with the slim JSON sidecar (characters, dirty_reason, pov,
 * location, timeline). Falls back gracefully if sidecar is missing.
 *
 * Also supports legacy full-fat meta files for backward compatibility.
 */
export async function getChapterMeta(projectId: string, partId: string, chapterId: string): Promise<ChapterMeta> {
  const root = projectRoot(projectId);
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);

  // Parse markdown for beat structure and summaries
  let mdBeats: BeatBlock[] = [];
  let chapterSummary: string | null = null;
  let chapterTitle = chapterId;
  if (existsSync(mdPath)) {
    const markdown = await readMd(mdPath);
    const parsed = parseBeatsGrouped(markdown);
    mdBeats = parsed.blocks;
    chapterSummary = parsed.chapterSummary;
    // Extract title from heading
    const headingMatch = parsed.preamble.match(/^#\s+(.+)$/m);
    if (headingMatch) chapterTitle = headingMatch[1]!;
  }

  // Read sidecar if it exists
  let sidecar: Record<string, unknown> | null = null;
  if (existsSync(metaPath)) {
    sidecar = await readJson<Record<string, unknown>>(metaPath);
  }

  // Determine if this is a legacy full-fat meta or slim meta
  // Legacy metas have beats with "summary" and "label" fields
  const sidecarBeats = (sidecar?.beats as Array<Record<string, unknown>>) ?? [];
  const isLegacyMeta = sidecarBeats.length > 0 && sidecarBeats[0] && ("summary" in sidecarBeats[0] || "label" in sidecarBeats[0]);

  if (isLegacyMeta && mdBeats.length === 0) {
    // Pure legacy mode — no markdown beats yet, return as-is from JSON
    return sidecar as unknown as ChapterMeta;
  }

  // Build beat index from sidecar
  const sidecarBeatMap = new Map<string, Record<string, unknown>>();
  for (const b of sidecarBeats) {
    if (b.id) sidecarBeatMap.set(b.id as string, b);
  }

  // Deduplicate mdBeats by ID (variants share IDs — take first occurrence for metadata)
  const seenIds = new Set<string>();
  const uniqueMdBeats = mdBeats.filter(b => {
    if (seenIds.has(b.id)) return false;
    seenIds.add(b.id);
    return true;
  });

  // Merge: markdown wins for summary/label/status, sidecar wins for characters/dirty_reason
  const beats: BeatMeta[] = uniqueMdBeats.map(mdBeat => {
    const sb = sidecarBeatMap.get(mdBeat.id);
    return {
      id: mdBeat.id,
      label: mdBeat.label,
      summary: mdBeat.summary ?? (sb?.summary as string ?? ""),
      status: mdBeat.status ?? (sb?.status as string ?? "planned"),
      dirty_reason: (sb?.dirty_reason as string | null) ?? null,
      characters: (sb?.characters as string[]) ?? [],
      depends_on: (sb?.depends_on as string[]) ?? [],
      depended_by: (sb?.depended_by as string[]) ?? [],
    };
  });

  // Determine chapter-level status from beat statuses
  const hasDirty = beats.some(b => b.status === "dirty" || b.status === "conflict");
  const chapterStatus = hasDirty ? "dirty" : (sidecar?.status as string ?? "planning");

  return {
    title: (sidecar?.title as string) ?? chapterTitle,
    summary: chapterSummary ?? (sidecar?.summary as string ?? ""),
    pov: (sidecar?.pov as string) ?? "",
    location: (sidecar?.location as string) ?? "",
    timeline_position: (sidecar?.timeline_position as string) ?? "",
    status: chapterStatus,
    dirty_reason: (sidecar?.dirty_reason as string | null) ?? null,
    beats,
  };
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
// Notes files — planning workspace separate from scannable summaries
// ---------------------------------------------------------------------------

/**
 * Read part-level notes from part-XX.notes.md (if it exists).
 * Returns empty string if file doesn't exist (graceful degradation).
 */
export async function getPartNotes(projectId: string, partId: string): Promise<string> {
  const notesPath = join(projectRoot(projectId), "parts", `${partId}.notes.md`);
  if (!existsSync(notesPath)) return "";
  return readMd(notesPath);
}

/**
 * Read chapter-level notes from chapter-XX.notes.md (if it exists).
 * Returns empty string if file doesn't exist (graceful degradation).
 */
export async function getChapterNotes(projectId: string, partId: string, chapterId: string): Promise<string> {
  const notesPath = join(projectRoot(projectId), "parts", partId, `${chapterId}.notes.md`);
  if (!existsSync(notesPath)) return "";
  return readMd(notesPath);
}

/**
 * Write part-level notes to part-XX.notes.md.
 * Creates file if it doesn't exist.
 */
export async function writePartNotes(projectId: string, partId: string, content: string): Promise<WriteResult> {
  const notesPath = join(projectRoot(projectId), "parts", `${partId}.notes.md`);
  await writeMd(notesPath, content);
  return {
    path: notesPath,
    description: `Updated part notes: ${partId}`,
  };
}

/**
 * Write chapter-level notes to chapter-XX.notes.md.
 * Creates file if it doesn't exist.
 */
export async function writeChapterNotes(
  projectId: string,
  partId: string,
  chapterId: string,
  content: string
): Promise<WriteResult> {
  const notesPath = join(projectRoot(projectId), "parts", partId, `${chapterId}.notes.md`);
  await writeMd(notesPath, content);
  return {
    path: notesPath,
    description: `Updated chapter notes: ${partId}/${chapterId}`,
  };
}

// ---------------------------------------------------------------------------
// Canon path resolution — shared by getCanon, editCanon, updateCanon, etc.
// ---------------------------------------------------------------------------

/**
 * Resolve canon paths when the type directory is already known.
 * Checks directory format ({id}/brief.md) first, then flat ({id}.md).
 */
function resolveCanonPaths(
  basePath: string,
  id: string
): { mdPath: string; metaPath: string } | null {
  const dirBriefPath = join(basePath, id, "brief.md");
  if (existsSync(dirBriefPath)) {
    return { mdPath: dirBriefPath, metaPath: join(basePath, id, "meta.json") };
  }
  const flatMdPath = join(basePath, `${id}.md`);
  if (existsSync(flatMdPath)) {
    return { mdPath: flatMdPath, metaPath: join(basePath, `${id}.meta.json`) };
  }
  return null;
}

/**
 * Find a canon entry when the type is unknown — scans all canon type dirs.
 */
async function findCanonEntry(
  projectId: string,
  id: string
): Promise<{ mdPath: string; metaPath: string; type: string } | null> {
  const root = projectRoot(projectId);
  const types = await listCanonTypes(projectId);
  for (const type of types) {
    const paths = resolveCanonPaths(join(root, "canon", type), id);
    if (paths) return { ...paths, type };
  }
  return null;
}

// ---------------------------------------------------------------------------
// Canon reads
// ---------------------------------------------------------------------------

export async function getCanon(projectId: string, type: string, id: string): Promise<{ content: string; meta: unknown }> {
  const basePath = join(projectRoot(projectId), "canon", type);
  const paths = resolveCanonPaths(basePath, id);
  if (!paths) {
    throw new Error(`Canon entry "${type}/${id}" not found`);
  }
  const content = await readMd(paths.mdPath);
  let meta: unknown = null;
  if (existsSync(paths.metaPath)) {
    meta = await readJson(paths.metaPath);
  }
  return { content, meta };
}

export async function listCanon(projectId: string, type: string): Promise<string[]> {
  const dir = join(projectRoot(projectId), "canon", type);
  if (!existsSync(dir)) return [];
  const entries = await readdir(dir, { withFileTypes: true });
  const ids: string[] = [];
  for (const entry of entries) {
    if (shouldIgnore(entry.name) || entry.name.startsWith(".")) continue;
    if (entry.isFile() && entry.name.endsWith(".md") && !entry.name.endsWith(".meta.json")) {
      ids.push(entry.name.replace(/\.md$/, ""));
    } else if (entry.isDirectory()) {
      // Directory format: check for brief.md inside
      if (existsSync(join(dir, entry.name, "brief.md"))) {
        ids.push(entry.name);
      }
    }
  }
  return ids.sort();
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
    .filter((e) => e.isDirectory() && !e.name.startsWith(".") && !shouldIgnore(e.name))
    .map((e) => e.name)
    .sort();
}


// ---------------------------------------------------------------------------
// Canon section parsing — lazy-load sections by slug
// ---------------------------------------------------------------------------

export interface CanonSection {
  name: string;    // "Voice & Personality"
  id: string;      // "voice-personality"
  content: string; // Full text of section including header
}

export interface ParsedCanon {
  topMatter: string;
  sections: CanonSection[];
}

export function slugify(heading: string): string {
  return heading
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

export function splitMarkdownSections(markdown: string): ParsedCanon {
  const lines = markdown.split("\n");
  let topMatter = "";
  const sections: CanonSection[] = [];
  let currentSection: CanonSection | null = null;

  // Track slug counts for deduplication
  const slugCounts = new Map<string, number>();

  for (const line of lines) {
    const match = line.match(/^## (.+)$/);
    if (match) {
      if (currentSection) {
        currentSection.content = currentSection.content.trimEnd();
        sections.push(currentSection);
      }
      let slug = slugify(match[1]);
      const count = slugCounts.get(slug) ?? 0;
      slugCounts.set(slug, count + 1);
      if (count > 0) slug = `${slug}-${count + 1}`;
      currentSection = { name: match[1], id: slug, content: line + "\n" };
    } else if (currentSection) {
      currentSection.content += line + "\n";
    } else {
      topMatter += line + "\n";
    }
  }
  if (currentSection) {
    currentSection.content = currentSection.content.trimEnd();
    sections.push(currentSection);
  }

  return { topMatter: topMatter.trimEnd(), sections };
}

async function resolveCanon(
  projectId: string,
  id: string
): Promise<{ content: string; meta: unknown; type: string; sections: Array<{ name: string; id: string }> } | null> {
  const entry = await findCanonEntry(projectId, id);
  if (!entry) return null;

  const rawContent = await readMd(entry.mdPath);
  let meta: unknown = null;
  if (existsSync(entry.metaPath)) {
    meta = await readJson(entry.metaPath);
  }
  const parsed = splitMarkdownSections(rawContent);
  const content = parsed.sections.length > 0 ? parsed.topMatter : rawContent;
  const sections = parsed.sections.map(s => ({ name: s.name, id: s.id }));
  return { content, meta, type: entry.type, sections };
}

async function getCanonSection(
  projectId: string,
  entryId: string,
  sectionId: string
): Promise<{ content: string; type: string }> {
  const entry = await findCanonEntry(projectId, entryId);
  if (!entry) {
    throw new Error(`Canon entry "${entryId}" not found in any canon type`);
  }
  const rawContent = await readMd(entry.mdPath);
  const parsed = splitMarkdownSections(rawContent);
  const section = parsed.sections.find(s => s.id === sectionId);
  if (!section) {
    const available = parsed.sections.map(s => s.id).join(", ");
    throw new Error(`Section '${sectionId}' not found in ${entryId}. Available: ${available || "(none)"}`);
  }
  return { content: section.content, type: entry.type };
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
      if (shouldIgnore(entry.name)) continue;
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
 * Returns { annotations, warnings } — warnings surface corrupt/unparseable markup.
 */
export function parseAnnotations(
  markdown: string,
  partId: string,
  chapterId: string
): { annotations: ParsedAnnotation[]; warnings: AnnotationWarning[] } {
  const lines = markdown.split("\n");
  const annotations: ParsedAnnotation[] = [];
  const warnings: AnnotationWarning[] = [];
  let currentBeat = "none";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();

    // Track current beat
    const beatMatch = BEAT_MARKER_REGEX.exec(line);
    if (beatMatch) {
      currentBeat = beatMatch[1]!;
      continue;
    }

    // Check for annotation — single-line first
    let annoMatch = ANNOTATION_REGEX.exec(line);
    let endLine = i; // last line consumed by this annotation

    if (!annoMatch) {
      // Multi-line annotation: starts with <!-- @type but --> is on a later line
      const startMatch = ANNOTATION_START_REGEX.exec(line);
      if (startMatch) {
        // Scan forward for closing -->, but abort at structural boundaries
        let joined = line;
        let found = false;
        for (let j = i + 1; j < lines.length; j++) {
          const scanLine = lines[j]!.trim();
          // Abort if we hit a structural marker or another annotation/comment start
          if (BEAT_MARKER_REGEX.test(scanLine)) break;
          if (scanLine === "<!-- /chapter -->") break;
          if (ANNOTATION_START_REGEX.test(scanLine)) break;
          if (ANNOTATION_REGEX.test(scanLine)) break;
          joined += " " + scanLine;
          if (scanLine.includes("-->")) {
            endLine = j;
            found = true;
            break;
          }
        }
        if (found) {
          // Normalize whitespace and try to match as a single line
          const normalized = joined.replace(/\s+/g, " ").trim();
          annoMatch = ANNOTATION_REGEX.exec(normalized);
        }
        if (!annoMatch) {
          // Annotation-like start that couldn't be parsed — warn
          warnings.push({
            line: i + 1,
            beat: currentBeat,
            content: line,
            issue: found
              ? "Annotation comment could not be parsed after joining lines"
              : "Annotation start without closing -->",
          });
        }
      }
      if (!annoMatch) continue;
    }

    const lineNumber = i + 1; // 1-based
    const type = annoMatch[1]! as AnnotationType;
    const author = annoMatch[2] ?? "human";
    const message = annoMatch[3]?.replace(/\s*\n\s*/g, " ").trim() ?? null;

    // Context: scan for nearest non-empty, non-comment, non-marker prose line
    let before: string | null = null;
    for (let b = i - 1; b >= 0; b--) {
      const bLine = lines[b]!.trim();
      if (!bLine) continue;
      if (bLine.startsWith("<!--")) continue; // skip any HTML comment (annotations, briefs, etc.)
      if (BEAT_MARKER_REGEX.test(bLine)) break;
      before = bLine;
      break;
    }

    let after: string | null = null;
    for (let a = endLine + 1; a < lines.length; a++) {
      const aLine = lines[a]!.trim();
      if (!aLine) continue;
      if (aLine.startsWith("<!--")) continue; // skip any HTML comment
      if (BEAT_MARKER_REGEX.test(aLine)) break;
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

    // Skip past any extra lines consumed by a multi-line annotation
    if (endLine > i) i = endLine;
  }

  return { annotations, warnings };
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
 * Build an annotation HTML comment string, word-wrapped at ~80 columns.
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
  // Normalize whitespace — collapse any newlines/runs into single spaces
  const safeMessage = message?.replace(/\s+/g, " ").trim() ?? null;
  const singleLine = `<!-- @${type}${authorPart}: ${safeMessage} -->`;
  if (singleLine.length <= 80) return singleLine;

  // Word-wrap: first line has the prefix, continuation lines are plain text
  const prefix = `<!-- @${type}${authorPart}: `;
  const suffix = " -->";
  const words = (safeMessage ?? "").split(" ");
  const lines: string[] = [];
  let current = prefix;

  for (const word of words) {
    const candidate = current + (current === prefix ? "" : " ") + word;
    if (candidate.length > 80 && current !== prefix) {
      lines.push(current);
      current = word;
    } else {
      current = candidate;
    }
  }
  lines.push(current + suffix);
  return lines.join("\n");
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
  const allWarnings: AnnotationWarning[] = [];
  const versions: Record<string, string> = {};

  for (const { partId, chapterId } of chaptersToScan) {
    try {
      const mdPath = join(root, "parts", partId, `${chapterId}.md`);
      const markdown = await readMd(mdPath);
      const { annotations, warnings } = parseAnnotations(markdown, partId, chapterId);
      allNotes.push(...annotations);
      allWarnings.push(...warnings);

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
    warnings: allWarnings,
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

    // Verify each target line is actually an annotation and collect all lines to remove
    // (multi-line annotations may span multiple lines)
    const toRemove = new Set<number>();
    for (const ln of lineNumbers) {
      if (ln < 1 || ln > lines.length) {
        throw new Error(
          `Line ${ln} is out of range in ${partId}/${chapterId}. File has ${lines.length} lines.`
        );
      }
      const content = lines[ln - 1]!.trim();
      if (ANNOTATION_REGEX.test(content)) {
        // Single-line annotation
        toRemove.add(ln);
      } else if (ANNOTATION_START_REGEX.test(content)) {
        // Multi-line annotation: scan forward for closing -->, stop at structural boundaries
        toRemove.add(ln);
        for (let j = ln; j < lines.length; j++) {
          const scanLine = lines[j]!.trim();
          if (BEAT_MARKER_REGEX.test(scanLine)) break;
          if (scanLine === "<!-- /chapter -->") break;
          toRemove.add(j + 1);
          if (scanLine.includes("-->")) break;
        }
      } else {
        throw new Error(
          `Line ${ln} is not an annotation: '${content}'. Notes may have shifted — re-read with get_notes.`
        );
      }
    }

    // Filter out annotation lines
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

// ---------------------------------------------------------------------------
// Migration: legacy meta → markdown-first format
// ---------------------------------------------------------------------------

/**
 * Migrate a chapter from legacy full-fat .meta.json to markdown-first format.
 * Reads summaries/labels/status from legacy JSON, writes them into the .md file
 * as structured comments, then slims the .meta.json to navigation-only data.
 *
 * Returns the list of modified file paths.
 */
export async function migrateChapterToMarkdownFirst(
  projectId: string,
  partId: string,
  chapterId: string
): Promise<string[]> {
  const root = projectRoot(projectId);
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);

  if (!existsSync(metaPath)) return [];

  const legacyMeta = await readJson<Record<string, unknown>>(metaPath);
  const legacyBeats = (legacyMeta.beats as Array<Record<string, unknown>>) ?? [];

  // Check if already migrated (slim format — no "summary" or "label" on beats,
  // and no chapter-level "summary" field in sidecar)
  const beatsAreSlim = legacyBeats.length === 0 || (!("summary" in legacyBeats[0]!) && !("label" in legacyBeats[0]!));
  const chapterSummaryInSidecar = "summary" in legacyMeta;

  // Also check markdown for legacy comments that need cleanup
  const markdown = existsSync(mdPath) ? await readMd(mdPath) : `# ${legacyMeta.title ?? chapterId}\n\n<!-- /chapter -->\n`;
  const hasLegacyComments = /<!--\s*chapter-brief\s*\[/.test(markdown) || /<!--\s*beat-brief:\S+\s*\[/.test(markdown);

  if (beatsAreSlim && !chapterSummaryInSidecar && !hasLegacyComments) {
    return []; // Already migrated
  }
  const parsed = parseBeatsGrouped(markdown);

  // Inject chapter summary from legacy meta
  const chapterSummary = (legacyMeta.summary as string) ?? "";
  if (chapterSummary && !parsed.chapterSummary) {
    parsed.chapterSummary = chapterSummary;
  }

  // Build index of legacy beat data
  const legacyBeatMap = new Map<string, Record<string, unknown>>();
  for (const lb of legacyBeats) {
    if (lb.id) legacyBeatMap.set(lb.id as string, lb);
  }

  // Update existing blocks with legacy data
  for (const block of parsed.blocks) {
    const lb = legacyBeatMap.get(block.id);
    if (!lb) continue;
    // Inject label if it differs from the legacy one
    if (lb.label && typeof lb.label === "string") block.label = lb.label;
    // Inject status
    if (lb.status && typeof lb.status === "string") block.status = lb.status;
    // Inject summary
    if (lb.summary && typeof lb.summary === "string" && !block.summary) {
      block.summary = lb.summary;
    }
  }

  // Add any beats that are in meta but not in markdown (planned beats with no marker)
  const existingIds = new Set(parsed.blocks.map(b => b.id));
  for (const lb of legacyBeats) {
    if (existingIds.has(lb.id as string)) continue;
    parsed.blocks.push({
      id: lb.id as string,
      label: (lb.label as string) ?? "",
      status: (lb.status as string) ?? "planned",
      summary: (lb.summary as string) ?? "",
      prose: "",
    });
  }

  // Reassemble and write markdown
  const updated = reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble, parsed.chapterSummary);
  await writeMd(mdPath, updated);

  // Slim the sidecar
  const slimMeta: SlimChapterMeta = {
    title: (legacyMeta.title as string) ?? chapterId,
    pov: (legacyMeta.pov as string) ?? "",
    location: (legacyMeta.location as string) ?? "",
    timeline_position: (legacyMeta.timeline_position as string) ?? "",
    beats: legacyBeats.map(lb => ({
      id: lb.id as string,
      characters: (lb.characters as string[]) ?? [],
      dirty_reason: (lb.dirty_reason as string | null) ?? null,
    })),
  };
  await writeJson(metaPath, slimMeta);

  return [mdPath, metaPath];
}

// ---------------------------------------------------------------------------

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
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];

  // Read current state from merged view
  const current = await getChapterMeta(projectId, partId, chapterId);

  // Merge beats
  let mergedBeats = current.beats;
  if (patch.beats) {
    mergedBeats = current.beats.map((currentBeat) => {
      const patchBeat = patch.beats!.find((pb) => pb.id === currentBeat.id);
      return patchBeat ? { ...currentBeat, ...patchBeat } : currentBeat;
    });
  }

  // --- Update markdown file (summaries, labels, status) ---
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  if (existsSync(mdPath)) {
    const markdown = await readMd(mdPath);
    const parsed = parseBeatsGrouped(markdown);

    // Update chapter summary in preamble
    const newChapterSummary = patch.summary ?? current.summary;
    if (newChapterSummary !== parsed.chapterSummary) {
      parsed.chapterSummary = newChapterSummary || null;
    }

    // Update beat blocks from merged data
    for (const block of parsed.blocks) {
      const beatData = mergedBeats.find(b => b.id === block.id);
      if (!beatData) continue;
      // Update label, status, summary from the merged beat data
      if (patch.beats) {
        const patchBeat = patch.beats.find(pb => pb.id === block.id);
        if (patchBeat) {
          if (patchBeat.label !== undefined) block.label = patchBeat.label;
          if (patchBeat.status !== undefined) block.status = patchBeat.status;
          if (patchBeat.summary !== undefined) block.summary = patchBeat.summary;
        }
      }
    }

    const updated = reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble, parsed.chapterSummary);
    await writeMd(mdPath, updated);
    results.push({ path: mdPath, description: `Updated ${partId}/${chapterId}.md` });
  }

  // --- Update slim sidecar (characters, dirty_reason, pov, location, timeline) ---
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  const slimMeta: SlimChapterMeta = {
    title: patch.title ?? current.title,
    pov: patch.pov ?? current.pov,
    location: patch.location ?? current.location,
    timeline_position: patch.timeline_position ?? current.timeline_position,
    beats: mergedBeats.map(b => ({
      id: b.id,
      characters: b.characters,
      dirty_reason: b.dirty_reason,
    })),
  };
  await writeJson(metaPath, slimMeta);
  results.push({ path: metaPath, description: `Updated ${partId}/${chapterId}.meta.json` });

  return results;
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

  // Write beat marker + summary to markdown
  const mdPath = join(root, "parts", partId, `${chapterId}.md`);
  const markdown = await readMd(mdPath);
  const updated = addBeatMarkerToMarkdown(
    markdown, beatDef.id, beatDef.status ?? "planned",
    beatDef.label, beatDef.summary, afterBeatId
  );
  await writeMd(mdPath, updated);

  // Add slim entry to sidecar
  const slimBeat: SlimBeatMeta = {
    id: beatDef.id,
    characters: beatDef.characters,
    dirty_reason: beatDef.dirty_reason,
  };
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  let sidecar: SlimChapterMeta;
  if (existsSync(metaPath)) {
    sidecar = await readJson<SlimChapterMeta>(metaPath);
  } else {
    sidecar = { title: chapterId, pov: "", location: "", timeline_position: "", beats: [] };
  }
  if (afterBeatId) {
    const idx = sidecar.beats.findIndex((b) => b.id === afterBeatId);
    sidecar.beats.splice(idx + 1, 0, slimBeat);
  } else {
    sidecar.beats.push(slimBeat);
  }
  await writeJson(metaPath, sidecar);

  return [
    { path: mdPath, description: `Added beat ${beatDef.id} to ${chapterId}.md` },
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

  // Update slim sidecar — remove the beat entry
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  if (existsSync(metaPath)) {
    const sidecar = await readJson<SlimChapterMeta>(metaPath);
    sidecar.beats = sidecar.beats.filter((b: SlimBeatMeta) => b.id !== beatId);
    await writeJson(metaPath, sidecar);
    results.push({ path: metaPath, description: `Removed beat ${beatId} from ${chapterId}.meta.json` });
  }

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

  // Reorder sidecar beats
  const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
  if (existsSync(metaPath)) {
    const sidecar = await readJson<SlimChapterMeta>(metaPath);
    const sidecarBeatMap = new Map(sidecar.beats.map((b: SlimBeatMeta) => [b.id, b]));
    sidecar.beats = beatOrder
      .filter(id => sidecarBeatMap.has(id))
      .map(id => sidecarBeatMap.get(id)!);
    await writeJson(metaPath, sidecar);
    results.push({ path: metaPath, description: `Reordered beats in ${partId}/${chapterId}.meta.json` });
  }

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

  const updated = reassembleChapter(parsed.preamble, newBlocks, parsed.postamble, parsed.chapterSummary);
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

  const updated = reassembleChapter(parsed.preamble, newBlocks, parsed.postamble, parsed.chapterSummary);
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
  notes?: { scope?: string; type?: string; author?: string };
  scratch_index?: boolean;
  canon_list?: string | boolean;
  part_notes?: string[];
  chapter_notes?: string[];
}

export async function getContext(
  projectId: string,
  include: ContextInclude
): Promise<Record<string, unknown>> {
  const response: Record<string, unknown> = {};
  const errors: Record<string, string> = {};

  async function fetchAll<T>(
    refs: string[],
    fetcher: (ref: string) => Promise<T>,
    key: string,
  ): Promise<void> {
    const result: Record<string, T> = {};
    await Promise.all(refs.map(async (ref) => {
      try {
        result[ref] = await fetcher(ref);
      } catch (err) {
        errors[`${key}:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(result).length > 0) response[key] = result;
  }

  // Canon — resolve type automatically; supports # for section-level lazy loading
  if (include.canon && include.canon.length > 0) {
    const canon: Record<string, unknown> = {};
    await Promise.all(include.canon.map(async (ref) => {
      try {
        // Section notation: "emmy#voice-personality" → entry "emmy", section "voice-personality"
        const hashIdx = ref.indexOf("#");
        if (hashIdx !== -1) {
          const entryId = ref.slice(0, hashIdx);
          const sectionId = ref.slice(hashIdx + 1);
          const result = await getCanonSection(projectId, entryId, sectionId);
          canon[ref] = { content: result.content, type: result.type };
          return;
        }
        // Summary + TOC fetch
        const result = await resolveCanon(projectId, ref);
        if (result) {
          // When sections exist, add fetch hints so agents know how to drill down
          if (result.sections.length > 0) {
            const enriched = {
              ...result,
              sections: result.sections.map(s => ({ ...s, fetch: `${ref}#${s.id}` })),
              _hint: `Only top-matter is shown. To fetch a section, include '${ref}#<section-id>' in the canon array.`,
            };
            canon[ref] = enriched;
          } else {
            canon[ref] = result;
          }
        } else {
          errors[`canon:${ref}`] = `Canon entry "${ref}" not found in any canon type`;
        }
      } catch (err) {
        errors[`canon:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(canon).length > 0) response.canon = canon;
  }

  // Scratch files
  if (include.scratch?.length) {
    await fetchAll(include.scratch, (f) => getScratch(projectId, f), "scratch");
  }

  // Parts
  if (include.parts?.length) {
    await fetchAll(include.parts, (id) => getPart(projectId, id), "parts");
  }

  // Chapter meta
  if (include.chapter_meta?.length) {
    await fetchAll(include.chapter_meta, async (ref) => {
      const { partId, chapterId } = parseChapterRef(ref);
      return getChapterMeta(projectId, partId, chapterId);
    }, "chapter_meta");
  }

  // Chapter prose — returns { prose, version } to match get_chapter_prose tool
  if (include.chapter_prose && include.chapter_prose.length > 0) {
    const chapterProse: Record<string, unknown> = {};
    await Promise.all(include.chapter_prose.map(async (ref) => {
      try {
        const { partId, chapterId } = parseChapterRef(ref);
        const prose = await getChapterProse(projectId, partId, chapterId);
        const root = projectRoot(projectId);
        const relPath = join("parts", partId, `${chapterId}.md`);
        const { getFileVersion } = await import("./git.js");
        const version = await getFileVersion(root, relPath);
        chapterProse[ref] = { prose, version };
      } catch (err) {
        errors[`chapter_prose:${ref}`] = err instanceof Error ? err.message : String(err);
      }
    }));
    if (Object.keys(chapterProse).length > 0) response.chapter_prose = chapterProse;
  }

  // Individual beats
  if (include.beats?.length) {
    await fetchAll(include.beats, async (ref) => {
      const { partId, chapterId, beatId } = parseBeatRef(ref);
      return getBeatProse(projectId, partId, chapterId, beatId);
    }, "beats");
  }

  // Beat variants
  if (include.beat_variants?.length) {
    await fetchAll(include.beat_variants, async (ref) => {
      const { partId, chapterId, beatId } = parseBeatRef(ref);
      return (await getBeatVariants(projectId, partId, chapterId, beatId)).variants;
    }, "beat_variants");
  }

  // Dirty nodes
  if (include.dirty_nodes) {
    try {
      response.dirty_nodes = await getDirtyNodes(projectId);
    } catch (err) {
      errors["dirty_nodes"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Project meta — enriched with canon_types_active and has_guide
  if (include.project_meta) {
    try {
      const projectData = await getProject(projectId);
      const canonTypesActive = await listCanonTypes(projectId);
      const root = projectRoot(projectId);
      const hasGuide = existsSync(join(root, "GUIDE.md"));
      response.project_meta = { ...projectData, canon_types_active: canonTypesActive, has_guide: hasGuide };
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

  // Notes — inline annotations with optional filters
  if (include.notes) {
    try {
      const { scope, type, author } = include.notes;
      response.notes = await getAnnotations(projectId, scope, type, author);
    } catch (err) {
      errors["notes"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Scratch index
  if (include.scratch_index) {
    try {
      response.scratch_index = await getScratchIndex(projectId);
    } catch (err) {
      errors["scratch_index"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Canon list — true for type listing, string for entries within a type
  if (include.canon_list !== undefined && include.canon_list !== false) {
    try {
      if (include.canon_list === true) {
        response.canon_list = await listCanonTypes(projectId);
      } else {
        response.canon_list = await listCanon(projectId, include.canon_list);
      }
    } catch (err) {
      errors["canon_list"] = err instanceof Error ? err.message : String(err);
    }
  }

  // Part notes — planning workspace at part level
  if (include.part_notes?.length) {
    await fetchAll(include.part_notes, (partId) => getPartNotes(projectId, partId), "part_notes");
  }

  // Chapter notes — planning workspace at chapter level
  if (include.chapter_notes?.length) {
    await fetchAll(include.chapter_notes, async (ref) => {
      const { partId, chapterId } = parseChapterRef(ref);
      return getChapterNotes(projectId, partId, chapterId);
    }, "chapter_notes");
  }

  if (Object.keys(errors).length > 0) {
    response.errors = errors;
  }

  return response;
}

// ---------------------------------------------------------------------------
// Surgical string editing — shared by beat prose and canon edits
// ---------------------------------------------------------------------------

function applyEdits(
  text: string,
  edits: { old_str: string; new_str: string }[],
  ref: string
): { text: string; changes: { old_str: string; new_str: string; context: string }[] } {
  const changes: { old_str: string; new_str: string; context: string }[] = [];

  for (const edit of edits) {
    const firstIdx = text.indexOf(edit.old_str);
    if (firstIdx === -1) {
      const preview = edit.old_str.length > 100 ? edit.old_str.slice(0, 100) + "..." : edit.old_str;
      throw new Error(`No match for old_str in ${ref}: "${preview}"`);
    }

    const secondIdx = text.indexOf(edit.old_str, firstIdx + 1);
    if (secondIdx !== -1) {
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
        `old_str matches ${count} locations in ${ref}. Include more context to make it unique: "${preview}"`
      );
    }

    const before = text.slice(Math.max(0, firstIdx - 50), firstIdx);
    const afterStart = firstIdx + edit.old_str.length;
    const after = text.slice(afterStart, afterStart + 50);
    const context = `...${before}${edit.new_str}${after}...`;

    text = text.slice(0, firstIdx) + edit.new_str + text.slice(firstIdx + edit.old_str.length);
    changes.push({ old_str: edit.old_str, new_str: edit.new_str, context });
  }

  return { text, changes };
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

  // Apply edits atomically — nothing touches disk until all pass
  const target = variantEntries[variantIndex]!;
  const { text, changes } = applyEdits(target.block.prose, edits, `beat ${beatId}`);

  // All edits passed — update the block and write to disk
  parsed.blocks[target.idx]! = { ...target.block, prose: text };
  const updated = reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble, parsed.chapterSummary);
  await writeMd(mdPath, updated);

  return {
    result: { path: mdPath, description: `Applied ${edits.length} edit(s) to ${partId}/${chapterId}:${beatId}` },
    edits_applied: edits.length,
    changes,
  };
}

export async function setNodeStatus(
  projectId: string,
  nodeRef: string,
  status: "dirty" | "clean",
  reason?: string
): Promise<WriteResult[]> {
  const root = projectRoot(projectId);
  const results: WriteResult[] = [];
  const parts = nodeRef.split("/");
  const partId = parts[0]!;
  const isDirty = status === "dirty";
  const desc = isDirty ? `dirty: ${reason}` : "clean";

  if (parts.length === 1) {
    // Part-level dirty/clean
    const part = await getPart(projectId, partId);
    part.status = isDirty ? "dirty" : "clean";
    part.dirty_reason = isDirty ? reason! : null;
    const path = join(root, "parts", partId, "part.json");
    await writeJson(path, part);
    results.push({ path, description: `Marked ${partId} ${desc}` });
  } else {
    const chapterBeat = parts[1]!;
    const [chapterId, beatId] = chapterBeat.split(":");

    if (!beatId) {
      // Chapter-level dirty/clean — dirty_reason stays in sidecar
      const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
      if (existsSync(metaPath)) {
        const sidecar = await readJson<Record<string, unknown>>(metaPath);
        sidecar.dirty_reason = isDirty ? reason! : null;
        await writeJson(metaPath, sidecar);
        results.push({ path: metaPath, description: `Marked ${partId}/${chapterId} ${desc}` });
      }
    } else {
      // Beat-level dirty/clean — update status in markdown, dirty_reason in sidecar
      const beatStatus = isDirty ? "dirty" : "written";

      // Update beat marker status in markdown
      const mdPath = join(root, "parts", partId, `${chapterId}.md`);
      if (existsSync(mdPath)) {
        const markdown = await readMd(mdPath);
        const parsed = parseBeatsGrouped(markdown);
        for (const block of parsed.blocks) {
          if (block.id === beatId) {
            block.status = beatStatus;
          }
        }
        const updated = reassembleChapter(parsed.preamble, parsed.blocks, parsed.postamble, parsed.chapterSummary);
        await writeMd(mdPath, updated);
        results.push({ path: mdPath, description: `Marked ${partId}/${chapterId}:${beatId} ${desc} in markdown` });
      }

      // Update dirty_reason in sidecar
      const metaPath = join(root, "parts", partId, `${chapterId}.meta.json`);
      if (existsSync(metaPath)) {
        const sidecar = await readJson<SlimChapterMeta>(metaPath);
        const sidecarBeat = sidecar.beats.find((b: SlimBeatMeta) => b.id === beatId);
        if (sidecarBeat) {
          sidecarBeat.dirty_reason = isDirty ? reason! : null;
          await writeJson(metaPath, sidecar);
          results.push({ path: metaPath, description: `Updated dirty_reason for ${beatId} in sidecar` });
        }
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

  const existing = resolveCanonPaths(basePath, id);
  const mdPath = existing?.mdPath ?? join(basePath, `${id}.md`);
  const metaPath = existing?.metaPath ?? join(basePath, `${id}.meta.json`);
  const isDir = existing ? mdPath.endsWith("brief.md") : false;
  const label = isDir ? `canon/${type}/${id}/brief.md` : `canon/${type}/${id}.md`;
  const metaLabel = isDir ? `canon/${type}/${id}/meta.json` : `canon/${type}/${id}.meta.json`;

  await writeMd(mdPath, content);
  results.push({ path: mdPath, description: `Updated ${label}` });
  if (meta) {
    await writeJson(metaPath, meta);
    results.push({ path: metaPath, description: `Updated ${metaLabel}` });
  }

  return results;
}

export async function editCanon(
  projectId: string,
  type: string,
  id: string,
  edits: { old_str: string; new_str: string }[]
): Promise<{
  result: WriteResult;
  edits_applied: number;
  changes: { old_str: string; new_str: string; context: string }[];
}> {
  const root = projectRoot(projectId);
  const basePath = join(root, "canon", type);
  const paths = resolveCanonPaths(basePath, id);
  if (!paths) {
    throw new Error(`Canon entry "${type}/${id}" not found`);
  }
  const mdPath = paths.mdPath;

  // Empty edits → no-op
  if (edits.length === 0) {
    return {
      result: { path: mdPath, description: `No edits applied to canon/${type}/${id}` },
      edits_applied: 0,
      changes: [],
    };
  }

  // Read and apply edits atomically
  const raw = await readMd(mdPath);
  const { text, changes } = applyEdits(raw, edits, `canon/${type}/${id}`);

  // All edits passed — write to disk
  await writeMd(mdPath, text);

  return {
    result: { path: mdPath, description: `Applied ${edits.length} edit(s) to canon/${type}/${id}` },
    edits_applied: edits.length,
    changes,
  };
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
