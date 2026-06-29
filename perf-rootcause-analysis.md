# Performans Kök-Neden Analizi — `hindsight-perf-rootcause`

> **Kaynak:** Bu dosya, 2026-06-29T20:57:45.711Z tarihli workflow çalışmasından (runId `wf_6791487f-4a3`) kurtarıldı.
> Orijinal yapılandırılmış çıktı: `~/.claude/projects/-Users-osmanunal-repos-osman-Hindsight/12acf8aa-.../workflows/wf_6791487f-4a3.json`
> Durum: **completed** · 37 agent · ~22d 33s · 2.57M token · 410 tool çağrısı
> Problem: Hindsight çok-sekme + yoğun istek altında sayfa donması (jank). Eklenti kaldırılınca anında düzeliyor.

**Önemli:** Bu analiz yalnızca KÖK-NEDEN teşhisidir. Hiçbir kod değişikliği uygulanmadı; repo temiz.

---

## Yönetici Özeti

Semptomun (çok-sekme × çok-istek × kaldırınca-anında-düzelme) baskın kök-nedeni, kodla doğrulandı: sayfa MAIN-world'ündeki post() (interceptor.ts:28-39) HER yakalanan olayda KOŞULSUZ window.postMessage(message, '\*') yapıyor (interceptor.ts:35). v0.6.2'nin batch'i ve Tier-4 kapısı bunun TAMAMEN SONRASINDA, ISOLATED-world bridge'inde (bridge.ts:123-142). Yani structured-clone + sayfanın kendi 'message' dinleyicilerine fan-out maliyeti renderer ana thread'inde, kapı/batch'ten ÖNCE, her olayda ödeniyor. 910bc50 interceptor.ts'e HİÇ dokunmadı (git ile doğrulandı) — yalnızca postMessage SONRASI runtime IPC sayısını azalttı. Bu, sayfa jank'ının doğduğu thread'de üç koşulu da açıklayan tek mekanizmadır.

İkinci, daha dar ama gerçek bir renderer-main katkısı: XHR loadend handler'ı TAMAMEN SENKRON (network-patch.ts:269-306) — capText(xhr.responseText) (gövdeyi materialize eder, text yolunda content-length guard'ı YOK) + JSON.stringify + senkron post(). fetch ad53e40'ta detach edildi (network-patch.ts:113-122), XHR'a yalnızca cap eklendi, detach EKLENMEDİ. axios/jQuery/Angular XHR kullandığından XHR-ağır SPA'larda istek başına ana-thread stall.

