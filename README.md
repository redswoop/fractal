# Fractal

A narrative management system exposed as an MCP server. Claude connects to it — via Claude.ai custom connectors or Claude Code — and gets structured tools for building, editing, and maintaining long-form fiction.

The file format is plain markdown + JSON sidecars. If the tool disappears, you're left with a readable manuscript in folders. Nothing is locked in.

## Why this exists

LLMs are good at writing prose. They're bad at writing *novels*. The failure mode isn't quality — it's coherence. By chapter 20, the AI has forgotten what it established in chapter 3. A character's eye color drifts. A plot thread gets dropped. The timeline contradicts itself.

Fractal solves this by giving the AI **structured memory** for your story. Canon files define characters, locations, and world rules. Beat-level tracking means the AI always knows where it is in the narrative. Dirty propagation means when you change a character detail, every scene featuring that character gets flagged for review.

You talk to Claude in natural language. Claude talks to Fractal through MCP tools. You never touch JSON or worry about file structure — but if you open the project folder, it's all just readable markdown.

## What it does

Fractal manages **projects** — each one a novel, novella, or other long-form work. Each project contains:

- **Parts** and **chapters** with beat-level structure
- **Canon** — character sheets, locations, and any genre-specific types (factions, items, systems, relationships — whatever your story needs). Plain markdown.
- **Templates** — genre presets that configure which canon types a project starts with (fiction, worldbuilding, LitRPG, fanfic), or start with the default and add types as you go
- **Scratch** — loose scenes, dialogue riffs, ideas without a home yet
- **Dirty tracking** — when canon changes, downstream beats get flagged for review
- **Inline annotations** — notes, queries, continuity flags embedded in prose
- **Git versioning** — every write auto-commits with a meaningful message

There are 12 consolidated tools covering reads, writes, search, structure manipulation, and session management.

## Examples

You talk to Claude normally. Claude calls Fractal tools behind the scenes. These examples use "Rust & Flour" — a story about a decommissioned factory robot who discovers baking.

### Starting a new project

> **You:** I want to write a story about a decommissioned factory robot who discovers baking and opens a bakery in a small town that doesn't want her there. Themes: reinvention, belonging, what counts as "alive."
>
> **Claude:** I'll set up the project structure.
>
> *creates project, canon entries for three characters, two locations, and a two-part chapter structure*
>
> Here's what I've built:
>
> **Rust & Flour** — "A decommissioned factory robot discovers baking and opens a bakery in a small town that doesn't want her there."
>
> **Part 1: Dough** (2 chapters)
> - Chapter 1: Ignition — Unit 7 finds the bakery. Marguerite offers to teach her.
> - Chapter 2: First Batch — Unit 7's first attempt. The bread is terrible. She doesn't understand why.
>
> **Part 2: Crust** (2 chapters)
> - Chapter 1: The Petition — Dale circulates a petition to ban Unit 7 from Main Street.
> - Chapter 2: Proof — Unit 7 bakes something perfect. The town shows up. Dale eats a roll.
>
> I've created character canon for Unit 7, Marguerite, and Dale, plus location files for the bakery and the factory. Want to review the character sheets before we start writing?

Behind the scenes that's `create(target='project')`, `create(target='part')` (x2), `create(target='chapter')` (x4), `write(target='canon')` (x5). You never see tool calls — just the conversation.

### Writing a scene

> **You:** Let's write chapter 1. Unit 7's POV. She's walked past the bakery nine times. Today she goes in. I want her voice to be flat and literal — she's a machine, she doesn't do metaphor.
>
> **Claude:** *reads Unit 7's canon, the bakery location file, and Marguerite's character sheet*
>
> I'll structure this as two beats:
> - b01: Unit 7 walks down Main Street. People stare. She doesn't understand why.
> - b02: She stops at the bakery window. Marguerite comes out and invites her in.
>
> *adds beats, then writes prose*
>
> Here's the opening:
>
> > Unit 7 walked down Main Street at 6:47 AM because that was when the bakery opened and she had calculated the optimal arrival time based on visible foot traffic patterns over the previous nine days of observation.
> >
> > People stared. This was not new. A woman pulled her child closer. A man in a pickup truck slowed down, then sped up. The barber stood in his doorway with his mouth open and his scissors still cutting air.
> >
> > Unit 7 did not understand why they stared. She was simply walking. She had verified that walking was legal.

