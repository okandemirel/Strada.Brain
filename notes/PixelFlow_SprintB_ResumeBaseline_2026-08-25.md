# Sprint B Resume Baseline ve Git Durumu Planı

## Amaç
`SprintBElements.cs` ile mevcut HardPixel/IceBlock testlerinin çalışma ağacındaki durumunu belgelemek ve Git araçları çalışmadığında commit durumunu doğrulanabilir kanıt seviyeleriyle sınıflandırmak.

## Kısıtlar
- `git_status`, `git_log` ve `shell_exec` `spawn EBADF` nedeniyle kullanılamıyor.
- Kaynak dosyası veya teslim notu, tek başına commit kanıtı sayılmayacak.
- Main üzerinde commit edilmiş olma iddiası doğrudan Git metadata'sı okunmadan kesinleştirilmeyecek.

## Uygulama Adımları
1. Kaynak envanterini doğrula:
   - `Assets/Modules/PixelFlowSimModule/Scripts/Models/SprintBElements.cs`
   - `Assets/Modules/PixelFlowSimModule/Tests/Runtime/SimulationTests.cs`
   - ilgili diğer Runtime testleri.
2. `SprintBElementType`, `ElementState`, `SprintBElementResolver` ve IceBlock davranışını oku.
3. `HardPixel` için ayrı test dosyası veya başka test sınıfında davranış testi olup olmadığını ara.
4. `BoardState`, `CellState`, `ApplyHit`, `IsHittable` ve `ShedIceAdjacentTo` implementasyonlarını test sözleşmesiyle karşılaştır.
5. Süreç başlatmadan mümkünse `.git/HEAD`, main ref, reflog ve index metadata'sını oku; okunamazsa Git durumu `unverifiable` olarak bırak.
6. Kanıtları şu şekilde sınıflandır:
   - **confirmed:** doğrudan okunan dosya veya Git metadata'sı ile doğrulandı.
   - **reported_only:** teslim notunda raporlandı, Git ile doğrulanmadı.
   - **unverifiable:** doğrudan kanıt bulunamadı.
7. Bu notu resume baseline olarak güncelle ve sonraki uygulama noktasını belirt.

## Beklenen Sonuç
- SprintBElements ve IceBlock testlerinin kesin mevcut durumu.
- HardPixel testinin mevcut olup olmadığı.
- Main/commit/working-tree durumunun kanıt seviyesi.
- Git doğrulanamıyorsa bunun açıkça belirtilmesi; varsayım yapılmaması.

## Mevcut Engelin Kök Nedeni
Süreç başlatan araçlar tekrarlı olarak `spawn EBADF` verdiği için Git komutları çalıştırılamıyor; bu nedenle plan önce doğrudan dosya ve mümkünse `.git` metadata okumasına dayanıyor.
