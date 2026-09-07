# FrozenPig Loader Fix — 2026-08-25

## Yapılan
- `LevelJsonLoader.cs`: blocker'lar artık canvas altından VE kök düzeyden okunuyor (Appendix B, conveyor-side frozenpig kök düzeyde). Lock-key lookup canvas branch dışına alındı.
- Kök neden: `Loader_Parses_FrozenPigBlocker` testi blockers'ı JSON köküne koyuyordu; loader yalnızca `canvas.blockers`'ı parse ediyordu → FrozenPigs=0.

## Doğrulama
- FrozenPigTests: 5/5 geçti.
- Tüm PlayMode suite: **29/29 passed**, runResult=Passed, unityExit=0 (`unity_playmode_verify`, 2026-08-25).

## Kalan
Commit (git/shell araçları bu oturumda spawn EBADF veriyor):
```
git add -A && git commit -m "fix: LevelJsonLoader parses root-level blockers (frozenpig), PlayMode 29/29 green"
```
