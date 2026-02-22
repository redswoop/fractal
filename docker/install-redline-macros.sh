#!/bin/bash
echo "**** installing redline keybindings + snippets ****"

# code-server user data lives here in the linuxserver image
CS_DATA="/config/data/User"
CS_SNIPPETS="${CS_DATA}/snippets"

mkdir -p "$CS_DATA" "$CS_SNIPPETS"

# Keybindings — ctrl+/ note, ctrl+. flag, ctrl+shift+1-4 for dev/line/continuity/query
cat > "${CS_DATA}/keybindings.json" << 'KEYBINDINGS'
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
KEYBINDINGS

# Snippets — //n, //d, //l, //c, //q, //f triggers
cat > "${CS_SNIPPETS}/markdown.code-snippets" << 'SNIPPETS'
{
  "Redline: Note": {
    "prefix": "//n",
    "body": "<!-- @note: $1 -->",
    "description": "Inline note redline"
  },
  "Redline: Dev": {
    "prefix": "//d",
    "body": "<!-- @dev: $1 -->",
    "description": "Developmental redline"
  },
  "Redline: Line": {
    "prefix": "//l",
    "body": "<!-- @line: $1 -->",
    "description": "Line-level redline"
  },
  "Redline: Continuity": {
    "prefix": "//c",
    "body": "<!-- @continuity: $1 -->",
    "description": "Continuity redline"
  },
  "Redline: Query": {
    "prefix": "//q",
    "body": "<!-- @query: $1 -->",
    "description": "Query redline"
  },
  "Redline: Flag": {
    "prefix": "//f",
    "body": "<!-- @flag -->",
    "description": "Wordless flag"
  }
}
SNIPPETS

echo "**** redline macros installed ****"
