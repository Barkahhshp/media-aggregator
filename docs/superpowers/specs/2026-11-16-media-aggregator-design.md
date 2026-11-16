# Media Aggregator — Desain MVP

Tanggal: 2026-11-16  
Status: Draf untuk persetujuan; belum ada kode aplikasi.

## Tujuan

Bangun layanan internal `media-aggregator` di VM kerja untuk mengumpulkan item dari RSS/Atom/JSON Feed serta halaman berita publik yang dapat dibaca lewat HTTP biasa. Simpan metadata dan teks artikel penuh, lalu sediakan REST API untuk membaca dan mencari ribuan item. MVP menargetkan Cloudflare Free tanpa layanan berbayar.

MVP berhasil bila sumber bisa ditambah lewat REST API, artikel yang sudah ditemukan tidak hilang saat isi lengkapnya masih menunggu fetch, data tidak ganda, detail artikel menyajikan teks penuh, pencarian/filter dasar berjalan, dan status kegagalan sumber terlihat.

## Keputusan produk yang diberikan

- Pemakaian internal.
- Cloudflare Free saja, biaya layanan eksternal nol.
- X ditunda; YouTube dikeluarkan dari MVP.
- Isi artikel penuh diinginkan.
- Tidak memakai Browser Run, browser/VM eksternal, Supabase, atau API pihak ketiga berbayar.
- Nama kerja `media-aggregator`.
- Implementasi bertahap dengan coder, test, dan review.

## Keputusan default yang kuambil

- API produksi dilindungi Cloudflare Access Service Auth di custom hostname. Access Free memiliki batas akun yang memadai untuk aplikasi/token internal. Local development memakai `API_TOKEN` dummy. Bila custom hostname belum tersedia, tetap local-only; jangan membuka deployment `workers.dev` ke internet hanya dengan Bearer key.
- Sumber domain apa pun boleh ditambahkan secara eksplisit. Link artikel yang ditemukan hanya difetch jika host sama dengan sumber. Redirect ditangani manual, divalidasi ulang, maksimal 3 hop, hanya HTTP/HTTPS port 80/443.
- Tipe sumber: RSS/Atom/JSON Feed, sitemap, URL artikel tunggal, atau halaman daftar publik dengan CSS selector yang diberikan saat sumber dibuat. Tidak ada auto-discovery heuristik universal.
- Baseline maksimum 100 sumber aktif, polling default dua jam, minimum 15 menit; ini target best-effort, bukan SLA. Satu Cron berjalan tiap menit dan memproses paling banyak satu sumber baru; lag dan `next_fetch_at` terlihat di API.
- Maksimum 100 item feed/sitemap yang baru ditemukan dicatat per respons. Artikel yang butuh full-text fetch disimpan sebagai pending dan diproses maksimum dua URL per invocation. Backlog yang lebih besar tetap tersimpan dan dikerjakan berangsur, tidak dibuang diam-diam.
- Isi artikel maksimal 500 KiB UTF-8 disimpan di satu database D1. Isi yang lebih besar ditandai `content_too_large`.
- Tidak memakai R2 pada MVP. D1 memakai hard stop aplikasi 300 MB physical size, termasuk indeks/FTS, diukur lewat `meta.size_after`. Sisakan ruang dari batas D1 Free 500 MB per database. Saat mendekati batas, hentikan penambahan artikel baru dengan status `storage_limit`.
- Data artikel tidak dihapus otomatis. `fetch_runs` dipangkas setelah 30 hari.
- D1 Time Travel Free dipakai untuk restore tujuh hari terakhir; ekspor NDJSON konsisten disediakan untuk backup lebih lama.
- Dedupe dilakukan per sumber. Item dari sumber berbeda tidak digabung.

## Pendekatan yang dipilih

1. Cloudflare Free saja: Workers untuk API/ingestion, satu Cron Trigger, D1 untuk metadata, teks artikel, FTS, dan pending backlog. Paling sederhana dan menjaga penggunaan layanan tetap di allowance gratis.
2. Tambah R2: memberi ruang objek lebih besar, tetapi allowance gratis R2 bukan hard cap; kelebihan pemakaian dapat ditagih. Tidak dipakai pada MVP.
3. Tambah Browser Run/Playwright: membantu halaman JavaScript tetapi memerlukan kuota/biaya atau runtime eksternal. Tidak sesuai kebutuhan gratis/Cloudflare-only.

MVP mengambil data dari feed dan HTTP GET publik. Halaman yang hanya mengirim konten setelah JavaScript atau menolak fetch biasa ditandai jelas sebagai `unsupported_dynamic_page`/`blocked` dan dilewati. Sistem tidak mencoba melewati login, paywall, CAPTCHA, atau anti-bot.

