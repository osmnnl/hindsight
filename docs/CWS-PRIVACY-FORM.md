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

> Hindsight records browser activity in the background — network requests, console messages, user actions and screenshots — so that when something breaks, the user can review what happened and share a faithful bug report. All captured data stays on the user's device until the user explicitly saves a file or presses Send to a destination they configured. There is no backend, no telemetry and no analytics.

---

## 2. İzin gerekçeleri (Permission justifications, her biri max 1.000)

Dashboard, `manifest.json` içindeki **her** izin için bir kutu açar.
1.0.0 manifesti tam olarak şunları ister — bu listede olmayan bir izin
için gerekçe yazma (reviewer "kullanılmayan izin" diye reddeder):

| Manifest alanı              | Değer                                                   |
| --------------------------- | ------------------------------------------------------- |
| `permissions`               | `storage`, `unlimitedStorage`, `activeTab`, `sidePanel` |
| `optional_permissions`      | `notifications`                                         |
| `host_permissions`          | — (boş)                                                 |
| `optional_host_permissions` | `<all_urls>` (Replay, köken başına istenir)             |
| `content_scripts.matches`   | `<all_urls>`                                            |

1.0.0'da kaldırılanlar: `scripting` (kodda hiç çağrılmıyordu; content
script'ler manifestte tanımlı), opsiyonel `downloads`, `tabs`,
`webNavigation` (hiçbir yerde istenmiyordu). Eski metinlerini
dashboard'da görürsen sil.

### 2.1 `storage`

**Türkçe:** Yakalanan olaylar sekme başına `chrome.storage.local`'de
tutulur; service worker uykuya geçip uyandığında tampon kaybolmasın
diye şart.

**Yapıştır:**

> Required to keep the captured events of each tab (network requests, console messages, user actions, screenshots) in chrome.storage.local, plus the user's settings. Manifest V3 service workers are stopped between events, so without local storage no capture would survive from one event to the next. Everything is stored on the user's device only; nothing is synced or uploaded.

### 2.2 `unlimitedStorage`

**Türkçe:** Varsayılan kota, gövdeli istekler ve ekran görüntüleriyle
dolu birkaç sekmede yetmez. Tampon zaten sınırlı (sekme başına 200 olay
/ 2 MB, en fazla 30 arşiv oturumu); bu izin sınıra gelmeden kota
hatasıyla yarıda kesilmeyi önler.

**Yapıştır:**

> Several busy tabs with response bodies and screenshots can exceed the default storage quota. Hindsight bounds its own usage (a rolling buffer of 200 events / 2 MB per tab and at most 30 archived sessions, oldest removed first), and unlimitedStorage prevents a capture from failing with a quota error before those bounds are reached. All data stays on the user's device.

### 2.3 `activeTab`

**Türkçe:** Kullanıcı simgeye, kısayola ya da yan panele bastığında o
sekmenin ekran görüntüsünü alabilmek için (`tabs.captureVisibleTab`).
Ekran görüntüsü için `<all_urls>` istemek yerine bunu seçtik.

**Yapıştır:**

> Used for screenshots. When the user clicks the toolbar icon, opens the side panel or presses one of the extension's keyboard shortcuts on a tab, activeTab lets Hindsight call tabs.captureVisibleTab for that tab, so error screenshots and recording-mode frames can be attached to the bug report. We chose activeTab over a broad host permission for this. Screenshots are stored locally and never uploaded.

### 2.4 `sidePanel`

**Türkçe:** Asıl arayüz yan panel: zaman çizelgesi, olay listesi,
ayrıntı, dışa aktarma.

**Yapıştır:**

> The side panel is the extension's main inspection interface: the timeline scrubber, the event list, request/response details, filters and the export buttons all live there. chrome.sidePanel is the Manifest V3 API that shows this next to the page, so the user keeps the page they are debugging in view.

### 2.5 `notifications` (opsiyonel)

