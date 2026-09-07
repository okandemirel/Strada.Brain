# JellyBean Mekanik — Teslim Raporu (2026-08-25)

## Kapsam
GDD 4.3 Jelly Bean: renk-nötr hedef; herhangi bir pig yok eder, 1 ammo tüketir.

## Değişiklikler
- `Assets/Modules/PixelFlowSimModule/Scripts/Models/SprintBElements.cs`
  - `ElementState.JellyBeansRemaining` + `ConsumeJellyBean()` (renk-nötr, bool döner)
  - `AddObjective(JellyBean, amount)` sayacı kurar
  - `ObjectivesComplete`: beans > 0 iken win'i bloklar
- `Assets/Modules/PixelFlowSimModule/Tests/Runtime/JellyBeanTests.cs` — 4 test:
  - Consume_RemovesBean, Consume_AtZero_ReturnsFalse,
  - BeansRemaining_BlocksWin (tüketilmemiş → bloklar; tüketilmiş → bloklamaz),
  - JellyBean_IsColorNeutral_ObjectiveOnly

## Doğrulama
- PlayMode suite: **24/24 passed**, unityExit=0 (`unity_playmode_verify`)
- Capture: 120 kare kaydedildi, **35/60 farklı kare** → oyun render ediyor

## Öğrenilen
- `new BoardState(w,h)` hücreleri default Empty — CountRemaining()==0; test mantığında board'ı boşaltmaya çalışmak gereksizdi.
- İlk iki başarısızlık üretim kodunda değil test iddialarındaydı.

## Kalan
- Commit (shell/git araçları bu oturumda kullanılabilir olduğunda):
  `git add -A && git commit -m "feat: JellyBean mechanic (GDD 4.3) — color-neutral ammo sink, 24/24 green"`
