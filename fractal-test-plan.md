# Fractal MCP — Test Plan

> **Purpose:** Systematic verification of every Fractal MCP tool. Creates a throwaway test project with a simple story, exercises all CRUD operations, verifies round-trip integrity, tests error handling, and finishes with inference-based quality checks.
>
> **IMPORTANT:** This test suite must run against a **separate projects root** — not the production root containing `velvet-bond` or any real work. Configure the Fractal server's `PROJECTS_ROOT` (or equivalent) to point at a temporary directory before running. If that's not possible, the test project `_fractal-test` should be treated as disposable and deleted after the run.

---

## THE TEST STORY

We're using a deliberately simple, two-part story so the structure is easy to verify mechanically. The story is called **"Rust & Flour"** — a robot opens a bakery.

### Story Bible (for reference during verification)

**Title:** Rust & Flour
**Logline:** A decommissioned factory robot discovers baking and opens a bakery in a small town that doesn't want her there.
**Themes:** reinvention, belonging, what counts as "alive"

**Characters:**
- **Unit 7** (protagonist): Retired industrial robot, 8 feet tall, learns to bake. Speaks in short declarative sentences. Doesn't understand metaphor.
- **Marguerite** (mentor): 70-year-old French baker, dying, needs someone to take over her shop. Sees something in Unit 7.
- **Dale** (antagonist): Town selectman, wants the robot gone. Not evil — just scared.

**Locations:**
- **The Bakery**: Marguerite's shop, "Flour & Salt", Main Street, fictional town of Millhaven, Vermont
- **The Factory**: Abandoned auto plant where Unit 7 was made. Now her home.

**Part 1: "Dough"** (2 chapters)
- Chapter 1: "Ignition" — Unit 7 finds the bakery. Marguerite offers to teach her.
- Chapter 2: "First Batch" — Unit 7's first attempt. The bread is terrible. She doesn't understand why.

**Part 2: "Crust"** (2 chapters)
- Chapter 1: "The Petition" — Dale circulates a petition to ban Unit 7 from Main Street.
- Chapter 2: "Proof" — Unit 7 bakes something perfect. The town shows up. Dale eats a roll.

---

## PHASE 0: PREREQUISITES

- [ ] Fractal server is running
- [ ] Projects root is pointed at a **temporary/test directory**, NOT production
- [ ] Verify connectivity: call `hello` with name "test-runner"
- [ ] Expected response contains "Hello from Fractal"

---

## PHASE 1: PROJECT & STRUCTURE CREATION

### 1.1 — Create Project

```
Tool: create_project
Args: project="_fractal-test", title="Rust & Flour"
```

**Verify:**
```
Tool: get_project
Args: project="_fractal-test"
```
- [ ] `title` == "Rust & Flour"
- [ ] `status` exists (any value)
- [ ] `parts` is empty array or exists

### 1.2 — Update Project Metadata

```
Tool: update_project
Args: project="_fractal-test"
Patch: {
  "logline": "A decommissioned factory robot discovers baking and opens a bakery in a small town that doesn't want her there.",
  "status": "in-progress",
  "themes": ["reinvention", "belonging", "what counts as alive"],
  "parts": ["part-01", "part-02"]
}
```

**Verify:**
```
Tool: get_project
Args: project="_fractal-test"
```
- [ ] `logline` contains "decommissioned factory robot"
- [ ] `themes` has 3 entries
- [ ] `parts` == `["part-01", "part-02"]`

### 1.3 — Create Parts

```
Tool: create_part
Args: project="_fractal-test", part_id="part-01", title="Part 1: Dough"
      summary="Unit 7 finds the bakery and tries to learn."
      arc="Discovery → failure → the question of why she cares"
```

```
Tool: create_part
Args: project="_fractal-test", part_id="part-02", title="Part 2: Crust"
      summary="The town pushes back. Unit 7 pushes through."
      arc="Resistance → persistence → acceptance (grudging)"
```

**Verify each:**
```
Tool: get_part (for each)
```
- [ ] part-01: title == "Part 1: Dough", summary contains "finds the bakery"
- [ ] part-02: title == "Part 2: Crust", summary contains "pushes back"

### 1.4 — Create Chapters

Create 4 chapters total:

| Part | Chapter | Title | POV | Location | Timeline |
|------|---------|-------|-----|----------|----------|
| part-01 | chapter-01 | Ignition | unit-7 | the-bakery | day-01 |
| part-01 | chapter-02 | First Batch | unit-7 | the-bakery | day-03 |
| part-02 | chapter-01 | The Petition | dale | town-hall | day-14 |
| part-02 | chapter-02 | Proof | unit-7 | the-bakery | day-30 |

