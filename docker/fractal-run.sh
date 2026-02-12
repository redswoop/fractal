#!/usr/bin/with-contenv bash

# Configure git credentials from env vars
if [ -n "$GIT_USER_NAME" ]; then
  git config --global user.name "$GIT_USER_NAME"
fi
if [ -n "$GIT_USER_EMAIL" ]; then
  git config --global user.email "$GIT_USER_EMAIL"
fi

# Trust mounted project directories (ownership differs across volume mounts)
git config --global --add safe.directory '*'

echo "[fractal] git user: $(git config --global user.name) <$(git config --global user.email)>"
echo "[fractal] starting MCP server on port ${PORT:-3001}"
cd /opt/fractal
exec node dist/server.js
