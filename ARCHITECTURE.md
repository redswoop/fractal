# Fractal — Architecture Reference

## Guiding Principle: Ejectability

If this tool vanishes tomorrow, you're left with **a folder of markdown files organized in directories, with some JSON sidecar files you can ignore**. The prose is always readable, always yours, never locked in. Every design decision below serves this constraint.

---

## The Core Decision: One File Per Chapter

Chapters are single markdown files. Not split into one-file-per-beat. Here's why:

- Without the tool, you can open `chapter-01.md` and **read the whole chapter**. It's just prose.
- Beats are marked with **HTML comments** inside the markdown. Any renderer ignores them. Any editor shows them as faint gray lines. They're structural annotations, not file boundaries.
- This means the story is always readable as a plain manuscript — top to bottom, chapter by chapter. The fractal structure is overlaid, not imposed.

If a chapter gets monstrously long, nothing stops you from splitting it. But the default is: one chapter, one file, readable.

---

## Directory Structure

```
rust-and-flour/
│
├── project.json                    ← the root. title, logline, status.
│
├── parts/
│   ├── part-01/
│   │   ├── part-01.notes.md        ← part-level planning notes (optional)
│   │   ├── part.json               ← part title, summary, arc description, status
│   │   ├── chapter-01.md           ← the prose (with beat markers)
│   │   ├── chapter-01.notes.md     ← chapter planning notes (optional)
│   │   ├── chapter-01.meta.json    ← slim navigation index (characters, dirty_reason, pov, location)
│   │   ├── chapter-02.md
│   │   ├── chapter-02.notes.md     ← (optional)
│   │   ├── chapter-02.meta.json
│   │   └── ...
│   ├── part-02/
│   │   └── ...
│   └── ...
│
├── canon/
│   ├── characters/
│   │   ├── unit-7/                  ← directory format (brief.md + meta.json)
│   │   │   ├── brief.md            ← the canon entry markdown
│   │   │   └── meta.json           ← tags, appears-in refs, last-updated
│   │   ├── marguerite.md           ← flat format (single file)
│   │   ├── marguerite.meta.json
│   │   └── ...
│   ├── locations/
│   │   ├── the-bakery.md
│   │   ├── the-bakery.meta.json
│   │   └── ...
│   ├── timeline.md                 ← chronological event reference
│   ├── rules.md                    ← world rules, constraints, "never do X"
│   └── themes.md                   ← thematic threads we're tracking
│
├── scratch/
│   ├── unit7-dream-sequence.md     ← a scene that doesn't have a home yet
│   ├── alternate-ending-idea.md    ← just a sketch
│   ├── dale-backstory-riff.md      ← raw dialogue we liked
│   └── scratch.json                ← index: what's here, any notes on where it might go
│
└── .git/                           ← just a git repo. the tool commits automatically.
                                      without the tool, it's still git. you have history.
```

### What you see without the tool
A perfectly normal project folder. Markdown files you can read. JSON files you can ignore. A git repo you can browse.

### What the tool sees
A fractal tree with state, dependencies, and zoom-level summaries it can render and I can query through MCP.

---

## The Prose File: Beat Markers & Summary Comments

The markdown file is the **source of truth for all narrative content**: prose, beat summaries, labels, status, and chapter summaries. A chapter file looks like this:

```markdown
# Chapter 1: Ignition
<!-- chapter-summary: Unit 7 walks down Main Street for the tenth
time. Today she goes into the bakery. Marguerite offers to teach
her. -->

<!-- beat:b01 [written] | Unit 7 walks down Main Street -->
<!-- summary: Unit 7 walks past the bakery for the tenth time.
People stare. She doesn't understand why — she has verified that
walking is legal. -->
Unit 7 walked down Main Street at 6:47 AM because that was when
the bakery opened and she had calculated the optimal arrival time
based on visible foot traffic patterns over the previous nine days
of observation.

People stared. This was not new.

<!-- beat:b02 [written] | Unit 7 enters the bakery -->
<!-- summary: Marguerite recognizes her. She's been watching Unit 7
walk past. She doesn't flinch — the first person in town who
doesn't. -->
The woman behind the counter looked up immediately. She did not
step back. She did not pull a child closer or speed up a pickup
truck.

"You're the one who's been walking past," she said.

<!-- beat:b03 [planned] | Marguerite offers to teach her -->
<!-- summary: Marguerite hands Unit 7 a roll and tells her to hold
it. Unit 7's sensors register warmth. Something she can't
categorize happens. -->

<!-- /chapter -->
```

