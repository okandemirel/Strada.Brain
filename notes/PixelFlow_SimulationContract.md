# Pixel Flow! — Simulation Contract Working Notes

Source: docs/PixelFlow_GDD.md v1.0 (Loom Games, Aug 2026). These notes drive all later goals.

## 1. Simulation Contract — Core Rules R-01..R-15 (§3.3, authoritative)

- **R-01 Exposure** — Cube EXPOSED iff no cube of ANY state below it in same column (= bottom-most remaining per column). LOCKED cubes unhittable even if geometrically exposed.
- **R-02 Tap validity** — Tap on conveyor pig valid iff ≥1 free slot; else deny wobble+thud. Taps on slotted pigs do nothing.
- **R-03 Slot assignment** — Valid tap reserves leftmost free slot immediately; pig airborne 0.35 s (LAUNCHED), untouchable.
- **R-04 Auto-fire** — Slotted pig ammo>0 auto-fires nearest exposed same-color cube. Nearest = lowest row first → smallest horizontal distance to slot → leftmost column. No aiming ever (P1).
- **R-05 Ball resolution** — Ball flight ~0.25 s; impact removes 1 hp and 1 ammo. In-flight ball whose target died retargets next valid on impact frame; none → fizzles + AMMO REFUNDED (engine never wastes ammo).
- **R-06 Gravity** — Cubes do NOT fall; destroying exposes the cube above in same column. (Set-piece exceptions: Pixel Pipe.)
- **R-07 Idle** — ammo>0 + no exposed match → IDLE; wakes ≤1 frame when match exposed. Idle pigs are THE space threat.
- **R-08 Exit** — ammo=0 → 0.5 s celebration; slot usable by a new tap on frame 1 of exit animation.
- **R-09 Parallel sim** — All slotted pigs act simultaneously/independently; same-color pigs interleave targets via R-04 ordering with target reservation on ball spawn (no duplicate targets).
- **R-10 Win** — clear-% = 100% AND all set-piece objectives complete. Leftover ammo/pigs → score bonus only.
- **R-11 Deadlock** — FAIL iff every slot occupied AND every slotted pig IDLE AND no valid tap changes it (evaluated BY SIMULATION, not heuristics). Grace: check runs 0.8 s after last state change.
- **R-12 Continue** — Before FAIL commits: Out of Space offer +2 temp slots for coins (900 base, +300 each reuse same attempt). Decline → commit fail.
- **R-13 Queue exhaustion** — Queue empty + canvas incomplete = treat as deadlock → R-12. (Validator guarantees ammo ≥ hp normally; possible after Jelly Bean waste.)
- **R-14 Determinism** — Zero RNG after load. Same level rev + same tap log (with timestamps) ⇒ identical end state anywhere. Testable requirement; enables server replay validation.
- **R-15 Interrupts** — Backgrounding freezes sim losslessly; restore exact; no pause penalty/timer exploit.

### Pig FSM (§3.8)
IN_QUEUE → LAUNCHED (0.35 s) → FIRING (12 balls/s) ⇄ IDLE (≤1-frame wake) → DEPLETED (ammo 0) → EXIT (0.5 s, slot freed frame 1). Authored modifiers: FROZEN (thaw after N any-color clears), LOCKED (needs canvas key).

### Game-feel constants (§3.9, remote-config keys)
core.fire_rate=12/s · ball_flight=0.25s · launch_time=0.35s · exit_time=0.50s · deadlock_grace=0.8s · belt_speed=0.6 slot/s · belt_gap=1.5s · base_slots=5 · tap_feedback_max=50ms · cube_pop=0.12s. Slots max 8 (+1 booster →6, continue +2 →7 hard cap).

## 2. Level JSON Format (§6.5 / Appendix B)