## Arsitektur

```text
Cron Trigger (setiap menit, UTC)
        |
        v
Scheduler Worker
  lease global; pilih sumber due atau item pending
        |
        v
Fetch source feed/sitemap (satu sumber per invocation)
  ekstrak sampai 100 kandidat; simpan pending + cursor dalam batch D1
        |
        v
Ambil sampai 2 pending article URL biasa
        |
        v
Normalize + validasi + dedupe + upsert ke D1
        |
        +--> D1: sources, source_state, pending_items, articles, FTS5, fetch_runs
        |
        v
REST Worker: sumber, daftar artikel, pencarian, detail, ekspor

Deployment API -> Cloudflare Access Service Auth -> Worker
```

Satu Cron Trigger berjalan per menit (UTC). Global ingestion lease mencegah dua invocation memproses backlog atau menulis artikel secara bersamaan. Satu invocation mengambil satu sumber yang due, menyimpan kandidat feed/sitemap ke `pending_items`, lalu mengambil maksimal dua item pending untuk mendapatkan full text. Batasi satu feed fetch + dua article fetch per invocation; batas ini menyisakan ruang untuk D1 dan redirect dari kuota 50 subrequest.

Scheduler punya dua antrean prioritas: `pending_items` yang sudah ditemukan dan belum selesai, lalu sumber yang jatuh tempo. Batasi pending pada 2.000 row dan maksimum 24 MiB serialized metadata. Jika backlog pending mulai tertinggal, sumber baru ditunda; semua retryable pending tetap dipertahankan. API melaporkan backlog dan keterlambatan aktual. Queue product tidak dipakai: kuota gratisnya 10.000 operasi/hari dengan retensi 24 jam.

## Feed, sitemap, dan pending backlog

Tabel `pending_items` menjadi backlog durable di D1. Minimal menyimpan `source_id`, `dedupe_key`, `external_id`, `canonical_url`, title/summary/published time provisional, `status`, attempts, `next_attempt_at`, error terakhir, dan waktu ditemukan. Batas UTF-8 per row: title 4 KiB, summary 1 KiB, URL 4 KiB, external ID 1 KiB, dan error 1 KiB; kandidat yang melewati batas diberi `metadata_too_large` tanpa menyimpan payload tak terbatas.

Feed/sitemap diproses sebagai berikut:

1. Ambil feed atau satu sitemap URL.
2. Parse maksimum 100 kandidat, tetapi persist paling banyak 10 kandidat per invocation; sisanya tetap dapat ditemukan dari overlap/cursor pada polling berikutnya.
3. Sebelum menyimpan, cek write gate D1, ukuran physical `meta.size_after`, kuota pending, dan ruang cadangan. Upsert paling banyak 10 kandidat per invocation ke `pending_items`. Cursor hanya maju sampai kandidat yang sukses tercatat; jika kapasitas tidak cukup, jangan majukan cursor melewati kandidat pertama yang belum tersimpan dan tandai sumber `storage_limit`.
4. Pada invocation berikutnya, proses pending tertua. URL tetap pending sampai artikel berhasil diambil dan di-upsert atau kegagalan definitif dicatat; 403/404/unsupported page berstatus blocked/failed, bukan hilang.
5. Sumber feed yang tidak punya pagination hanya dapat mengirim artikel yang masih ditampilkan penerbit. Jika satu feed berubah begitu cepat sampai item hilang sebelum polling berikutnya, sistem tidak dapat memulihkannya; catat batas ini.

Untuk sitemap index, simpan setiap child sitemap sebagai pending discovery. Untuk sitemap URL-set berisi lebih dari 100 item, lanjutkan dalam beberapa putaran dengan `sitemap_last_loc`; jangan memajukan cursor melampaui batch URL yang sudah masuk D1. Jika sitemap berubah saat pemindaian, ulangi overlap berdasarkan `lastmod`/URL, dan dedupe dengan unique constraint. Saat pending cap atau D1 write gate tercapai, hentikan discovery tanpa memajukan cursor. Tes harus membuktikan overload tidak melampaui cap dan tidak melewati kandidat yang belum tersimpan.

