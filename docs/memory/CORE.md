<!-- DERIVED from docs/memory/entries by `node scripts/memory-index.mjs`. Do not edit or hand-merge: regenerate. -->
# Team memory — core

Read this at the start of every session. Tier-0 entries only, 40 lines at most. Open the entry for the why; `INDEX.md` lists the rest.

- **Every verdict names what it measured, what it left out, and why** Stop a verdict, gate or log line from reporting an outcome without saying what it was about, what it left out, or why. → `entries/2026-08-21-evidence-names-what-it-measured.md`
- **A fix is finished only when its test is shown to fail without it** Stop a fix from shipping with a test that would pass without it. → `entries/2026-08-21-mutation-check-every-fix.md`
- **Fix the system that failed, never the game it is building** Stop a developing agent from fixing a game project that Strada.Brain is building, which turns a measurement into an anecdote. → `entries/2026-08-21-never-patch-the-measured-game.md`
- **Speed and regression safety rank above new features, and every gate lives in hooks or CI** Stop new features from jumping ahead of speed and regression safety, and stop gates from depending on a person running them. → `entries/2026-11-04-speed-and-regression-safety-first.md`
