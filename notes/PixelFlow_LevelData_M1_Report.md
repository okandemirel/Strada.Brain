# Level Data M1 — Tamamlandı

- 12 seviye JSON (level_001–012) `Assets/StreamingAssets/Levels/` altında yazıldı ve Appendix B şemasına uyumlu.
- Doğrulama: tüm JSON'lar `json.tool` ile parse edildi (ALL_PARSED, exit 0); grep ile 12/12 levelId/rev/diff metadata teyidi.
- Git: `feature/level-data-m1` dalında `658d084` + `b42ea75` commit'leri; `git diff Assets/StreamingAssets/Levels` temiz — her şey commit'li.
- Zorluk rampesi: ftue_01 (L1–3, NORMAL) → meadow_01 (L4–7) → orchard_01 (L8–9) → neon_city_01 (L10, L12) → frost_01 (L11, HARD); grid 8×8'den 12×12'ye, L12 VERY HARD.

## Kalan öneriler
1. Dalı main'e merge et.
2. Loader'ı `unity_playmode_verify` ile runtime'da test et.
3. cert.sha256 alanlarını gerçek hash'lerle doldur (şu an placeholder).