```
Tool: create_chapter (x4)
```

**Verify each:**
```
Tool: get_chapter_meta (x4)
```
- [ ] Each returns correct title, pov, location, timeline_position
- [ ] Each has empty or initialized beats array

### 1.5 — Add Beats

Each chapter gets exactly 2 beats. This keeps it simple and verifiable.

**Part 1, Chapter 1: "Ignition"**

Beat b01:
```json
{
  "id": "b01",
  "label": "Unit 7 walks into town",
  "summary": "Unit 7 walks down Main Street for the first time. People stare. She doesn't understand why.",
  "status": "draft",
  "characters": ["unit-7"],
  "depends_on": [],
  "depended_by": ["b02"]
}
```

Beat b02:
```json
{
  "id": "b02",
  "label": "Marguerite offers to teach",
  "summary": "Unit 7 stops at the bakery window. Marguerite comes out. 'You're looking at the sourdough.' 'I am looking at all of it.'",
  "status": "draft",
  "characters": ["unit-7", "marguerite"],
  "depends_on": ["b01"],
  "depended_by": []
}
```

**Part 1, Chapter 2: "First Batch"**

Beat b01:
```json
{
  "id": "b01",
  "label": "Unit 7 follows the recipe exactly",
  "summary": "Every measurement perfect. Every temperature exact. The bread comes out technically correct and completely soulless.",
  "status": "draft",
  "characters": ["unit-7", "marguerite"],
  "depends_on": [],
  "depended_by": ["b02"]
}
```

Beat b02:
```json
{
  "id": "b02",
  "label": "Marguerite explains what's missing",
  "summary": "'The recipe is not the bread.' Unit 7 does not understand. Marguerite tears a piece of her own loaf. 'Taste this.' 'I cannot taste.' 'Then how will you bake?'",
  "status": "draft",
  "characters": ["unit-7", "marguerite"],
  "depends_on": ["b01"],
  "depended_by": []
}
```

**Part 2, Chapter 1: "The Petition"**

Beat b01:
```json
{
  "id": "b01",
  "label": "Dale presents the petition at town meeting",
  "summary": "Forty-three signatures. 'It's not safe. It's not natural. It's a machine in a kitchen.'",
  "status": "draft",
  "characters": ["dale"],
  "depends_on": [],
  "depended_by": ["b02"]
}
```

Beat b02:
```json
{
  "id": "b02",
  "label": "Unit 7 attends, says one thing",
  "summary": "Unit 7 stands in the back. Eight feet tall. Everyone turns. 'I am not asking to be natural. I am asking to make bread.'",
  "status": "draft",
  "characters": ["unit-7", "dale"],
  "depends_on": ["b01"],
  "depended_by": []
}
```

**Part 2, Chapter 2: "Proof"**

Beat b01:
```json
{
  "id": "b01",
  "label": "Unit 7 bakes alone, night before the vote",
  "summary": "The bakery at 3 AM. Flour on her chassis. She has modified the recipe — not by measurement but by something she cannot name.",
  "status": "draft",
  "characters": ["unit-7"],
  "depends_on": [],
  "depended_by": ["b02"]
}
```

Beat b02:
```json
{
  "id": "b02",
  "label": "Dale eats the bread",
  "summary": "Morning. The town arrives. Dale takes a roll. Bites. Chews. Says nothing. Takes another.",
  "status": "draft",
  "characters": ["unit-7", "dale", "marguerite"],
  "depends_on": ["b01"],
  "depended_by": []
}
```

**Verify:** For each chapter, call `get_chapter_meta` and confirm:
- [ ] Beat count == 2
- [ ] Beat IDs are b01, b02
- [ ] Labels match what was submitted
- [ ] Characters arrays are correct
- [ ] depends_on / depended_by are correct

---

## PHASE 2: CANON

### 2.1 — Create Characters

**Unit 7:**
```
Tool: update_canon
type: characters, id: unit-7
content: (see below)
```

Content:
```markdown
# Unit 7

## Core
- Decommissioned GM factory robot, serial number U7-4419
- 8 feet tall, 600 pounds
- Originally built to weld car doors
- Now lives in the abandoned factory, bakes bread

## Voice
- Short declarative sentences
- Does not understand metaphor
- Takes everything literally
- "I am not asking to be natural. I am asking to make bread."
```

