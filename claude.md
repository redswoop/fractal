# Fractal Narrative Project — Architecture Spec

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
│   │   ├── part.json               ← part title, summary, arc description, status
│   │   ├── chapter-01.md           ← the prose (with beat markers)
│   │   ├── chapter-01.meta.json    ← beat index, summaries, dirty states, deps
│   │   ├── chapter-02.md
│   │   ├── chapter-02.meta.json
│   │   └── ...
│   ├── part-02/
│   │   └── ...
│   └── ...
│
├── canon/
│   ├── characters/
│   │   ├── unit-7.md               ← readable character doc, plain markdown
│   │   ├── unit-7.meta.json        ← tags, appears-in refs, last-updated
│   │   ├── marguerite.md
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

## The Prose File: Beat Markers

A chapter file looks like this:

```markdown
# Chapter 1: Ignition

<!-- beat:b01 | Unit 7 walks down Main Street -->
Unit 7 walked down Main Street at 6:47 AM because that was when
the bakery opened and she had calculated the optimal arrival time
based on visible foot traffic patterns over the previous nine days
of observation.

People stared. This was not new.

<!-- beat:b02 | Unit 7 enters the bakery -->
The woman behind the counter looked up immediately. She did not
step back. She did not pull a child closer or speed up a pickup
truck.

"You're the one who's been walking past," she said.

<!-- beat:b03 | Marguerite offers to teach her -->
Marguerite set a roll on the counter. It was warm. Unit 7's
thermal sensors registered 41.2 degrees Celsius.

"Eat it," Marguerite said.

"I do not eat."

"Then hold it. Tell me what you feel."

<!-- /chapter -->
```

### Marker format

```
<!-- beat:BEAT_ID | SHORT_DESCRIPTION -->
...prose...
```

That's it. The beat ID is a local identifier (unique within the chapter). The short description is a human-readable label — it's *not* the summary (that lives in the meta file), it's just a signpost so you can scan the file and know where you are.

The closing `<!-- /chapter -->` is optional but useful for parsing.

### Why HTML comments

- **Invisible in any markdown preview** (GitHub, Obsidian, VS Code, whatever)
- **Visible in the editor** so you can see the structure while writing
- **Parseable** by the tool with a trivial regex
- **Ignorable** — delete every comment and you have a clean manuscript
- **Not proprietary** — it's standard markdown/HTML

---

## The Meta Files

Every content file has an optional `.meta.json` sidecar. The prose file is the source of truth for *content*. The meta file is the source of truth for *structure and state*.

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

### `chapter-NN.meta.json`

```json
{
  "title": "Ignition",
  "summary": "Unit 7 walks down Main Street for the tenth time. Today she goes into the bakery. Marguerite offers to teach her.",
  "pov": "unit-7",
  "location": "the-bakery",
  "timeline_position": "2045-03-14",
  "status": "clean",
  "beats": [
    {
      "id": "b01",
      "label": "Unit 7 walks down Main Street",
      "summary": "Unit 7 walks past the bakery for the tenth time. People stare. She doesn't understand why — she has verified that walking is legal.",
      "status": "written",
      "dirty_reason": null,
      "characters": ["unit-7"],
      "depends_on": [],
      "depended_by": ["chapter-01:b02"]
    },
    {
      "id": "b02",
      "label": "Unit 7 enters the bakery",
      "summary": "Marguerite recognizes her. She's been watching Unit 7 walk past. She doesn't flinch — the first person in town who doesn't.",
      "status": "written",
      "dirty_reason": null,
      "characters": ["unit-7", "marguerite"],
      "depends_on": ["chapter-01:b01"],
      "depended_by": ["chapter-01:b03", "chapter-02:b01"]
    },
    {
      "id": "b03",
      "label": "Marguerite offers to teach her",
      "summary": "Marguerite hands Unit 7 a roll and tells her to hold it. Unit 7's sensors register warmth. Something she can't categorize happens.",
      "status": "planned",
      "dirty_reason": "prose not yet written",
      "characters": ["unit-7", "marguerite"],
      "depends_on": ["chapter-01:b02"],
      "depended_by": ["chapter-02:b01"]
    }
  ]
}
```