### Beat marker format

```
<!-- beat:BEAT_ID [STATUS] | LABEL -->
```

The beat ID is a local identifier (unique within the chapter). Status is one of `planned`, `written`, `dirty`, or `conflict`. The label is a human-readable signpost so you can scan the file and know where you are.

### Summary comment format

```
<!-- summary: FULL BEAT SUMMARY TEXT -->
```

Placed immediately after the beat marker, before prose. Word-wrapped at ~80 columns for readability. Contains the complete beat summary — no truncation. The parser strips these from prose when returning beat content via `get_context`.

### Chapter summary format

```
<!-- chapter-summary: FULL CHAPTER SUMMARY TEXT -->
```

Placed in the preamble after the `# Heading`. Word-wrapped at ~80 columns.

### Closing marker

The closing `<!-- /chapter -->` is optional but useful for parsing.

### Why HTML comments

- **Invisible in any markdown preview** (GitHub, Obsidian, VS Code, whatever)
- **Visible in the editor** so you can see the structure while writing
- **Parseable** by the tool with a trivial regex
- **Ignorable** — delete every comment and you have a clean manuscript
- **Not proprietary** — it's standard markdown/HTML

---

## Summary vs Notes: Separation of Concerns

**The problem:** Beat summaries were serving two conflicting purposes:
1. **Navigation** — understanding what happens when scanning/reordering beats
2. **Planning workspace** — dense ideation notes with psychology, themes, foreshadowing (500-700+ words)

This created bloat: scanning beats across chapters meant loading thousands of words of planning notes you didn't need.

**The solution:** Separate files with distinct purposes.

### Summaries (in .md files)

Summaries remain as `<!-- summary: ... -->` comments in chapter markdown files. They are **scannable navigation** (1-3 sentences):

```markdown
<!-- beat:b05 [planned] | Vertical Club / Beekman Tower -->
<!-- summary: Emmy's first class at Vertical Club with Lexi. Locker
room education watching Lexi's containment ritual. Drinks at Beekman
Tower, New Year's invite. Outside, Emmy's nipples react to cold with
unusual intensity. Lexi notices unconsciously. -->
```