**Marguerite:**
```markdown
# Marguerite Deschamps

## Core
- 70 years old, French-born, moved to Vermont in 1962
- Runs "Flour & Salt" on Main Street
- Dying (cancer, unspecified, not the point)
- Needs someone to take over the shop

## Voice
- Wry, patient, speaks in baking metaphors
- "The recipe is not the bread."
```

**Dale:**
```markdown
# Dale Hoskins

## Core
- Town selectman, 55, hardware store owner
- Third-generation Millhaven
- Not evil — just scared of what he doesn't understand
- Voted against every change since 1983

## Voice
- Blunt, folksy, repeats himself when nervous
- "It's not safe. It's not natural."
```

**Verify each:**
```
Tool: get_canon (x3)
Tool: list_canon type=characters
```
- [ ] `list_canon` returns exactly `["dale", "marguerite", "unit-7"]` (alpha order)
- [ ] Each `get_canon` returns both content and meta
- [ ] Content contains the expected key phrases
- [ ] Meta has correct id and type fields

### 2.2 — Create Locations

**The Bakery:**
```markdown
# Flour & Salt — The Bakery

Main Street, Millhaven, Vermont.
Brick building, blue door, bell that jingles.
Smells like sourdough and old wood.
Marguerite's domain for 40 years.
```

**The Factory:**
```markdown
# The Factory

Abandoned GM assembly plant, Route 7, outside Millhaven.
Where Unit 7 was made. Where she still lives.
Cold concrete, dripping pipes, one working light.
She sleeps standing up because she doesn't know another way.
```

**Verify:**
```
Tool: list_canon type=locations
Tool: get_canon (x2)
```
- [ ] `list_canon` returns `["the-bakery", "the-factory"]`
- [ ] Content round-trips correctly

---

## PHASE 3: PROSE WRITING & ROUND-TRIP

### 3.1 — Write Beat Prose

Write actual prose to all 8 beats. This is the core round-trip test.

**Part 1, Chapter 1, Beat b01:**
```
Unit 7 walked down Main Street at 6:47 AM because that was when the bakery opened and she had calculated the optimal arrival time based on visible foot traffic patterns over the previous nine days of observation.

People stared. This was not new. People had been staring since she left the factory. A woman pulled her child closer. A man in a pickup truck slowed down, then sped up. The barber stood in his doorway with his mouth open and his scissors still cutting air.

Unit 7 did not understand why they stared. She was simply walking. She had verified that walking was legal.
```

**Part 1, Chapter 1, Beat b02:**
```
The bakery window displayed seven loaves of bread, four croissants, and a handwritten sign that said FLOUR & SALT in blue paint. Unit 7 catalogued each item. She had been cataloguing them for nine days.

The door opened. A small woman emerged. White hair. Flour on her apron. She looked up at Unit 7 the way you look up at a building.

"You're looking at the sourdough," the woman said.

"I am looking at all of it," Unit 7 said. This was true.

"Would you like to come in?"

Unit 7 considered this. She had not been invited inside a building since her decommission.

"Yes," she said. "I would like to come in."
```

**Part 1, Chapter 2, Beat b01:**
```
The recipe called for 500 grams of bread flour, 350 grams of water, 10 grams of salt, and 100 grams of active starter. Unit 7 measured each ingredient to the milligram. She set the oven to exactly 450 degrees Fahrenheit. She timed the proof to the second.

The bread came out at precisely the correct internal temperature. The crust was uniform. The crumb was even.

Marguerite picked it up. Squeezed it. Set it down.

"Technically perfect," she said.

"Thank you."

"That wasn't a compliment."
```

**Part 1, Chapter 2, Beat b02:**
```
"The recipe is not the bread," Marguerite said. She was sitting on her stool behind the counter, the one with the wobbly leg she refused to fix because she said it kept her honest.

"The recipe produced bread. I followed it precisely."

"You followed it like a machine."

"I am a machine."

Marguerite tore a piece from her own loaf — the one she'd baked that morning, the one that was lumpy and imperfect and smelled like something Unit 7 could not identify but wanted to catalogue.

"Taste this," Marguerite said.

"I cannot taste."

"Then how will you bake?"

Unit 7 did not have an answer. She filed this under UNRESOLVED and set a reminder to revisit it in 24 hours. She would revisit it much sooner than that.
```