### Beat status values

| Status | Meaning |
|--------|---------|
| `planned` | Beat exists in the structure. Summary describes intent. No prose yet. |
| `written` | Prose exists and is consistent with the beat definition. |
| `dirty` | Something upstream changed. Prose may be inconsistent. Needs review. |
| `conflict` | A canon or dependency change directly contradicts this beat's content. |

### `dirty_reason`

When I mark something dirty, I say *why*:

- `"marguerite.md canon updated: going blind, not dying"`
- `"chapter-02:b02 rewrote Unit 7's motivation, may affect this scene"`
- `"part-level arc revised, chapter summary may not align"`

This is how you (and I) triage. Not everything dirty is urgent.

---

## Canon Files

Canon files are **plain markdown**, readable as-is. The meta sidecar tracks references.

### `canon/characters/unit-7.md`

```markdown
# Unit 7

## Core
- Decommissioned industrial assembly robot, 8 feet tall
- Originally built for the Millhaven auto parts factory
- Decommissioned 18 months ago when the factory closed
- Currently without purpose or housing

## Personality
- Literal, precise, takes everything at face value
- Speaks in declarative sentences — no metaphor, no subtext
- Genuinely doesn't understand social cues, but observes everything
- Processes the world through data — counts, measures, categorizes

## Appearance
- Industrial frame, not designed to look human
- Hydraulic joints, optical sensors (not eyes)
- Flour-dusted after Chapter 2 onward

## Arc
- Starts purposeless — a machine without a task
- Baking gives her a task. The town's resistance gives her something harder: a reason to stay.
- Central tension: can a machine want something? And if she can, is she still a machine?

## Constraints
- She NEVER uses metaphor in narration or dialogue. Everything is literal.
- She doesn't understand emotions but she observes their effects precisely.
- She cannot eat. She experiences food through sensors (temperature, texture, chemical composition).
```

### `canon/characters/unit-7.meta.json`

```json
{
  "id": "unit-7",
  "type": "character",
  "role": "protagonist",
  "appears_in": [
    "part-01/chapter-01:b01",
    "part-01/chapter-01:b02",
    "part-01/chapter-01:b03",
    "part-01/chapter-02:b01",
    "part-01/chapter-02:b02"
  ],
  "last_updated": "2026-02-07T14:30:00Z",
  "updated_by": "claude-conversation"
}
```

The `appears_in` list is what lets me answer "where does Unit 7 show up?" without scanning every file. I maintain this as we work. The tool can also rebuild it by scanning beat markers if it ever gets out of sync.

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

The entire project directory is a git repository. The tool commits automatically with meaningful messages:

```
[auto] Updated chapter-01 beats b01-b02 prose
[auto] Canon update: marguerite.md — changed backstory to going blind
[auto] Marked chapter-01 beats b02-b03 dirty (upstream: marguerite canon change)
[auto] Promoted scratch/unit7-dream-sequence.md → part-02/chapter-01:b01
[session] Session with Claude — restructured Part 2 arc
```

The `[auto]` commits happen per-operation. The `[session]` commits are summaries I write at natural breakpoints — "here's what we did in this working session."

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

The MCP server exposes these operations. I call them from conversation.

### Read operations
- `get_project()` → returns `project.json` — the top-level view
- `get_part(part_id)` → returns `part.json` — part summary + chapter list
- `get_chapter_meta(part_id, chapter_id)` → returns the meta.json — beats, status, summaries
- `get_chapter_prose(part_id, chapter_id)` → returns the .md file — the actual text
- `get_beat_prose(part_id, chapter_id, beat_id)` → extracts just one beat's prose from the chapter file
- `get_canon(type, id)` → returns a canon file (character, location, etc.)
- `get_scratch_index()` → returns scratch.json
- `get_scratch(filename)` → returns a scratch file
- `search(query, scope?)` → full-text search across prose, canon, scratch (scope limits it)
- `get_dirty_nodes()` → returns all nodes with status != clean, with reasons

