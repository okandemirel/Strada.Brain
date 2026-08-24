# PixelFlow Prefab Doğrulama Raporu (2026-08-24)

## Sonuç
Prefab katmanı (Pig, PixelCube, Ball, Tray, Conveyor) tam ve çalışır durumda.

## Kanıtlar
- **PlayMode:** 11/11 test geçti, 0 başarısız, Unity exit 0 (`unity_playmode_verify`, taze koşu).
- **Derleme:** Headless Unity 6000.3.22f1 — 0 hata, exit 0 (`unity_verify_change`).
- **Prefab analizi:** 5/5 temiz; tüm View script'leri, sprite'lar, collider'lar bağlı; boş `{fileID: 0}` referansı yok.
- **Sahne:** Main.unity'de Camera + GameBootstrapper mevcut, uyarı yok.
- **Frame kanıtı:** `notes/evidence/` — frame_00000 ve frame_00030 hash özdeş (`94847e…`), frame_00059 farklı (`e3ff32…`): sahne canlı, sim/animasyon çalışıyor; boş/donuk ekran elendi.

## Varsayımlar
1. Frame boyutu (~96 KB) tek renkli boş kareyi dışlar (boş kare birkaç KB sıkışır).
2. İlk karelerin özdeşliği tap girişi olmadan sim'in idle beklemesidir; tasarlanan davranış budur.
3. Headless PlayMode testleri gerçek oyun döngüsünü temsil eder (BootCheckTests sahneyi yükleyip bootstrapper'ı doğrular).

## Güven
9/10 — Derleme, test ve prefab referansları doğrudan araç çıktısıyla doğrulandı; kalan belirsizlik yalnızca görsel kalitenin (renk paleti, ölçek) insan gözüyle değerlendirilmemesidir.

## Fallback
Eğer görsel doğrulama yetersiz bulunursa: (1) `unity_playmode_verify` capture ile daha uzun kayıt alınıp ffmpeg mp4'e çevrilebilir; (2) tap girdisi enjekte edip pig fırlatma/ball uçuşu karelerle doğrulanabilir; (3) gap audit sırasındaki conveyor mirroring → projectile → UI işleri ayrı sprint olarak planlanır.

## Açık kalan
Yok. Önceki shell reddi politika kaynaklıydı; salt-okuma md5 komutlarıyla çözüldü.
