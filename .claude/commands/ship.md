---
description: Commit and push the current change the way this repo requires (gates, explicit paths, no bent tests)
---
Load `docs/skills/ship/SKILL.md` and follow it in full. This file is only the loader: the procedure lives there, once.

What it carries, in short:
- `node scripts/ci/gates.mjs` before every push, and every red gate fixed in the code, never in its test.
- Stage an explicit path list. Never `git add -A`: the checkout is shared.
- Never `--no-verify`, never force, never amend a pushed commit, never `[skip ci]`.
- Watch CI after the push. A red CI means the change is not done.
