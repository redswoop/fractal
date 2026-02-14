#!/usr/bin/env bash
# Fractal MCP feature test suite
# Runs 30 tests against the Fractal MCP server on localhost:3001

set -euo pipefail

BASE_URL="http://localhost:3001/mcp"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
TEST_DIR="${SCRIPT_DIR}/test-projects/_fractal-test"
PASS_COUNT=0
FAIL_COUNT=0
CALL_ID=0
SESSION_ID=""

# ── MCP session initialization ──────────────────────────────
init_session() {
  local resp
  resp=$(curl -si --max-time 10 -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -d '{"jsonrpc":"2.0","method":"initialize","params":{"protocolVersion":"2025-03-26","capabilities":{},"clientInfo":{"name":"test-templates","version":"1.0"}},"id":0}')
  SESSION_ID=$(echo "$resp" | grep -i "mcp-session-id" | head -1 | tr -d '\r' | awk '{print $2}')
  if [ -z "$SESSION_ID" ]; then
    echo "FATAL: Failed to initialize MCP session"
    echo "$resp"
    exit 1
  fi
  # Send initialized notification
  curl -s --max-time 5 -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d '{"jsonrpc":"2.0","method":"notifications/initialized"}' > /dev/null 2>&1
  echo "Session: $SESSION_ID"
}

# ── Helper: send MCP tool call, return JSON-RPC result ──────
mcp_call() {
  local tool_name="$1"
  local args_json="$2"
  CALL_ID=$((CALL_ID + 1))
  local payload="{\"jsonrpc\":\"2.0\",\"id\":${CALL_ID},\"method\":\"tools/call\",\"params\":{\"name\":\"${tool_name}\",\"arguments\":${args_json}}}"
  local raw
  raw=$(curl -s -N --max-time 30 -X POST "$BASE_URL" \
    -H "Content-Type: application/json" \
    -H "Accept: application/json, text/event-stream" \
    -H "mcp-session-id: $SESSION_ID" \
    -d "$payload")

  # Handle SSE format (data: lines) or plain JSON
  if echo "$raw" | grep -q '^data: '; then
    echo "$raw" | grep '^data: ' | grep '"jsonrpc"' | head -1 | sed 's/^data: //'
  else
    echo "$raw"
  fi
}

# ── Helper: extract text content from MCP result ────────────
extract_text() {
  python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
content = data.get('result', {}).get('content', [])
for c in content:
    if c.get('type') == 'text':
        print(c['text'])
        break
" <<< "$1"
}

# ── Helper: check if MCP result is an error ─────────────────
is_error() {
  python3 -c "
import sys, json
data = json.loads(sys.stdin.read())
print('true' if data.get('result', {}).get('isError') else 'false')
" <<< "$1"
}

report() {
  local test_num="$1"
  local desc="$2"
  local passed="$3"
  local detail="${4:-}"
  if [ "$passed" = "true" ]; then
    echo "Test $test_num: $desc ... PASS"
    PASS_COUNT=$((PASS_COUNT + 1))
  else
    echo "Test $test_num: $desc ... FAIL"
    if [ -n "$detail" ]; then
      echo "  Detail: $detail"
    fi
    FAIL_COUNT=$((FAIL_COUNT + 1))
  fi
}

echo "================================================================="
echo "Fractal MCP -- Template-Driven Canon Types Test Suite"
echo "================================================================="
echo ""

# Initialize MCP session
init_session
echo ""

# Clean test directory
rm -rf "$TEST_DIR"
echo "Cleaned test directory: $TEST_DIR"
echo ""