Çok-SEKME amplifikasyonu ise paylaşılan tek SW + tek storage backing store'da birikir (service-worker.ts CAPTURE_BATCH seri await döngüsü 241-253; storage.ts flushTab 250ms tam-dizi yeniden-yazma 163-181). Bu SW yükü sayfa thread'ini DOĞRUDAN dondurmaz; bridge IPC drenajını yavaşlatarak dolaylı katkı verir. (Denetimde "SW doygunluğu sayfaya sızar" ve "storage çekişmesi" hipotezleri bağımsız KÖK-NEDEN olarak çürütüldü çünkü sayfa jank'ını tek başına üretemezler — ama renderer-main hipotezlerinin altında gerçek kötüleştiriciler.)

Dört bench de (fetch/xhr/masking/filter) tsx/Node'da, post()=no-op ile veya saf fonksiyon olarak çalışır; gerçek postMessage clone, IPC clone, sayfa-dinleyici uyanışı, çok-sekme SW/storage çekişmesini HİÇ ölçmez. "Bench yeşil ama jank var" çelişkisi tamamen budur — yanlış katman ölçülüyor.

Cerrahi düzeltmeler gizliliği veya storage'daki bilgiyi zayıflatmadan uygulanabilir: postMessage'i namespace'li bir özel kanala (MessagePort) taşımak fan-out'u ortadan kaldırır; XHR'a fetch'in detach desenini uygulamak senkron stall'ı keser; cursor/scroll'u MAIN-world'de recording mirror'ı ile post()'tan ÖNCE düşürmek taban yükü siler.

## Nedensellik Zinciri (uçtan uca)

UÇTAN UCA HİKÂYE (kodla doğrulanmış):

1. Sayfa bir fetch/XHR/click/tuş/console/longtask/cursor/scroll üretir. interceptor.ts MAIN-world'de (manifest world:MAIN) = sayfanın renderer ana thread'inde çalışır. Her yakalama tek çıkıştan geçer: post() (interceptor.ts:28-39).

2. post() KOŞULSUZ window.postMessage(message, '_') çağırır (interceptor.ts:35). Chromium'da bu çağrı thread'inde (renderer-main) payload'ı SENKRON structured-clone eder. '_' targetOrigin + hedef pencere kendisi olduğundan MessageEvent yalnızca ISOLATED bridge'e değil, SAYFANIN KENDİ tüm window 'message' dinleyicilerine de bir görev (task) olarak kuyruğa alınır. Bunu bridge.ts:124'teki `if (event.source !== window) return` guard'ı kanıtlar — bridge, sayfanın aynı pencereye attığı mesajı filtrelemek zorunda. MessageChannel/transferable YOK (grep doğruladı) → gerçek clone yolu, ucuz transfer değil.

3. Bu clone CPU'su gövde boyutuyla (≤BODY_CAP=200000 char, capture-limits.ts:13) ölçeklenir; fan-out maliyeti sayfanın dinleyici sayısıyla (OAuth/3DS iframe köprüleri, wallet RPC, analytics SDK, framework router/HMR) çarpılır. ÇOK İSTEK (b) = post() frekansı doğrudan istek frekansıyla ölçeklenir → ana-thread görev kuyruğu birikir → uzun task'ler → jank/freeze.

4. XHR'da ek senkron maliyet: loadend handler (network-patch.ts:269-306) yield etmeyen tek senkron blok — capText(xhr.responseText) gövdeyi tam materialize eder (text yolu guard'sız), JSON.stringify, sonra senkron post(). fetch detach edilmiş ama XHR edilmemiş (asimetri ad53e40'ta atlandı).

5. ÇOK SEKME (a): her sekme bağımsız renderer'da kendi post()/postMessage yükünü öder (sekme-içi jank toplamsal). Ayrıca tüm sekmelerin batch IPC'leri TEK paylaşılan SW'de (service-worker.ts:241-253 seri for-await handleCapture) toplanır; her handleCapture readEvents+detect (başarısız network'te ~3×O(N), detection.ts:60-74,92-100,129-136) + renderBadge (2×O(N) tarama + 2 chrome.action IPC, service-worker.ts:942-962) + queueEvent yapar. queueEvent/flushTab her aktif sekme için 250ms'de bir TÜM diziyi yeniden serialize edip chrome.storage.local'a yazar (storage.ts:163-181) — tek backing store'da N-sekme çekişmesi. SW doygunlaşınca bridge'in sendMessage drenajı gecikir, renderer queue birikir → çok-sekme süper-doğrusal kötüleşme. (Bu SW/storage yükü TEK BAŞINA sayfa thread'ini dondurmaz — bu yüzden bağımsız kök-neden olarak çürütüldü — ama renderer-main yükünü amplifiye eder.)

6. Cursor/scroll (interceptor.ts:346-371) recording KAPALIYKEN bile 10Hz+10Hz post() yapar; Tier-4 gate bridge.ts:130'da postMessage SONRASI. Yani kayıt kapalı her ön-plan sekmesinde sabit ~20Hz saf-israf clone+fan-out taban yükü, istek dalgalarına kırılganlaştırır.

7. KALDIRINCA ANINDA DÜZELME (c): eklenti kaldırılınca MAIN-world yamaları (window.fetch/XHR/WebSocket, dinleyiciler) ve postMessage tamamen gider; bridge+SW+storage işleme durur. Renderer ana thread'inde hiçbir capture maliyeti kalmaz → jank ANINDA biter. Üç koşul da tek tutarlı modelle açıklanır; baskın eksen renderer-main postMessage, amplifikasyon ekseni paylaşılan SW/storage.

---

## Kök Nedenler (öncelik sırasına göre)

### #1 — post() her olayda renderer ana thread'inde KOŞULSUZ senkron window.postMessage(msg,'\*') yapar — structured-clone + sayfanın TÜM message dinleyicilerine fan-out; batch ve Tier-4 gate bunun SONRASINDA

- **Thread:** `renderer-main` · **Güven:** high · **Efor:** M
- **Mekanizma:** interceptor.ts:28-39 post() koşulsuz window.postMessage(message,'_') (interceptor.ts:35) çağırır. Tüm capture siteleri buradan geçer: fetch (network-patch.ts:110), XHR (network-patch.ts:302), click (interceptor.ts:68), her tuş input (interceptor.ts:254), console (interceptor.ts:104/128/152), SPA-nav (interceptor.ts:209), longtask (interceptor.ts:309), CLS (interceptor.ts:323), cursor (interceptor.ts:353), scroll (interceptor.ts:368). manifest world:MAIN olduğundan bu kod sayfanın renderer ana thread'indedir. window.postMessage payload'ı çağrı thread'inde SENKRON structured-clone eder; '_' + hedef-pencere-kendisi olduğundan MessageEvent sayfanın KENDİ window 'message' dinleyicilerine de teslim edilir (task olarak kuyruğa alınır, AYNI ana thread'de koşar). v0.6.2 batch'i (bridge.ts:99-142) ve Tier-4 gate'i (bridge.ts:130) İKİSİ DE ISOLATED-world bridge'inde, postMessage event'i alındıktan SONRA — yani clone+fan-out maliyeti gate/batch'ten ÖNCE, her olayda, renderer ana thread'inde tam ödenir.
- **Kanıt:** interceptor.ts:28-39 (post gövdesi), :35 (window.postMessage(message,'\*')). bridge.ts:124 (`if (event.source !== window) return` — sayfanın kendi window'una fan-out'u KANITLAR, bridge filtrelemek zorunda). bridge.ts:130 (Tier-4 gate listener İÇİNDE), :137 (BATCH_MAX=50), :141 (BATCH_FLUSH_MS=250). grep: src/content/ ve network-patch.ts'de MessageChannel/transferable YOK → gerçek clone yolu. capture-limits.ts:13 (BODY_CAP=200000). git: 910bc50 interceptor.ts'e DOKUNMADI (yalnızca bridge.ts/service-worker.ts/runtime-messages.ts), yani postMessage v0.6.2'de değişmedi. Bench körlüğü: bench/fetch-overhead.bench.ts:75-78 ve bench/xhr-overhead.bench.ts:116-119 post=no-op.
- **Beklenen etki:** En büyük tek kazanç. Sayfa-handler fan-out'unu ELE ALMAK postMessage-ağır SPA'larda (OAuth/3DS/wallet/analytics) capture başına maliyeti istek_frekansı × (clone + D dinleyici) yerine yalnızca clone'a indirir. Tüm capture tipleri (fetch+XHR+click+her tuş+console+cursor+scroll) tek seferde fan-out maliyetinden kurtulur. (b) ve (a) eksenlerinin renderer-main kısmını doğrudan azaltır.
- **Düzeltme yaklaşımı:** post() çıkışını '_' broadcast'ten namespace'li ÖZEL bir kanala taşımak. İki seçenek: (A) MessagePort köprüsü — bridge (ISOLATED) sayfa yüklenirken MAIN'e bir MessagePort transfer eder; interceptor port.postMessage(message) ile YALNIZCA bridge'e gönderir, sayfanın hiçbir 'message' dinleyicisi uyanmaz. (B) Daha cerrahi/düşük-risk ara adım: '_' yerine window.postMessage(message, window.location.origin) — fan-out'u DEĞİŞTİRMEZ (hâlâ aynı pencere) ama asıl kazanç MessagePort'ta. Tercih (A).
  - _Taslak:_ ISOLATED bridge.ts içinde sayfa açılırken: const channel = new MessageChannel(); window.postMessage({source: CAPTURE*BRIDGE_TAG, kind:'PORT_INIT'}, window.location.origin, [channel.port2]); channel.port1.onmessage = (e) => { /* mevcut queue.push + Tier4 gate + batch mantığı \_/ }. MAIN interceptor.ts: bir kez 'message' ile port2'yi yakala (capturePort = e.ports[0]), sonra post() içinde window.postMessage YERİNE capturePort.postMessage(message). Port hazır olana dek küçük bir bootstrap kuyruğu tut (ilk birkaç olay). Böylece structured-clone hâlâ var (kaçınılmaz, payload ≤200KB) ama fan-out ve '\*' tamamen gider. CSP uyumlu (eval/innerHTML yok), MessagePort transferable standart.
  - _Risk:_ Orta. MAIN↔ISOLATED port handshake'in sırası kritik (port gelmeden olay düşmesin → bootstrap kuyruğu). Firefox MAIN-world enjeksiyon yolu (bridge.ts:28-57) port init'i de tetiklemeli. pagehide/visibilitychange flush yolları (bridge.ts:146-149) korunmalı. Mevcut '\*' postMessage'a bağlı hiçbir başka tüketici yok (yalnızca bridge dinliyor) — geri uyum riski düşük.
  - _PRD/gizlilik:_ Gizlilik/bilgi-kaybı çelişkisi YOK — payload AYNI, yalnızca taşıma kanalı değişiyor; hiçbir veri kırpılmıyor/maskeleme değişmiyor. PRD §11.1/§5.3 (CSP) uyumlu: MessageChannel inline script/eval gerektirmez. Aksine GİZLİLİĞİ İYİLEŞTİRİR: '\*' broadcast capture payload'ını (≤200KB gövde, header'lar) sayfanın kendi script'lerine sızdırıyordu; özel kanal bunu kapatır. Bench: yeni bir renderer-bench (Playwright) eklenmeli (proposedBenches A), aksi halde mevcut tsx bench'ler bu yolu görmediği için regresyonu yakalamaz.

### #2 — XHR loadend yolu ana thread'de TAMAMEN SENKRON: responseText materialize + JSON.stringify + post — fetch'in ad53e40'ta aldığı detach optimizasyonunu ALMADI

- **Thread:** `renderer-main` · **Güven:** high · **Efor:** S
- **Mekanizma:** createXhrPatch loadend handler'ı (network-patch.ts:269-306) yield etmeyen tek senkron blok: parseRawHeaders → (rt===''||'text') capText(xhr.responseText) (network-patch.ts:279, responseText getter'ı yanıtın TAMAMINI string'e materialize eder, cap SONUCU slice'lar, text yolunda content-length guard'ı YOK) VEYA (rt==='json') capJsonResponse→JSON.stringify(xhr.response) (network-patch.ts:367) → senkron post() (network-patch.ts:302). Karşıtlık: fetch sayfa Response'unu HEMEN döndürür ve gövdeyi captureResponseBody→readBodyCapped().then(finish) ile DETACHED okur (network-patch.ts:113-122,173,184-212). ad53e40 fetch'i detach etti + XHR'a yalnızca capText/capJsonResponse cap'i ekledi, okuma+stringify+post zincirini senkron loadend'den ÇIKARMADI.
- **Kanıt:** network-patch.ts:269-306 (senkron loadend), :279 (capText(xhr.responseText)), :280→352-372 (capJsonResponse, JSON yolu content-length>1M guard'lı :363; text yolu guard'sız), :302 (senkron post). Fetch detach karşıtlığı: :113-122, :173. Kod yorumu :275-278 'copied 4× on the main thread'. git show ad53e40: önceki kod 'responseBody = xhr.responseText'/'JSON.stringify(xhr.response)' idi → sadece sarmalandı, detach edilmedi. Bench körlüğü: xhr-overhead.bench.ts:116-119 post=no-op; :37 SyntheticXHR.responseText='{"ok":true}' (11 char) — büyük gövde materializasyonunu gizler.
- **Beklenen etki:** XHR-ağır SPA'larda (axios/jQuery/Angular HttpClient) istek başına ana-thread stall'ı keser. Büyük text/JSON yanıtlarda (≤200KB+ veya guard'sız text) ms-mertebesi senkron bloklamayı detached mikrotask'lara taşır. Tipik küçük JSON yanıtlarda kazanç mikrosaniye, ama büyük-yanıt + yüksek-frekans rejiminde belirgin. #1'in tamamlayıcısı (XHR'a özgü ek maliyet).
- **Düzeltme yaklaşımı:** XHR loadend'i fetch ile simetrik yapmak: senkron handler'da yalnızca status/headers/timing'i oku, gövde okuma+cap+post'u detached bir mikrotask'a (queueMicrotask veya Promise.resolve().then) ertelemek. responseText/response erişimi loadend'de senkron mecburi olsa da, capText/JSON.stringify ve post'u yield ettirmek tek-blok stall'ı böler.
  - _Taslak:_ xhr.addEventListener('loadend', () => { const status=xhr.status, statusText=xhr.statusText, rt=xhr.responseType, rawHeaders=xhr.getAllResponseHeaders(); const startedAt=state.startedAt; const dur=Date.now()-startedAt; queueMicrotask(() => { try { const responseHeaders=parseRawHeaders(rawHeaders); let responseBody:string; if(rt===''||rt==='text') responseBody=capText(xhr.responseText); else if(rt==='json') responseBody=capJsonResponse(xhr,responseHeaders); else responseBody=`[non-text responseType: ${rt}]`; post({type:'network.xhr', data:{...}}); } catch {} }); }); — responseText/response loadend sonrası hâlâ erişilebilir (DONE state korunur). Daha agresif: büyük text için TextDecoder-stream yerine doğrudan capText yeterli, ama materializasyonu kaçınmak istenirse responseType='text' yerine 'blob' + stream okuması gerekir (kapsam dışı, gereksiz karmaşık).
  - _Risk:_ Düşük-orta. queueMicrotask loadend'den sonra çalışır; xhr.responseText/response DONE state'te kalıcıdır, erişim güvenli. Tek incelik: post() artık senkron değil, ama zaten fetch de detached — sıra garantisi handleCapture'ın sequenceNumber'ı (service-worker.ts:602) ile değil, batch içi FIFO ile korunur; aynı XHR örneğinde tek post olduğu için yarış yok. Bench: xhr-overhead.bench.ts gövde boyutunu parametrik yapmalı (proposedBenches B).
  - _PRD/gizlilik:_ Gizlilik/bilgi-kaybı çelişkisi YOK — aynı cap (BODY_CAP=200000), aynı maskeleme (SW'de applyMasking değişmez), aynı veri. Yalnızca okuma anı senkron→detached'a kayar. PRD §13.1 fetch/XHR p95<0.5ms gate'i KORUNUR (hatta iyileşir). 'No information loss' §4.1 korunur: detach yalnızca zamanlama, içerik aynı.

### #3 — cursor/scroll recording KAPALIYKEN bile 10Hz+10Hz senkron postMessage('\*') yapar — Tier-4 gate yanlış katmanda (bridge, postMessage'ten SONRA)

- **Thread:** `renderer-main` · **Güven:** high · **Efor:** S
- **Mekanizma:** mousemove (interceptor.ts:346-356) ve scroll (interceptor.ts:358-371) 10Hz throttle'dan sonra recording state'i KONTROL ETMEDEN koşulsuz post()→postMessage çağırır. Tier-4 gate bridge.ts:130'da (ISOLATED, postMessage SONRASI) recording yoksa düşürür — yalnızca sonraki runtime IPC'yi nötrler, renderer-main postMessage clone+fan-out maliyetini DEĞİL. Recording mirror yalnızca ISOLATED'da (bridge.ts:66-83); MAIN'in erişimi yok. Kayıt kapalı (varsayılan) her ön-plan sekmesinde fare/scroll oldukça sürekli ~20Hz saf-israf clone+fan-out.
- **Kanıt:** interceptor.ts:346-356,358-371 (recording kontrolü olmadan post), :337-340 (maliyeti 'one timestamp compare per event' diye hafife alan yorum — throttle'ı GEÇEN olaylar için yanıltıcı), :341-342 (CURSOR/SCROLL_INTERVAL_MS=100). bridge.ts:130 (gate listener içinde, postMessage SONRASI), :66-83 (recording mirror sadece ISOLATED). git: 910bc50 interceptor cursor/scroll'a dokunmadı.
- **Beklenen etki:** Düşük-orta — payload küçük ({x,y}/{scrollX,scrollY}, gövde-boyutuyla ölçeklenmez) ve 10Hz throttle frekansı sınırlar. Ama recording-bağımsız SABİT taban yük: kayıt kapalı her sekmede etkileşim sırasında ~20 clone+fan-out/sn boşa harcanır, #1/#2 üstüne ana thread'i istek dalgalarına kırılganlaştırır. (c)'yi güçlü, (a)'yı kısmen açıklar; (b) ile ölçeklenmez. ROI #1/#2'den düşük ama düzeltme ucuz.
- **Düzeltme yaklaşımı:** Recording state'i MAIN-world'e mirror'layıp post()'tan ÖNCE cursor/scroll'u düşürmek. Altyapı zaten var: service-worker.ts:400 broadcastRecordingState RECORDING_STATE mesajını tab'a yolluyor; bridge bunu dinliyor (bridge.ts:81-83). Aynı bilgiyi MAIN'e ulaştırmak gerekir.
  - _Taslak:_ Eğer #1'in MessagePort köprüsü uygulanırsa: bridge port üzerinden MAIN'e {kind:'RECORDING_STATE', recording} yollar; interceptor bir let recordingActive=false tutar ve mousemove/scroll handler'larında `if (!recordingActive) return;` ile post()'tan ÖNCE düşürür. MessagePort yoksa ara çözüm: bridge.ts'deki RECORDING_STATE listener'ı window.postMessage({source:CAPTURE_BRIDGE_TAG, kind:'REC_MIRROR', recording}, origin) ile MAIN'e iletir; interceptor bunu dinleyip recordingActive'i günceller. interceptor.ts:346/358 throttle'dan SONRA, post()'tan ÖNCE gate. Cursor/scroll capture'ı recording dışında zaten DROP edildiği için bilgi kaybı yok (mevcut davranış aynı, yalnızca daha erken).
  - _Risk:_ Düşük. Davranış değişmiyor (cursor/scroll recording dışında zaten düşüyordu); yalnızca düşme noktası postMessage öncesine alınıyor. SW asleep iken default recordingActive=false güvenli (kayıt zaten yok). #1 ile birlikte yapılırsa neredeyse bedava.
  - _PRD/gizlilik:_ Gizlilik/bilgi-kaybı çelişkisi YOK — Tier-4 zaten recording-only (PRD §6.1.1); recording dışında bu olaylar storage'a hiç girmiyordu. Erken düşürme bilgi kaybı DEĞİL. PRD §6.1.1 Tier-4 semantiği KORUNUR.

### #4 — renderBadge HER capture'da koşulsuz 2 awaited chrome.action IPC + 2×O(N) tarama; CAPTURE_BATCH seri await; storage flushTab 250ms tam-dizi yeniden-yazma — paylaşılan SW/storage çok-sekme amplifikasyonu (sayfa jank'ının DOLAYLI kötüleştiricisi)

- **Thread:** `sw` · **Güven:** medium · **Efor:** M
- **Mekanizma:** handleCapture (service-worker.ts:551-728) capture başına: 4 config await + applyMasking (network için 4× maskBody/maskHeaders tam-gövde regex, service-worker.ts:883-886 + masking.ts:227-228) + getOrCreateSession + smartDetection AÇIK ise readEvents (storage.ts:190-195, O(N) slice tahsisi) + detect (başarısız network'te ~3×O(N) tarama: detection.ts:60-74,92-100,129-136) + queueEvent + renderBadge (service-worker.ts:938-966: 2×O(N) tarama reduce+some + 2 awaited chrome.action IPC, badge değişmese bile). CAPTURE_BATCH bunları SIRAYLA for-await ile işler (service-worker.ts:241-253); SW tek thread, N sekmeden gelen batch'ler birbirini bekler. queueEvent/flushTab her aktif sekme için 250ms'de bir [...persisted,...pending].slice(-max) ile TÜM diziyi yeniden serialize edip chrome.storage.local.set yapar (storage.ts:163-181) — tek backing store'da N-sekme çekişmesi. Recording'de dizi base64 jpeg dataUrl'leri içerir (service-worker.ts:480-488), her flush'ta yeniden yazılır.
- **Kanıt:** service-worker.ts:241-253 (seri for-await), :553-555,690 (4 config await), :883-886 (4 mask çağrısı), :692-693 (readEvents+detect her capture), :719-720 (queueEvent+renderBadge her capture), :938-966 (renderBadge 2 IPC + 2 tarama koşulsuz). storage.ts:163-181 (tam-dizi yeniden yazma), :135-142 (sekme başına ayrı 250ms timer). detection.ts:88-137 (detectCascade filter+sort, countIdenticalFailures filter). masking.ts:227-228 (regex clone + .replace tam gövde). Bench körlüğü: hiçbir bench chrome.storage/chrome.action/çok-sekme SW'ye değmez.
- **Beklenen etki:** Bu yük sayfa thread'ini TEK BAŞINA dondurmaz (SW ayrı process) — denetimde bağımsız kök-neden olarak çürütülme nedeni budur. Ama çok-sekme/çok-istek altında SW'yi boğarak bridge'in sendMessage drenajını yavaşlatır, renderer queue'sunu biriktirir → #1/#2'nin etkisini amplifiye eder. renderBadge'i diff'lemek + detection'ı artımlı yapmak SW CPU'sunu kayda değer düşürür; çok-sekme dolaylı janka katkıyı azaltır.
- **Düzeltme yaklaşımı:** Üç ucuz, bağımsız mikro-düzeltme: (1) renderBadge'i son yazılan değere göre diff'le — text+color değişmediyse chrome.action IPC'lerini atla; ayrıca tabId başına failedCount/hasWarn'ı artımlı güncelle (queueEvent'in döndürdüğü buffer yerine bir sayaç). (2) detection'da readEvents'in döndürdüğü diziyi detect'e geçerken yeni slice tahsisinden kaçın (persistedByTab+pending zaten cache'li; detect'e doğrudan referans ver, mutasyon yok). (3) flushTab yazma sıklığını trafik altında uyarla (250ms sabit yerine, çok-sekme + yüksek trafik tespitinde adaptive backoff) — ama bilgi kaybı OLMADAN, yalnızca yazma penceresini genişleterek.
  - _Taslak:_ renderBadge diff: module-global const lastBadge = new Map<number,{text:string,color:string}>(); renderBadge içinde: const prev=lastBadge.get(tabId); if(prev && prev.text===text && prev.color===color) return; lastBadge.set(tabId,{text,color}); ... (IPC'ler yalnızca değişimde). detection slice: readEvents zaten slice(-max) yapıyor; detect buffer'ı salt-okunur kullanıyor (detection.ts filter'lar yeni dizi üretir), bu yüzden readEvents'i detect-özel bir 'son N salt-okunur görünüm' ile değiştir (kopya yerine). flushTab adaptive: scheduleFlush'a son yazma süresi ölçümü ekle; >X ms sürerse pencereyi 250→500ms büyüt (geçici), trafik düşünce geri al. Hiçbir event DÜŞÜRÜLMEZ, yalnızca daha büyük batch'lerde yazılır.
  - _Risk:_ Düşük-orta. renderBadge diff: kayıt temizleme/clear yollarında lastBadge invalidate edilmeli (clearBadge'de sil). detection görünüm değişikliği: detect'in buffer'ı mutasyona uğratmadığından emin ol (uğratmıyor — saf). flushTab adaptive: en kötü durumda veri 500ms gecikmeyle yazılır; SW eviction riski için pencereyi MV3 ~30s idle sınırının çok altında tut. Bu en riskli düzeltme; #1-3'ten SONRA ve yalnızca gerekirse.
  - _PRD/gizlilik:_ Bilgi-kaybı çelişkisi riski VAR ve kaçınılmalı: flushTab penceresini büyütmek BİLGİ KAYBI DEĞİLDİR (tüm event'ler hâlâ yazılır, sadece daha seyrek) — ama pencere SW eviction'dan önce kapanmalı, yoksa evict olursa pending kaybolur. Bu yüzden adaptive backoff üst sınırı tutucu (≤500ms) ve pagehide/visibilitychange flush (bridge.ts:146-149) korunmalı. renderBadge diff ve detection görünümü bilgi/gizlilik etkilemez (yalnızca CPU). PRD §13.2 250ms flush stratejisiyle hizalı kalır; sapma PRD'de belgelenmelidir (CLAUDE.md kuralı: PRD ile çelişirse aynı PR'da güncelle).

---

## Önerilen Uygulama Sırası

1. ÖNCE #2 (XHR detach, effort S, risk düşük): En hızlı kazanç/risk oranı. fetch'in zaten kanıtlanmış detach desenini XHR'a uygular, yalnızca network-patch.ts'de cerrahi. XHR-ağır SPA'larda (axios/Angular) anında ana-thread stall azaltır. #1 daha büyük olduğu için bunu önce kapatıp hızlı bir kazanç almak mantıklı. Mevcut xhr bench gövde-parametrik hale getirilerek (proposedBenches B) regresyon korunur.

2. SONRA #1 (MessagePort köprüsü, effort M, en büyük etki): Asıl baskın kök-neden. #2'den daha riskli (handshake sırası, Firefox yolu) olduğu için #2'nin verdiği güvenle ve yeni Playwright bench'i (proposedBenches A) hazırlandıktan SONRA yapılmalı — çünkü mevcut tsx bench'ler bu yolu görmez, regresyonu yakalayacak tek şey yeni renderer-bench'tir. Bu, fan-out'u ve '\*' sızıntısını kapatır; tüm capture tiplerine fayda sağlar ve gizliliği de iyileştirir.

3. SONRA #3 (cursor/scroll MAIN-world gate, effort S): #1'in MessagePort altyapısı üzerine neredeyse bedava oturur (recording mirror'ı aynı port'tan akıtılır). #1'den ÖNCE yapılırsa ayrı bir window.postMessage mirror mekanizması gerekir (gereksiz iş); bu yüzden #1'den SONRA. Taban yükü siler.

4. EN SON #4 (SW/storage amplifikasyon mikro-düzeltmeleri, effort M, en riskli): #1-3 renderer-main yükünü düşürdükten sonra ölç — eğer çok-sekme janku hâlâ varsa SW tarafını ele al. renderBadge-diff ve detection-görünümü düşük risk, önce onlar. flushTab adaptive-backoff EN SON ve yalnızca gerekirse (bilgi-kaybı/eviction riski en yüksek olan, PRD §13.2 ile hizalanması gereken). Sıralama gerekçesi: en büyük ve doğrudan sayfa-thread etkisi olan renderer-main düzeltmeleri (1-3) önce; dolaylı amplifikasyon (4) ölçülen ihtiyaca göre sonra. Her adım kendi bench'iyle (B→A→A→C/D) doğrulanır; CLAUDE.md §4 altı CI gate'i (typecheck/lint/format/test/build/bench) her adımda yeşil tutulur.

## Bu Düzeltmelerin ÇÖZMEYECEĞİ Şeyler

- structured-clone'un KENDİSİ kalır: MessagePort fan-out'u ortadan kaldırır ama payload hâlâ çağrı thread'inde (renderer-main) klonlanır (≤BODY_CAP=200000 char/olay). Çok büyük gövdeli, çok yüksek frekanslı istek rejiminde clone CPU'su kalan bir maliyettir — yalnızca worker'a taşıma veya transferable (ArrayBuffer) bunu keser, ki bu büyük bir mimari değişiklik ve PRD kapsamı dışı.
- post() FREKANSI: hiçbir fix istek/etkileşim frekansını azaltmaz (azaltmamalı — capture eksiksizliği PRD gereği). Olay başına maliyet düşer ama saniyede yüzlerce capture üreten patolojik bir sayfa hâlâ kümülatif yük üretir.
- input (her tuş vuruşu) throttle'sız kalır (interceptor.ts:220-260, Tier 2 default-on, throttle YOK): hızlı yazımda her karakter bir post()+clone öder. MessagePort fan-out'u keser ama tuş-başına clone kalır. PRD §6.1.1 Tier 2 input'u listeler; throttle eklemek davranış değişikliği olur, ayrı bir karar.
- Çok-sekme SW tek-thread doğası MV3 mimarisidir — fix'ler SW CPU'sunu azaltır ama tüm sekmelerin tek SW'de seri işlenmesi yapısal kalır. Aşırı sekme (örn. 50+) + aşırı trafik kombinasyonunda SW yine darboğaz olabilir; tam çözüm offscreen document/worker dağıtımı gerektirir (kapsam dışı, aşırı mühendislik).
- chrome.storage.local'ın delta-yazma desteklememesi: flushTab adaptive backoff yazma SIKLIĞINI azaltır ama her yazma hâlâ tüm diziyi serialize eder (amplifikasyon faktörü = dizi_boyutu korunur). Gerçek delta yazma chrome.storage API'sinde yok; per-event ayrı anahtar şeması büyük bir storage-katmanı yeniden tasarımı olur (kapsam dışı).
- Recording modu storage şişmesi (base64 jpeg dataUrl'leri event dizisine inline, service-worker.ts:480-488): bu fix'ler dokunmuyor. dataUrl'leri ayrı storage anahtarlarına (storageRef zaten var, :481) taşıyıp event dizisinden çıkarmak ayrı bir iş; recording opsiyonel olduğu ve semptomun zorunlu koşulu olmadığı için önceliklendirilmedi.

## Önerilen Bench / Repro

- A) BİRİNCİL — renderer-main postMessage clone + sayfa-handler fan-out bench'i (gerçek Chromium gerektirir, mevcut tsx bench'lerin kör noktasını kapatır): Playwright/puppeteer ile headless Chromium aç, boş sayfaya interceptor.ts'i MAIN-world'e enjekte et. Sayfaya D adet (0, 5, 20) gürültü 'message' dinleyicisi ekle (her biri JSON.parse + küçük iş). window.fetch'i N=2000 kez, gövde G ∈ {1KB,50KB,200KB} ile çağır. PerformanceObserver('longtask') ile toplam longtask süresini topla + post()→postMessage etrafını performance.mark ile ölç. İddia/gate: toplam main-thread block G ve D ile DOĞRUSAL artmalı; D=20,G=200KB,N=2000'de bir bütçe belirle. MessagePort fix'i sonrası D ekseni DÜZLEŞMELİ (fan-out gitti). Bu tek bench #1'in hem mekanizmasını hem fix'in regresyonunu yakalar.

- B) XHR senkron loadend bench'i (atlanmış detach'i ifşa eder): xhr-overhead.bench.ts'i SyntheticXHR.responseText'i parametrik G ∈ {1KB,200KB,2MB} gerçek string yapacak ve responseType='json' için büyük gerçek obje koyacak şekilde genişlet. no-op post yerine post içinde JSON.parse(JSON.stringify(capture)) ile structured-clone proxy'si ölç (Node'da postMessage yok, clone maliyetini yaklaşık temsil). İddia/gate: mevcut senkron loadend maliyeti G ile ölçeklenir ve fetch'in (detached) profilinden belirgin ayrışır; detach fix'i sonrası XHR delta'sı fetch delta'sına yaklaşmalı. Mevcut bench deseni (tsx) korunur.

- C) SW capture-başına O(N) + IPC bench'i (saf fonksiyon, mevcut desene uyar): detect()+renderBadge tarama fazını izole ölç. N ∈ {50,200,500,2000} buffer kur, değişen oranda isFailedNetwork olayı koy, chrome.action'ı mock no-op yap. İddia/gate: başarısız-network capture'da maliyet ~5×O(N) (3 detection + 2 badge tarama); N=2000'de capture başına maliyet patlar. renderBadge-diff + detection-görünüm fix'i sonrası O(N) tarama sayısı düşmeli. chrome.action IPC sayısını (diff öncesi=2/capture, sonrası≈0 değişmeyen badge'de) ayrı say.

- D) Çok-sekme storage yazma amplifikasyonu bench'i: chrome.storage.local'ı in-memory mock'la (set'te JSON.stringify(value).length'i 'yazılan bayt' say + serialize süresi ölç). T ∈ {1,5,20} sekme, her sekmede sürekli trafik (queueEvent + 250ms flushTab). İddia/gate: yazılan bayt/sn = T × (max × event_boyutu)/0.25s; amplifikasyon faktörü = dizi_boyutu (tek yeni event tüm diziyi yeniden yazar). flushTab adaptive-backoff fix'i sonrası bayt/sn üst sınırı düşmeli.

- EN HIZLI TEK REPRO (semptomun üçünü birden deterministik üretir): Playwright ile 5 sekme aç, her sekmede 5 sayfa-message-dinleyicisi + sürekli 200KB-gövdeli fetch döngüsü (10/sn) çalıştır. Tüm sekmelerde PerformanceObserver('longtask') toplamını ölç (a+b). Sonra eklentiyi kaldır (chrome.management veya unpacked dizinini kaldır), aynı yükü tekrarla → longtask ≈ 0'a düşmeli (c). Mevcut tsx bench'ler yeşilken bu repro jank'ı gösterir — 'bench yeşil ama jank' çelişkisini kanıtlar ve fix'ler sonrası longtask toplamının düştüğünü doğrular.

---

## Denetçi (Critic) Notları

**Tek seçilecek kök-neden:** If exactly one thing is fixed, fix interceptor.ts:28-39 / :35 — post() does an UNCONDITIONAL synchronous window.postMessage(message, '_') on every captured event, on the page's renderer main thread (manifest world:MAIN, manifest.json:25-29). I verified all capture sites funnel through post(): fetch (network-patch.ts:110), XHR (network-patch.ts:302), click (interceptor.ts:68), every keystroke (interceptor.ts:254, NO throttle/debounce — confirmed), console x3 (104/128/152), unhandled (128/152), SPA-nav (209), longtask (309), CLS (323), cursor (353), scroll (368). The v0.6.2 batch and Tier-4 gate both live in bridge.ts (ISOLATED world, lines 99-142 and :130) — i.e. AFTER the postMessage has already paid its structured-clone + same-window fan-out cost. git show 910bc50 confirms it did NOT touch interceptor.ts (empty diff), so the postMessage was never optimized. bridge.ts:124 (`if (event.source !== window) return`) proves the message IS delivered to the page's own window 'message' listeners (the bridge must filter them out). No MessageChannel/MessagePort/transferable exists anywhere (grep confirmed) — it is the real structured-clone path, not a cheap transfer. This single mechanism is the only one that explains all three symptom conditions on the thread where page jank actually originates: (b) more requests => post() frequency scales 1:1 with request rate, clone cost scales with body size (≤BODY_CAP=200000, capture-limits.ts:13); (a) more tabs => each renderer independently pays this (and the shared SW amplifies it); (c) uninstall => MAIN-world patches + postMessage vanish, jank stops instantly. The recommended fix (MessagePort private channel) eliminates the fan-out and the '_' broadcast (which also closes a real privacy leak: ≤200KB capture payloads are currently broadcast to the page's own scripts), without changing payload, masking, or storage — PRD-compliant.

**Nihai karar (high):** REAL FINDING with one materially under-weighted blind spot and one over-stated confidence claim. The synthesis's rank-1 root cause (unconditional renderer-main postMessage before the gate/batch) and rank-2 (XHR synchronous loadend vs fetch's detached read) are both code-verified and correct; ad53e40's diff literally shows XHR got only capText/capJsonResponse wrapping while fetch got captureResponseBody detach, with the comment 'copied 4x on the main thread.' Rank-3 (cursor/scroll gate in wrong layer) and rank-4 (shared-SW/storage amplification as INDIRECT page-jank contributor, not standalone cause) are correct and correctly ranked. The bench-blindness thesis is fully confirmed: both fetch and xhr benches pass `() => {}` as the no-op post (verified line-for-line), so postMessage clone, runtime IPC clone, page-listener fan-out, multi-tab SW contention, and chrome.storage full-array rewrite are ALL unmeasured. However: (1) The synthesis dismissed the sidepanel as 'only relevant when the panel is open' and never connected it to its own SW-saturation amplification axis. In fact sidepanel.ts:866-879 AND popup.ts:124-135 send GET_EVENTS every 1000ms; the SW responds via readEvents (service-worker.ts:257-261) which synchronously structured-clones the ENTIRE ≤200-event buffer (containing base64 screenshots when recording) back to the panel ON THE SW THREAD every second per open panel. The render-skip signature gate (sidepanel.ts:873) skips only the DOM render, NOT the IPC or the SW-side clone — so an open side panel is a continuous 1-Hz SW-thread load source the synthesis missed. This belongs in rank-4's mechanism. (2) The rank-1 'high confidence' that page-listener fan-out DOMINATES plain clone cost is asserted, not proven — fan-out magnitude is a per-page runtime property (how many 'message' listeners the page registers) that no code in this repo can establish, and no renderer bench exists to measure it. The mechanism is real and sound; its claimed dominance over bare clone cost is the one unproven leap. Net: the analysis is actionable and the fix ordering is sound, but it should add the sidepanel/popup 1-Hz GET_EVENTS poll to the SW-amplification root cause and soften rank-1's dominance claim to 'mechanism certain, magnitude page-dependent and unmeasured.'

---

## Hipotez İstatistikleri

- Hayatta kalan kök-neden: **3**
- Çürütülen hipotez: **4**
- Kümeleme sırasında elenen: **25**

### Nicel Ölçüm Özeti

**perRequestMainThreadCost:**

RENDERER ANA THREAD — bir fetch/XHR başına model (kod ile doğrulandı):

== fetch (network-patch.ts:37-130) ==
SENKRON ana-thread işi (post ÇAĞRILMADAN ÖNCE):

- serializeBody(request body) (network-patch.ts:54/59,374-394) — string/FormData/URLSearchParams için capText'e kadar O(istek_gövdesi), Blob/ArrayBuffer için O(1) metadata.
- headersToObject(request + response) (network-patch.ts:53,85,330-344) — header sayısıyla O(h), 2 obje.
  Gövde okuması DETACHED (network-patch.ts:113-122 captureResponseBody → readBodyCapped) — ana thread'i bloklamaz ama decode/string-concat ana thread MİKROTASK'larında çalışır (network-patch.ts:198-208).
  finish()→post() (network-patch.ts:110) detached promise'te çalışır → 1 adet window.postMessage.

structured-clone SAYISI: fetch başına TAM 1 window.postMessage (interceptor.ts:35), clone girdisi = NetworkFetchData (request {method,url,headers,body≤200KB} + response {status,statusText,headers,body≤200KB} + timing + error). En kötü clone boyutu ≈ 2×BODY_CAP = ~400KB karakter + header'lar.

== XHR (network-patch.ts:261-309) — ATLANMIŞ DÜZELTME ==
loadend handler TAMAMEN SENKRON ve ana thread'de (network-patch.ts:269-306), fetch'in detach optimizasyonu YOK:

- parseRawHeaders(getAllResponseHeaders()) (network-patch.ts:271,521-532) — O(header).
- responseType ''/'text': capText(xhr.responseText) (network-patch.ts:279) — responseText erişimi tüm gövdeyi materialize eder, sonra slice → O(tam_yanıt) senkron ana-thread.
- responseType 'json': capJsonResponse → JSON.stringify(xhr.response) (network-patch.ts:280,367) — content-length>1MB değilse senkron O(≤1MB) stringify.
- ardından SENKRON post() (network-patch.ts:302) → 1 window.postMessage, clone ≈ 2×BODY_CAP.

== HER capture'da ortak: window.postMessage(message,'_') (interceptor.ts:35) ==
Chromium'da çağıran thread'de (renderer-main) SENKRON structured-clone + targetOrigin '_' olduğu için mesaj SADECE bridge'e değil SAYFANIN KENDİ tüm 'message' dinleyicilerine de senkron iletilir (analytics/router/RPC). Yani fetch/XHR başına gerçek ana-thread maliyeti = 1 structured-clone (≤~400KB) + sayfanın D adet message-handler'ının senkron uyandırılması. İstek-yoğun SPA'da bu, istek frekansı × (clone + D handler) ile ölçeklenir.

== chrome.action IPC SAYISI (renderer'da DEĞİL — SW'de) ==
Bir fetch/XHR başına renderer'dan chrome.action IPC = 0. Ama SW'de handleCapture başına renderBadge HER capture'da 2 adet awaited chrome.action.\* IPC yapar (setBadgeText + setBadgeBackgroundColor, service-worker.ts:961-962) — badge değişmese bile. Yani capture başına 2 SW→browser IPC + capture başına 1 renderer→SW IPC payı (250ms batch ile amortize, en kötü 1/50 batch).

== SW tarafı capture başına (service-worker.ts:687-720) ==
smartDetection AÇIK (varsayılan): readEvents(tabId) → [...persisted,...pending].slice(-200) yeni dizi tahsisi (storage.ts:190-195) + detect(). Başarısız network olayında buffer 3× O(N) taranır (detection.ts: detectCascade filter+sort 92-100, countIdenticalFailures filter 129-136, + ana akış isFailedNetwork). renderBadge ayrıca 2× O(N) tarar (reduce 942 + some 943). N ≤ maxEventsPerTab (200, ayarla 2000). Yani başarısız network capture başına SW: ~5×O(N) tarama + O(N) dizi tahsisi + 2 chrome.action IPC + applyMasking (network olayları için ≤4×200K karakter regex, masking.ts:227-233).

**perFlushCost:**

İKİ AYRI "flush" var; karıştırılmamalı:

== (1) bridge CAPTURE_BATCH flush (renderer→SW IPC, bridge.ts:99-121) ==
BATCH_FLUSH_MS=250, BATCH_MAX=50 (bridge.ts:91,94). Bir batch IPC'sinde structured-clone girdisi = QueuedCapture[] (≤50 öğe), her öğe bir RawCapture (network olayı için ≤2×BODY_CAP gövde taşıyabilir).
EN KÖTÜ DURUM clone boyutu = BATCH_MAX × (2×BODY_CAP) = 50 × 400.000 = ~20.000.000 karakter (~20M char ≈ on MB'lar) TEK runtime IPC structured-clone'unda. Pratikte erken flush (queue≥50) bunu sınırlar ama üst sınır budur. Bu, chrome.runtime.sendMessage'in çağıran thread'inde (renderer-main) senkron klonlanır → tek seferde devasa ana-thread stall riski.
NOT: Bu clone, interceptor.ts:35'teki olay-başına postMessage clone'una EKTİR (her olay zaten bir kez bireysel olarak klonlandı); batch ikinci bir toplu clone ekler.

== (2) storage flushTab (SW→disk, storage.ts:150-182) ==
Sekme başına AYRI 250ms zamanlayıcı (scheduleFlush, storage.ts:135-142, flushTimerByTab Map). Her flush:

- nextEvents = [...persisted, ...pending].slice(-max) (storage.ts:164) — TÜM diziyi (≤max=200/2000 eleman) yeniden inşa eder, tek yeni event için bile.
- chrome.storage.local.set({[eventsKey]: nextEvents}) (storage.ts:180) — TÜM diziyi (gövdeler + recording'de base64 screenshot dataUrl'leri dahil) yeniden serialize+yazar. KLASİK YAZMA AMPLİFİKASYONU.
  EN KÖTÜ DURUM yazılan bayt/flush = max × (event başına ≤BODY_CAP=200KB) = 200 × 200KB = ~40MB (recording'de screenshot dataUrl'leriyle daha da fazla). N sekme = N paralel 250ms zamanlayıcı, hepsi TEK chrome.storage.local backing store'unda (storage.ts:20-25) serialize edilir → çekişme; SW thread'i doygunlaşır → CAPTURE_BATCH sıralı await döngüsü (service-worker.ts:241-253) yavaşlar → bridge IPC drenajı gecikir → renderer queue birikir.
  Ek: archiveSession (storage.ts:231-252) tab kapanışında archives/recent TEK anahtarına tüm geçmiş oturumları biriktirip tamamını yeniden yazar — ikinci amplifikasyon.

**perRequestMainThreadCostConfirmed:**

true

**benchesCoverRealPath:**

```json
false
```

**benchGapAnalysis:**

Bench'ler GERÇEK hot-path'i ölçMÜYOR. Dört bench de tsx/Node ile, gerçek renderer/Chrome runtime DIŞINDA çalışır ve en pahalı zincir adımlarını ölçüm dışı bırakır:

1. post() = NO-OP. fetch-overhead.bench.ts:76-78 ve xhr-overhead.bench.ts:117-119 createFetchPatch/createXhrPatch'e BOŞ post geçirir ('no-op post — benchmarking call overhead, not the bridge'). Yani interceptor.ts:35'teki window.postMessage'in SENKRON structured-clone'u VE sayfanın kendi 'message' dinleyicilerinin uyandırılması — gerçek semptomun birincil kaynağı — HİÇ ölçülmez. Bench yalnızca wrapper'ın saf CPU call-overhead'ını (p95<0.5ms) ölçer.

2. XHR bench'i yanıltıcı şekilde yeşil. SyntheticXHR.responseText sabit '{"ok":true}' (11 char) (xhr-overhead.bench.ts:37). Gerçek atlanmış maliyet — loadend'de capText(xhr.responseText) full-body materialize + JSON.stringify(xhr.response) SENKRON ana-thread (network-patch.ts:279-280) — büyük gövdeyle ölçeklenir; 11-char örnek bunu gizler. fetch detach edildi ama XHR EDİLMEDİ; bench bu farkı göremez.

3. Hiçbir bench chrome.runtime.sendMessage IPC clone'unu (bridge batch, ≤20M char/batch) ölçmez — Node'da chrome yok.

4. Hiçbir bench chrome.storage.local'a değmez → storage.ts:180'deki 250ms tam-dizi yeniden-yazma amplifikasyonu (≤40MB/flush/sekme), N-sekme tek-store çekişmesi, recording base64 screenshot şişmesi ölçülmez.

5. Hiçbir bench SW-tarafı capture-başına maliyeti ölçmez: detection'ın readEvents+3×O(N) buffer taraması (detection.ts:60-74,92-100,129-136), renderBadge'in 2×O(N) tarama + 2 chrome.action IPC'si (service-worker.ts:942-962), CAPTURE_BATCH'in seri 50'li await döngüsü (service-worker.ts:241-253). masking-cost.bench.ts sabit 4KB tek gövde ölçer (masking-cost.bench.ts:54-87) — capture başına ≤4×200K karakterlik regex geçişini (masking.ts:227-233) ve çok-sekme SW çekişmesini temsil etmez.

6. filter-1000.bench.ts capture hot-path'iyle ALAKASIZ — yalnızca panel açıkken sidepanel filtre fazını ölçer (filter-1000.bench.ts:11-19,93-108); HTML/DOM fazı jsdom gerektirdiği için ertelenmiş.

SONUÇ: 'bench yeşil' ile 'gerçek jank' çelişkisi yok — bench'ler yanlış katmanı (izole saf-fonksiyon CPU) ölçüyor; semptomu üreten katman (renderer-main postMessage clone + sayfa-handler uyandırma + SW seri işleme + storage yazma amplifikasyonu + çok-sekme tek-SW/tek-store çekişmesi) tamamen ölçüm boşluğunda.

**proposedRepro:**

DETERMİNİSTİK REPRO/BENCH ÖNERİLERİ (her biri ölçüm boşluğunu kapatır, mevcut tsx+izole-fonksiyon desenini koruyarak):

== A) renderer-main postMessage clone + sayfa-handler uyandırma bench'i (BİRİNCİL) ==
Gerçek renderer gerektirir → bench'i happy-dom/jsdom yerine Playwright (devDeps'te zaten happy-dom var ama postMessage clone'unu simüle etmez; gerçek Chromium şart) ile çalıştır. Adımlar:

1. Playwright ile headless Chromium aç, boş sayfaya interceptor.ts'i MAIN-world'e enjekte et.
2. Sayfaya D adet (örn. 0, 5, 20) gürültü 'message' dinleyicisi ekle (gerçek SPA'yı taklit: her biri JSON.parse + küçük iş yapsın).
3. window.fetch'i N=2000 kez, gövde boyutu G ∈ {1KB, 50KB, 200KB} ile çağır.
4. performance.now() ile post()→postMessage'in ana-thread'i bloklama süresini ölç (interceptor.ts:35 etrafına işaretle) VE PerformanceObserver('longtask') ile toplam longtask süresini topla.
5. İddia: ana-thread engellemesi G ve D ile DOĞRUSAL artmalı; bu, mevcut p95<0.5ms gate'inin gizlediği maliyeti gösterir. Gate olarak: D=20, G=200KB, N=2000'de toplam main-thread block bütçesi belirle.

== B) XHR senkron loadend bench'i (ATLANMIŞ DÜZELTMEYİ ifşa eder) ==
xhr-overhead.bench.ts'i SyntheticXHR.responseText'i parametrik G boyutunda (1KB→200KB→2MB) gerçek bir string yapacak ve responseType='json' için büyük gerçek obje koyacak şekilde genişlet. no-op post yerine post içinde JSON.parse(JSON.stringify(capture)) ile bir structured-clone proxy'si ölç (Node'da postMessage yok ama clone maliyeti yaklaşık temsil edilir). İddia: capText(responseText)+JSON.stringify senkron maliyeti G ile ölçeklenir ve fetch'in (detached) maliyetinden belirgin ayrışır → XHR'a detach uygulanması gerektiğini sayısal kanıtlar.

== C) çok-sekme storage yazma amplifikasyonu bench'i ==
chrome.storage.local'ı bellekte sahte (in-memory) bir store ile mock'la (set'te JSON.stringify(value).length'i 'yazılan bayt' olarak say ve serialize süresini ölç). T ∈ {1,5,20} sekme, her sekmede sürekli trafik simüle et (queueEvent + 250ms flushTab). İddia: toplam yazılan bayt/saniye = T × (max × event_boyutu) / 0.25s şeklinde ölçeklenmeli; tek yeni event'in tüm diziyi yeniden yazdığını (amplifikasyon faktörü = dizi_boyutu) sayısal göster. Gate: bayt-yazma amplifikasyon oranı için üst sınır.

== D) SW capture-başına O(N) bench'i (saf fonksiyon, mevcut desene uyar) ==
detect() + renderBadge'in tarama maliyetini izole ölç: N ∈ {50,200,500,2000} elemanlı buffer kur, içine değişen oranda isFailedNetwork olayı koy, capture başına detect()+renderBadge-tarama-fazını (chrome.action IPC'yi mock no-op yaparak) timele. İddia: başarısız-network capture'da maliyet ~5×O(N) (3 detection taraması + 2 badge taraması); N=2000'de capture başına maliyet patlar. Bu, smartDetection ve renderBadge'in her capture'da O(N) çalışmasının çok-istek senaryosundaki SW boğulmasına katkısını gate'ler.

EN HIZLI TEK REPRO (semptomun üçünü birden gösterir): Playwright ile 5 sekme aç, her sekmede 5 sayfa-message-dinleyicisi + sürekli 200KB-gövdeli fetch döngüsü (10/sn) çalıştır; ana-thread longtask toplamını ölç. Sonra eklentiyi kaldır, aynı yükü tekrarla, longtask ≈ 0'a düşmeli. Bu (a) çok-sekme, (b) çok-istek, (c) kaldırınca düzelme koşullarını deterministik üretir ve mevcut bench'lerin yeşil kalmasına rağmen jank'ı gösterir.

**estimates:**

```json
[
  {
    "scenario": "Tek fetch/XHR, küçük gövde (~1KB), sayfada 0 ek message-dinleyici",
    "estimate": "Renderer ana-thread: 1 window.postMessage structured-clone (~1KB) + wrapper CPU. Mevcut bench'in ölçtüğü saf wrapper overhead'ı muhtemelen p95<0.5ms içinde (gerçekten). Bu rejimde semptom YOK — kullanıcının (b) 'çok istek' koşulu sağlanmıyor.",
    "assumptions": "Clone maliyeti gövde boyutuyla ~doğrusal; küçük gövdede ihmal edilebilir. interceptor.ts:35 tek clone, fetch için detached gövde (network-patch.ts:113-122)."
  },
  {
    "scenario": "XHR, büyük gövde (~200KB), responseType text/json",
    "estimate": "Renderer ana-thread SENKRON: capText(responseText) full-body materialize+slice (~200K char) VEYA JSON.stringify(≤1MB) + ardından 1 postMessage clone (~200K char). fetch'in aksine HİÇ detach yok (network-patch.ts:269-306). Tek XHR'da bile ms-mertebesi senkron stall; saniyede onlarca böyle XHR (ağır SPA) → kümülatif yüzlerce ms ana-thread bloklama = gözle görülür jank. ATLANMIŞ DÜZELTME.",
    "assumptions": "responseText erişimi tüm gövdeyi materialize eder (tarayıcı davranışı). JSON.stringify O(girdi). content-length≤1MB ise stringify atlanmaz (network-patch.ts:363-368)."
  },
  {
    "scenario": "Ağır SPA: sayfada D=10-20 kendi 'message' dinleyicisi (router/analytics/RPC), 10 istek/sn",
    "estimate": "Her capture'da window.postMessage(,'*') (interceptor.ts:35) sayfanın D dinleyicisinin TÜMÜNÜ senkron uyandırır. Renderer ana-thread maliyeti ≈ istek_frekansı × (clone + D×handler_işi). D=20'de bu, capture başına maliyeti ~20× çoğaltır → kuadratik-benzeri hissedilen yavaşlama. Bench post()=no-op olduğu için bu maliyet TAMAMEN ölçüm dışı.",
    "assumptions": "targetOrigin '*' tüm same-window dinleyicilere iletir (Chromium semantiği). Sayfa handler'ları önemsiz olmayan iş yapar (gerçekçi)."
  },
  {
    "scenario": "Bir bridge CAPTURE_BATCH flush, en kötü durum (50 network olayı, her biri ~400KB)",
    "estimate": "Tek chrome.runtime.sendMessage structured-clone girdisi = BATCH_MAX × 2×BODY_CAP = 50 × 400.000 ≈ 20.000.000 karakter (~on MB'lar). Renderer ana-thread'inde tek seferde senkron klonlanır (bridge.ts:115). Bu, olay-başına postMessage clone'larına EK. Tek bir bu flush bile uzun bir longtask üretebilir.",
    "assumptions": "Her network olayı request+response gövdesinde ~200KB taşıyor (üst sınır). Pratikte erken flush ve daha küçük gövdeler bunu düşürür; bu teorik tavan."
  },
  {
    "scenario": "Bir storage flushTab, max=200, ortalama 50KB/event",
    "estimate": "Tek yeni event için bile [...persisted,...pending].slice(-200) (storage.ts:164) + chrome.storage.local.set tüm 200-elemanlı diziyi yeniden serialize+yazar (storage.ts:180). Yazılan bayt ≈ 200 × 50KB = ~10MB her 250ms = ~40MB/sn/sekme. Amplifikasyon faktörü ≈ 200 (dizi boyutu). SW thread'i serialize ile doygunlaşır.",
    "assumptions": "chrome.storage.local kısmi/delta yazma desteklemez → tam-dizi yeniden yazma zorunlu. Gövde boyutu BODY_CAP=200KB'a kadar değişken; 50KB ortalama varsayımı."
  },
  {
    "scenario": "5 sekme açık + her sekmede 10 istek/sn (kullanıcının a+b koşulu)",
    "estimate": "Renderer tarafı: her sekme bağımsız renderer'da 10/sn × (postMessage clone + sayfa-handler uyandırma) öder — sekme-içi jank. SW tarafı (TEK paylaşılan thread): 5×10=50 capture/sn, her biri seri await handleCapture (service-worker.ts:241-253); her capture'da readEvents+detect (başarısızsa ~5×O(N=200)) + renderBadge 2 chrome.action IPC + queueEvent. Storage: 5 paralel 250ms flush, 5×~40MB/sn tek store'da serialize → çekişme. SW boğulur → IPC drenajı gecikir → renderer queue birikir → tüm sekmelerde kümülatif kasılma. Eklenti kaldırılınca yamalar+IPC+SW işleme biter → ANINDA düzelir (c).",
    "assumptions": "SW tek process (MV3). chrome.storage.local tek backing store (storage.ts:20-25). Sekmeler arası paralellik yok; batch'ler tek SW thread'inde serialize. Bu, üç semptom koşulunu da (a+b+c) birden açıklayan tek tutarlı model."
  },
  {
    "scenario": "Recording AÇIK + çok sekme",
    "estimate": "Her kayıttaki sekme 2sn'de bir base64 JPEG (yüzlerce KB) üretir (service-worker.ts:445-489), queueEvent ile 200'lük diziye girer ve HER 250ms flush'ta tüm screenshot'larla birlikte yeniden yazılır (storage.ts:180). Flush boyutu MB'lardan on-MB'lara çıkar. Opsiyonel (a+b'ye bağlı değil) ama açıksa storage amplifikasyonunu katlar.",
    "assumptions": "Screenshot dataUrl event'e inline gömülür (service-worker.ts:474-488). Recording semptomun zorunlu koşulu değil; kötüleştirici faktör."
  }
]
```