### Write operations
- `update_chapter_meta(part_id, chapter_id, patch)` → update beat summaries, status, deps
- `update_part(part_id, patch)` → update part summary/arc/status
- `update_project(patch)` → update top-level metadata
- `update_canon(type, id, content)` → rewrite a canon file
- `write_beat_prose(part_id, chapter_id, beat_id, content)` → insert/replace prose for a beat
- `add_beat(part_id, chapter_id, beat_def)` → add a new beat to the structure
- `remove_beat(part_id, chapter_id, beat_id)` → remove a beat (prose moves to scratch)
- `mark_dirty(node_ref, reason)` → flag a node as needing review
- `mark_clean(node_ref)` → clear dirty status after review
- `add_scratch(filename, content, note)` → toss something in the scratch folder
- `promote_scratch(filename, target)` → move scratch content into the narrative structure

### Every write operation triggers a git commit.

---

## Zoom Level Rendering (What the App Shows)

The app doesn't call Claude to render these. It reads the meta files directly.

| Zoom Level | What's Visible | Data Source |
|------------|---------------|-------------|
| 0 — Project | Title, logline, parts as blocks with summaries | `project.json` + each `part.json` |
| 1 — Part | Part title/arc, chapters as cards with summaries | `part.json` + each `chapter.meta.json` (title + summary only) |
| 2 — Chapter | Chapter summary, beats as rows with labels + status indicators | `chapter.meta.json` |
| 3 — Beat | Beat summary + context, prose visible | `chapter.meta.json` (beat entry) + parsed prose from `.md` |
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

---

## Testing

### Test Plan

`fractal-test-plan.md` contains a 9-phase verification suite. It uses a disposable test project
(`_fractal-test`, routed to `test-projects/` automatically by the `_` prefix) with a simple
two-part story ("Rust & Flour" — a robot opens a bakery).

### Two-Layer Testing Strategy

**Layer 1: Mechanical verification (Phases 0–7)** — Binary pass/fail. Call a tool, read
the result, compare to expected. Deterministic, a script could do these:
- Structure CRUD: create project/parts/chapters/beats, verify round-trip
- Canon CRUD: create characters/locations, verify content and listing
- Prose round-trip: write beat prose, read it back, verify exact match
- Scratch operations: add, promote to beat, remove beat (backup to scratch)
- Dirty tracking: mark dirty at beat/chapter/part level, verify reason, mark clean
- Search: scoped search (prose/canon/scratch), unscoped, empty results
- Error handling: nonexistent resources, duplicate IDs, invalid operations

**Layer 2: Inference verification (Phase 8)** — The agent reads the full story and makes
qualitative judgments no mechanical test can:
- Narrative coherence: does the story flow across chapters and parts?
- Voice-to-canon match: does Unit 7's prose match her canon voice description?
- Character consistency: same voice throughout, no drift
- Data bleeding: no text from one beat leaking into another
- Dependency validity: would reversing any beat pair break the story?
- Encoding integrity: no mojibake, no truncation, no artifacts

### When to Run Tests

**After any change to `src/store.ts`, `src/server.ts`, or `src/git.ts` — before committing:**

```bash
cd /workspace/fractal
npm run build                          # must succeed
# restart server on :3001 without auth (kill old process first)
FRINGE_PROJECTS_ROOT=/workspace/fractal/projects node dist/server.js &
bash test-templates.sh                 # all tests must pass
```

Do NOT commit or push until tests are green. Do NOT tell the user work is "done" without running tests. This is not optional.

For minor changes (typo fixes, comment updates), build check alone is sufficient.
For any change that touches tool logic, data handling, or file operations — run the full suite.