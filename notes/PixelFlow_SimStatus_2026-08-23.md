# PixelFlow Sim — Durum (2026-08-23)

## Doğrulanmış
- Saf sim çekirdeği bağımsız dotnet derlemesi: **0 hata / 0 uyarı** (`.strada/simcheck/simcheck.csproj`; BoardState, ConveyorState, FireResolver, Simulation, TrayState, OutcomeResolver, ValueObjects, PigSim).
- Düzeltilen kök nedenler: Simulation.cs birleştirilmiş satır (119), FireResolver.cs eksik `using System;`.

## AÇIK KALE — oyun toplanmadı
- `PixelFlowSimModuleConfig` sınıfı var ama **.asset örneği yok**.
- **.unity sahnesi yok** — GameBootstrapper + _gameConfig zinciri kurulmadı.
- `unity_scene_build` bu oturumun araç yüzeyinde MEVCUT DEĞİL; sahne elle yazılmaz (bilinen fileID/type hatası riski).
- `PixelFlowSimService.cs` ve `Tests/Runtime/SimulationTests.cs` yalnızca Unity tarafında doğrulanabilir (bridge bağlı değil).

## Sonraki adım (bridge/Editor ile)
1. `unity_scene_build`: GameBootstrapperConfig asset'i + GameBootstrapper objesi + `_gameConfig` reference alanı (kind:"reference") + PixelFlowSimModuleConfig.asset listelemeli.
2. Runtime'da spawn edilen her şey aynı spec'te prefabPath + keepInScene:false ile.
3. `unity_playmode_verify`.
