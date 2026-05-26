# Hindsight — CWS Privacy / Permissions form

Bu dosya, Chrome Web Store geliştirici dashboard'unun **"Gizlilik"**
sekmesini doldurmana yardımcı olur. Her alan için:

- **Türkçe açıklama:** ne sorulduğunu ve nasıl yorumlanması gerektiğini anlatır
- **İngilizce metin:** form alanına direkt yapıştır

Her İngilizce metin 1.000 karakter sınırının altındadır. Kopyalarken
satır başlarındaki `>` işaretini dahil etme — sadece blockquote
içeriğini al.

---

## 1. Tek amaç açıklaması (Single purpose, max 1.000 chars)

**Türkçe rehber:** CWS, eklentinin _bir_ açık amacı olmasını ister. "Pasif yakalama

- paylaşma" tek bir cümle değil ama tek bir amaca hizmet ediyor —
  "yakalanmamış kanıtı sonradan paylaş." Bunu net yaz, mitigation'ları
  ekle (cihazda kalıyor, telemetri yok), ki reviewer'ın aklında soru
  işareti kalmasın.

**Yapıştır:**

> Hindsight captures browser activity — network requests, console messages, user actions, and screenshots — in the background, so users can review and share a faithful bug report when something breaks. All captured data stays on the user's device until they explicitly click a Share button. There is no backend, no telemetry, and no analytics. The extension's sole purpose is to be the "DevTools you forgot to open" — a passive, privacy-first recorder that turns ephemeral browser state into a shareable artifact at the user's request.

---

## 2. İzin gerekçeleri (Permission justifications, her biri max 1.000)

Her izin için **neden gerekli** olduğunu söyle, **gerekmeseydi
istemezdik** vurgusu yap.

### 2.1 `storage`

**Türkçe:** "Eklentinin temel iş alanı yakalama-tampona-yaz. Yerel storage olmadan hiçbir capture
service-worker uyanışları arasında hayatta kalmaz."

**Yapıştır:**

> Required to persist captured events (network requests, console messages, user actions, screenshots) to the per-tab buffer in chrome.storage.local. This is the extension's primary working store. Without it, no capture would survive between service-worker wake-ups, defeating the purpose of a passive background recorder.

### 2.2 `unlimitedStorage`

**Türkçe:** "5 MB varsayılan storage kotası uzun bir tarama gününde
patlar — biz 'bilgi kaybı yok' diyoruz, dolayısıyla bu kısıtı
istiyoruz. Veri yine yerel kalıyor."

**Yapıştır:**

> Heavy-browsing sessions can accumulate several megabytes of captured network bodies and screenshots within a single tab. unlimitedStorage prevents the buffer from being silently truncated by the default 5 MB quota mid-session, preserving the extension's promise of "no information loss." All data still stays on the user's device.

### 2.3 `activeTab`

**Türkçe:** "Kullanıcı toolbar ikonuna basınca veya yan paneli
açınca, sadece o anki sekmeye dokunuyoruz. Daha geniş izin yerine
bunu tercih ettik — install-time prompt küçük kalsın."

**Yapıştır:**

> The extension only inspects the tab the user is actively looking at when they invoke its UI (toolbar icon click or side-panel open). Used in place of broader host_permissions to keep the install-time permission ask minimal. activeTab grants the minimum surface area needed for the inspection UI to function.

### 2.4 `scripting`

**Türkçe:** "MV3'te content-script enjekte etmenin tek yolu. fetch /
XHR / console gözlemcilerimiz olmadan eklentinin amacı kalmaz."

**Yapıştır:**

> Required to inject the content scripts that observe fetch / XMLHttpRequest / console events in the page world. Without scripting, the extension cannot see any network or console activity, which is the entire reason it exists. Injection only runs in the user's active tab via activeTab.

### 2.5 `sidePanel`

