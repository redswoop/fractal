# Rules

These are operational rules. Follow them every time. Architecture reference is in [ARCHITECTURE.md](ARCHITECTURE.md).

## Testing

After ANY change to `src/server.ts`, `src/store.ts`, or `src/git.ts`:

```bash
cd /workspace/fractal
npm run build                          # must succeed
# kill any existing server, then start fresh:
FRINGE_PROJECTS_ROOT=/workspace/fractal/projects node dist/server.js &
bash test-templates.sh                 # all tests must pass
```

- Do NOT commit until build succeeds and all tests pass.
- Do NOT tell the user work is "done" without running tests.
- Do NOT push without running tests first.
- For minor changes (comments, docs, config): build check alone is sufficient.

## Commit Discipline

- Build and test BEFORE committing. Not after.
- If tests fail, fix the issue and re-run. Do not commit broken code.
- Never skip tests because "it's just a small change" if it touches tool logic, data handling, or file operations.

## Workflow

- Read existing code before modifying it.
- Check canon files before writing prose that references characters or locations.
- When adding MCP tools: update the `/help` endpoint, add tests to `test-templates.sh`, update ARCHITECTURE.md tool list.

## Architecture Reference

See [ARCHITECTURE.md](ARCHITECTURE.md) for:
- Directory structure and file formats
- Beat marker syntax (`<!-- beat:ID | label -->`)
- Meta file schemas (project.json, part.json, chapter.meta.json)
- Canon file conventions
- MCP tool inventory (read and write operations)
- Zoom level rendering
- Git auto-commit conventions