Before writing, Claude loaded the canon files. It knows Unit 7 is 8 feet tall, speaks in declarative sentences, and takes everything literally. It knows Marguerite's voice is wry and patient. It won't contradict either.

### Editing without rewriting

> **You:** In chapter 2, beat 2, the line "You followed it like a machine" feels too cute. Can you rework just Marguerite's dialogue there?
>
> **Claude:** *reads beat b02 prose*
>
> Current exchange:
> > "You followed it like a machine."
> >
> > "I am a machine."
>
> *uses `edit(target='beat')` to surgically replace just those lines*
>
> Updated:
> > "You followed it. That's all you did."
> >
> > "Following the recipe is the task."
> >
> > "No. Following the recipe is the easy part."
>
> The rest of the beat is untouched.

`edit(target='beat')` does surgical find-and-replace within a single beat. No risk of accidentally changing prose in a different scene.

### Canon changes that ripple

> **You:** I want to change Marguerite's backstory. She's not dying of cancer — she's going blind. She can't read her own recipes anymore. That's why she needs someone with perfect precision.
>
> **Claude:** That's a significant canon change. Let me update her character file and trace the impact.
>
> *updates Marguerite's canon entry*
> *searches all written prose for scenes referencing Marguerite*
> *marks 2 beats as dirty:*
> - `part-01/chapter-01:b02` — "Marguerite's physical description; currently no mention of vision issues, but the 'looked up at Unit 7 the way you look up at a building' implies clear sight"
> - `part-01/chapter-02:b02` — "'The recipe is not the bread' scene; Marguerite tears bread and hands it over, no indication she's struggling to see"
>
> Want me to revise these beats now, or review the list first?

This is dirty tracking. Claude doesn't just update the character sheet — it flags every downstream scene that might be affected and explains *why*. You decide what actually needs rewriting.

### Exploring ideas in scratch

> **You:** I have this image of Unit 7 in standby mode at night, replaying the feeling of dough over and over. Like dreaming but she insists it isn't. I don't know where it goes yet.
>
> **Claude:** I'll save that to scratch.
>
> *adds to scratch folder with mood, character tags, and a note about potential placement*
>
> Saved as `unit7-dream-sequence.md`:
>
> > In standby mode, Unit 7's processors cycle through the day's sensory data. This is maintenance. This is not dreaming.
> >
> > But tonight the data loops. The flour. The way it felt between her joints. The moment the dough changed — went from paste to something alive under her hands.
> >
> > She replays this 4,771 times before morning.
> >
> > This is not dreaming. She is certain.
>
> Tagged as potential placement in Part 2. When we get there, I'll surface it.

Later, when you're writing Part 2:

> **Claude:** Before we start — you have a scratch file, `unit7-dream-sequence.md`, that I flagged as a potential fit here. Want to work it into the night-before-the-vote scene?

> **You:** Yes, put it between the baking scene and the morning scene.

> **Claude:** *adds a new beat b03 between b01 and b02, promotes the scratch content into it*

### Annotations — leaving notes in the prose