**Türkçe:** Varsayılan kapalı. Kullanıcı Ayarlar → Algılama'da açınca
istenir; ardışık hata zinciri algılanınca tek bir masaüstü bildirimi.

**Yapıştır:**

> Optional and off by default. Requested at runtime only when the user turns on Settings → Detection → Desktop notifications. It shows a desktop notification when Hindsight detects a cascade of failed requests or the same request failing repeatedly, so the user can open the side panel without watching the toolbar badge.

### 2.6 Ana makine izni — content script `<all_urls>` ve opsiyonel `<all_urls>`

**Türkçe:** Dashboard bu ikisi için tek bir "host permission"
kutusu açar. İkisini birden açıkla:
(a) Yakalayıcı content script her sayfada çalışmak zorunda — bir hata
olmadan önce hangi sekmede olacağını bilemeyiz; ürünün tek amacı bu.
(b) `optional_host_permissions` yalnız **Replay** içindir ve köken
başına (`https://ornek.com/*`) istenir; Ayarlar → Gizlilik → Replay
erişimi'nden geri alınır.

**Yapıştır:**

> Content scripts (matches <all_urls>): Hindsight's purpose is to have the evidence already recorded when a page breaks, and that cannot be known in advance, so its two content scripts run on every page at document_start. They only observe the page's own fetch / XMLHttpRequest / console activity and user actions; they make no network requests. Sensitive headers, password fields and card numbers are masked before anything is written, and the user can exclude origins in Settings → Privacy.
>
> Optional host permission (<all_urls>): never requested at install. When the user presses Replay on a captured request, Hindsight asks for that single origin only (for example https://api.example.com/*) so the request can be re-sent from the extension. Granted origins are listed in Settings → Privacy → Replay access and can be revoked there.

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
— Sebep: Ziyaret edilen sayfaların URL'leri, sayfa yükleme ve SPA rota olayları.

✅ **Kullanıcı etkinliği**
— Sebep: Tıklamalar, scroll, cursor (recording mode'da), network izleme.

✅ **Web sitesi içeriği**
— Sebep: Request/response body'leri, ekran görüntüleri.

### İşaretlenmeyecek

❌ **Sağlık bilgileri** — özel olarak ele almıyoruz
❌ **Kişisel iletişimler** — özel olarak ele almıyoruz (body'de e-posta geçebilir ama bunu pattern olarak ayıklamıyoruz)
❌ **Konum** — yakalamıyoruz

### Reviewer "neden bu kadar kategori?" diye sorarsa hazır cevap:

> Hindsight is a general-purpose passive recorder for developer bug reports. By design, it captures whatever network requests and DOM events the user's tabs generate. The categories above describe the technical surface the extension can touch — not data the extension extracts or transmits. Every captured value is masked at capture time when it matches a sensitive-data rule (Authorization / Cookie / TCKN / credit-card / user-defined regex), stored locally only, and never leaves the device until the user explicitly saves a file or clicks Send.

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
- [ ] 6 izin gerekçesi dolu (storage, unlimitedStorage, activeTab, sidePanel, notifications, host) — her biri 1.000 karakter altında
- [ ] Dashboard'da `scripting` / `downloads` / `tabs` / `webNavigation` gerekçesi kalmadı
- [ ] Uzak kod: **Hayır**
- [ ] 6 veri kategorisi işaretli (PII, Financial, Auth, Web history, User activity, Website content)
- [ ] 3 beyan kutusu işaretli
- [ ] Privacy policy URL canlı ve HTTP 200 dönüyor (test: `curl -I https://osmnnl.github.io/hindsight/privacy.html`)

Reddedilme nedenlerinin %80'i şunlar:

1. Privacy policy URL ölü veya boş
2. İzin gerekçesi "I need this" gibi yetersiz
3. Veri kategori beyanı eksik (gizliyormuş gibi)

Yukarıdaki metinler üçünü de adresliyor.