# =========================================================================
# Test 1: list_templates
# =========================================================================
echo "--- Test 1: list_templates ---"
RESULT=$(mcp_call "list_templates" '{}')
TEXT=$(extract_text "$RESULT")
T1_PASS=$(python3 -c "
import json, sys
data = json.loads(sys.stdin.read())
ids = {t['id'] for t in data}
required = {'fiction-default', 'worldbuilding', 'litrpg', 'fanfic'}
if required.issubset(ids):
    print('true')
else:
    print('false|Missing: ' + str(required - ids))
" <<< "$TEXT")

if [ "$(echo "$T1_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 1 "list_templates returns at least 4 templates" "true"
else
  report 1 "list_templates returns at least 4 templates" "false" "$(echo "$T1_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 2: get_template returns full contents
# =========================================================================
echo "--- Test 2: get_template ---"
RESULT=$(mcp_call "get_template" '{"template_id":"litrpg"}')
TEXT=$(extract_text "$RESULT")
T2_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ids = [c['id'] for c in d.get('canon_types', [])]
has_guide = d.get('guide') is not None and len(d.get('guide', '')) > 100
has_themes = len(d.get('themes', [])) > 0
has_bestiary = 'bestiary' in ids
ok = has_guide and has_themes and has_bestiary and len(ids) == 6
print('true' if ok else 'false|canon_types=' + str(ids) + ' guide_len=' + str(len(d.get('guide',''))) + ' themes=' + str(d.get('themes')))
" <<< "$TEXT")

if [ "$(echo "$T2_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 2 "get_template returns full litrpg (6 types, themes, guide)" "true"
else
  report 2 "get_template returns full litrpg (6 types, themes, guide)" "false" "$(echo "$T2_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 3: create_project without template
# =========================================================================
echo "--- Test 3: create_project without template ---"
RESULT=$(mcp_call "create_project" '{"project":"_fractal-test","title":"Template Test"}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 3 "create_project without template" "false" "Tool error: $(extract_text "$RESULT")"
else
  T3_PASS="true"
  T3_DETAIL=""

  [ ! -d "$TEST_DIR/canon/characters" ] && T3_PASS="false" && T3_DETAIL="canon/characters/ missing"
  [ ! -d "$TEST_DIR/canon/locations" ] && T3_PASS="false" && T3_DETAIL="$T3_DETAIL; canon/locations/ missing"

  HAS_CT=$(python3 -c "
import json; d = json.load(open('$TEST_DIR/project.json'))
print('true' if 'canon_types' in d and len(d['canon_types']) > 0 else 'false')
")
  [ "$HAS_CT" != "true" ] && T3_PASS="false" && T3_DETAIL="$T3_DETAIL; project.json missing canon_types"

  report 3 "create_project without template -- filesystem checks" "$T3_PASS" "$T3_DETAIL"
fi

# =========================================================================
# Test 4: get_context project_meta enrichment (no template)
# =========================================================================
echo "--- Test 4: get_context project_meta enrichment ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"project_meta":true}}')
TEXT=$(extract_text "$RESULT")
T4_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
pm = d.get('project_meta', {})
ok = (
    'canon_types_active' in pm
    and 'has_guide' in pm
    and set(pm.get('canon_types_active', [])) == {'characters', 'locations'}
    and pm.get('has_guide') == False
)
print('true' if ok else 'false|canon_types_active=' + str(pm.get('canon_types_active')) + ' has_guide=' + str(pm.get('has_guide')))
" <<< "$TEXT")

if [ "$(echo "$T4_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 4 "get_context project_meta returns canon_types_active=[characters,locations], has_guide=false" "true"
else
  report 4 "get_context project_meta returns canon_types_active=[characters,locations], has_guide=false" "false" "$(echo "$T4_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 5: apply_template to existing project (adds dirs + GUIDE.md)
# =========================================================================
echo "--- Test 5: apply_template (worldbuilding -> existing project) ---"
RESULT=$(mcp_call "apply_template" '{"project":"_fractal-test","template_id":"worldbuilding"}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 5 "apply_template worldbuilding" "false" "Tool error: $(extract_text "$RESULT")"
else
  T5_PASS="true"
  T5_DETAIL=""

  for dir in characters locations factions lore systems; do
    [ ! -d "$TEST_DIR/canon/$dir" ] && T5_PASS="false" && T5_DETAIL="$T5_DETAIL canon/$dir/ missing;"
  done
  [ ! -f "$TEST_DIR/GUIDE.md" ] && T5_PASS="false" && T5_DETAIL="$T5_DETAIL GUIDE.md missing;"

  CANON_COUNT=$(python3 -c "
import json; d = json.load(open('$TEST_DIR/project.json'))
print(len(d.get('canon_types', [])))
")
  # Should have 5: original 2 (characters, locations) + 3 new (factions, lore, systems)
  [ "$CANON_COUNT" != "5" ] && T5_PASS="false" && T5_DETAIL="$T5_DETAIL canon_types count=$CANON_COUNT (expected 5);"

  TEXT=$(extract_text "$RESULT")
  GUIDE_UPDATED=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
print('true' if d.get('guide_updated') else 'false')
" <<< "$TEXT")
  [ "$GUIDE_UPDATED" != "true" ] && T5_PASS="false" && T5_DETAIL="$T5_DETAIL guide_updated=$GUIDE_UPDATED;"

  report 5 "apply_template adds canon dirs and GUIDE.md" "$T5_PASS" "$T5_DETAIL"
fi

# =========================================================================
# Test 6: get_context project_meta reflects applied template
# =========================================================================
echo "--- Test 6: get_context project_meta after apply_template ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"project_meta":true}}')
TEXT=$(extract_text "$RESULT")
T6_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
pm = d.get('project_meta', {})
active = set(pm.get('canon_types_active', []))
expected = {'characters', 'locations', 'factions', 'lore', 'systems'}
ok = active == expected and pm.get('has_guide') == True
print('true' if ok else 'false|active=' + str(sorted(active)) + ' has_guide=' + str(pm.get('has_guide')))
" <<< "$TEXT")

if [ "$(echo "$T6_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 6 "get_context project_meta lists all 5 canon types and has_guide=true" "true"
else
  report 6 "get_context project_meta lists all 5 canon types and has_guide=true" "false" "$(echo "$T6_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 7: update_template creates a new custom template
# =========================================================================
echo "--- Test 7: update_template (create custom) ---"
RESULT=$(mcp_call "update_template" '{"template_id":"_test-custom","name":"Test Custom","description":"A test template","canon_types":[{"id":"characters","label":"Characters","description":"People"},{"id":"tech","label":"Technology","description":"Gadgets and inventions"}],"themes":["innovation","disruption"],"guide":"# Custom Guide\n\nA minimal test guide."}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 7 "update_template create custom" "false" "Tool error: $(extract_text "$RESULT")"
else
  # Verify by reading it back
  RESULT2=$(mcp_call "get_template" '{"template_id":"_test-custom"}')
  TEXT2=$(extract_text "$RESULT2")
  T7_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ids = [c['id'] for c in d.get('canon_types', [])]
ok = d.get('name') == 'Test Custom' and 'tech' in ids and len(d.get('themes',[])) == 2
print('true' if ok else 'false|name=' + str(d.get('name')) + ' types=' + str(ids) + ' themes=' + str(d.get('themes')))
" <<< "$TEXT2")

  if [ "$(echo "$T7_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 7 "update_template creates and get_template reads back" "true"
  else
    report 7 "update_template creates and get_template reads back" "false" "$(echo "$T7_PASS" | cut -d'|' -f2-)"
  fi
fi

# =========================================================================
# Test 8: create canon with custom type (factions)
# =========================================================================
echo "--- Test 8: update_canon with custom type (factions) ---"
RESULT=$(mcp_call "update_canon" '{"project":"_fractal-test","type":"factions","id":"the-guild","content":"# The Guild\n\nA powerful faction."}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 8 "update_canon with custom type (factions)" "false" "$(extract_text "$RESULT")"
else
  if [ -f "$TEST_DIR/canon/factions/the-guild.md" ]; then
    report 8 "update_canon with custom type (factions)" "true"
  else
    report 8 "update_canon with custom type (factions)" "false" "File not on disk"
  fi
fi

# =========================================================================
# Test 9: get_context canon for custom type
# =========================================================================
echo "--- Test 9: get_context canon for factions/the-guild ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["the-guild"]}}')
TEXT=$(extract_text "$RESULT")
T9_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entry = d.get('canon', {}).get('the-guild', {})
content = entry.get('content', '')
ok = '# The Guild' in content and 'powerful faction' in content
print('true' if ok else 'false|Content: ' + repr(content[:200]))
" <<< "$TEXT")

if [ "$(echo "$T9_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 9 "get_context canon returns correct factions content" "true"
else
  report 9 "get_context canon returns correct factions content" "false" "$(echo "$T9_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 10: get_context with guide
# =========================================================================
echo "--- Test 10: get_context with guide and canon ---"

# Create part and chapter
mcp_call "create_part" '{"project":"_fractal-test","part_id":"part-01","title":"Part One"}' > /dev/null
mcp_call "create_chapter" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","title":"Chapter One"}' > /dev/null

RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"guide":true,"canon":["the-guild"]}}')
TEXT=$(extract_text "$RESULT")
T10_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
has_guide = d.get('guide') is not None and len(str(d.get('guide', ''))) > 10
canon = d.get('canon', {})
has_canon = 'the-guild' in canon
content_ok = '# The Guild' in canon.get('the-guild', {}).get('content', '') if has_canon else False
ok = has_guide and has_canon and content_ok
print('true' if ok else 'false|has_guide=' + str(has_guide) + ' has_canon=' + str(has_canon) + ' content_ok=' + str(content_ok))
" <<< "$TEXT")

if [ "$(echo "$T10_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 10 "get_context returns guide and canon entry" "true"
else
  report 10 "get_context returns guide and canon entry" "false" "$(echo "$T10_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 11: resolveCanon via get_context (factions auto-discovery)
# =========================================================================
echo "--- Test 11: resolveCanon discovers the-guild in factions/ ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["the-guild"]}}')
TEXT=$(extract_text "$RESULT")
T11_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entry = d.get('canon', {}).get('the-guild', {})
resolved_type = entry.get('type', '')
content = entry.get('content', '')
ok = resolved_type == 'factions' and '# The Guild' in content
print('true' if ok else 'false|type=' + str(resolved_type) + ' content_has_guild=' + str('# The Guild' in content))
" <<< "$TEXT")

if [ "$(echo "$T11_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 11 "resolveCanon resolves the-guild from factions/" "true"
else
  report 11 "resolveCanon resolves the-guild from factions/" "false" "$(echo "$T11_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 12: backward compat -- project without canon_types field
# =========================================================================
echo "--- Test 12: backward compat -- velvet-bond (no canon_types in project.json) ---"
RESULT=$(mcp_call "get_context" '{"project":"velvet-bond","include":{"project_meta":true}}')
TEXT=$(extract_text "$RESULT")
T12_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
pm = d.get('project_meta', {})
active = pm.get('canon_types_active', [])
has_guide_key = 'has_guide' in pm
has_chars = 'characters' in active
has_locs = 'locations' in active
ok = has_chars and has_locs and has_guide_key
print('true' if ok else 'false|active=' + str(active) + ' has_guide_key=' + str(has_guide_key))
" <<< "$TEXT")

if [ "$(echo "$T12_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 12 "backward compat -- canon_types_active from filesystem scan" "true"
else
  report 12 "backward compat -- canon_types_active from filesystem scan" "false" "$(echo "$T12_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 13: apply_template is idempotent (re-apply doesn't duplicate)
# =========================================================================
echo "--- Test 13: apply_template idempotent ---"
RESULT=$(mcp_call "apply_template" '{"project":"_fractal-test","template_id":"worldbuilding"}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 13 "apply_template idempotent" "false" "Tool error: $(extract_text "$RESULT")"
else
  CANON_COUNT=$(python3 -c "
import json; d = json.load(open('$TEST_DIR/project.json'))
print(len(d.get('canon_types', [])))
")
  # Should still be 5, not 10
  if [ "$CANON_COUNT" = "5" ]; then
    report 13 "apply_template idempotent -- still 5 canon types after re-apply" "true"
  else
    report 13 "apply_template idempotent -- still 5 canon types after re-apply" "false" "count=$CANON_COUNT (expected 5)"
  fi
fi

# =========================================================================
# Test 14: add_beat injects beat-brief comment into .md
# =========================================================================
echo "--- Test 14: add_beat injects beat-brief into prose file ---"
mcp_call "add_beat" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat":{"id":"b01","label":"The guild arrives","summary":"The Guild marches into town at dawn. Banners flying, armor gleaming. The townsfolk watch from shuttered windows.","status":"planned","dirty_reason":null,"characters":["the-guild"],"depends_on":[],"depended_by":[]}}' > /dev/null

T14_PASS=$(python3 -c "
import sys
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_marker = '<!-- beat:b01 |' in md
has_brief = '<!-- beat-brief:b01 [PLANNED]' in md
has_summary = 'Guild marches into town' in md
ok = has_marker and has_brief and has_summary
print('true' if ok else 'false|marker=' + str(has_marker) + ' brief=' + str(has_brief) + ' summary=' + str(has_summary))
")
if [ "$(echo "$T14_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 14 "add_beat injects beat-brief [PLANNED] into .md file" "true"
else
  report 14 "add_beat injects beat-brief [PLANNED] into .md file" "false" "$(echo "$T14_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 15: write_beat_prose preserves beat-brief, getBeatProse is clean
# =========================================================================
echo "--- Test 15: write prose, verify .md has brief, beat read is clean ---"
mcp_call "write_beat_prose" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_id":"b01","content":"The dust rose before the column did. Marguerite saw it first."}' > /dev/null

# Check the .md on disk still has beat-brief
T15A_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_brief = 'beat-brief:b01' in md
has_prose = 'dust rose before the column' in md
print('true' if (has_brief and has_prose) else 'false|brief=' + str(has_brief) + ' prose=' + str(has_prose))
")

# Check getBeatProse returns clean prose (no beat-brief)
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"beats":["part-01/chapter-01:b01"]}}')
TEXT=$(extract_text "$RESULT")
T15B_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
prose = d.get('beats', {}).get('part-01/chapter-01:b01', {}).get('prose', '')
clean = 'beat-brief' not in prose
has_content = 'dust rose' in prose
print('true' if (clean and has_content) else 'false|clean=' + str(clean) + ' content=' + str(has_content))
" <<< "$TEXT")

if [ "$(echo "$T15A_PASS" | cut -d'|' -f1)" = "true" ] && [ "$(echo "$T15B_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 15 "write_beat_prose: .md has brief, getBeatProse is clean" "true"
else
  report 15 "write_beat_prose: .md has brief, getBeatProse is clean" "false" "disk=$(echo "$T15A_PASS" | cut -d'|' -f2-) api=$(echo "$T15B_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 16: update_chapter_meta refreshes beat-brief status
# =========================================================================
echo "--- Test 16: update_chapter_meta refreshes beat-brief status ---"
mcp_call "update_chapter_meta" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","patch":{"beats":[{"id":"b01","status":"written"}]}}' > /dev/null

T16_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_written = '[WRITTEN]' in md
no_planned = '[PLANNED]' not in md
print('true' if (has_written and no_planned) else 'false|written=' + str(has_written) + ' no_planned=' + str(no_planned))
")
if [ "$(echo "$T16_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 16 "update_chapter_meta refreshes beat-brief to [WRITTEN]" "true"
else
  report 16 "update_chapter_meta refreshes beat-brief to [WRITTEN]" "false" "$(echo "$T16_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 17: mark_node dirty updates beat-brief
# =========================================================================
echo "--- Test 17: mark_node dirty updates beat-brief ---"
mcp_call "mark_node" '{"project":"_fractal-test","node_ref":"part-01/chapter-01:b01","status":"dirty","reason":"canon change: the-guild backstory revised"}' > /dev/null

T17_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_dirty = '[DIRTY: canon change: the-guild backstory revised]' in md
no_written = '[WRITTEN]' not in md
print('true' if (has_dirty and no_written) else 'false|dirty=' + str(has_dirty) + ' no_written=' + str(no_written))
")
if [ "$(echo "$T17_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 17 "mark_node dirty updates beat-brief to [DIRTY: reason]" "true"
else
  report 17 "mark_node dirty updates beat-brief to [DIRTY: reason]" "false" "$(echo "$T17_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 18: edit_beat_prose preserves beat-brief
# =========================================================================
echo "--- Test 18: edit_beat_prose preserves beat-brief ---"
mcp_call "edit_beat_prose" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_id":"b01","edits":[{"old_str":"Marguerite saw it first","new_str":"Marguerite noticed it first"}]}' > /dev/null

T18_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_brief = 'beat-brief:b01' in md
has_edit = 'noticed it first' in md
print('true' if (has_brief and has_edit) else 'false|brief=' + str(has_brief) + ' edit=' + str(has_edit))
")
if [ "$(echo "$T18_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 18 "edit_beat_prose preserves beat-brief comment" "true"
else
  report 18 "edit_beat_prose preserves beat-brief comment" "false" "$(echo "$T18_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 19: add second beat, reorder — briefs travel with beats
# =========================================================================
echo "--- Test 19: reorder_beats carries beat-brief comments ---"
mcp_call "add_beat" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat":{"id":"b02","label":"The standoff","summary":"Unit 7 stands between the Guild and the bakery door. She does not move.","status":"planned","dirty_reason":null,"characters":["unit-7","the-guild"],"depends_on":[],"depended_by":[]}}' > /dev/null

mcp_call "reorder_beats" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_order":["b02","b01"]}' > /dev/null

T19_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
b02_marker = md.find('beat:b02')
b01_marker = md.find('beat:b01')
b02_brief = md.find('beat-brief:b02')
b01_brief = md.find('beat-brief:b01')
order_ok = 0 < b02_marker < b01_marker
briefs_present = b02_brief > 0 and b01_brief > 0
briefs_ordered = b02_brief < b01_brief
ok = order_ok and briefs_present and briefs_ordered
print('true' if ok else 'false|order=' + str(order_ok) + ' briefs=' + str(briefs_present) + ' brief_order=' + str(briefs_ordered))
")
if [ "$(echo "$T19_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 19 "reorder_beats: beat-brief comments travel with their blocks" "true"
else
  report 19 "reorder_beats: beat-brief comments travel with their blocks" "false" "$(echo "$T19_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 20: refresh_summaries tool works
# =========================================================================
echo "--- Test 20: refresh_summaries tool ---"
RESULT=$(mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01"}')
TEXT=$(extract_text "$RESULT")
T20_PASS=$(python3 -c "
import sys
text = sys.stdin.read()
ok = 'up to date' in text or 'Refreshed' in text
print('true' if ok else 'false|' + repr(text[:200]))
" <<< "$TEXT")
if [ "$(echo "$T20_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 20 "refresh_summaries tool responds correctly" "true"
else
  report 20 "refresh_summaries tool responds correctly" "false" "$(echo "$T20_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 21: idempotency — refresh twice produces identical .md
# =========================================================================
echo "--- Test 21: beat-brief refresh is idempotent ---"
MD_BEFORE=$(cat "$TEST_DIR/parts/part-01/chapter-01.md")
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01"}' > /dev/null
MD_AFTER=$(cat "$TEST_DIR/parts/part-01/chapter-01.md")
if [ "$MD_BEFORE" = "$MD_AFTER" ]; then
  report 21 "refresh_summaries is idempotent — .md unchanged on second run" "true"
else
  report 21 "refresh_summaries is idempotent — .md unchanged on second run" "false" "files differ"
fi

# =========================================================================
# Test 22: summary truncation for long summaries
# =========================================================================
echo "--- Test 22: long summary gets truncated in beat-brief ---"
mcp_call "add_beat" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat":{"id":"b03","label":"The long speech","summary":"This is a very long beat summary that goes on and on about many things. It describes in great detail everything that happens in this particular beat of the story. The characters do things, say things, and experience things. There are descriptions of the setting, the mood, the weather, and the general atmosphere. This continues for quite a while because we want to test that the truncation logic works properly when the summary exceeds the maximum length allowed.","status":"planned","dirty_reason":null,"characters":[],"depends_on":[],"depended_by":[]}}' > /dev/null

T22_PASS=$(python3 -c "
import re
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
m = re.search(r'<!-- beat-brief:b03 \[PLANNED\] (.+?) -->', md)
if not m:
    print('false|no beat-brief:b03 found')
else:
    text = m.group(1)
    ok = len(text) <= 300 and text.startswith('This is a very long')
    print('true' if ok else 'false|len=' + str(len(text)) + ' text=' + repr(text[:80]))
")
if [ "$(echo "$T22_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 22 "long summary is truncated in beat-brief (<=300 chars)" "true"
else
  report 22 "long summary is truncated in beat-brief (<=300 chars)" "false" "$(echo "$T22_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 23: remove_beat also removes its beat-brief
# =========================================================================
echo "--- Test 23: remove_beat removes beat-brief ---"
mcp_call "remove_beat" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_id":"b03"}' > /dev/null

T23_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
no_marker = 'beat:b03' not in md
no_brief = 'beat-brief:b03' not in md
print('true' if (no_marker and no_brief) else 'false|marker_gone=' + str(no_marker) + ' brief_gone=' + str(no_brief))
")
if [ "$(echo "$T23_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 23 "remove_beat removes both beat marker and beat-brief" "true"
else
  report 23 "remove_beat removes both beat marker and beat-brief" "false" "$(echo "$T23_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 24: create_chapter with summary → chapter-brief appears
# =========================================================================
echo "--- Test 24: create_chapter with summary injects chapter-brief ---"
mcp_call "create_chapter" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","title":"The Market","summary":"Unit 7 visits the morning market and discovers a coded message."}' > /dev/null

T24_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_heading = '# The Market' in md
has_brief = '<!-- chapter-brief [PLANNING]' in md
has_summary = 'coded message' in md
has_close = '<!-- /chapter -->' in md
ok = has_heading and has_brief and has_summary and has_close
print('true' if ok else 'false|heading=' + str(has_heading) + ' brief=' + str(has_brief) + ' summary=' + str(has_summary) + ' close=' + str(has_close))
")
if [ "$(echo "$T24_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 24 "create_chapter with summary injects chapter-brief [PLANNING]" "true"
else
  report 24 "create_chapter with summary injects chapter-brief [PLANNING]" "false" "$(echo "$T24_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 25: create_chapter without summary → no chapter-brief
# =========================================================================
echo "--- Test 25: create_chapter without summary → no chapter-brief ---"
T25_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
no_brief = 'chapter-brief' not in md
print('true' if no_brief else 'false|chapter-brief found in chapter without summary')
")
if [ "$(echo "$T25_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 25 "chapter without summary has no chapter-brief" "true"
else
  report 25 "chapter without summary has no chapter-brief" "false" "$(echo "$T25_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 26: chapter-brief coexists with beat-briefs
# =========================================================================
echo "--- Test 26: chapter-brief coexists with beat-briefs ---"
mcp_call "add_beat" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","beat":{"id":"b01","label":"Arriving at market","summary":"Unit 7 enters through the east gate. Vendors call out prices.","status":"planned","dirty_reason":null,"characters":["unit-7"],"depends_on":[],"depended_by":[]}}' > /dev/null

T26_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_chapter_brief = '<!-- chapter-brief [PLANNING]' in md
has_beat_brief = '<!-- beat-brief:b01 [PLANNED]' in md
has_beat_marker = '<!-- beat:b01 |' in md
# chapter-brief should come before beat markers
cb_pos = md.find('chapter-brief')
bm_pos = md.find('beat:b01')
order_ok = cb_pos < bm_pos
ok = has_chapter_brief and has_beat_brief and has_beat_marker and order_ok
print('true' if ok else 'false|ch_brief=' + str(has_chapter_brief) + ' beat_brief=' + str(has_beat_brief) + ' order=' + str(order_ok))
")
if [ "$(echo "$T26_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 26 "chapter-brief coexists with beat-briefs, correct order" "true"
else
  report 26 "chapter-brief coexists with beat-briefs, correct order" "false" "$(echo "$T26_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 27: update_chapter_meta summary → chapter-brief injected
# =========================================================================
echo "--- Test 27: update_chapter_meta with summary updates chapter-brief ---"
mcp_call "update_chapter_meta" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","patch":{"summary":"Unit 7 visits the morning market and finds a hidden cipher."}}' > /dev/null

T27_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_new_summary = 'hidden cipher' in md
no_old_summary = 'coded message' not in md
has_brief = '<!-- chapter-brief [PLANNING]' in md
ok = has_new_summary and no_old_summary and has_brief
print('true' if ok else 'false|new=' + str(has_new_summary) + ' no_old=' + str(no_old_summary) + ' brief=' + str(has_brief))
")
if [ "$(echo "$T27_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 27 "update_chapter_meta summary refreshes chapter-brief" "true"
else
  report 27 "update_chapter_meta summary refreshes chapter-brief" "false" "$(echo "$T27_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 28: status change updates chapter-brief status tag
# =========================================================================
echo "--- Test 28: status change updates chapter-brief tag ---"
mcp_call "update_chapter_meta" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","patch":{"status":"dirty","dirty_reason":"canon revision"}}' > /dev/null

T28_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_dirty = '[DIRTY: canon revision]' in md
no_planning = '<!-- chapter-brief [PLANNING]' not in md
ok = has_dirty and no_planning
print('true' if ok else 'false|dirty=' + str(has_dirty) + ' no_planning=' + str(no_planning))
")
if [ "$(echo "$T28_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 28 "chapter-brief status updates to [DIRTY: reason]" "true"
else
  report 28 "chapter-brief status updates to [DIRTY: reason]" "false" "$(echo "$T28_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 29: refresh_summaries updates both chapter-brief and beat-briefs
# =========================================================================
echo "--- Test 29: refresh_summaries covers chapter-brief + beat-briefs ---"
mcp_call "update_chapter_meta" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","patch":{"status":"written","dirty_reason":null}}' > /dev/null
RESULT=$(mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02"}')
TEXT=$(extract_text "$RESULT")

T29_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_ch = '<!-- chapter-brief [WRITTEN]' in md
has_beat = 'beat-brief:b01' in md
ok = has_ch and has_beat
print('true' if ok else 'false|ch_brief=' + str(has_ch) + ' beat_brief=' + str(has_beat))
")
if [ "$(echo "$T29_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 29 "refresh_summaries covers chapter-brief and beat-briefs" "true"
else
  report 29 "refresh_summaries covers chapter-brief and beat-briefs" "false" "$(echo "$T29_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 30: chapter-brief idempotency
# =========================================================================
echo "--- Test 30: chapter-brief refresh is idempotent ---"
MD_BEFORE2=$(cat "$TEST_DIR/parts/part-01/chapter-02.md")
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02"}' > /dev/null
MD_AFTER2=$(cat "$TEST_DIR/parts/part-01/chapter-02.md")
if [ "$MD_BEFORE2" = "$MD_AFTER2" ]; then
  report 30 "chapter-brief refresh is idempotent" "true"
else
  report 30 "chapter-brief refresh is idempotent" "false" "files differ after second refresh"
fi

# =========================================================================
# Cleanup
# =========================================================================
rm -f "${SCRIPT_DIR}/templates/_test-custom.json" 2>/dev/null

# =========================================================================
# Summary
# =========================================================================
echo ""
echo "================================================================="
TOTAL=$((PASS_COUNT + FAIL_COUNT))
echo "$PASS_COUNT/$TOTAL tests passed"
if [ "$FAIL_COUNT" -gt 0 ]; then
  echo "$FAIL_COUNT test(s) FAILED"
  exit 1
else
  echo "All tests passed!"
  exit 0
fi