**Türkçe:** "Yan panel — scrubber, event listesi, detail pane,
replay-bundle export — tüm asıl UI orada yaşıyor. MV3'te kalıcı
inceleme yüzeyi sunan tek API bu."

**Yapıştır:**

> The side panel is the extension's primary inspection UI. Scrubber, event list, detail pane, filters, and replay-bundle exports all live there. chrome.sidePanel is the only Manifest V3 API that offers a persistent inspection surface alongside the page — without it the user would have to lose their browsing context to inspect captures.

### 2.6 `notifications` (opsiyonel)

**Türkçe:** "10 saniyede 3+ başarısız istek olduğunda tek seferlik
masaüstü bildirim. Varsayılan KAPALI — kullanıcı Settings'ten açtığında
isteriz."

**Yapıştır:**

> Optional. Surfaces a one-shot desktop notification when the extension detects a cascade of failed requests (3 or more failures to the same origin within 10 seconds) so the user can switch to the side panel without watching the toolbar icon. Disabled by default; the permission is requested at runtime only when the user enables it in Settings → Detection.

### 2.7 `downloads` (opsiyonel)

**Türkçe:** "Replay bundle .html dosyasını ve ZIP/JSON/HAR
export'larını diske yazıyor. Hiçbir uzak upload yok — sadece
chrome.downloads.download bir data: URL ile."

**Yapıştır:**

> Optional. Used by the "Save as replay bundle" feature to write a single self-contained HTML file to the user's computer, and by JSON / HAR / ZIP exports. The only API call is chrome.downloads.download with a local data: URL — nothing is uploaded to any remote server. Requested at runtime only when the user triggers a download.

### 2.8 `tabs` (opsiyonel)

**Türkçe:** "Popup özetinde ve yan panelde URL/başlık göstermek için
sekme metadata'sı okur. Tab navigation veya kontrolü yok."

**Yapıştır:**

> Optional. Reads tab metadata (URL, title, id) for the popup summary and the side-panel display. Not used to enumerate other tabs, switch between them, or modify their navigation. Requested at runtime when the user enables UI features that surface tab context.

### 2.9 `webNavigation` (opsiyonel)

**Türkçe:** "SPA route değişiklerini ve sayfa reload'larını yakalayıp
zaman çizelgesinde gösteriyoruz. Yönlendirme yapmıyor, navigation'a
müdahale etmiyor — sadece dinliyor."

**Yapıştır:**

> Optional. Detects same-document navigation events (SPA route changes) and full reload events so the timeline can show distinct navigation segments. Used purely to enrich the captured event stream — the extension never redirects, blocks, or modifies any navigation.

### 2.10 Ana makine izni — `<all_urls>` (opsiyonel)

**Türkçe:** "fetch/XHR yakalayıcı content-script'in kullanıcının
ziyaret ettiği sayfada çalışması için gerekli. Manifest'te
optional_host_permissions olarak — install-time istemiyor, kullanıcı
'her sitede yakala' feature'ını açınca isteniyor."

**Yapıştır:**

> Required so the content script that intercepts fetch / XMLHttpRequest / console activity runs on whatever page the user visits. Without it, the extension could only see captures from its own pages, which defeats the entire purpose. Declared as optional_host_permissions in the manifest — it is requested only when the user enables the broader "capture on all sites" feature, never at install time. The extension makes zero outbound HTTP requests of its own to any of these hosts; it only observes the user's existing traffic.

---

## 3. Uzak kod (Remote code)

**Türkçe:** "Hayır" işaretle.

**Sebep (sormazsa söyleme, sorarsa hazır olsun):**

> The extension's CSP is `script-src 'self'; object-src 'self'` (Manifest V3 baseline). All JavaScript is bundled into the package via Vite at build time. No remote scripts, no eval(), no Function(), no dynamic imports from external URLs. The replay bundle export contains its own viewer JS inlined in the same HTML file — that viewer is also bundled at build time, not fetched.