**Part 2, Chapter 1, Beat b01:**
```
Dale Hoskins had forty-three signatures on the petition, which he felt was a strong showing for a town of twelve hundred, especially considering he'd only been collecting since Tuesday.

"It's a safety issue," he said, standing at the podium in the Grange Hall. "Eight feet tall and six hundred pounds in a kitchen with gas ovens and customers. It's not safe. It's not natural."

He paused. Looked at his notes. Looked at the room.

"It's a machine," he said. "In a kitchen. Handling food. That people eat."

Murmurs. Some nodding. He was winning. He could feel it.
```

**Part 2, Chapter 1, Beat b02:**
```
The door opened at the back of the hall and the room went quiet the way rooms go quiet when something very large enters them.

Unit 7 stood in the doorway. She had to duck. Her head nearly touched the ceiling inside. She walked to the back row and remained standing because the chairs were not rated for her weight.

Everyone turned.

Dale gripped the podium.

"I am not asking to be natural," Unit 7 said. Her voice was the same flat frequency it always was. "I am asking to make bread."

Nobody said anything for eleven seconds. Unit 7 counted.
```

**Part 2, Chapter 2, Beat b01:**
```
The bakery at 3 AM was the quietest place Unit 7 had ever been, and she had lived in an abandoned factory for two years.

Flour on her chassis. Dough under her finger joints. She had been modifying the recipe, but not by measurement — she could not explain what she was doing differently. The adjustments were not in her programming. They had emerged from somewhere she could not locate in her system architecture.

She added a little more water than the recipe specified. Not because the math said to. Because the dough looked like it wanted it.

This was not rational. She did it anyway.
```

**Part 2, Chapter 2, Beat b02:**
```
Morning. Gray Vermont light through the bakery windows.

They came in ones and twos, then in clusters. The bell over the door jingled so often it became a kind of music. Marguerite sat in the corner in her good chair, the one they'd brought from the back, and watched.

Dale arrived at 8:15. He stood in the doorway for a moment. Looked at the line. Looked at Unit 7 behind the counter, flour on her chassis, handing a paper bag to Mrs. Chen.

He walked to the counter. Took a roll from the basket. Bit into it.

Chewed.

Said nothing.

Took another.

Marguerite caught Unit 7's optical sensors from across the room and did something with her face that Unit 7's recognition software classified as a smile, subcategory: pride.
```

**Verify:** For each of the 8 beats:
```
Tool: get_beat_prose
Tool: get_chapter_prose (verify beats appear in order with markers)
```
- [ ] Each `get_beat_prose` returns the exact text that was written
- [ ] Each `get_chapter_prose` contains all beats in b01, b02 order
- [ ] Beat markers (`<!-- beat:b01 -->` etc.) are present in chapter prose
- [ ] No data corruption, truncation, or encoding issues

### 3.2 — Update Beat Status

After writing prose, update each beat's status from "draft" to "written":

```
Tool: update_chapter_meta
Patch: update each beat's status to "written"
```

**Verify:**
```
Tool: get_chapter_meta (x4)
```
- [ ] All 8 beats show status "written"

---

## PHASE 4: SCRATCH PAD

### 4.1 — Add Scratch Files

Create 2 scratch files:

**File 1: "unit7-dream-sequence.md"**
```
Tool: add_scratch
filename: "unit7-dream-sequence.md"
note: "Unit 7 experiences something like a dream. Might go in Part 2 somewhere. She processes bread textures in standby mode."
characters: ["unit-7"]
mood: "eerie, gentle"
potential_placement: "part-02/chapter-02"
content: |
  In standby mode, Unit 7's processors cycle through the day's sensory data. This is maintenance. This is not dreaming.

  But tonight the data loops. The flour. The way it felt between her joints. The moment the dough changed — went from paste to something alive under her hands.

  She replays this 4,771 times before morning.

  This is not dreaming. She is certain.
```

**File 2: "dale-backstory-riff.md"**
```
Tool: add_scratch
filename: "dale-backstory-riff.md"
note: "Dale's wife left him for Burlington. The hardware store is all he has. The robot threatens his sense of order. Raw dialogue riff."
characters: ["dale"]
mood: "bitter, defensive, human"
content: |
  "My grandfather built the Grange Hall. My father wired the streetlights. I've been fixing pipes in this town for thirty years. I know every house. I know every furnace. I know which ones leak."

  "And now there's a machine that bakes bread better than Marguerite, and Marguerite baked the best bread in the state. So what's next? A machine that fixes pipes? A machine that runs the store?"

  "Where does it stop?"
```

