# Pixel Flow — Level JSON Şeması (Appendix B) + Loader Sözleşmesi

## Onaylanmış şema (docs/PixelFlow_GDD.md L1415–1457)
- Üst seviye: `levelId` (int, zorunlu), `rev` (int, vars. 1), `diff` ("NORMAL"|"HARD"|"VERY HARD", vars. NORMAL), `area` (string, vars. farm_01)
- `canvas`: `w`, `h`; `rows[]` (satır-major stringler; R/Y/B/G/P/O renk, '.'=boş, '#'=duvar); `legend` (loader tarafından YOK SAYILIR); `blockers[]`; `setpieces[]` (loader okumuyor)
- Blocker tipleri:
  - hard: `at:[[c,r],...]` — loader yalnız İLK koordinatı kullanır; hp=2 (Armored)
  - ice: `at`, `layers` (vars. 1)
  - lock: `rect:[x1,y1,x2,y2]` — `keyAt` loader'da KULLANILMIYOR
  - pipe: `col`, `reserve:"RRGGB"` → kuyruğa ammo=4 domuzlar eklenir
- `queue`: sıralı `{c,color,a(ammo)}`
- `belt`: `{rows(1|2), moving(bool), speed?(vars .6)}`
- `objectives`: `[{"type":"clear_canvas"}]` — yalnız ilk objective'in tipi alınır
- `rewards.coins`
- `cert` (solver, solvable, minTaps, surplusByColor, botWinRates, sha256): runtime loader OKUMAZ

## Loader sözleşmesi
- Giriş noktası: `LevelJsonLoader.Load(json)` → `LevelData`; `LevelJsonLoader.BuildSimulation(level)` → `Simulation`
- JSON DOM: `Scripts/Data/ValueObjects/JsonNode.cs` (pure C#)
- Koordinat çevirisi: rows üst satır = yüksek y (`CanvasH - 1 - r`) — BoardState'e yazılırken flip edilir
- Zorunluluk validasyonu (FormatException): levelId > 0, w/h > 0, rows boş olamaz, queue boş olamaz
- Bilinen eksikler (gelecek iş): keyAt (lock anahtarı) ve setpieces (ör. ufo seats) parse edilmiyor; "hard"/"ice" blocker'ların at dizisindeki sonraki hücreleri yok sayılıyor

## Dosya/kontrat zinciri
- Unity tarafı ham JSON'u StreamingAssets'ten okuyup `LevelStateModel.CacheJson(id, json)` ile besler; `Load(id)` parse + sim kurar
- DTO: `Assets/Modules/PixelFlowSimModule/Scripts/Data/ValueObjects/LevelData.cs`
- Model: `Assets/Modules/PixelFlowSimModule/Scripts/Models/LevelStateModel.cs`
