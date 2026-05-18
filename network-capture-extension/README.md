# QA Network Capture

Chrome extension'ı; testçilerin **DevTools açmadan** API hatalarını yakalayıp tek tıkla teknik ekibe iletebilmesi için.

## Nasıl çalışır

```
┌─ Page world ────────────────────┐    ┌─ Isolated world ─┐    ┌─ Service worker ─┐
│ interceptor.js                  │    │  bridge.js       │    │ service-worker.js │
│ • fetch + XMLHttpRequest patch  │ →  │ window.postMessage│ →  │ chrome.storage   │
│ • request/response body capture │    │ → chrome.runtime  │    │ • per-tab buffer │
└─────────────────────────────────┘    └──────────────────┘    │ • badge counter  │
                                                                └────────┬─────────┘
                                                                         │
                                                                         ▼
                                                                ┌─────────────────┐
                                                                │   popup.html    │
                                                                │ • list + filter │
                                                                │ • copy as cURL  │
                                                                │ • bug report MD │
                                                                └─────────────────┘
```

**Neden content-script patch (chrome.debugger değil):** `chrome.debugger` her şeyi yakalar ama tarayıcı üstüne sarı "X is debugging this browser" çubuğunu yapıştırır — testçi sekmesini kapatabilir, kötü UX. Page-world content script ile `fetch` ve `XMLHttpRequest`'i monkey-patch'lemek MV3 uyumlu, debug bar yok, response body var. Datasoft HR gibi React/Next.js uygulamalarında istekler zaten page context'inden çıktığı için bu yaklaşım %100'e yakın kapsama veriyor.

## Kurulum

1. Bu klasörü indir / klonla.
2. Chrome → `chrome://extensions` → **Developer mode** toggle'ı aç.
3. **Load unpacked** → bu klasörü seç.
4. Test edilecek sekmeye git, hatayı tekrarla. Toolbar'daki ikondaki kırmızı badge failed request sayısını gösterir.
5. İkona tıkla → failed listesinden hatayı seç → **Copy bug report**.

## Özellikler (MVP)

- `fetch` + `XMLHttpRequest` interception (response body dahil).
- Sekme bazlı circular buffer (son 200 istek; chrome.storage.session).
- Failed-only filter (status ≥ 400 veya network error) + "All" toggle.
- Hassas header maskeleme: `Authorization`, `Cookie`, `X-API-Key`, `X-Auth-Token` → `***MASKED***`. (`***MASKED***` notation'ı **field var, sadece değer gizlendi** demek — alan kaybı değil.)
- **Faithful kopyalama** — clipboard'a giden her byte gerçek request/response'tan. Translations, null'lar, audit field'ları (createdAt, isDeleted, vs.), hepsi orijinal halinde korunur. Backend dev "neden bu field eksik?" diye kafa karıştırmaz.
- **Size indicator + Slack uyarısı** — her copy butonunun yanında char sayısı. Bug report Slack rich-text limitini (~12k) aşarsa buton amber'a döner, üstte uyarı banner'ı çıkar: "Use Download JSON instead".
- **Server error signals (ADDITIVE)** — response JSON'unda `errors`/`message`/`detail`/`traceId`/`ModelState` varsa raporun başına özet bullet'ları ekler. Full response body raporda yine **olduğu gibi** durur, sadece üstte göz hizasında özet bulunur.
- **Download JSON** — full capture'ı `.json` dosyası olarak indirir. Slack'e drag-drop → snippet attachment, 1MB'a kadar her şey sığar.
- Toolbar badge: o sekmedeki failed request sayısı.
- Tab kapanışında ve full reload'da otomatik temizlik.

## Hangi butonu ne zaman?

**Senaryo 1: Validation hatası (response küçük, 4xx)**
→ "Copy bug report" yeter. Char sayısı ~1-3k, Slack'e direkt paste edilir. Üstte "Server error signals" özeti, altında full request/response body — backend dev gerçek payload'u görür.

**Senaryo 2: 200 dönen devasa payload (Upsert gibi)**
→ Buton "21.4k chars ⚠" der, üstte amber uyarı çıkar. **"⤓ Download JSON"** ile dosyayı indir, Slack'e drag-drop. Snippet olarak açılır, dev expand/collapse'la inceler, gerçek payload'la 1-1 aynı.

**Senaryo 3: Jira issue açıyorum**
→ Jira description'da char limiti pratikte sorun değil — "Copy bug report"u direkt yapıştırabilirsin. Eğer 32KB üstü gerçekten dev olursa Download JSON dosyasını Jira'ya attachment olarak ekle.

## Tasarım prensibi: zero information loss

Önceki iterasyonlarda compact mode'da "noise stripping" (translations, null'lar, audit fields silme) ve head+tail truncation denedik. Vazgeçtik çünkü:
- Backend dev raporu okuduğunda eksik bir field gördüğünde "bu eksik mi gönderildi, yoksa benim tool mu sildi?" sorusuna takılır. False debug signal = kaybedilmiş saatler.
- "Truncated" notu olsa bile, dev'in ilgilendiği field truncate edilmiş kısımda olabilir. Hangi field'ın gittiğini bilmiyor.