**Verify:**
```
Tool: get_scratch_index
Tool: get_scratch (x2)
```
- [ ] Index shows 2 entries
- [ ] Each scratch file returns correct content
- [ ] Metadata (characters, mood, note, potential_placement) preserved

### 4.2 — Promote Scratch to Beat

First, add a new beat to receive the promoted content:

```
Tool: add_beat
Args: project="_fractal-test", part_id="part-02", chapter_id="chapter-02"
beat: {
  "id": "b03",
  "label": "Unit 7 in standby — not dreaming",
  "summary": "Unit 7 replays the day's bread data 4,771 times. This is not dreaming.",
  "status": "draft",
  "characters": ["unit-7"],
  "depends_on": ["b01"],
  "depended_by": ["b02"]
}
after_beat_id: "b01"
```

Then promote:
```
Tool: promote_scratch
filename: "unit7-dream-sequence.md"
target: part-02/chapter-02:b03
```

**Verify:**
- [ ] `get_beat_prose` for part-02/chapter-02:b03 returns the dream sequence content
- [ ] `get_scratch_index` no longer lists "unit7-dream-sequence.md"
- [ ] `get_chapter_prose` for part-02/chapter-02 now shows 3 beats in order: b01, b03, b02

### 4.3 — Remove Beat (with scratch backup)

```
Tool: remove_beat
Args: part-02/chapter-02:b03
```

**Verify:**
- [ ] `get_chapter_meta` for part-02/chapter-02 shows only b01, b02
- [ ] `get_scratch_index` contains a backup file with the removed prose
- [ ] The backup content matches what was in b03

---

## PHASE 5: DIRTY TRACKING

### 5.1 — Mark Dirty

```
Tool: mark_dirty
node_ref: "part-01/chapter-01:b02"
reason: "marguerite.md canon updated: changed her age from 70 to 72"
```

**Verify:**
```
Tool: get_dirty_nodes
```
- [ ] Returns at least one node
- [ ] Node ref matches "part-01/chapter-01:b02"
- [ ] Reason contains "marguerite.md"

### 5.2 — Mark Clean

```
Tool: mark_clean
node_ref: "part-01/chapter-01:b02"
```

**Verify:**
```
Tool: get_dirty_nodes
```
- [ ] The node is no longer listed
- [ ] If no other dirty nodes, returns empty

### 5.3 — Mark Dirty at Chapter Level

```
Tool: mark_dirty
node_ref: "part-01/chapter-02"
reason: "restructuring beat order"
```

**Verify:**
- [ ] `get_dirty_nodes` shows chapter-level dirty flag
- [ ] Clean it up after verification

### 5.4 — Mark Dirty at Part Level

```
Tool: mark_dirty
node_ref: "part-02"
reason: "part 2 arc revised"
```

**Verify:**
- [ ] `get_dirty_nodes` shows part-level dirty flag
- [ ] Clean it up after verification

---

## PHASE 6: SEARCH

### 6.1 — Search Prose

```
Tool: search
query: "sourdough"
scope: prose
```

- [ ] Returns hits from part-01/chapter-01 (beat b02 contains "sourdough")
- [ ] Results include file path and line numbers

### 6.2 — Search Canon

```
Tool: search
query: "decommissioned"
scope: canon
```

- [ ] Returns hit from unit-7 character file

### 6.3 — Search Scratch

```
Tool: search
query: "grandfather"
scope: scratch
```

- [ ] Returns hit from dale-backstory-riff.md

### 6.4 — Search All (no scope)

```
Tool: search
query: "bread"
```

- [ ] Returns hits from multiple sources (prose, canon, and/or scratch)

### 6.5 — Search for Nonexistent Term

```
Tool: search
query: "xylophone"
```

- [ ] Returns empty results, NOT an error

---

## PHASE 7: ERROR HANDLING

Test that the system fails gracefully, not silently or explosively.

### 7.1 — Nonexistent Resources

| Tool | Args | Expected |
|------|------|----------|
| `get_canon` | id="nonexistent", type="characters" | Error message, not crash |
| `get_chapter_prose` | part="part-99", chapter="chapter-99" | Error message, not crash |
| `get_beat_prose` | beat="b99" on valid chapter | Error message, not crash |
| `get_part` | part_id="part-99" | Error message, not crash |
| `get_scratch` | filename="nope.md" | Error message, not crash |