**Summary guidelines:**
- **Function over length:** Scannable in seconds, never explain "why" (that's for notes)
- **For written beats:** 1-3 sentences describing what happens (naturally ~25-65 words)
- **For planned beats:** Label expanded into sentences — what needs to happen, who's involved
- **Never:** Psychology, thematic analysis, foreshadowing, motivation beneath surface

### Notes (in .notes.md files)

Notes live in separate `.notes.md` files alongside chapter markdown:

```
parts/part-01/
  chapter-01.md           # Prose + markers + lightweight summaries
  chapter-01.notes.md     # Dense planning notes (optional)
  chapter-01.meta.json    # Navigation sidecar
```

Notes are **dense planning workspace** (500+ words typical) with:
- Psychology and character motivation
- Thematic analysis and symbolic purpose
- Foreshadowing and Chekhov's guns
- Research notes and timeline constraints
- Why this beat matters beneath the surface action

### Notes File Format

**Flexible markdown organization** — not prescribed structure:

```markdown
# Chapter Notes: The Audience

In this part, we basically break Emmy. Everything that happens serves
to push her inevitably towards the Bond.

# Growth Timeline

- Mid-December: First dose from Mira
- Dec 25: Already outgrown Christmas gift (DD → E/F)
- End of chapter: Pushing F

# Thematic Concerns

The golden period. Everything the dose touches turns golden. This is the trap.

## Beat b05 — Vertical Club / Beekman Tower

Mid-December. Emmy's first class at the Vertical Club on East 61st. Lexi's
domain — the dancer reinvented as trainer...

[Full 700-word planning analysis]

Thematic purpose: This beat plants Chekhov's nipples — the first symptom
everyone was too aroused to read.

# Parking Lot

- Need to place Marcus's "Where do you go?" line
- Research: Beekman Tower bar name in 1996?
```

**Key properties:**
- Proper markdown headers (`#`, `##`) for structure
- No prescribed organization — use what makes sense
- Beat sections optional, can mix with thematic/research sections
- Same file format for part-level and chapter-level notes

### Part-Level vs Chapter-Level Notes

**Part notes** (`part-01/part-01.notes.md`):
- Big-picture context for the entire part
- Thematic intentions and arc considerations
- Always relevant when working on any chapter in this part

**Chapter notes** (`chapter-01.notes.md`):
- Chapter-specific planning and detail
- Dense psychology, uncommitted details, research
- Specific to that chapter only

### Scoped Hierarchy

Notes are **properly scoped**:
- Part notes provide context for all chapters in the part
- Chapter notes are specific to that chapter
- When writing beat b05, consult: part notes + chapter notes + beat prose

### API Access

**Reading notes via get_context:**
```javascript
get_context({
  project: "velvet-bond",
  include: {
    part_notes: ["part-01"],              // Context for whole part
    chapter_notes: ["part-01/chapter-03"], // Chapter-specific thinking
    beats: ["part-01/chapter-03:b05"]     // The prose
  }
})
```

**Writing notes via write:**
```javascript
write({
  target: "part_notes",
  project: "velvet-bond",
  part_id: "part-01",
  content: "# Part Notes\n\nIn this part, we break Emmy..."
})

write({
  target: "chapter_notes",
  project: "velvet-bond",
  part_id: "part-01",
  chapter_id: "chapter-03",
  content: "# Chapter Notes\n\n# Growth Timeline\n\n..."
})
```

### Graceful Degradation

- Notes files are **optional** — not all chapters need them
- Missing `.notes.md` files return empty string (no errors)
- Projects without notes work unchanged
- Beats can add notes incrementally

### File Operations

Notes files are **carried along automatically**:
- Moving a chapter moves `.md`, `.notes.md`, and `.meta.json` together
- Reordering a part moves the entire folder (including `part-XX.notes.md`)
- File relationships preserved

### Annotations in Notes

Annotations work in `.notes.md` files using the same syntax as prose files:
```markdown
<!-- @dev(claude): Remember to check if this foreshadowing pays off in Part 3 -->
```

The annotation tools (`update_annotations`, etc.) accept `.notes.md` file paths.

---

## Inline Annotations

Annotations are editorial markers embedded in prose files:

```
<!-- @dev(claude): Check pacing here -->
```

### Format

```
<!-- @TYPE(AUTHOR): MESSAGE -->
```

Types: `note` (general), `dev` (structural), `line` (prose craft), `continuity` (consistency), `query` (question), `flag` (no message).

Author defaults to `claude` when created via the tool, `human` when hand-written.

### Wrapping

Long annotations are word-wrapped at ~80 columns for readability:

```
<!-- @dev(claude): This is a longer note about a pacing
problem that wraps naturally at word boundaries so each
line stays readable in a text editor -->
```

The parser handles both single-line and multi-line annotations transparently. Wrapping is output-only — the parser normalizes whitespace when reading.

### Warnings

When `get_context` returns notes, the response includes a `warnings` array. Warnings surface corrupt or unparseable annotation-like markup:

```json
{
  "notes": [...],
  "warnings": [
    {
      "line": 9,
      "beat": "b01",
      "content": "<!-- @dev: This comment has no closing tag",
      "issue": "Annotation start without closing -->"
    }
  ]
}
```

If warnings appear, the agent should fix the corrupt markup using `edit target=beat`.

### IDs

Annotation IDs are line-number-based: `part-01/chapter-03:b02:n47`. Since line numbers shift on edit, always re-read notes before removing them.

---

## The Meta Files

The prose file is the source of truth for all narrative content (prose, summaries, labels, status). The `.meta.json` sidecar is a **slim navigation index** — it holds only data that doesn't belong in prose: characters, dirty reasons, POV, location, timeline position.

### `project.json` (root)

```json
{
  "title": "Rust & Flour",
  "subtitle": null,
  "logline": "A decommissioned factory robot discovers baking and opens a bakery in a small town that doesn't want her there.",
  "status": "in-progress",
  "themes": ["reinvention", "belonging", "what counts as alive"],
  "parts": ["part-01", "part-02"]
}
```

### `part.json`

```json
{
  "title": "Part One: Dough",
  "summary": "Unit 7 discovers the bakery, meets Marguerite, and learns to bake. The town watches with suspicion.",
  "arc": "Setup — Unit 7 is capable but purposeless. The bakery gives her something to do. Marguerite gives her someone to learn from.",
  "status": "clean",
  "chapters": ["chapter-01", "chapter-02"]
}
```

### `chapter-NN.meta.json` (slim navigation index)

The sidecar holds only data that doesn't belong in prose. Summary, label, and status live in the markdown file via beat markers and summary comments.

```json
{
  "title": "Ignition",
  "pov": "unit-7",
  "location": "the-bakery",
  "timeline_position": "2045-03-14",
  "beats": [
    {
      "id": "b01",
      "characters": ["unit-7"],
      "dirty_reason": null
    },
    {
      "id": "b02",
      "characters": ["unit-7", "marguerite"],
      "dirty_reason": null
    },
    {
      "id": "b03",
      "characters": ["unit-7", "marguerite"],
      "dirty_reason": "prose not yet written"
    }
  ]
}
```

When reading chapter metadata via `get_context`, the tool merges the markdown (summaries, labels, status) with the sidecar (characters, dirty_reason) to present a complete view.

### Beat status values

Status is stored in the beat marker in the markdown file: `<!-- beat:b03 [planned] | label -->`.

| Status | Meaning |
|--------|---------|
| `planned` | Beat exists in the structure. Summary describes intent. No prose yet. |
| `written` | Prose exists and is consistent with the beat definition. |
| `dirty` | Something upstream changed. Prose may be inconsistent. Needs review. |
| `conflict` | A canon or dependency change directly contradicts this beat's content. |

### `dirty_reason`

When I mark something dirty, I say *why* (stored in the sidecar):

- `"marguerite.md canon updated: going blind, not dying"`
- `"chapter-02:b02 rewrote Unit 7's motivation, may affect this scene"`
- `"part-level arc revised, chapter summary may not align"`

This is how you (and I) triage. Not everything dirty is urgent.

---

## Canon Files

Canon entries are **plain markdown**, readable as-is. The meta sidecar tracks references. Entries support two formats: **flat** (a single file) and **directory** (brief.md inside a subdirectory).

**Flat format** — the default:
```
canon/characters/marguerite.md          # The canon entry
canon/characters/marguerite.meta.json   # Meta sidecar
```

**Directory format** — also supported:
```
canon/characters/unit-7/
├── brief.md              # The canon entry
└── meta.json             # Metadata sidecar
```

**Resolution order**: directory (`{id}/brief.md`) checked first, then flat file (`{id}.md`).

### Content Conventions

Use `##` sections to organize canon entries. Suggested structure:

- **Identity** — Who/what this is, key physical details
- **Voice** — How they talk, speech patterns
- **Current State** — Where they are right now in the story
- **Active Goals** — What they're trying to do
- **Key Dynamics** — Important relationships, described briefly

### Section-Level Lazy Loading

Canon entries with `##` headers support section-level fetching. When you request a canon entry, the response returns only the **top-matter** (text before the first `##`) plus a **sections TOC** listing available `##` headers with their slugified IDs. Fetch specific sections by appending `#slug` to the entry ID:

```
canon: ["emmy"]                        → summary + sections TOC
canon: ["emmy#voice-personality"]      → just the ## Voice & Personality section
canon: ["emmy#core", "emmy#arc-summary"]  → batch multiple sections
```

Section IDs are slugified from headers: `"Physical (Pre-Transformation)"` → `physical-pre-transformation`. The sections array in the response includes both display names and slugs:
```json
"sections": [
  { "name": "Core", "id": "core" },
  { "name": "Voice & Personality", "id": "voice-personality" }
]
```

If a canon file has no `##` headers, the full content is returned as before (backward compatible).

### Example: Flat Format

#### `canon/characters/marguerite.md`

```markdown
# Marguerite

## Core
- Bakery owner, 60s, weathered hands
- Has run the bakery for 30 years
- Recently diagnosed with macular degeneration (going blind)
```

#### `canon/characters/marguerite.meta.json`

```json
{
  "id": "marguerite",
  "type": "character",
  "role": "mentor",
  "appears_in": ["part-01/chapter-01:b02", "part-01/chapter-01:b03"],
  "last_updated": "2026-02-07T14:30:00Z"
}
```

### Example: Directory Format

#### `canon/characters/unit-7/brief.md`

```markdown
# Unit 7

## Identity
Decommissioned industrial robot, 8 feet tall. Lives above Marguerite's bakery.

## Voice
Literal, precise. Declarative sentences. No metaphor. Processes through data.

## Current State
Learning to bake. Town divided on her presence. Growing attached to Marguerite.

## Active Goals
- Find purpose after decommission
- Master bread dough hydration ratios

## Key Dynamics
- **Marguerite**: Teacher, reluctant friend. Anchors the story.
- **Sheriff Dale**: Suspicious, represents town resistance.

```

#### `canon/characters/unit-7/meta.json`

```json
{
  "id": "unit-7",
  "type": "character",
  "role": "protagonist",
  "appears_in": [
    "part-01/chapter-01:b01",
    "part-01/chapter-01:b02",
    "part-01/chapter-01:b03"
  ],
  "last_updated": "2026-02-07T14:30:00Z",
  "updated_by": "claude-conversation"
}
```

The `appears_in` list is what lets me answer "where does Unit 7 show up?" without scanning every file. I maintain this as we work. The tool can also rebuild it by scanning beat markers if it ever gets out of sync.

### Meta as Index

The meta sidecar is **derived navigation data**, not writing content. It exists so the tool can answer "where does X appear?" and "what type is Y?" without scanning every file.

- **What goes in meta**: `appears_in`, `role`, `type`, `last_updated`, `updated_by` — fields the tool needs for indexing and navigation
- **What goes in markdown**: Everything a human writing a scene would need — personality, voice, appearance, arc, constraints, relationships
- **`appears_in` is manually maintained** — updated as we work, no auto-sync currently. If it drifts from reality, the markdown is always right
- **If meta disappeared**, the story is fully intact. If the markdown disappeared, you've lost real writing. That asymmetry is the design

---

## The Scratch Folder

Not everything has a place yet. The scratch folder is the junk drawer — but an *indexed* junk drawer.

### What goes here
- Scenes you wrote that don't belong to a chapter yet
- Dialogue riffs
- "What if..." explorations
- Research notes
- Vibes, images described in words, tonal references

### `scratch/scratch.json`

```json
{
  "items": [
    {
      "file": "unit7-dream-sequence.md",
      "note": "Unit 7 in standby mode, replaying the feeling of dough. Like dreaming but she insists it isn't. Potential Part 2 opening.",
      "characters": ["unit-7"],
      "mood": "contemplative, mechanical yearning",
      "potential_placement": "part-02/chapter-01",
      "created": "2026-02-05"
    },
    {
      "file": "dale-backstory-riff.md",
      "note": "Raw dialogue — Dale at the town council meeting arguing against Unit 7. The anger is right but he needs a softer moment too.",
      "characters": ["dale"],
      "mood": "confrontational, underlying fear",
      "potential_placement": null,
      "created": "2026-02-07"
    }
  ]
}
```

When a scratch file finds its home, we move it (or absorb it into a chapter) and update the index. The file might not survive intact — maybe just a paragraph makes it into the final beat. That's fine. The scratch copy stays in git history.

---

## Versioning: Git Under the Hood

The entire project directory is a git repository. New projects default to **session-based commits** to keep git history clean and meaningful.

### Commit Modes

Projects have an `autoCommit` field in `project.json` (default: `false` for new projects):

**When `autoCommit: false` (recommended):**
- Individual operations (create, write, edit, etc.) do NOT commit
- Changes accumulate in git working tree
- Use `session_summary` tool to commit all changes with a meaningful message
- Results in clean git history: `[session] Created opening scene with hero waking up`

**When `autoCommit: true` (legacy/opt-in):**
- Every operation commits immediately
- Results in verbose history:
  ```
  [auto] Updated chapter-01 beats b01-b02 prose
  [auto] Canon update: marguerite.md — changed backstory
  [auto] Marked chapter-01 beats b02-b03 dirty
  ```

**Uncommitted changes visibility:**
- `list_projects` shows `uncommitted_files` and `uncommitted_count` for all projects
- `get_context` with `project_meta` includes uncommitted status
- Agents can see pending changes and prompt: "Want to commit these first, or continue?"

### What this gives you

- **Revert anything**: `git log`, find the commit, reset or checkout.
- **Diff anything**: "What changed in Chapter 8 since last week?"
- **Without the tool**: It's just git. You already know git.
- **Experiments**: `git branch experiment/dale-accepts-unit-7-early` — explore, merge or abandon.

### What this does NOT do

- No remote. This is local git only (unless you choose to push somewhere).
- No complex branching workflow. Trunk is the story. Branches are rare experiments.
- No merge conflicts to resolve (you're the only writer, I'm the only committer besides you).

---

## How Claude Interacts With All This (MCP Tools)

The MCP server exposes **12 consolidated tools**. Six verb-based tools (`create`, `update`, `write`, `edit`, `remove`, `template`) use a discriminator parameter (`target` or `action`) to dispatch to the right operation. This keeps the API small while covering all object types uniformly.

### `list_projects` — Entry point
- `list_projects()` → list all projects with status briefing (dirty nodes, open notes, last session)

### `template` — Template management (action discriminator)
- `template(action="list")` → list available project templates
- `template(action="get", template_id)` → return full template contents (canon types, themes, guide)
- `template(action="save", template_id, name, description, canon_types, ...)` → create or update a template
- `template(action="apply", project, template_id)` → apply/re-apply a template to an existing project

### `get_context` — Primary read tool
Returns any combination of project data in one call via the `include` object:
- `project_meta` — project.json enriched with `canon_types_active` and `has_guide`
- `parts` — part metadata by ID
- `chapter_meta` — chapter metadata by ref (`part-01/chapter-01`)
- `chapter_prose` — full prose with version token (`{prose, version}`)
- `beats` — individual beat prose by ref (`part-01/chapter-01:b01`)
- `beat_variants` — all variant blocks for a beat
- `canon` — canon entries by ID (type auto-resolved). Returns summary + sections TOC. Use `#` for section fetch: `emmy#voice-personality`
- `scratch` — scratch file content by filename
- `scratch_index` — scratch folder index
- `dirty_nodes` — all nodes flagged dirty/conflict
- `notes` — inline annotations with scope/type/author filters
- `canon_list` — list canon types (boolean) or entries within a type (string)
- `guide` — GUIDE.md content
- `search` — `{query, scope?}` full-text search across prose, canon, scratch (replaces the old standalone `search` tool)

### `create` — Create any object (target discriminator)
- `create(target="project", project, title, template?)` → bootstrap a new project with directories, starter files, git init
- `create(target="part", project, part_id, title, ...)` → create a new part directory with part.json
- `create(target="chapter", project, part_id, chapter_id, title, ...)` → create a new chapter (prose .md + .meta.json)
- `create(target="beat", project, part_id, chapter_id, beat, after_beat_id?)` → add a new beat to the structure
- `create(target="scratch", project, filename, content, note, ...)` → toss something in the scratch folder
- `create(target="note", project, part_id, chapter_id, line_number, note_type, message?)` → insert inline annotation

### `update` — Update metadata (target discriminator)
- `update(target="project", project, patch)` → update top-level metadata
- `update(target="part", project, part_id, patch)` → update part summary/arc/status
- `update(target="chapter", project, part_id, chapter_id, patch)` → update beat summaries, status, deps
- `update(target="node", project, node_ref, mark, reason?)` → set dirty/clean status on a node

### `write` — Write or replace content (target discriminator)
- `write(target="beat", project, part_id, chapter_id, beat_id, content, append?)` → insert/replace prose for a beat
- `write(target="beat", project, part_id, chapter_id, beat_id, source_scratch)` → promote scratch content into a beat
- `write(target="canon", project, type, id, content, meta?)` → write canon entry markdown (replaces entire file)

### `edit` — Surgical string replacements (target discriminator)
- `edit(target="beat", project, part_id, chapter_id, beat_id, edits, variant_index?)` → find/replace within a beat's prose
- `edit(target="canon", project, type, id, edits)` → find/replace within a canon entry

### `remove` — Delete objects (target discriminator)
- `remove(target="beat", project, part_id, chapter_id, beat_id)` → remove a beat (prose moves to scratch)
- `remove(target="notes", project, note_ids)` → batch-remove annotations by ID

### `select_variant` — Pick a beat variant
- `select_variant(project, part_id, chapter_id, beat_id, keep_index)` → keep one variant, archive rest to scratch

### `reorder_beats` — Reorder beats in a chapter
- `reorder_beats(project, part_id, chapter_id, beat_order)` → reorder beats; prose and summary comments travel with their beats

### `session_summary` — Session-level git commit
- `session_summary(project, message)` → create a session-level git commit summarizing work done

### `refresh_summaries` — Migrate to markdown-first format
- `refresh_summaries(project, part_id, chapter_id)` → migrate legacy chapter from full-fat sidecar to markdown-first format (injects summaries/labels/status into .md, slims sidecar to navigation index). Idempotent — no-op if already migrated.

### Git Commit Behavior
- **New projects** (`autoCommit: false`): Changes accumulate, commit via `session_summary`
- **Legacy projects** or opt-in (`autoCommit: true`): Every write operation commits immediately

---

## Zoom Level Rendering (What the App Shows)

The app reads markdown and meta files to render these views.

| Zoom Level | What's Visible | Data Source |
|------------|---------------|-------------|
| 0 — Project | Title, logline, parts as blocks with summaries | `project.json` + each `part.json` |
| 1 — Part | Part title/arc, chapters as cards with summaries | `part.json` + chapter `.md` (chapter-summary comment) + `.meta.json` (title) |
| 2 — Chapter | Chapter summary, beats as rows with labels + status indicators | chapter `.md` (beat markers with [status], summary comments) |
| 3 — Beat | Beat summary + context, prose visible | chapter `.md` (summary comment + prose) merged with `.meta.json` (characters, dirty_reason) |
| 4 — Prose | Full writing view, beat markers visible as subtle dividers | `chapter.md` raw |

Status colors propagate upward. If a beat is dirty, the chapter shows a yellow indicator. If multiple chapters have dirty beats, the part shows yellow. You see project health at every zoom level.

---

## What Makes This Work Without The Tool

Strip away the MCP server, the app, Claude, everything. What's left?

1. A folder of markdown files that **is your manuscript**, readable in order.
2. JSON files that describe structure — readable but ignorable.
3. A git repo with full history.
4. A `canon/` folder that's a perfectly functional reference wiki.
5. A `scratch/` folder of loose ideas.

You could finish the novel in VS Code and never miss the tool. That's the point.