Bu yüzden artık tek bir mod var: **full fidelity**. Eğer büyükse "JSON indir, Slack'e bırak" yolu önerilir. Hiçbir field silinmez, hiçbir değer truncate edilmez. Tek istisna: `Authorization`/`Cookie` header'ları güvenlik için maskelenir, ama bunlar `***MASKED***` notation'ıyla açıkça işaretlenir (alan eksik değil, değer gizli).

## Bilinen kısıtlar

- **`chrome-extension://`, `chrome://` ve Web Store** sayfalarında çalışmaz (Chrome bunu yasaklar — normal).
- **Service worker, beacon, ve worker-internal istekleri** page-world patch'ten kaçar. Bu istekleri de yakalamak gerekiyorsa ek olarak `chrome.webRequest` ile metadata seviyesinde tamamlanabilir (response body için yeterli değil — orada `chrome.debugger`'a düşmek gerekir).
- **Binary response bodies** (`image/*`, `application/octet-stream`) text olarak okunmaz, placeholder yazılır.
- **`chrome.storage.session` ~10MB limiti var**, 200'lük tab buffer + truncate (200KB/body) ile rahat kalır.

## Sıradaki adımlar (Sprint 2 kapsamı)

- [ ] **Slack `files.upload_v2` ile direkt gönderim**: "Send to #slacktest" butonu → full payload'ı text/JSON snippet olarak yükler (40k char limiti yok, 1MB'a kadar). Mevcut Slack MCP planının doğal devamı. Webhook yerine bot token gerekir çünkü webhook'lar files.upload'a izin vermiyor.
- [ ] **Jira entegrasyonu**: doğrudan `datasoftdocument.atlassian.net`'de issue açma; full report `description`'a, JSON dump attachment olarak. Atlassian MCP üzerinden.
- [ ] **Sayfa ekran görüntüsü**: `chrome.tabs.captureVisibleTab` ile son hatanın anındaki screenshot'ı bug report'a ekle.
- [ ] **Replay**: bir failed request'i tek tıkla yeniden gönderme (developer için).
- [ ] **Korelasyon ID**: aynı işlem akışındaki birden fazla request'i grupla (örn. modal açılışından submit'e kadar).
- [ ] **Allowed-origin whitelist**: sadece `*.datasoft.local` ve API host'larında çalışsın, GA/Sentry/CDN gürültüsünü filtrele.
- [ ] **Schema-aware noise stripping**: `translations`, nested `populationCity/country/city` location objelerini opsiyonel olarak collapse et — Datasoft HR response'larında 1000-2000 char kazandırır.
- [ ] **Per-user config**: hassas header listesi, max buffer, default filter — `chrome.storage.sync` ile.
- [ ] **TypeScript + Vite build pipeline** (CRXJS plugin).

## Dosya yapısı

```
network-capture-extension/
├── manifest.json
├── icons/
│   ├── icon16.png  icon48.png  icon128.png
└── src/
    ├── background/service-worker.js   # storage + badge + lifecycle
    ├── content/
    │   ├── interceptor.js             # page-world: fetch + XHR patch
    │   └── bridge.js                  # isolated-world: postMessage → sendMessage
    └── popup/
        ├── popup.html
        ├── popup.css
        └── popup.js                   # list + detail + copy formatters
```
