# Fractal Annotations System

## The Idea

Both human and Claude can leave inline annotations in prose files — marginalia that accumulates during reading passes. Notes live in the text, visible in the editor, tracked by git, parseable by the MCP server. The reading pass and the revision conversation are separate modes.

**Workflow:**
1. Claude writes (or human writes)
2. Claude does a read pass — annotates, doesn't touch prose
3. Human does a read pass — responds to Claude's notes, adds their own
4. Human opens chat, says "let's go through chapter 03"
5. Claude pulls all notes, they work through them together
6. Claude revises, notes get resolved as they go

---

## Annotation Syntax

Annotations are HTML comments with a structured prefix. They sit inline in the prose `.md` files, inside beat blocks, inheriting their structural location for free.

### Format

```
<!-- @{type}({author}): {message} -->
```

### Types

| Type | Keystroke | Use |
|------|-----------|-----|
| `@note` | `Ctrl+/` | General observation. "This feels off." |
| `@dev` | `Ctrl+Shift+1` | Developmental. Scene-level, structural. "Does this beat need to exist?" |
| `@line` | `Ctrl+Shift+2` | Line-level. Prose craft. "This sentence is clunky." |
| `@continuity` | `Ctrl+Shift+3` | Consistency with canon or earlier chapters. "Unit 7 was 8 feet tall in ch01 but 7 here." |
| `@query` | `Ctrl+Shift+4` | Genuine question for the other party. "Is this intentional?" |
| `@flag` | `Ctrl+.` | Wordless. Something's off, can't articulate yet. |

### Author Tag

- `human` — written by the human during a read pass
- `claude` — written by Claude during a read pass
- Omitted — defaults to `human` (keeps the fast path frictionless)

### Examples in Context

```markdown
<!-- beat:b02 | Unit 7's first attempt at bread -->
Unit 7 measured the flour to the milligram. She calibrated the water temperature
to 37.2 degrees. She followed every step in the recipe with the precision of a
machine that had assembled 4.2 million auto parts.
<!-- @line: "precision of a machine" is too on-the-nose. She IS a machine — the reader knows. -->

The dough did not rise.

"You killed the yeast," Marguerite said.
<!-- @flag -->

"The recipe specified 37 degrees."

"The recipe is not the bread."
<!-- @query(claude): Unit 7's temperature reading — is 37.2 her internal sensor precision? Establish this in the canon if so. -->

...

Unit 7 examined the flat, dense mass. Every parameter had been correct. The outcome was incorrect. This did not compute.
<!-- @dev(claude): This line is too generic robot-speak. Unit 7 is literal but she's not a cliché. She'd describe the specific failure, not reach for "does not compute." -->

...

"I will attempt the recipe again. The recipe will produce bread."
<!-- @continuity(claude): This certainty feels wrong for Unit 7 at this stage. She's just failed for the first time. In her canon, she processes failure as a data anomaly — she'd want to understand the variable she missed, not just retry. -->
```

### Rules

1. Annotations go on the line **after** the text they refer to
2. Annotations inside a beat block belong to that beat
3. `@flag` has no message — just marks a location
4. Author tag is parenthetical: `@note(claude)`, `@dev(human)`, or just `@note` (defaults to human)
5. Multi-line annotations: not supported. Keep it to one line. If you need more, write two annotations.
6. Annotations NEVER touch the prose itself. They're commentary. The prose stays clean between them.

---

## MCP Endpoints

### `get_notes`

Scan prose files for annotations. Return them with full structural context.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | yes | Project identifier |
| `scope` | string | no | Filter: `part-01`, `part-01/chapter-03`, or `part-01/chapter-03:b02` |
| `type` | string | no | Filter by annotation type: `note`, `dev`, `line`, `continuity`, `query`, `flag` |
| `author` | string | no | Filter: `human`, `claude` |

**Returns:**
```json
{
  "notes": [
    {
      "id": "n001",
      "type": "continuity",
      "author": "claude",
      "message": "Unit 7 was 8 feet tall in ch01 but described as 7 feet here",
      "location": {
        "part": "part-01",
        "chapter": "chapter-03",
        "beat": "b02",
        "line_number": 47
      },
      "context": {
        "before": "She climbed the four flights to her door, calves burning.",
        "after": "The key stuck in the lock the way it always did."
      }
    }
  ],
  "summary": {
    "total": 12,
    "by_type": { "dev": 3, "line": 4, "continuity": 2, "query": 1, "flag": 2 },
    "by_author": { "human": 7, "claude": 5 }
  }
}
```

The `context` field gives the prose line immediately before and after the annotation — enough for Claude to orient without pulling the whole chapter.