- [ ] Each returns a clear error, not a stack trace or hang
- [ ] No side effects (nothing created, nothing corrupted)

### 7.2 — Invalid Operations

| Tool | Args | Expected |
|------|------|----------|
| `create_project` | same project id again | Error or idempotent, not corruption |
| `add_beat` | duplicate beat id in same chapter | Error, not silent overwrite |
| `promote_scratch` | to nonexistent target beat | Error message |
| `write_beat_prose` | to nonexistent beat | Error message |
| `remove_beat` | nonexistent beat id | Error message |

- [ ] Each returns a clear error
- [ ] Existing data is not corrupted (verify with get_ calls after each)

### 7.3 — Post-Error Integrity Check

After all error tests, verify the project is still intact:

```
Tool: get_project
Tool: get_part (x2)
Tool: get_chapter_meta (x4)
Tool: list_canon type=characters
Tool: list_canon type=locations
Tool: get_scratch_index
```

- [ ] All return the same data as before the error tests
- [ ] Nothing was silently created or deleted

---

## PHASE 8: INFERENCE VERIFICATION

This is where the agent stops checking boxes and actually READS.

### 8.1 — Full Story Read-Through

Pull all chapter prose in order:
```
get_chapter_prose: part-01/chapter-01
get_chapter_prose: part-01/chapter-02
get_chapter_prose: part-02/chapter-01
get_chapter_prose: part-02/chapter-02
```

Read the complete output and verify BY INFERENCE:

- [ ] **Narrative coherence:** Does the story flow? Does Part 2 feel like it follows Part 1?
- [ ] **Character consistency:** Does Unit 7 speak the same way throughout? Does she stay in character (declarative, literal, no metaphor)?
- [ ] **Voice match to canon:** Pull `get_canon unit-7` and compare. Does the prose match the voice description?
- [ ] **No data bleeding:** Is there any text from one beat appearing in another beat's section?
- [ ] **Beat markers intact:** Are the `<!-- beat:XX -->` markers correctly separating content?
- [ ] **Encoding integrity:** Any garbled characters, mojibake, or encoding artifacts?

### 8.2 — Canon Consistency Check

Pull each character canon file. Then search for each character's name in prose.

- [ ] **Unit 7** appears in the beats her canon says she appears in
- [ ] **Marguerite** appears only in scenes where she's listed as a character
- [ ] **Dale** appears only in his listed scenes
- [ ] No character appears in a scene where they weren't specified in beat metadata

### 8.3 — Dependency Chain Verification

Trace the beat dependency graph:
- part-01/chapter-01: b01 → b02
- part-01/chapter-02: b01 → b02
- part-02/chapter-01: b01 → b02
- part-02/chapter-02: b01 → b02

- [ ] Does the narrative actually flow in dependency order?
- [ ] Would reversing any pair break the story? (If yes, dependencies are correct.)

### 8.4 — Search Relevance

```
search: "bread" (all scopes)
```

- [ ] Are the results actually about bread? (Not just any line containing the word)
- [ ] Do the line numbers point to the right content?
- [ ] Is the result set complete? (Did it miss any known instances?)

---

## PHASE 9: SESSION SUMMARY & CLEANUP

### 9.1 — Session Commit

```
Tool: session_summary
message: "Test suite complete. All phases executed. [PASS/FAIL count here]"
```

- [ ] Returns a git commit hash
- [ ] Message is preserved

### 9.2 — Final State Snapshot

Record the final state for comparison against future runs:

```
get_project
get_part x2
get_chapter_meta x4
list_canon type=characters
list_canon type=locations
get_scratch_index
get_dirty_nodes
```

Log all results.

### 9.3 — Cleanup

If running against a temporary projects root:
- Delete the entire temporary directory

If running against the production root:
- Note: there is no `delete_project` tool
- Manual cleanup required: delete the `_fractal-test` directory from the projects root

---

## REPORTING

After completion, the agent should produce a summary:

```
# Fractal Test Results — [date]

## Summary
- Total checks: [N]
- Passed: [N]
- Failed: [N]
- Errors: [N]

## Failures (if any)
- [Phase].[Test]: [Expected] vs [Actual]

## Inference Findings
- [Any narrative, consistency, or encoding issues found in Phase 8]

## Recommendations
- [Any tools that need fixes, missing error handling, etc.]
```

---

*Test plan version: 1.0*
*Created: 2026-02-07*
*Story: "Rust & Flour" — Unit 7, Marguerite, Dale, bread, Vermont*
