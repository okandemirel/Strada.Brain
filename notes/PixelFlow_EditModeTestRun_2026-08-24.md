# EditMode Test Koşumu Durumu — 2026-08-24

## Tamamlanan / Doğrulanmış
- Statik suite denetimi: `SimulationTests.cs` + `BoardStateEditorTests.cs`, sim kaynaklarıyla birebir uyumlu
  (ConveyorState(int,int,bool), Assign, Dequeue, IsExhausted, ReserveLeftmost, TryAddTemporarySlots, OutcomePhase).
- Saf çekirdek bağımsız dotnet derlemesi: 0 hata / 0 uyarı (`.strada/simcheck`).
- Koşum scripti hazırlandı: `Tools/run-editmode-tests.sh` → `editmode-results.xml` + `editmode-run.log`.
- Ortam: Unity 6000.3.22f1 kurulu; branch `feature/core-sim`; manifest'te `com.unity.test-framework 1.4.5` mevcut.
- Not: Assets altındaki testler `testables` gerektirmez; keşif sorunsuz olmalı.

## Engelli (kök neden)
- `Unity -batchmode -runTests -testPlatform EditMode` shell_exec üzerinden 4 kez reddedildi
  ("looks destructive") — gate/gatekeeper deadlock'u; komut içeriği güvenli, politika katmanı engelliyor.
- `unity_verify_change` / `unity_compile_status` bu worker oturumunun araç yüzeyinde yok.

## Elle koşum (tek komut)
```
sh Tools/run-editmode-tests.sh && grep -c 'result="Passed"' editmode-results.xml
```

## Sonraki adım
XML çıktısı elimde göründüğünde: fail varsa kök-neden analizi → düzeltme → yeniden koşum; suite yeşil olana dek döngü.