### `add_note`

Claude adds an annotation inline during a read pass.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | yes | Project identifier |
| `part_id` | string | yes | Part |
| `chapter_id` | string | yes | Chapter |
| `beat_id` | string | yes | Beat |
| `type` | string | yes | `note`, `dev`, `line`, `continuity`, `query`, `flag` |
| `message` | string | no | The note text (optional for `flag`) |
| `after_text` | string | yes | Unique prose snippet to anchor the note after. Must match exactly once within the beat. |

**Behavior:** Finds `after_text` in the beat's prose, inserts the annotation on the next line. Author is automatically set to `claude`.

**Returns:**
```json
{
  "id": "n003",
  "inserted_after_line": 47,
  "location": "part-01/chapter-03:b02"
}
```

### `resolve_note`

Remove a specific annotation after it's been addressed.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | yes | Project identifier |
| `note_id` | string | yes | Note ID from `get_notes` |

**Behavior:** Deletes the annotation line from the prose file. Gone. Git remembers it if you ever need it back.

### `resolve_notes`

Batch resolve. For when you've worked through a bunch and want to clean up.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | yes | Project identifier |
| `note_ids` | string[] | yes | Array of note IDs to resolve |

### `read_pass`

The big one. Claude reads a chapter (or beat, or part) and annotates it — checking against canon, looking at pacing, flagging issues. Does NOT modify prose.

**Parameters:**
| Param | Type | Required | Description |
|-------|------|----------|-------------|
| `project` | string | yes | Project identifier |
| `scope` | string | yes | What to read: `part-01/chapter-03` or `part-01/chapter-03:b02` |
| `focus` | string[] | no | What to look for: `continuity`, `pacing`, `voice`, `structure`, `all`. Default: `all` |

**Behavior:** This isn't really one MCP call — it's a *workflow*. Claude:
1. Pulls the prose for the scope
2. Pulls relevant canon (characters present, locations)
3. Reads through, identifies issues
4. Calls `add_note` for each issue found
5. Returns a summary of what was annotated

This could be implemented as a single compound tool on the server, or as a convention where the human says "do a read pass on chapter 03" and Claude orchestrates it from the chat side using existing tools + `add_note`. The latter is simpler to build and more flexible.

**Recommended approach:** Don't build `read_pass` as a tool. Just document the workflow pattern. Claude already has `get_chapter_prose`, `get_canon`, and (once built) `add_note`. The "read pass" is a prompt pattern, not an endpoint.

---

## VS Code Keybindings

Add to `keybindings.json` (or `.devcontainer/keybindings.json`):

```json
[
  {
    "key": "ctrl+/",
    "command": "editor.action.insertSnippet",
    "args": { "snippet": "<!-- @note: $1 -->\n" },
    "when": "editorTextFocus && resourceExtname == .md"
  },
  {
    "key": "ctrl+shift+1",
    "command": "editor.action.insertSnippet",
    "args": { "snippet": "<!-- @dev: $1 -->\n" },
    "when": "editorTextFocus && resourceExtname == .md"
  },
  {
    "key": "ctrl+shift+2",
    "command": "editor.action.insertSnippet",
    "args": { "snippet": "<!-- @line: $1 -->\n" },
    "when": "editorTextFocus && resourceExtname == .md"
  },
  {
    "key": "ctrl+shift+3",
    "command": "editor.action.insertSnippet",
    "args": { "snippet": "<!-- @continuity: $1 -->\n" },
    "when": "editorTextFocus && resourceExtname == .md"
  },
  {
    "key": "ctrl+shift+4",
    "command": "editor.action.insertSnippet",
    "args": { "snippet": "<!-- @query: $1 -->\n" },
    "when": "editorTextFocus && resourceExtname == .md"
  },
  {
    "key": "ctrl+.",
    "command": "editor.action.insertSnippet",
    "args": { "snippet": "<!-- @flag -->\n" },
    "when": "editorTextFocus && resourceExtname == .md"
  }
]
```

### Notes on Keybindings

- `Ctrl+/` is normally "toggle line comment" in VS Code. This override only fires in `.md` files, so it won't affect code editing. If you want to preserve the default, use `Ctrl+Shift+/` instead for `@note`.
- `Ctrl+.` is normally "quick fix." Same deal — only overridden in markdown. If this bugs you, `Ctrl+;` is a good alternative.
- Human-authored notes don't include `(human)` — they're just `@note:` — because brevity matters during flow. The MCP parser treats missing author as `human`.
- `@flag` has no tab stop. It just drops and you keep moving.

### Snippet Alternatives

If you'd rather not override keybindings, you can use VS Code's user snippet system instead. Add to your markdown snippets:

**File:** `.vscode/markdown.code-snippets`
```json
{
  "Annotation: Note": {
    "prefix": "//n",
    "body": "<!-- @note: $1 -->",
    "description": "Inline note annotation"
  },
  "Annotation: Dev": {
    "prefix": "//d",
    "body": "<!-- @dev: $1 -->",
    "description": "Developmental annotation"
  },
  "Annotation: Line": {
    "prefix": "//l",
    "body": "<!-- @line: $1 -->",
    "description": "Line-level annotation"
  },
  "Annotation: Continuity": {
    "prefix": "//c",
    "body": "<!-- @continuity: $1 -->",
    "description": "Continuity annotation"
  },
  "Annotation: Query": {
    "prefix": "//q",
    "body": "<!-- @query: $1 -->",
    "description": "Query annotation"
  },
  "Annotation: Flag": {
    "prefix": "//f",
    "body": "<!-- @flag -->",
    "description": "Wordless flag"
  }
}
```

Type `//n` + Tab → annotation appears, cursor inside. Slightly more keystrokes than the keybinding approach but zero conflicts.

---

## Parsing Rules for the MCP Server

The server needs to extract annotations from prose files. Here's the spec:

### Regex Pattern

```
/^<!-- @(note|dev|line|continuity|query|flag)(?:\((\w+)\))?(?::\s*(.*?))?\s*-->$/
```

**Captures:**
1. `type` — note, dev, line, continuity, query, flag
2. `author` — human, claude, or null (treat null as human)
3. `message` — the note text, or null for flags

### Location Inference

The parser walks the file top to bottom. It tracks:
- Current beat (from `<!-- beat:XXX | ... -->` markers)
- Line number

Each annotation inherits the current beat context. An annotation before the first beat marker is a chapter-level note (rare but legal).

### Note IDs

Generated at parse time, not stored in the file. Format: `{chapter_id}:{beat_id}:n{line_number}` — e.g., `chapter-03:b02:n47`. Stable enough for a single session. If lines shift between sessions (because prose was edited), IDs may change — that's fine, notes are ephemeral anchors, not permanent records.

---

## Interaction Patterns

### "What are my notes?"

```
Human: What notes do I have?
Claude: [calls get_notes for the project]
Claude: You've got 12 notes across 3 chapters. 4 line notes, 3 dev notes,
        2 continuity flags, 1 query, and 2 wordless flags. Want to start
        with a specific chapter, or work through them in order?
```

### "Do a read pass"

```
Human: Do a read pass on chapter 03. Focus on continuity.
Claude: [pulls chapter-03 prose]
Claude: [pulls canon for unit-7, marguerite, and the-bakery]
Claude: [reads through, calls add_note for each issue]
Claude: Done. I added 4 continuity notes to chapter 03. The big one is
        Unit 7's height — she's described as 7 feet in b02 but 8 feet in her canon.
        Also flagged a timeline issue with Marguerite's vision — she reads a
        recipe label in b03 but she's going blind.
```

### "Let's work through chapter 03"

```
Human: Let's work through the chapter 03 notes.
Claude: [calls get_notes scoped to chapter-03]
Claude: First one — you flagged the "precision of a machine" line in b02
        as too on-the-nose. I agree. She IS a machine — the reader knows.
        Want me to try a revision, or do you have something in mind?
```

### "Resolve as we go"

```
Human: That revision works. Next note.
Claude: [calls resolve_note on the one just addressed]
Claude: Next — I flagged this in b02: "This certainty feels wrong for
        Unit 7 at this stage." The line is "The recipe will produce bread."
        She'd want to understand the variable she missed, not just retry.
```

---

## What This Doesn't Do (Yet)

- **Visual gutter markers.** Would need a VS Code extension. Nice to have, not required.
- **Note threading.** No reply chains. If you want to respond to Claude's note, edit it or add a new one below it.
- **Priority/severity.** Notes are all equal. If you want priority, the type system (`@dev` vs `@line`) is your coarse filter.
- **Annotation on canon files.** Currently prose-only. Could extend to character/location files later.
- **Auto-continuity scanning.** Claude does it manually during a read pass. A background job that continuously scans would be cool but is a different architecture.

---

## Implementation Order

1. **Keybindings / snippets** — 5 minutes. Install and start using immediately.
2. **`get_notes`** — The critical MCP endpoint. Parse annotations, return structured data.
3. **`add_note`** — Claude can annotate. Enables the read pass workflow.
4. **`resolve_note` / `resolve_notes`** — Cleanup. Simple string deletion.
5. **Iterate** — Use it for real, see what's missing.
