# PixelFlow — Teslim Raporu (2026-08-24)

## Test Sonuçları
- **PlayMode:** 8/8 geçti (`playmode-results.xml`, 05:45Z)
  - `BootCheckTests.Main_Scene_Boots_Without_Exceptions` — ana sahne istisnasız açılıyor
  - `SimulationTests` ×7: R01 exposure, R02 tap deny, R03/R05 fire+clear, R07 idle pig, R11 deadlock→continue, R14 bit-identical replay, conveyor dual-row/exhaustion
- **EditMode:** 4/4 geçti (`editmode-results.xml`, 05:39Z)
- Toplam: **12/12 Passed, 0 failed**

## Yapılan Düzeltmeler
- `Simulation.cs` 219 → 193 satır: R-12 continue akışı `ContinueService.cs`'e çıkarıldı; ateşleme blokları tek `SpawnBall` helper'ında birleştirildi.
- `FireResolver` R-04 öncelik düzeltildi: en alt satır baskın → slot'a yatay mesafe → sol kolon.
- `.strada/simcheck/simcheck.csproj`: EnableDefaultCompileItems=false.

## Commit Durumu
- Sim çalışması commit edildi: `bf70a97 "feat: PixelFlow core sim (M1) — board/conveyor/tray/outcome, 132 files"` (Assets/, docs/, notes/, Tools/, test XML'leri).
- ⚠️ HEAD detached durumda — commit `main` üzerinde değil. `git branch -f main bf70a97` veya checkout ile main'e taşınmalı.
