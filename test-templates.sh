#!/usr/bin/env bash
# Fractal MCP feature test suite
# Runs 55 tests against the Fractal MCP server on localhost:3001
# Tests the 12 consolidated tools (down from 28)

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
echo "Fractal MCP -- Consolidated Tools Test Suite (12 tools)"
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
# Test 1: template action=list
# =========================================================================
echo "--- Test 1: template action=list ---"
RESULT=$(mcp_call "template" '{"action":"list"}')
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
  report 1 "template list returns at least 4 templates" "true"
else
  report 1 "template list returns at least 4 templates" "false" "$(echo "$T1_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 2: template action=get returns full contents
# =========================================================================
echo "--- Test 2: template action=get ---"
RESULT=$(mcp_call "template" '{"action":"get","template_id":"litrpg"}')
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
  report 2 "template get returns full litrpg (6 types, themes, guide)" "true"
else
  report 2 "template get returns full litrpg (6 types, themes, guide)" "false" "$(echo "$T2_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 3: create target=project without template
# =========================================================================
echo "--- Test 3: create target=project without template ---"
RESULT=$(mcp_call "create" '{"target":"project","project":"_fractal-test","title":"Template Test"}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 3 "create project without template" "false" "Tool error: $(extract_text "$RESULT")"
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

  report 3 "create project without template -- filesystem checks" "$T3_PASS" "$T3_DETAIL"
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
# Test 5: template action=apply to existing project (adds dirs + GUIDE.md)
# =========================================================================
echo "--- Test 5: template action=apply (worldbuilding -> existing project) ---"
RESULT=$(mcp_call "template" '{"action":"apply","project":"_fractal-test","template_id":"worldbuilding"}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 5 "template apply worldbuilding" "false" "Tool error: $(extract_text "$RESULT")"
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

  report 5 "template apply adds canon dirs and GUIDE.md" "$T5_PASS" "$T5_DETAIL"
fi

# =========================================================================
# Test 6: get_context project_meta reflects applied template
# =========================================================================
echo "--- Test 6: get_context project_meta after template apply ---"
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
# Test 7: template action=save creates a new custom template
# =========================================================================
echo "--- Test 7: template action=save (create custom) ---"
RESULT=$(mcp_call "template" '{"action":"save","template_id":"_test-custom","name":"Test Custom","description":"A test template","canon_types":[{"id":"characters","label":"Characters","description":"People"},{"id":"tech","label":"Technology","description":"Gadgets and inventions"}],"themes":["innovation","disruption"],"guide":"# Custom Guide\n\nA minimal test guide."}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 7 "template save custom" "false" "Tool error: $(extract_text "$RESULT")"
else
  # Verify by reading it back
  RESULT2=$(mcp_call "template" '{"action":"get","template_id":"_test-custom"}')
  TEXT2=$(extract_text "$RESULT2")
  T7_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ids = [c['id'] for c in d.get('canon_types', [])]
ok = d.get('name') == 'Test Custom' and 'tech' in ids and len(d.get('themes',[])) == 2
print('true' if ok else 'false|name=' + str(d.get('name')) + ' types=' + str(ids) + ' themes=' + str(d.get('themes')))
" <<< "$TEXT2")

  if [ "$(echo "$T7_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 7 "template save creates and get reads back" "true"
  else
    report 7 "template save creates and get reads back" "false" "$(echo "$T7_PASS" | cut -d'|' -f2-)"
  fi
fi

# =========================================================================
# Test 8: write target=canon with custom type (factions)
# =========================================================================
echo "--- Test 8: write target=canon with custom type (factions) ---"
RESULT=$(mcp_call "write" '{"target":"canon","project":"_fractal-test","type":"factions","id":"the-guild","content":"# The Guild\n\nA powerful faction."}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 8 "write canon with custom type (factions)" "false" "$(extract_text "$RESULT")"
else
  if [ -f "$TEST_DIR/canon/factions/the-guild.md" ]; then
    report 8 "write canon with custom type (factions)" "true"
  else
    report 8 "write canon with custom type (factions)" "false" "File not on disk"
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
# Test 10: get_context with guide and canon
# =========================================================================
echo "--- Test 10: get_context with guide and canon ---"

# Create part and chapter
mcp_call "create" '{"target":"part","project":"_fractal-test","part_id":"part-01","title":"Part One"}' > /dev/null
mcp_call "create" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","title":"Chapter One"}' > /dev/null

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
# Test 13: template apply is idempotent (re-apply doesn't duplicate)
# =========================================================================
echo "--- Test 13: template apply idempotent ---"
RESULT=$(mcp_call "template" '{"action":"apply","project":"_fractal-test","template_id":"worldbuilding"}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 13 "template apply idempotent" "false" "Tool error: $(extract_text "$RESULT")"
else
  CANON_COUNT=$(python3 -c "
import json; d = json.load(open('$TEST_DIR/project.json'))
print(len(d.get('canon_types', [])))
")
  # Should still be 5, not 10
  if [ "$CANON_COUNT" = "5" ]; then
    report 13 "template apply idempotent -- still 5 canon types after re-apply" "true"
  else
    report 13 "template apply idempotent -- still 5 canon types after re-apply" "false" "count=$CANON_COUNT (expected 5)"
  fi
fi

# =========================================================================
# Test 14: create target=beat injects beat marker with [status] and summary comment
# =========================================================================
echo "--- Test 14: create target=beat injects marker + summary into prose file ---"
mcp_call "create" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat":{"id":"b01","label":"The guild arrives","summary":"The Guild marches into town at dawn. Banners flying, armor gleaming. The townsfolk watch from shuttered windows.","status":"planned","dirty_reason":null,"characters":["the-guild"],"depends_on":[],"depended_by":[]}}' > /dev/null

T14_PASS=$(python3 -c "
import sys
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_marker = '<!-- beat:b01 [planned] |' in md
has_summary = '<!-- summary:' in md
has_text = 'Guild marches into town' in md
ok = has_marker and has_summary and has_text
print('true' if ok else 'false|marker=' + str(has_marker) + ' summary=' + str(has_summary) + ' text=' + str(has_text))
")
if [ "$(echo "$T14_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 14 "create beat injects marker [planned] + summary comment into .md" "true"
else
  report 14 "create beat injects marker [planned] + summary comment into .md" "false" "$(echo "$T14_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 15: write target=beat preserves summary comment, getBeatProse is clean
# =========================================================================
echo "--- Test 15: write beat prose, verify .md has summary, beat read is clean ---"
mcp_call "write" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_id":"b01","content":"The dust rose before the column did. Marguerite saw it first."}' > /dev/null

# Check the .md on disk still has summary comment
T15A_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_summary = '<!-- summary:' in md
has_prose = 'dust rose before the column' in md
print('true' if (has_summary and has_prose) else 'false|summary=' + str(has_summary) + ' prose=' + str(has_prose))
")

# Check getBeatProse returns clean prose (no summary comment)
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"beats":["part-01/chapter-01:b01"]}}')
TEXT=$(extract_text "$RESULT")
T15B_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
prose = d.get('beats', {}).get('part-01/chapter-01:b01', {}).get('prose', '')
clean = 'summary:' not in prose
has_content = 'dust rose' in prose
print('true' if (clean and has_content) else 'false|clean=' + str(clean) + ' content=' + str(has_content))
" <<< "$TEXT")

if [ "$(echo "$T15A_PASS" | cut -d'|' -f1)" = "true" ] && [ "$(echo "$T15B_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 15 "write beat: .md has summary comment, getBeatProse is clean" "true"
else
  report 15 "write beat: .md has summary comment, getBeatProse is clean" "false" "disk=$(echo "$T15A_PASS" | cut -d'|' -f2-) api=$(echo "$T15B_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 16: update target=chapter updates beat marker status
# =========================================================================
echo "--- Test 16: update chapter updates beat marker status ---"
mcp_call "update" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","patch":{"beats":[{"id":"b01","status":"written"}]}}' > /dev/null

T16_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_written = '<!-- beat:b01 [written]' in md
no_planned = '[planned]' not in md
print('true' if (has_written and no_planned) else 'false|written=' + str(has_written) + ' no_planned=' + str(no_planned))
")
if [ "$(echo "$T16_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 16 "update chapter updates beat marker to [written]" "true"
else
  report 16 "update chapter updates beat marker to [written]" "false" "$(echo "$T16_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 17: update target=node dirty updates beat marker + sidecar
# =========================================================================
echo "--- Test 17: update node dirty updates marker [dirty] + sidecar dirty_reason ---"
mcp_call "update" '{"target":"node","project":"_fractal-test","node_ref":"part-01/chapter-01:b01","mark":"dirty","reason":"canon change: the-guild backstory revised"}' > /dev/null

T17_PASS=$(python3 -c "
import json
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
meta = json.load(open('$TEST_DIR/parts/part-01/chapter-01.meta.json'))
has_dirty_marker = '<!-- beat:b01 [dirty]' in md
no_written = '[written]' not in md
beat_meta = [b for b in meta.get('beats', []) if b['id'] == 'b01']
has_dirty_reason = len(beat_meta) > 0 and beat_meta[0].get('dirty_reason') == 'canon change: the-guild backstory revised'
ok = has_dirty_marker and no_written and has_dirty_reason
print('true' if ok else 'false|marker=' + str(has_dirty_marker) + ' no_written=' + str(no_written) + ' reason=' + str(has_dirty_reason))
")
if [ "$(echo "$T17_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 17 "update node dirty: marker [dirty] + sidecar dirty_reason" "true"
else
  report 17 "update node dirty: marker [dirty] + sidecar dirty_reason" "false" "$(echo "$T17_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 18: edit target=beat preserves summary comment
# =========================================================================
echo "--- Test 18: edit beat preserves summary comment ---"
mcp_call "edit" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_id":"b01","edits":[{"old_str":"Marguerite saw it first","new_str":"Marguerite noticed it first"}]}' > /dev/null

T18_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
has_summary = '<!-- summary:' in md
has_edit = 'noticed it first' in md
print('true' if (has_summary and has_edit) else 'false|summary=' + str(has_summary) + ' edit=' + str(has_edit))
")
if [ "$(echo "$T18_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 18 "edit beat preserves summary comment" "true"
else
  report 18 "edit beat preserves summary comment" "false" "$(echo "$T18_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 19: add second beat, reorder — summaries travel with beats
# =========================================================================
echo "--- Test 19: reorder_beats carries summary comments with beats ---"
mcp_call "create" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat":{"id":"b02","label":"The standoff","summary":"Unit 7 stands between the Guild and the bakery door. She does not move.","status":"planned","dirty_reason":null,"characters":["unit-7","the-guild"],"depends_on":[],"depended_by":[]}}' > /dev/null

mcp_call "reorder_beats" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_order":["b02","b01"]}' > /dev/null

T19_PASS=$(python3 -c "
import re
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
b02_marker = md.find('beat:b02')
b01_marker = md.find('beat:b01')
order_ok = 0 < b02_marker < b01_marker
# Each beat should have its own summary nearby
b02_section = md[b02_marker:b01_marker]
b01_section = md[b01_marker:]
b02_has_summary = '<!-- summary:' in b02_section and 'bakery door' in b02_section
b01_has_summary = '<!-- summary:' in b01_section and 'Guild marches' in b01_section
ok = order_ok and b02_has_summary and b01_has_summary
print('true' if ok else 'false|order=' + str(order_ok) + ' b02_sum=' + str(b02_has_summary) + ' b01_sum=' + str(b01_has_summary))
")
if [ "$(echo "$T19_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 19 "reorder_beats: summary comments travel with their blocks" "true"
else
  report 19 "reorder_beats: summary comments travel with their blocks" "false" "$(echo "$T19_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 20: refresh_summaries (migration) tool works
# =========================================================================
echo "--- Test 20: refresh_summaries (migration) tool ---"
RESULT=$(mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01"}')
TEXT=$(extract_text "$RESULT")
T20_PASS=$(python3 -c "
import sys
text = sys.stdin.read()
ok = 'up to date' in text.lower() or 'migrat' in text.lower() or 'already' in text.lower()
print('true' if ok else 'false|' + repr(text[:200]))
" <<< "$TEXT")
if [ "$(echo "$T20_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 20 "refresh_summaries (migration) tool responds correctly" "true"
else
  report 20 "refresh_summaries (migration) tool responds correctly" "false" "$(echo "$T20_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 21: idempotency — migration twice produces identical .md
# =========================================================================
echo "--- Test 21: migration is idempotent ---"
MD_BEFORE=$(cat "$TEST_DIR/parts/part-01/chapter-01.md")
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01"}' > /dev/null
MD_AFTER=$(cat "$TEST_DIR/parts/part-01/chapter-01.md")
if [ "$MD_BEFORE" = "$MD_AFTER" ]; then
  report 21 "migration is idempotent — .md unchanged on second run" "true"
else
  report 21 "migration is idempotent — .md unchanged on second run" "false" "files differ"
fi

# =========================================================================
# Test 22: long summary is preserved in full in summary comment
# =========================================================================
echo "--- Test 22: long summary is preserved in full in summary comment ---"
mcp_call "create" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat":{"id":"b03","label":"The long speech","summary":"This is a very long beat summary that goes on and on about many things. It describes in great detail everything that happens in this particular beat of the story. The characters do things, say things, and experience things. There are descriptions of the setting, the mood, the weather, and the general atmosphere. This continues for quite a while because we want to test that the truncation logic works properly when the summary exceeds the maximum length allowed.","status":"planned","dirty_reason":null,"characters":[],"depends_on":[],"depended_by":[]}}' > /dev/null

T22_PASS=$(python3 -c "
import re
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
# Find the b03 beat marker position
b03_pos = md.find('beat:b03')
if b03_pos < 0:
    print('false|no beat:b03 marker found')
else:
    after = md[b03_pos:]
    m = re.search(r'<!-- summary:\s*(.*?)\s*-->', after, re.DOTALL)
    if not m:
        print('false|no summary comment found after b03')
    else:
        # Normalize whitespace (word-wrapping inserts newlines)
        text = ' '.join(m.group(1).split())
        has_start = 'This is a very long' in text
        has_end = 'maximum length allowed' in text
        ok = has_start and has_end
        print('true' if ok else 'false|start=' + str(has_start) + ' end=' + str(has_end) + ' len=' + str(len(text)))
")
if [ "$(echo "$T22_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 22 "long summary is preserved in full in summary comment" "true"
else
  report 22 "long summary is preserved in full in summary comment" "false" "$(echo "$T22_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 23: remove target=beat also removes its summary comment
# =========================================================================
echo "--- Test 23: remove beat removes marker and summary comment ---"
mcp_call "remove" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-01","beat_id":"b03"}' > /dev/null

T23_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
no_marker = 'beat:b03' not in md
no_long_summary = 'maximum length allowed' not in md
print('true' if (no_marker and no_long_summary) else 'false|marker_gone=' + str(no_marker) + ' summary_gone=' + str(no_long_summary))
")
if [ "$(echo "$T23_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 23 "remove beat removes marker and summary comment" "true"
else
  report 23 "remove beat removes marker and summary comment" "false" "$(echo "$T23_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 24: create chapter with summary → chapter-summary appears
# =========================================================================
echo "--- Test 24: create chapter with summary injects chapter-summary ---"
mcp_call "create" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","title":"The Market","summary":"Unit 7 visits the morning market and discovers a coded message."}' > /dev/null

T24_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
md_flat = ' '.join(md.split())  # normalize word-wrapped lines
has_heading = '# The Market' in md
has_summary = '<!-- chapter-summary:' in md
has_text = 'coded message' in md_flat
has_close = '<!-- /chapter -->' in md
ok = has_heading and has_summary and has_text and has_close
print('true' if ok else 'false|heading=' + str(has_heading) + ' ch_summary=' + str(has_summary) + ' text=' + str(has_text) + ' close=' + str(has_close))
")
if [ "$(echo "$T24_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 24 "create chapter with summary injects chapter-summary comment" "true"
else
  report 24 "create chapter with summary injects chapter-summary comment" "false" "$(echo "$T24_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 25: create chapter without summary → no chapter-summary
# =========================================================================
echo "--- Test 25: create chapter without summary → no chapter-summary ---"
T25_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-01.md').read()
no_summary = 'chapter-summary' not in md
print('true' if no_summary else 'false|chapter-summary found in chapter without summary')
")
if [ "$(echo "$T25_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 25 "chapter without summary has no chapter-summary" "true"
else
  report 25 "chapter without summary has no chapter-summary" "false" "$(echo "$T25_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 26: chapter-summary coexists with beat summary comments
# =========================================================================
echo "--- Test 26: chapter-summary coexists with beat summary comments ---"
mcp_call "create" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","beat":{"id":"b01","label":"Arriving at market","summary":"Unit 7 enters through the east gate. Vendors call out prices.","status":"planned","dirty_reason":null,"characters":["unit-7"],"depends_on":[],"depended_by":[]}}' > /dev/null

T26_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_ch_summary = '<!-- chapter-summary:' in md
has_beat_summary = '<!-- summary:' in md
has_beat_marker = '<!-- beat:b01 [planned] |' in md
# chapter-summary should come before beat markers
cs_pos = md.find('chapter-summary')
bm_pos = md.find('beat:b01')
order_ok = cs_pos < bm_pos
ok = has_ch_summary and has_beat_summary and has_beat_marker and order_ok
print('true' if ok else 'false|ch_summary=' + str(has_ch_summary) + ' beat_summary=' + str(has_beat_summary) + ' order=' + str(order_ok))
")
if [ "$(echo "$T26_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 26 "chapter-summary coexists with beat summaries, correct order" "true"
else
  report 26 "chapter-summary coexists with beat summaries, correct order" "false" "$(echo "$T26_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 27: update chapter summary → chapter-summary updated
# =========================================================================
echo "--- Test 27: update chapter with summary updates chapter-summary ---"
mcp_call "update" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","patch":{"summary":"Unit 7 visits the morning market and finds a hidden cipher."}}' > /dev/null

T27_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
md_flat = ' '.join(md.split())  # normalize word-wrapped lines
has_new_summary = 'hidden cipher' in md_flat
no_old_summary = 'coded message' not in md_flat
has_ch_summary = '<!-- chapter-summary:' in md
ok = has_new_summary and no_old_summary and has_ch_summary
print('true' if ok else 'false|new=' + str(has_new_summary) + ' no_old=' + str(no_old_summary) + ' ch_summary=' + str(has_ch_summary))
")
if [ "$(echo "$T27_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 27 "update chapter summary refreshes chapter-summary comment" "true"
else
  report 27 "update chapter summary refreshes chapter-summary comment" "false" "$(echo "$T27_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 28: chapter status change preserved in sidecar, summary intact
# =========================================================================
echo "--- Test 28: chapter status change: sidecar dirty_reason, md summary intact ---"
mcp_call "update" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","patch":{"status":"dirty","dirty_reason":"canon revision"}}' > /dev/null

T28_PASS=$(python3 -c "
import json
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
md_flat = ' '.join(md.split())  # normalize word-wrapped lines
has_summary = 'hidden cipher' in md_flat
has_ch_summary = '<!-- chapter-summary:' in md
has_heading = '# The Market' in md
has_close = '<!-- /chapter -->' in md
ok = has_summary and has_ch_summary and has_heading and has_close
print('true' if ok else 'false|summary=' + str(has_summary) + ' ch_summary=' + str(has_ch_summary) + ' heading=' + str(has_heading) + ' close=' + str(has_close))
")
if [ "$(echo "$T28_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 28 "chapter status change: md summary preserved, file valid" "true"
else
  report 28 "chapter status change: md summary preserved, file valid" "false" "$(echo "$T28_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 29: migration produces chapter-summary and beat summary comments
# =========================================================================
echo "--- Test 29: migration covers chapter-summary + beat summaries ---"
mcp_call "update" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","patch":{"status":"written","dirty_reason":null}}' > /dev/null
RESULT=$(mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02"}')
TEXT=$(extract_text "$RESULT")

T29_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
has_ch = '<!-- chapter-summary:' in md
has_beat = '<!-- summary:' in md
ok = has_ch and has_beat
print('true' if ok else 'false|ch_summary=' + str(has_ch) + ' beat_summary=' + str(has_beat))
")
if [ "$(echo "$T29_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 29 "migration: chapter-summary and beat summary comments present" "true"
else
  report 29 "migration: chapter-summary and beat summary comments present" "false" "$(echo "$T29_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 30: migration idempotency
# =========================================================================
echo "--- Test 30: migration is idempotent ---"
MD_BEFORE2=$(cat "$TEST_DIR/parts/part-01/chapter-02.md")
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02"}' > /dev/null
MD_AFTER2=$(cat "$TEST_DIR/parts/part-01/chapter-02.md")
if [ "$MD_BEFORE2" = "$MD_AFTER2" ]; then
  report 30 "migration is idempotent" "true"
else
  report 30 "migration is idempotent" "false" "files differ after second migration"
fi

# =========================================================================
# Test 31: @eaDir project directory invisible to list_projects
# =========================================================================
echo "--- Test 31: @eaDir invisible to list_projects ---"
mkdir -p "${SCRIPT_DIR}/test-projects/@eaDir"
cat > "${SCRIPT_DIR}/test-projects/@eaDir/project.json" <<'EADIR_JSON'
{"title":"Junk NAS dir","subtitle":null,"logline":"","status":"planning","themes":[],"parts":[]}
EADIR_JSON

RESULT=$(mcp_call "list_projects" '{}')
TEXT=$(extract_text "$RESULT")
T31_PASS=$(python3 -c "
import json, sys
projects = json.loads(sys.stdin.read())
ids = [p['id'] for p in projects]
ok = '@eaDir' not in ids
print('true' if ok else 'false|@eaDir found in: ' + str(ids))
" <<< "$TEXT")
rm -rf "${SCRIPT_DIR}/test-projects/@eaDir"

if [ "$(echo "$T31_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 31 "@eaDir project dir invisible to list_projects" "true"
else
  report 31 "@eaDir project dir invisible to list_projects" "false" "$(echo "$T31_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 32: @eaDir inside parts/ invisible to search (via get_context)
# =========================================================================
echo "--- Test 32: @eaDir inside parts/ invisible to search ---"
mkdir -p "$TEST_DIR/parts/@eaDir"
cat > "$TEST_DIR/parts/@eaDir/junk.md" <<'EADIR_MD'
# Secret NAS metadata
This contains the word guild for search matching.
EADIR_MD

RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"search":{"query":"guild"}}}')
TEXT=$(extract_text "$RESULT")
T32_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
search = d.get('search', {})
results_str = str(search.get('results', []))
ok = '@eaDir' not in results_str
print('true' if ok else 'false|@eaDir found in search results: ' + repr(results_str[:300]))
" <<< "$TEXT")
rm -rf "$TEST_DIR/parts/@eaDir"

if [ "$(echo "$T32_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 32 "@eaDir inside parts/ invisible to search (via get_context)" "true"
else
  report 32 "@eaDir inside parts/ invisible to search (via get_context)" "false" "$(echo "$T32_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 33: .DS_Store invisible to listCanon
# =========================================================================
echo "--- Test 33: .DS_Store invisible to listCanon ---"
touch "$TEST_DIR/canon/characters/.DS_Store"

RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon_list":"characters"}}')
TEXT=$(extract_text "$RESULT")
T33_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entries = d.get('canon_list', [])
ok = '.DS_Store' not in entries
print('true' if ok else 'false|entries=' + str(entries))
" <<< "$TEXT")
rm -f "$TEST_DIR/canon/characters/.DS_Store"

if [ "$(echo "$T33_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 33 ".DS_Store invisible to listCanon" "true"
else
  report 33 ".DS_Store invisible to listCanon" "false" "$(echo "$T33_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 34: Flat canon still works (existing behavior)
# =========================================================================
echo "--- Test 34: flat canon write + get_context ---"
mcp_call "write" '{"target":"canon","project":"_fractal-test","type":"characters","id":"flat-char","content":"# Flat Character\n\nA simple character entry."}' > /dev/null
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["flat-char"]}}')
TEXT=$(extract_text "$RESULT")
T34_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entry = d.get('canon', {}).get('flat-char', {})
content = entry.get('content', '')
ok = '# Flat Character' in content and 'simple character' in content
print('true' if ok else 'false|content=' + repr(content[:100]))
" <<< "$TEXT")
if [ "$(echo "$T34_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 34 "flat canon: write + get_context returns correct content" "true"
else
  report 34 "flat canon: write + get_context returns correct content" "false" "$(echo "$T34_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 35: Canon entry with ## sections → returns sections array + top-matter only
# =========================================================================
echo "--- Test 35: canon entry returns sections TOC and top-matter ---"
mcp_call "write" '{"target":"canon","project":"_fractal-test","type":"characters","id":"sectioned-char","content":"# Sectioned Character\n\nTop-matter summary line.\n\n## Core\n\n- Age: 30\n- Role: Tester\n\n## Voice & Personality\n\n- Dry wit, short sentences\n- Never uses metaphor\n\n## Arc Summary\n\nGoes from doubt to confidence."}' > /dev/null
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["sectioned-char"]}}')
TEXT=$(extract_text "$RESULT")
T35_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entry = d.get('canon', {}).get('sectioned-char', {})
content = entry.get('content', '')
sections = entry.get('sections', [])
# content should be top-matter only (no ## headers)
has_top = 'Top-matter summary' in content
no_section_content = '## Core' not in content and '## Voice' not in content
has_sections = len(sections) == 3
section_ids = [s.get('id') for s in sections] if has_sections else []
ids_ok = section_ids == ['core', 'voice--personality', 'arc-summary'] or section_ids == ['core', 'voice-personality', 'arc-summary']
ok = has_top and no_section_content and has_sections and ids_ok
print('true' if ok else 'false|content=' + repr(content[:200]) + ' sections=' + str(sections) + ' ids=' + str(section_ids))
" <<< "$TEXT")
if [ "$(echo "$T35_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 35 "canon entry returns sections TOC + top-matter only" "true"
else
  report 35 "canon entry returns sections TOC + top-matter only" "false" "$(echo "$T35_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 36: Fetch specific canon section via # notation
# =========================================================================
echo "--- Test 36: fetch canon section via # notation ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["sectioned-char#voice-personality"]}}')
TEXT=$(extract_text "$RESULT")
T36_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entry = d.get('canon', {}).get('sectioned-char#voice-personality', {})
content = entry.get('content', '')
has_header = '## Voice & Personality' in content
has_detail = 'Dry wit' in content
no_other = '## Core' not in content and '## Arc' not in content
ok = has_header and has_detail and no_other
print('true' if ok else 'false|content=' + repr(content[:300]))
" <<< "$TEXT")
if [ "$(echo "$T36_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 36 "# notation returns specific section content" "true"
else
  report 36 "# notation returns specific section content" "false" "$(echo "$T36_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 37: Batch fetch multiple sections
# =========================================================================
echo "--- Test 37: batch fetch multiple sections ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["sectioned-char#core","sectioned-char#arc-summary"]}}')
TEXT=$(extract_text "$RESULT")
T37_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
canon = d.get('canon', {})
has_core = 'sectioned-char#core' in canon
has_arc = 'sectioned-char#arc-summary' in canon
core_ok = '## Core' in canon.get('sectioned-char#core', {}).get('content', '') if has_core else False
arc_ok = '## Arc Summary' in canon.get('sectioned-char#arc-summary', {}).get('content', '') if has_arc else False
ok = has_core and has_arc and core_ok and arc_ok
print('true' if ok else 'false|has_core=' + str(has_core) + ' has_arc=' + str(has_arc) + ' core_ok=' + str(core_ok) + ' arc_ok=' + str(arc_ok))
" <<< "$TEXT")
if [ "$(echo "$T37_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 37 "batch fetch multiple sections via # notation" "true"
else
  report 37 "batch fetch multiple sections via # notation" "false" "$(echo "$T37_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 38: Nonexistent section returns error with available sections list
# =========================================================================
echo "--- Test 38: nonexistent section returns helpful error ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["sectioned-char#nonexistent"]}}')
TEXT=$(extract_text "$RESULT")
T38_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
errors = d.get('errors', {})
err_key = 'canon:sectioned-char#nonexistent'
has_error = err_key in errors
err_msg = errors.get(err_key, '')
mentions_available = 'core' in err_msg and 'voice-personality' in err_msg
ok = has_error and mentions_available
print('true' if ok else 'false|errors=' + str(errors))
" <<< "$TEXT")
if [ "$(echo "$T38_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 38 "nonexistent section returns error listing available sections" "true"
else
  report 38 "nonexistent section returns error listing available sections" "false" "$(echo "$T38_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 39: Canon entry without ## headers returns full content (backward compat)
# =========================================================================
echo "--- Test 39: canon without ## headers returns full content ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"canon":["the-guild"]}}')
TEXT=$(extract_text "$RESULT")
T39_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
entry = d.get('canon', {}).get('the-guild', {})
content = entry.get('content', '')
sections = entry.get('sections', [])
ok = '# The Guild' in content and 'powerful faction' in content and sections == []
print('true' if ok else 'false|content=' + repr(content[:200]) + ' sections=' + str(sections))
" <<< "$TEXT")
if [ "$(echo "$T39_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 39 "canon without ## headers returns full content, sections=[]" "true"
else
  report 39 "canon without ## headers returns full content, sections=[]" "false" "$(echo "$T39_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 40: edit target=canon — basic single edit
# =========================================================================
echo "--- Test 40: edit canon basic single edit ---"
RESULT=$(mcp_call "edit" '{"target":"canon","project":"_fractal-test","type":"factions","id":"the-guild","edits":[{"old_str":"A powerful faction.","new_str":"A powerful and ancient faction."}]}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 40 "edit canon basic single edit" "false" "Tool error: $(extract_text "$RESULT")"
else
  TEXT=$(extract_text "$RESULT")
  T40_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ok = d.get('edits_applied') == 1
print('true' if ok else 'false|edits_applied=' + str(d.get('edits_applied')))
" <<< "$TEXT")

  # Verify on disk
  T40_DISK=$(python3 -c "
content = open('$TEST_DIR/canon/factions/the-guild.md').read()
ok = 'powerful and ancient faction' in content and 'A powerful faction.' not in content
print('true' if ok else 'false|content=' + repr(content[:200]))
")

  if [ "$(echo "$T40_PASS" | cut -d'|' -f1)" = "true" ] && [ "$(echo "$T40_DISK" | cut -d'|' -f1)" = "true" ]; then
    report 40 "edit canon basic single edit" "true"
  else
    report 40 "edit canon basic single edit" "false" "api=$(echo "$T40_PASS" | cut -d'|' -f2-) disk=$(echo "$T40_DISK" | cut -d'|' -f2-)"
  fi
fi

# =========================================================================
# Test 41: edit target=canon — multiple ordered edits
# =========================================================================
echo "--- Test 41: edit canon multiple edits ---"
RESULT=$(mcp_call "edit" '{"target":"canon","project":"_fractal-test","type":"factions","id":"the-guild","edits":[{"old_str":"# The Guild","new_str":"# The Grand Guild"},{"old_str":"powerful and ancient","new_str":"mighty and ancient"}]}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 41 "edit canon multiple edits" "false" "Tool error: $(extract_text "$RESULT")"
else
  TEXT=$(extract_text "$RESULT")
  T41_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
ok = d.get('edits_applied') == 2
print('true' if ok else 'false|edits_applied=' + str(d.get('edits_applied')))
" <<< "$TEXT")

  T41_DISK=$(python3 -c "
content = open('$TEST_DIR/canon/factions/the-guild.md').read()
ok = '# The Grand Guild' in content and 'mighty and ancient' in content
print('true' if ok else 'false|content=' + repr(content[:200]))
")

  if [ "$(echo "$T41_PASS" | cut -d'|' -f1)" = "true" ] && [ "$(echo "$T41_DISK" | cut -d'|' -f1)" = "true" ]; then
    report 41 "edit canon multiple edits applied in order" "true"
  else
    report 41 "edit canon multiple edits applied in order" "false" "api=$(echo "$T41_PASS" | cut -d'|' -f2-) disk=$(echo "$T41_DISK" | cut -d'|' -f2-)"
  fi
fi

# =========================================================================
# Test 42: edit target=canon — rejects duplicate matches
# =========================================================================
echo "--- Test 42: edit canon rejects duplicate match ---"
# First create an entry with duplicate text
mcp_call "write" '{"target":"canon","project":"_fractal-test","type":"factions","id":"dup-test","content":"# Dup Test\n\nThe word apple appears here. And apple appears again."}' > /dev/null
RESULT=$(mcp_call "edit" '{"target":"canon","project":"_fractal-test","type":"factions","id":"dup-test","edits":[{"old_str":"apple","new_str":"orange"}]}')
ERR=$(is_error "$RESULT")
TEXT=$(extract_text "$RESULT")
T42_PASS=$(python3 -c "
import sys
text = sys.stdin.read()
ok = 'matches 2 locations' in text or 'matches' in text.lower()
print('true' if ok else 'false|response=' + repr(text[:300]))
" <<< "$TEXT")
if [ "$(echo "$T42_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 42 "edit canon rejects duplicate match with helpful error" "true"
else
  report 42 "edit canon rejects duplicate match with helpful error" "false" "$(echo "$T42_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 43: edit target=canon — rejects missing match
# =========================================================================
echo "--- Test 43: edit canon rejects missing match ---"
RESULT=$(mcp_call "edit" '{"target":"canon","project":"_fractal-test","type":"factions","id":"the-guild","edits":[{"old_str":"this text does not exist anywhere","new_str":"replacement"}]}')
ERR=$(is_error "$RESULT")
TEXT=$(extract_text "$RESULT")
T43_PASS=$(python3 -c "
import sys
text = sys.stdin.read()
ok = 'No match' in text or 'no match' in text.lower()
print('true' if ok else 'false|response=' + repr(text[:300]))
" <<< "$TEXT")
if [ "$(echo "$T43_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 43 "edit canon rejects missing match with helpful error" "true"
else
  report 43 "edit canon rejects missing match with helpful error" "false" "$(echo "$T43_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 44: search via get_context include.search
# =========================================================================
echo "--- Test 44: search via get_context include.search ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"search":{"query":"dust rose","scope":"prose"}}}')
TEXT=$(extract_text "$RESULT")
T44_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
search = d.get('search', {})
results = search.get('results', [])
total = search.get('total', 0)
ok = total > 0 and any('dust rose' in r for r in results)
print('true' if ok else 'false|total=' + str(total) + ' results=' + str(results[:2]))
" <<< "$TEXT")
if [ "$(echo "$T44_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 44 "search via get_context include.search finds prose" "true"
else
  report 44 "search via get_context include.search finds prose" "false" "$(echo "$T44_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 45: search with no results
# =========================================================================
echo "--- Test 45: search with no results returns message ---"
RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"search":{"query":"zzz_nonexistent_zzz"}}}')
TEXT=$(extract_text "$RESULT")
T45_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
search = d.get('search', {})
ok = len(search.get('results', [])) == 0 and 'No results' in search.get('message', '')
print('true' if ok else 'false|search=' + str(search))
" <<< "$TEXT")
if [ "$(echo "$T45_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 45 "search with no results returns empty results + message" "true"
else
  report 45 "search with no results returns empty results + message" "false" "$(echo "$T45_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 46: multi-line summary doesn't duplicate chapter-summary (regression)
# =========================================================================
echo "--- Test 46: multi-line summary produces exactly one chapter-summary ---"
mcp_call "create" '{"target":"chapter","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-03","title":"The Return","summary":"Mid-October. The thermostat cranks up.\n\nTHE BOND: Second visit. Together again but the energy is completely different."}' > /dev/null

T46_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-03.md').read()
import re
# Count chapter-summary comment blocks (single or multi-line)
summaries = list(re.finditer(r'<!-- chapter-summary:.*?-->', md, re.DOTALL))
ok = len(summaries) == 1
print('true' if ok else 'false|count=' + str(len(summaries)))
")
if [ "$(echo "$T46_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 46 "multi-line summary produces exactly one chapter-summary" "true"
else
  report 46 "multi-line summary produces exactly one chapter-summary" "false" "$(echo "$T46_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 47: repeated migration doesn't duplicate chapter-summary
# =========================================================================
echo "--- Test 47: repeated migration doesn't duplicate chapter-summary ---"
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-03"}' > /dev/null
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-03"}' > /dev/null
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-03"}' > /dev/null

T47_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-03.md').read()
import re
summaries = re.findall(r'chapter-summary:', md)
ok = len(summaries) == 1
print('true' if ok else 'false|count=' + str(len(summaries)) + ' expected 1')
")
if [ "$(echo "$T47_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 47 "repeated migration doesn't duplicate chapter-summary" "true"
else
  report 47 "repeated migration doesn't duplicate chapter-summary" "false" "$(echo "$T47_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 48: legacy chapter-brief gets migrated to chapter-summary
# =========================================================================
echo "--- Test 48: legacy chapter-brief gets migrated to chapter-summary ---"
# Simulate legacy format: manually inject old-style chapter-briefs
python3 << 'PYEOF'
import sys
path = sys.argv[1] if len(sys.argv) > 1 else None
PYEOF

python3 -c "
import os, sys
path = '$TEST_DIR/parts/part-01/chapter-03.md'
md = open(path).read()
# Inject legacy chapter-brief comments (simulating pre-migration format)
extra = '<!-- chapter-brief [PLANNING] Mid-October. The thermostat cranks up. THE BOND: Second visit. Together again. -->'
# Insert after heading
lines = md.split(chr(10))
for i, line in enumerate(lines):
    if line.startswith('# '):
        lines.insert(i+1, extra)
        lines.insert(i+2, extra)
        lines.insert(i+3, extra)
        break
open(path, 'w').write(chr(10).join(lines))
"

# Now migration should clean up legacy chapter-briefs and produce one chapter-summary
mcp_call "refresh_summaries" '{"project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-03"}' > /dev/null

T48_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-03.md').read()
import re
legacy_briefs = list(re.finditer(r'chapter-brief', md))
new_summaries = list(re.finditer(r'chapter-summary:', md))
no_legacy = len(legacy_briefs) == 0
has_one_summary = len(new_summaries) == 1
ok = no_legacy and has_one_summary
print('true' if ok else 'false|legacy_count=' + str(len(legacy_briefs)) + ' summary_count=' + str(len(new_summaries)))
")
if [ "$(echo "$T48_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 48 "legacy chapter-brief migrated to single chapter-summary" "true"
else
  report 48 "legacy chapter-brief migrated to single chapter-summary" "false" "$(echo "$T48_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 49: annotation with newlines in message → single-line on disk
# =========================================================================
echo "--- Test 49: annotation with newlines → collapsed to single line ---"
# Write some prose first so we have a valid line to annotate
mcp_call "write" '{"target":"beat","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","beat_id":"b01","content":"The morning sun hit the cobblestones.\n\nUnit 7 walked through the gate."}' > /dev/null

RESULT=$(mcp_call "create" '{"target":"note","project":"_fractal-test","part_id":"part-01","chapter_id":"chapter-02","line_number":5,"note_type":"dev","message":"This needs work.\nThe pacing is off.\nConsider cutting."}')
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 49 "annotation with newlines" "false" "Tool error: $(extract_text "$RESULT")"
else
  T49_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
import re
# Find the annotation line
annos = [l for l in md.split('\n') if '<!-- @dev' in l and 'pacing' in l]
if not annos:
    print('false|no annotation with pacing found')
else:
    # Should be single line (contains both <!-- and -->)
    single = annos[0].strip().startswith('<!--') and annos[0].strip().endswith('-->')
    no_newlines = '\n' not in annos[0]
    ok = single and no_newlines
    print('true' if ok else 'false|single=' + str(single) + ' line=' + repr(annos[0][:200]))
")
  if [ "$(echo "$T49_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 49 "annotation with newlines collapsed to single line on disk" "true"
  else
    report 49 "annotation with newlines collapsed to single line on disk" "false" "$(echo "$T49_PASS" | cut -d'|' -f2-)"
  fi
fi

# =========================================================================
# Test 50: multi-line annotation on disk is parsed and visible
# =========================================================================
echo "--- Test 50: multi-line annotation on disk is parsed ---"
# Manually inject a multi-line annotation into the prose file
python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
lines = md.split('\n')
# Insert a multi-line annotation after line 5
multi = '<!-- @note(claude): This is a multi-line\nannotation that spans\nmultiple lines -->'
lines.insert(5, multi)
open('$TEST_DIR/parts/part-01/chapter-02.md', 'w').write('\n'.join(lines))
"

RESULT=$(mcp_call "get_context" '{"project":"_fractal-test","include":{"notes":{"scope":"part-01/chapter-02"}}}')
TEXT=$(extract_text "$RESULT")
T50_PASS=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
notes = d.get('notes', {}).get('notes', [])
# Find the multi-line annotation
found = [n for n in notes if n.get('message') and 'multi-line' in n['message'] and 'multiple lines' in n['message']]
ok = len(found) == 1 and found[0].get('author') == 'claude'
print('true' if ok else 'false|found=' + str(len(found)) + ' notes=' + str([n.get('message','')[:50] for n in notes]))
" <<< "$TEXT")
if [ "$(echo "$T50_PASS" | cut -d'|' -f1)" = "true" ]; then
  report 50 "multi-line annotation on disk is parsed correctly" "true"
else
  report 50 "multi-line annotation on disk is parsed correctly" "false" "$(echo "$T50_PASS" | cut -d'|' -f2-)"
fi

# =========================================================================
# Test 51: multi-line annotation can be removed
# =========================================================================
echo "--- Test 51: multi-line annotation can be removed ---"
# Get the note ID from the previous test
NOTE_ID=$(python3 -c "
import json, sys
d = json.loads(sys.stdin.read())
notes = d.get('notes', {}).get('notes', [])
found = [n for n in notes if n.get('message') and 'multi-line' in n['message']]
print(found[0]['id'] if found else '')
" <<< "$TEXT")

if [ -z "$NOTE_ID" ]; then
  report 51 "multi-line annotation removal" "false" "No multi-line note ID found"
else
  RESULT=$(mcp_call "remove" "{\"target\":\"notes\",\"project\":\"_fractal-test\",\"note_ids\":[\"$NOTE_ID\"]}")
  ERR=$(is_error "$RESULT")
  if [ "$ERR" = "true" ]; then
    report 51 "multi-line annotation removal" "false" "Tool error: $(extract_text "$RESULT")"
  else
    T51_PASS=$(python3 -c "
md = open('$TEST_DIR/parts/part-01/chapter-02.md').read()
no_multi = 'multi-line' not in md and 'multiple lines' not in md
print('true' if no_multi else 'false|multi-line annotation still in file')
")
    if [ "$(echo "$T51_PASS" | cut -d'|' -f1)" = "true" ]; then
      report 51 "multi-line annotation removed from disk" "true"
    else
      report 51 "multi-line annotation removed from disk" "false" "$(echo "$T51_PASS" | cut -d'|' -f2-)"
    fi
  fi
fi

# =========================================================================
# Notes Files (.notes.md) Tests
# =========================================================================

echo "--- Test 52: write part_notes creates part-01.notes.md ---"
RESULT=$(mcp_call "write" "{\"target\":\"part_notes\",\"project\":\"_fractal-test\",\"part_id\":\"part-01\",\"content\":\"# Part Notes\\n\\nThis is part-level planning context.\\n\\n## Theme\\n\\nExploration of connection.\\n\"}")
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 52 "write part_notes" "false" "Tool error: $(extract_text "$RESULT")"
else
  T52_PASS=$(python3 -c "
import os
path = '$TEST_DIR/parts/part-01/part-01.notes.md'
if not os.path.exists(path):
    print('false|file not created')
else:
    content = open(path).read()
    has_header = '# Part Notes' in content
    has_theme = '## Theme' in content
    has_text = 'part-level planning' in content
    if has_header and has_theme and has_text:
        print('true')
    else:
        print('false|content missing expected text')
")
  if [ "$(echo "$T52_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 52 "write part_notes creates file with content" "true"
  else
    report 52 "write part_notes" "false" "$(echo "$T52_PASS" | cut -d'|' -f2-)"
  fi
fi

echo "--- Test 53: write chapter_notes creates chapter-01.notes.md ---"
RESULT=$(mcp_call "write" "{\"target\":\"chapter_notes\",\"project\":\"_fractal-test\",\"part_id\":\"part-01\",\"chapter_id\":\"chapter-01\",\"content\":\"# Chapter Notes: Opening\\n\\n## Beat b01\\n\\nDense planning for this beat. Psychology, themes, foreshadowing.\\n\\n## Parking Lot\\n\\n- Research needed\\n\"}")
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 53 "write chapter_notes" "false" "Tool error: $(extract_text "$RESULT")"
else
  T53_PASS=$(python3 -c "
import os
path = '$TEST_DIR/parts/part-01/chapter-01.notes.md'
if not os.path.exists(path):
    print('false|file not created')
else:
    content = open(path).read()
    has_header = '# Chapter Notes: Opening' in content
    has_beat = '## Beat b01' in content
    has_planning = 'Dense planning' in content
    has_parking = '## Parking Lot' in content
    if has_header and has_beat and has_planning and has_parking:
        print('true')
    else:
        print('false|content missing expected text')
")
  if [ "$(echo "$T53_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 53 "write chapter_notes creates file with content" "true"
  else
    report 53 "write chapter_notes" "false" "$(echo "$T53_PASS" | cut -d'|' -f2-)"
  fi
fi

echo "--- Test 54: get_context lazy-loads notes with sections TOC ---"
RESULT=$(mcp_call "get_context" "{\"project\":\"_fractal-test\",\"include\":{\"part_notes\":[\"part-01\"],\"chapter_notes\":[\"part-01/chapter-01\"]}}")
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 54 "get_context with part_notes and chapter_notes" "false" "Tool error: $(extract_text "$RESULT")"
else
  T54_PASS=$(python3 -c "
import json, sys
text = sys.stdin.read()
d = json.loads(text)
pn = d.get('part_notes', {}).get('part-01', '')
cn = d.get('chapter_notes', {}).get('part-01/chapter-01', '')
# Both should be structured objects with sections
if not isinstance(pn, dict) or 'sections' not in pn:
    print('false|part_notes should be structured with sections, got: ' + str(type(pn).__name__))
elif not isinstance(cn, dict) or 'sections' not in cn:
    print('false|chapter_notes should be structured with sections, got: ' + str(type(cn).__name__))
elif not any(s['id'] == 'part-notes' for s in pn['sections']):
    print('false|expected part-notes section in part_notes')
elif not any(s['id'] == 'chapter-notes-opening' for s in cn['sections']):
    print('false|expected chapter-notes-opening section in chapter_notes')
elif '_hint' not in pn or '_hint' not in cn:
    print('false|missing _hint in structured notes')
else:
    print('true')
" <<< "$(extract_text "$RESULT")")
  if [ "$(echo "$T54_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 54 "get_context lazy-loads notes with sections TOC" "true"
  else
    report 54 "get_context notes lazy-load" "false" "$(echo "$T54_PASS" | cut -d'|' -f2-)"
  fi
fi

echo "--- Test 55: missing notes files return empty string gracefully ---"
RESULT=$(mcp_call "get_context" "{\"project\":\"_fractal-test\",\"include\":{\"part_notes\":[\"part-02\"],\"chapter_notes\":[\"part-01/chapter-02\"]}}")
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 55 "missing notes files graceful handling" "false" "Tool error: $(extract_text "$RESULT")"
else
  T55_PASS=$(python3 -c "
import json, sys
text = sys.stdin.read()
d = json.loads(text)
# part-02 notes don't exist, should return empty string
part_notes = d.get('part_notes', {}).get('part-02', None)
# chapter-02 notes don't exist, should return empty string
chapter_notes = d.get('chapter_notes', {}).get('part-01/chapter-02', None)
# Empty string is the graceful fallback
if part_notes == '' and chapter_notes == '':
    print('true')
else:
    print('false|expected empty strings for missing files')
" <<< "$(extract_text "$RESULT")")
  if [ "$(echo "$T55_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 55 "missing notes files return empty string" "true"
  else
    report 55 "missing notes files graceful handling" "false" "$(echo "$T55_PASS" | cut -d'|' -f2-)"
  fi
fi

echo "--- Test 56: fetch specific note section via # notation ---"
RESULT=$(mcp_call "get_context" "{\"project\":\"_fractal-test\",\"include\":{\"part_notes\":[\"part-01#part-notes\"],\"chapter_notes\":[\"part-01/chapter-01#chapter-notes-opening\"]}}")
ERR=$(is_error "$RESULT")
if [ "$ERR" = "true" ]; then
  report 56 "fetch note section via # notation" "false" "Tool error: $(extract_text "$RESULT")"
else
  T56_PASS=$(python3 -c "
import json, sys
text = sys.stdin.read()
d = json.loads(text)
pn = d.get('part_notes', {}).get('part-01#part-notes', {})
cn = d.get('chapter_notes', {}).get('part-01/chapter-01#chapter-notes-opening', {})
pn_content = pn.get('content', '') if isinstance(pn, dict) else ''
cn_content = cn.get('content', '') if isinstance(cn, dict) else ''
has_part = 'part-level planning' in pn_content
has_chapter = 'Dense planning' in cn_content
if has_part and has_chapter:
    print('true')
else:
    print('false|section content missing expected text. part=' + repr(pn_content[:80]) + ' chapter=' + repr(cn_content[:80]))
" <<< "$(extract_text "$RESULT")")
  if [ "$(echo "$T56_PASS" | cut -d'|' -f1)" = "true" ]; then
    report 56 "fetch specific note section via # notation" "true"
  else
    report 56 "fetch note section via #" "false" "$(echo "$T56_PASS" | cut -d'|' -f2-)"
  fi
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