`pending_items.status` mencakup `pending`, `leased`, `retry_wait`, `blocked`, dan `failed`. Claim memakai `lease_token` unik serta expiry; hanya token lease yang masih cocok boleh menyelesaikan item. Setelah artikel berhasil disimpan dan FTS diperbarui, hapus pending row di transaksi D1 yang sama; unique constraint artikel menjadi catatan dedupe. `blocked`/`failed` terminal disimpan 30 hari untuk diagnosis lalu dipangkas. `pending` dan `retry_wait` tidak dipangkas otomatis. Retry timeout/5xx dengan backoff+jitter dan `429` dengan `Retry-After`; berhenti retry pada error izin, halaman dinamis, atau parse yang berulang.

## Penyimpanan dan hard stop D1

Satu database D1 adalah sumber kebenaran; R2 tidak digunakan. Free menyediakan maksimum 500 MB per database dan 5 GB total allowance akun. Aplikasi menghentikan semua ingestion writes pada 280 MiB physical size dan mempunyai hard cap 300 MiB, menyisakan 20 MiB untuk operasi aman, ekspor, cleanup, dan perubahan kecil.

D1 mengembalikan `meta.size_after` setelah query. Write gate melindungi semua durable ingestion writes, termasuk pending, artikel, FTS, cursor/watermark, dan fetch-run records. Setelah tiap transaction, simpan ukuran physical terbaru di satu row `system_state` yang sudah dibuat saat migrasi. Pada atau di atas 280 MiB, hentikan discovery, pending inserts, article writes, serta pembuatan sumber baru; tandai `storage_limit`. Hanya operasi kecil yang mengurangi data atau menandai/menonaktifkan record yang boleh berjalan. Tiap batch dibatasi satu artikel atau 10 pending rows dan dibatasi byte-nya; global lease membuat cek ukuran dan write serial. Jika size melewati 300 MiB karena satu write tak terduga, masuk read-only untuk semua pertumbuhan baru. Tes mengisi D1 dengan sustained overload, menguji `meta.size_after` termasuk indeks/FTS, dan membuktikan physical size tetap di bawah cap serta cursor tidak melewati kandidat yang belum disimpan.

Tabel utama:

- `sources`: `id`, `url`, `kind`, `host`, `poll_interval_sec`, `selectors_json`, `enabled`, `next_fetch_at`, `etag`, `last_modified`, `feed_watermark`, `sitemap_last_loc`, `consecutive_errors`, `last_status`, `last_fetched_at`.
- `pending_items`: kandidat feed/article/sitemap, unique key per sumber, provisional metadata, status, attempts, `next_attempt_at`, lease token/expiry, error terakhir.
- `articles`: `id`, `source_id`, `external_id`, `canonical_url`, `title`, `summary`, `author`, `published_at`, `fetched_at`, `content_text`, `content_hash`, `status`.
- `fetch_runs`: run timestamps, status HTTP, counts, error code/message maks. 1 KiB; dipangkas setelah 30 hari.
- `system_state`: global ingestion lease, observed D1 size, cap state, export lock.
- `articles_fts`: FTS5 untuk judul/snippet, bukan isi penuh.
- `export_sessions`: snapshot ID, export watermark, cursor, expiry, state.

Ukuran 500 KiB dihitung dari bytes UTF-8. Unique constraints mencegah duplikasi `(source_id, external_id)`; fallback `(source_id, canonical_url)` yang dinormalisasi, lalu hash. Item berubah dengan ID sama memperbarui artikel di transaksi D1 yang sama dengan pembaruan FTS. Artikel lintas sumber tidak digabung.

Terapkan batas byte pada seluruh field sebelum menulis: `title` maks. 4 KiB, `summary` maks. 16 KiB, `author` maks. 1 KiB, `canonical_url` maks. 4 KiB, `external_id` maks. 1 KiB, dan `content_text` maks. 500 KiB UTF-8. Validasi ukuran row gabungan terhadap 1,8 MB (di bawah limit D1 2,000,000 bytes) sebelum insert/update; tolak item dengan `row_too_large` daripada membuang konten tanpa pemberitahuan. Tes harus mengisi field gabungan mendekati limit dan memastikan row tidak melampaui batas.

## REST API

Produksi memakai custom hostname yang diproteksi Cloudflare Access dengan Service Auth token; endpoint `workers.dev` dimatikan. Hanya request yang lolos policy Access yang mencapai Worker. Client internal mengirim service token headers; tidak ada aplikasi publik. Local dev memakai `API_TOKEN` lokal. API rate-limit per service token, dengan request body maksimum 32 KiB.

