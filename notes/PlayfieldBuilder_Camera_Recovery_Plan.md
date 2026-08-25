# PlayfieldBuilder Kamera Recovery Plan

## Hedef
PlayfieldBuilder'ın BoardView, TrayView ve ConveyorView prefablarını bootstrap tamamlandıktan sonra runtime'da oluşturmasını tamamlamak ve `PrefabAssembly.unity` için `STRADA NO CAMERA` conformance hatasını sahne YAML'ını elle düzenlemeden çözmek.

## Durum
- `Assets/Scripts/PlayfieldBuilder.cs` mevcut; BoardView property tipi düzeltildi ancak Board spawn çağrısı hâlâ `SpawnView<Component>` kullanıyor.
- `Assets/Editor/MainScenePresentationInstaller.cs` içinde `InstallPrefabAssemblyCamera()` mevcut.
- `Assets/Scenes/PrefabAssembly.unity` içinde Camera yok.
- Unity Editor bridge bağlı değil; installer doğrudan çalıştırılamıyor.
- Yanlış not yolu: `notes/PixelFlow_SimStatus_2026-08-23.md`; doğru adaylar `docs/run-notes/PixelFlow_SimStatus_2026-08-23.md`, `.strada/knowledge/notes/PixelFlow_SimStatus_2026-08-23.md` ve `Packages/Submodules/Strada.Core/notes/PixelFlow_SimStatus_2026-08-23.md`.

## Uygulama sırası
1. `PlayfieldBuilder.cs` içinde Board spawn çağrısını `SpawnView<BoardView>` yap; `BoardView`, `TrayView`, `ConveyorView` sonuçlarını sakla; eksik prefab/component durumlarında `StradaLog` kullan.
2. `PresentationPrefabConfig.asset` ve üç prefab referansını doğrula.
3. Unity bridge veya `unity_scene_build` kullanılabilir olduğunda `PrefabAssembly.unity` için deklaratif spec uygula: mevcut bootstrap/config bağlantılarını koru, `PrefabAssemblyCamera` GameObject + Camera component + MainCamera tag ekle.
4. `unity_scene_analyze` ile Camera ve kamera kök nesnesini doğrula.
5. `.cs` değişiklikleri için `unity_verify_change` çalıştır; hata varsa düzelt ve tekrarla.
6. `unity_playmode_verify` çalıştır; en az bir testin gerçekten execute edildiğini ve kritik Error/Exception olmadığını doğrula.
7. Conformance gate'i tekrar çalıştır; `STRADA NO CAMERA` kalmadığında tamamla.

## Kısıtlar
- `.unity` veya `.asset` dosyaları `file_write`/`file_edit` ile elle düzenlenmeyecek.
- Kamera eklenmeden görev tamamlandı ilan edilmeyecek.
- Unity bridge yoksa, eksik runtime adımı açıkça blocker olarak raporlanacak; sahte başarı bildirilmeyecek.

## Başarı ölçütleri
- BoardView, TrayView, ConveyorView runtime spawn akışı derleniyor.
- `PrefabAssembly.unity` içinde gerçek Camera component bulunuyor.
- Bootstrap ve prefab config referansları geçerli.
- PlayMode'da en az bir test çalışıyor.
- `STRADA NO CAMERA` conformance hatası yok.