> **You:** Can you flag every place where Unit 7 says something that could be read as emotional? I want to track whether I'm making her too human too fast.
>
> **Claude:** *searches prose for Unit 7's dialogue and internal observations*
> *adds @continuity annotations at each location*
>
> Found 5 moments across 4 chapters:
> - Chapter 1, b02: "I would like to come in" — `@continuity: emotional marker 1/5, "would like" implies desire`
> - Chapter 2, b02: "wanted to catalogue" — `@continuity: emotional marker 2/5, "wanted" is new for her`
> - Chapter 2, b02: files under UNRESOLVED — `@continuity: emotional marker 3/5, she's bothered by not having an answer`
> - Part 2, Ch 2, b01: "the dough looked like it wanted it" — `@continuity: emotional marker 4/5, projecting desire onto material`
> - Part 2, Ch 2, b01: "This was not rational. She did it anyway." — `@continuity: emotional marker 5/5, first time she overrides her programming`
>
> The progression looks intentional — she goes from polite phrasing (1) to desire (2) to frustration (3) to projection (4) to defiance (5). That arc works. If anything, the jump between 3 and 4 could use one more beat.

Annotations are HTML comments in the prose — invisible in any markdown reader, visible in the editor, scannable by the tool.

### Picking between variants

> **You:** Write me two versions of the moment Dale eats the bread. One understated, one where he actually cries.
>
> **Claude:** *writes variant 1, then appends variant 2 using the variant system*
>
> **Variant A (understated):**
> > Dale took a roll from the basket. Bit into it. Chewed. Said nothing. Took another.
>
> **Variant B (he cries):**
> > Dale took a roll from the basket. Bit into it. Chewed. His jaw stopped. He looked down at the roll like it had said something to him. His eyes went wet and he turned away so no one would see, but Marguerite saw, and Unit 7's optical sensors saw, and probably everyone in the bakery saw.
>
> Both are saved in the chapter file. Pick one and I'll archive the other.

> **You:** Variant A. The understatement is the whole point.
>
> **Claude:** *selects variant A, archives variant B to scratch*
>
> Done. Variant B is in scratch if you change your mind.

### Mid-project status check

> **You:** Where are we?
>
> **Claude:** *reads project metadata, checks all statuses, pulls dirty nodes*
>
> **Rust & Flour** — 2 parts, 4 chapters
>
> | Part | Status | Written | Dirty | Planned |
> |------|--------|---------|-------|---------|
> | Part 1: Dough | In progress | 2/2 chapters | 1 dirty beat | — |
> | Part 2: Crust | In progress | 2/2 chapters | 0 | — |
>
> **Dirty beats (1):**
> - `part-01/chapter-01:b02` — Marguerite's canon changed (going blind, not dying)
>
> Want to clean that up?

### The ejectability promise

At any point, open the project folder:

```
rust-and-flour/
  project.json
  parts/
    part-01/
      part.json
      chapter-01.md      ← just prose, readable top to bottom
      chapter-01.meta.json
      chapter-02.md
      ...
  canon/
    characters/
      unit-7.md           ← plain markdown character sheet
      marguerite.md
      dale.md
    locations/
      the-bakery.md
      the-factory.md
  scratch/
    dale-backstory-riff.md
  .git/
```

Delete the server. Delete Claude. Open `chapter-01.md` in any text editor and read:

> Unit 7 walked down Main Street at 6:47 AM because that was when the bakery opened and she had calculated the optimal arrival time based on visible foot traffic patterns over the previous nine days of observation.

That's your story. The JSON files are structural metadata — useful but ignorable. The beat markers in the prose are HTML comments — invisible in any markdown renderer.

**Your story is never locked in.**

## Templates

Different genres need different canon structures. A LitRPG needs items and systems. A mystery needs evidence and suspect profiles. A romance might need relationship trackers.

Templates configure which canon types a project starts with:

| Template | Canon types | Good for |
|----------|------------|----------|
| `fiction-default` | characters, locations | Literary fiction, thrillers, memoir, most narratives |
| `worldbuilding` | characters, locations, factions, lore, systems | Epic fantasy, sci-fi, alternate history |
| `litrpg` | characters, locations, systems, factions, items | Progression fantasy, GameLit |
| `fanfic` | characters, locations, canon-deviations, original-additions | Stories set in existing universes |

Templates are scaffolding, not cages. You can always create new canon types on the fly — just call `write(target='canon')` with any type name and the directory is created automatically. A romance writer might start with `fiction-default` and add `relationships` and `sensory-palette` types as the story demands them.