Self-contained JSON served from CDN. Full example (Appendix B, L214 HARD):
- Top level: `levelId`, `rev`, `diff` ("NORMAL"|"HARD"|"VERY HARD"), `area`
- `canvas`: `w`,`h`, `rows` (array of strings, row-major; legend R/Y/B/G/P/O colors, `.`=empty, `#`=wall) OR abbreviated `cells`; `legend`; `blockers[]`: `{type:"hard",at:[[c,r]]}` (hp2), `{type:"ice",at,layers}` , `{type:"lock",rect:[x1,y1,x2,y2],keyAt:[x,y]}`, `{type:"pipe",col,reserve:"RRGGB"}`; `setpieces[]` e.g. `{type:"ufo",seats:["R","G","B"]}`
- `queue`: ordered array `{c,color,a(ammo 4–25)}`
- `belt`: `{rows:1|2, moving:bool, speed?}`
- `objectives`: e.g. `[{"type":"clear_canvas"}]`
- `rewards`: `{coins}`
- `cert` (blocking for upload): `{solver, solvable:true, minTaps, surplusByColor{}, botWinRates{casual,smart,expert}, sha256}`

Validator invariants (§6.6): per-color queue ammo ≥ per-color cube hp (unless Jelly Bean relief); no clearable cube above wall without sanctioned breaker (Rocket/Totem); element caps respected; UFO seat colors covered by queue; no unbreakable ice cluster surrounded by walls. Solver must prove a booster-free win; bot win-rate tiers must match tag or upload blocked.

## 3. FTUE Ramp (§7.3)

Philosophy: teach by situation, <60 s mandatory across L1–3.
1. **L1** — scripted single-tap cascade (feel first); ammo-exit lesson.
2. **L2** — pre-slotted wrong-color pig idles ("Zzz"); teaches idle/exposure wake.
3. **L3** — free-solve 3-color board; streak + coins toast.
4. **L4–7** — untutored; L6 dual-belt callout arrow.
5. **L8/12/16/20** — booster unlock ceremonies w/ free grants + guided use (Hand/Shuffle/+Slot/Super).
6. **L13** — first HARD tag framing popup.
7. **First deadlock (~L9–15)** — Out of Space with scripted 50%-off continue.
8. **L14/L25/L30** — Fire Quest / Arena / Pass unlocks.
Targets: ≥90% installs finish L3, ≥75% finish L10 on D0. Element ceremony pattern: splash → isolated friendly level → reuse within 10 levels.

## 4. Color Pacing (§6.3)

- ≤6 colors total (readability/colorblind budget).
- Ramp: **3 colors L1–7 → 4 by L8 → 5 by L25 → 6 from L60+.**
- Strong silhouette at arm's length; background cells EMPTY not walls unless shaping.
- Contiguous same-color chunks (cascade feel) on Normal; salt-and-pepper dithering deliberately on Hard+ (raises idle risk).
- Grid 8×8 up to 20×26. Every ~10th level screenshot-worthy.
- Difficulty levers (§6.2): ammo surplus (Normal +15–30%, Hard +5–12%, VH 0–5%), adversarial interleave, blocker load. Tiers: Normal ~70% of levels fail ≤15%; Hard every ~10th fail 30–40%; VH every ~25th fail 50–60%.

## 5. Win / Fail / Deadlock Flow (§3.6)

- **WIN (R-10)** — progress++, streak++, coin reward, event/pass points, optional interstitial (post-reward render only). Score = cubes×10 + leftover ammo×25 + leftover pigs×100.
- **CONTINUE (R-12)** — deadlock → inline popup (no scene change): +2 temp slots, 900c then +300 escalation; accept resumes seamlessly, counter++.
- **FAIL (R-11 declined)** — streak reset, −1 life, forced interstitial from L12; retry keeps identical layout (determinism).
- Deadlock evaluation is simulated (not heuristic) with 0.8 s grace after last state change; queue exhaustion routes here too (R-13).

## Notes for later goals
- Sim must be pure C#, allocation-free, zero UnityEngine refs (§15.1); 60 Hz fixed tick; pooled projectiles (zero GC worst case).
- Levels are versioned data (levelId+rev) — tuning = new revision.
- Boosters never required (solver cert is booster-free); Hand & Super two-step arm→target; Shuffle seeded deterministic redeal.