- `GET /health` — informasi hidup/minimal; endpoint ini juga hanya tersedia setelah Access.
- `GET /v1/sources` — daftar sumber, interval, freshness, status dan backlog.
- `POST /v1/sources` — tambah RSS/Atom/JSON Feed, sitemap, URL artikel, atau halaman daftar dengan selector.
- `PATCH /v1/sources/:id` — ubah selector/interval atau enable/disable.
- `DELETE /v1/sources/:id` — soft-disable; artikel tersimpan tidak dihapus.
- `GET /v1/articles?source_id=&from=&to=&q=&cursor=&limit=` — list dengan cursor; `from` inklusif UTC, `to` eksklusif UTC; `q` mencari judul/snippet; limit default 20, maksimum 100.
- `GET /v1/articles/:id` — metadata dan teks penuh.
- `POST /v1/exports` — mulai ekspor dan mengunci ingestion.
- `GET /v1/exports/:id?cursor=` — halaman NDJSON dengan maks. 10 record dan maks. 3 MiB serialized UTF-8 per halaman; berisi schema version, sumber, source state/watermark, seluruh pending item, artikel, full text, dan cursor berikut.
- `DELETE /v1/exports/:id` — akhiri ekspor dan buka kembali ingestion.

List artikel diurutkan stabil dengan `published_at DESC NULLS LAST, fetched_at DESC, id DESC`. Cursor memakai tuple urutan tersebut. Error response konsisten `{error:{code,message,request_id}}`, tanpa menyertakan secret atau URL credential.

## Backup dengan snapshot konsisten

Ekspor berjalan dengan pause ingestion supaya halaman ekspor menjadi snapshot yang konsisten:

1. `POST /v1/exports` memperoleh global `export_lock` dan menetapkan batas snapshot/ID terakhir.
2. Saat lock hidup, Cron menghentikan fetch/write artikel, dan perubahan source configuration mengembalikan `423 export_in_progress`.
3. Page export diurutkan dengan immutable `article.id`, bukan `fetched_at`; semua record di bawah watermark tidak berubah selama ekspor.
4. Setiap halaman mencakup versi schema, sources, source state/watermark, semua pending/retryable dan terminal records yang belum dipangkas, articles, teks, serta cursor. Maksimal 10 record dan 3 MiB NDJSON setelah encoding; server berhenti sebelum batas byte tercapai, bukan memotong record. Client dapat menyimpan checkpoint dan melanjutkan halaman berikutnya.
5. Ekspor selesai dengan `DELETE /v1/exports/:id`; lock otomatis habis setelah 30 menit. Ekspor kedaluwarsa harus dimulai ulang.
6. Uji ekspor penuh, restore ke database D1 lokal yang kosong, bandingkan row counts/hash/isi untuk sources, cursors/watermarks, pending backlog, dan articles; lakukan export sambil ada source updates untuk membuktikan lock mencegah kehilangan/duplikasi.

D1 Time Travel Free memberi point-in-time restore tujuh hari; ekspor NDJSON adalah backup jangka panjang manual. Tidak ada backup data R2 karena R2 tidak dipakai.

## SSRF, auth, dan kestabilan

- Tolak localhost, IP private/link-local/reserved, skema non-HTTP, URL dengan userinfo, port selain 80/443, dan hostname numeric/encoded yang tidak normal.
- Set `redirect: manual`. Validasi setiap `Location` setelah normalisasi; redirect hanya pada hostname yang sama dan maksimal tiga hop. URL sitemap/item lintas host tetap pending `blocked_external_host` sampai host ditambahkan sebagai sumber eksplisit.
- Batasi response 2 MiB, timeout 10 detik, satu feed + dua article URL, maksimum 100 kandidat baru per respons. Cancel body pada status/error yang tidak dipakai.
- Cloudflare outbound restrictions menjadi pertahanan tambahan, bukan pengganti aplikasi.
- Retry timeout/5xx terbatas dengan jitter; `429` menghormati `Retry-After`; stop untuk 401/403/captcha/dynamic pages.
- Access Service Token dibatasi scope, dapat dicabut/dirotasi. Jangan log header auth. Kegagalan policy Access ditangani sebelum aplikasi Worker.
- Global lease mencegah invocation overlap; lease expiry bisa diambil ulang; pending item memakai lease sendiri untuk recovery.

## Batas Cloudflare Free yang memengaruhi desain

- Workers: 100.000 request/hari, 10 ms CPU per invocation, 128 MB memori, 50 subrequest/invocation. D1/R2 calls dan redirect termasuk subrequest.
- D1: 5 juta row read/hari, 100.000 row write/hari, 500 MB maksimum per database Free, 5 GB total allowance akun, maksimum 50 D1 queries per Worker invocation.
- R2 memberi allowance 10 GB-month / 1M Class A / 10M Class B, tetapi kelebihan dapat ditagih; tidak digunakan.
- Queues: 10.000 operasi/hari dan retensi 24 jam; tidak digunakan.
- Cron: Worker Free dapat memakai lima Cron Triggers per akun. Proyek memakai satu trigger per menit; UTC.
- Zero Trust Free mendukung custom Access applications dan service tokens; deployment internal membutuhkan hostname yang dapat diproteksi Access.