---

## 4. Veri kullanımı (Data usage)

**Türkçe rehber:** CWS "topladığım veriler" listesi. Hindsight teknik
olarak şu kategorilere _dokunur_ (yerel olarak yakalar, hiçbir yere
yollamaz). Dürüstçe işaretle. Az veya çok işaretlemek reddedilme
sebebi olabilir.

### İşaretlenecek kutular

✅ **Kimliği tanımlayabilecek bilgiler (PII)**
— Sebep: Eklenti TCKN ve kredi-kartı tespit eden regex'ler içeriyor (maskelemek için). Yani _işliyor_; CWS perspektifinde declare edilmeli.

✅ **Finansal bilgiler ve ödeme bilgileri**
— Sebep: Aynı, kredi kartı pattern matching (maskleme için, Luhn doğrulamalı).

✅ **Kimlik doğrulama bilgileri**
— Sebep: `Authorization`, `Cookie`, `X-API-Key` header'larını yakalama anında görür ve `***MASKED***` ile değiştirir. _Görüyor_ → declare edilmeli.

✅ **Web geçmişi**
— Sebep: Ziyaret edilen sayfaların URL'leri, navigation event'leri.

✅ **Kullanıcı etkinliği**
— Sebep: Tıklamalar, scroll, cursor (recording mode'da), network izleme.

✅ **Web sitesi içeriği**
— Sebep: Request/response body'leri, ekran görüntüleri.

### İşaretlenmeyecek

❌ **Sağlık bilgileri** — özel olarak ele almıyoruz
❌ **Kişisel iletişimler** — özel olarak ele almıyoruz (body'de e-posta geçebilir ama bunu pattern olarak ayıklamıyoruz)
❌ **Konum** — yakalamıyoruz

### Reviewer "neden bu kadar kategori?" diye sorarsa hazır cevap:

> Hindsight is a general-purpose passive recorder for developer bug reports. By design, it captures whatever network requests and DOM events the user's tabs generate. The categories above describe the technical surface the extension can touch — not data the extension extracts or transmits. Every captured value is masked at capture time when it matches a sensitive-data rule (Authorization / Cookie / TCKN / credit-card / user-defined regex), stored locally only, and never leaves the device until the user explicitly clicks Send.

---

## 5. Üç beyan (Three declarations)

Hepsini **işaretle** ✅. Üçü de doğru:

| #   | Beyan                                      | Neden doğru                                        |
| --- | ------------------------------------------ | -------------------------------------------------- |
| 1   | Üçüncü taraflara satmıyorum / aktarmıyorum | Backend yok, telemetri yok, hiçbir dış istek yok   |
| 2   | Tek amaç dışında kullanmıyorum             | Tek amaç: bug yakala + kullanıcı paylaşırsa paylaş |
| 3   | Kredi değerlendirme için kullanmıyorum     | Açıkça yok                                         |

---

## 6. Gizlilik politikası URL'si

**Yapıştır:**

```
https://osmnnl.github.io/hindsight/privacy.html
```

---

## Hızlı kontrol — submit etmeden önce

- [ ] Tek amaç metni 1.000 chars altında (~700)
- [ ] 10 izin gerekçesi dolu (her biri 1.000 chars altında)
- [ ] Uzak kod: **Hayır**
- [ ] 6 veri kategorisi işaretli (PII, Financial, Auth, Web history, User activity, Website content)
- [ ] 3 beyan kutusu işaretli
- [ ] Privacy policy URL canlı ve HTTP 200 dönüyor (test: `curl -I https://osmnnl.github.io/hindsight/privacy.html`)

Reddedilme nedenlerinin %80'i şunlar:

1. Privacy policy URL ölü veya boş
2. İzin gerekçesi "I need this" gibi yetersiz
3. Veri kategori beyanı eksik (gizliyormuş gibi)

Yukarıdaki metinler üçünü de adresliyor.