Each template includes a GUIDE.md that explains when to use each canon type, readable via `get_context`.

## Quick start

```bash
# Install
npm ci

# Dev mode (auto-reloads)
npm run dev

# Production
npm run build && npm start

# Or with PM2
npm run build && pm2 start ecosystem.config.js
```

The server runs on port 3001 (override with `PORT` env var).

## Health check

```bash
curl http://localhost:3001/health
# {"status":"ok"}
```

## Connecting to Claude

### Claude.ai (custom connector)

1. Deploy behind HTTPS (reverse proxy — see below)
2. In Claude.ai: **+** → **Connectors** → **Add custom connector**
3. Enter `https://your-domain.com/mcp` as the server URL

### Claude Code (local)

Point your MCP config at the running server's `/mcp` endpoint.

## Environment

| Variable | Default | Description |
|----------|---------|-------------|
| `PORT` | `3001` | Server port |
| `FRACTAL_PROJECTS_ROOT` | `./projects` | Where project directories live |

## Project structure

```
src/
  server.ts   — MCP server, 12 consolidated tool registrations (Fastify + Streamable HTTP)
  store.ts    — Filesystem operations (read/write projects, chapters, canon, scratch)
  git.ts      — Auto-commit and session-commit helpers
templates/    — Genre presets (fiction-default, worldbuilding, litrpg, fanfic)
```

## Tools

The API is 12 consolidated tools. Six verb-based tools (`create`, `update`, `write`, `edit`, `remove`, `template`) use a `target` or `action` discriminator to dispatch to the right operation.

| Tool | Targets / Actions | Description |
|------|-------------------|-------------|
| `list_projects` | — | List all projects with status briefing (dirty nodes, open notes, last session) |
| `get_context` | — | Primary read tool — returns any combination of project data in one call. Supports: project_meta, parts, chapter_meta, chapter_prose, beats, beat_variants, canon (with `#section` notation), scratch, scratch_index, dirty_nodes, notes, canon_list, guide, search |
| `create` | project, part, chapter, beat, scratch, note | Create new entities across the project hierarchy |
| `update` | project, part, chapter, node | Update metadata; mark nodes dirty/clean with reasons |
| `write` | beat, canon | Write/replace content — beat prose, canon entries, or promote scratch into beats |
| `edit` | beat, canon | Surgical find/replace with atomic ordered edits |
| `remove` | beat, notes | Remove beats (prose archived to scratch) or resolve annotations |
| `template` | list, get, save, apply | Manage project templates (fiction, worldbuilding, LitRPG, fanfic) |
| `select_variant` | — | Choose one variant of a beat, archive the rest to scratch |
| `reorder_beats` | — | Reorder beats within a chapter (meta and prose updated together) |
| `session_summary` | — | Create a session-level git commit summarizing work accomplished |
| `refresh_summaries` | — | Regenerate chapter-brief and beat-brief comments from metadata |

## File format

Chapters are single markdown files with beat markers as HTML comments:

```markdown
<!-- beat:b01 | Unit 7 walks down Main Street -->
Unit 7 walked down Main Street at 6:47 AM...

<!-- beat:b02 | She enters the bakery -->
The woman behind the counter looked up...

<!-- /chapter -->
```

Beat markers are invisible in any markdown renderer but visible in the editor. Delete them and you have a clean manuscript. The full format spec is in `claude.md`.

## Reverse proxy (for remote deployment)

The server runs plain HTTP. Terminate HTTPS at your reverse proxy:

```nginx
server {
    listen 443 ssl;
    server_name mcp.yourdomain.com;

    ssl_certificate /path/to/fullchain.pem;
    ssl_certificate_key /path/to/privkey.pem;

    location / {
        proxy_pass http://127.0.0.1:3001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

## Testing

`test-templates.sh` is the comprehensive test suite (45 tests). See `CLAUDE.md` for testing rules.