Ribuan item teks muat selama masih di bawah cap 300 MB. Namun batas gratis bukan SLA: 100 sumber yang polling terlalu sering atau feed sangat aktif bisa menimbulkan backlog dan kuota habis. API menampilkan lag, jumlah pending, ukuran D1, serta `storage_limit`.

## Stack dan verifikasi

- TypeScript, Cloudflare Workers/Wrangler.
- D1 migrations; FTS5 untuk judul/snippet.
- `HTMLRewriter` dan CSS selector per sumber; parser RSS/Atom/JSON Feed.
- Vitest dengan Workers runtime lokal.

Tes wajib: feed/Atom/JSON valid, 304, lebih dari 2 item pending feed, lebih dari 10 URL sitemap, kandidat >10 yang masih akan ditemukan, new item during pending drain, pending deletion atomik dengan article+FTS, terminal pending purge setelah 30 hari, pending cap 2.000 rows/24 MiB, sustained overload sampai write gate menutup tanpa cursor skip dan ukuran D1 tetap di bawah 300 MiB, metadata/error field caps, body lengkap, selector hilang, 403/429/Retry-After, halaman dinamis, response 2 MiB, multi-hop/private/encoded redirect, host eksternal, lease race/reclaim, dedupe, FTS sync, D1 daily/storage limit, size_after/index accounting, UTF-8 field caps dan row gabungan dekat 1,800,000 bytes, Access auth/local token/secret redaction, stable cursor, export page ≤10 rows dan ≤3 MiB encoded dengan full-size bodies/pending metadata, export lock/pagination/expiry, export→restore termasuk sources/cursors/pending/articles, serta D1 failures.

Setiap fitur memakai RED → GREEN → REFACTOR; jalankan seluruh test suite, lint, typecheck, dan build. Ukur CPU/pending throughput dengan fixture realistis; jika 10 ms Free terlewati, sederhanakan parsing atau kecilkan batch—jangan diam-diam mengandalkan plan berbayar.

## Tahap kerja dan batas persetujuan

1. Buat repo lokal di `/workspace/media-aggregator`; tidak membuat resource di akun Cloudflare/Supabase.
2. Implementasikan schema + tests, source CRUD/auth, ingestion + pending backlog, API/pencarian, lalu export/recovery, satu task per coder dispatch.
3. Reviewer memeriksa setiap task dan seluruh proyek; verifikasi penuh sebelum dinyatakan selesai.
4. Siapkan panduan deploy, konfigurasi Access, D1, dan Cron. Deploy atau membuat Cloudflare Access app/service token/Worker/D1/secret/Cron hanya setelah persetujuan khusus untuk perubahan akun.

## Di luar MVP

X dan klien tidak resmi, YouTube, Instagram/Threads/Reddit APIs, cookies login, Browser Run, Playwright, layanan eksternal, Supabase, UI, notifikasi, gambar/video, bypass login/paywall/anti-bot, dan full-text search isi artikel.

## Referensi teknis

- [Workers pricing/Free limits](https://developers.cloudflare.com/workers/platform/pricing/)
- [Workers limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Cron Triggers](https://developers.cloudflare.com/workers/configuration/cron-triggers/)
- [D1 pricing](https://developers.cloudflare.com/d1/platform/pricing/)
- [D1 limits and row size](https://developers.cloudflare.com/d1/platform/limits/)
- [D1 result metadata including `size_after`](https://developers.cloudflare.com/d1/worker-api/return-object/)
- [D1 FTS5 support](https://developers.cloudflare.com/d1/sql-api/sql-statements/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [R2 pricing](https://developers.cloudflare.com/r2/pricing/)
- [Queues pricing/retention](https://developers.cloudflare.com/queues/platform/pricing/)
- [Cloudflare Access account limits](https://developers.cloudflare.com/cloudflare-one/account-limits/)
- [Access service tokens](https://developers.cloudflare.com/cloudflare-one/access-controls/service-credentials/service-tokens/)
- [Workers security model](https://developers.cloudflare.com/workers/reference/security-model/)
- [HTMLRewriter](https://developers.cloudflare.com/workers/runtime-apis/html-rewriter/)
