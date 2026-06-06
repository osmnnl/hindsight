// PRD §14 — i18n message catalog.
//
// Keys are dot-separated and grouped by UI surface (settings / popup /
// sidepanel / background). English is the canonical source: when a TR
// translation is missing the runtime falls back to EN, then to the raw
// key, so a half-translated key never produces a blank UI element.
//
// New strings: add the key under en first, then mirror under tr.
// `MessageKey` is derived from the EN table so missing-in-TR is a runtime
// fallback (not a type error) per PRD §14.3.
//
// Variable substitution: literal `{name}` tokens are replaced by t(key,
// { name: value }). Unknown placeholders pass through verbatim so a typo
// in the call site is visible during dev.

import type { Locale } from './types';

const en = {
  // — Common —
  'common.cancel': 'Cancel',
  'common.save': 'Save',
  'common.delete': 'Delete',
  'common.remove': 'Remove',
  'common.add': 'Add',
  'common.refresh': 'Refresh',
  'common.close': 'Close',
  'common.copy': 'Copy',
  'common.copied': 'Copied',
  'common.reset': 'Reset',
  'common.confirm': 'Confirm',
  'common.any': 'Any',
  'common.empty': '—',
  'common.calculating': 'Calculating…',

  // — Settings: shell —
  'settings.title': 'Hindsight Settings',
  'settings.subtitle': 'Privacy-first defaults — captures stay on your machine.',
  'settings.nav.general': 'General',
  'settings.nav.privacy': 'Privacy',
  'settings.nav.capture': 'Capture',
  'settings.nav.detection': 'Detection',
  'settings.nav.sharing': 'Sharing',
  'settings.nav.advanced': 'Advanced',

  // — Settings: General —
  'settings.general.heading': 'General',
  'settings.general.theme.label': 'Theme',
  'settings.general.theme.system': 'Match system',
  'settings.general.theme.light': 'Light',
  'settings.general.theme.dark': 'Dark',
  'settings.general.theme.hint': 'Affects the popup, side panel, and settings page.',
  'settings.general.language.label': 'Language',
  'settings.general.language.en': 'English',
  'settings.general.language.tr': 'Türkçe',
  'settings.general.language.hint':
    'Changes apply immediately across the popup, side panel, and this settings page.',

  // — Settings: Privacy —
  'settings.privacy.heading': 'Privacy',
  'settings.privacy.lead':
    'Masking happens at capture time — the original value is never written to storage (<code>PRD §11.2</code>).',
  'settings.privacy.defaultRules.heading': 'Default rules',
  'settings.privacy.defaultRules.hint':
    'Click a chip to disable that rule for future captures. Disabled rules stay disabled until you re-enable them — already-captured masked values are not affected (PRD §11.2: mask cannot be reversed). Form-field rules cannot be disabled.',
  'settings.privacy.defaultRules.warn':
    '⚠ Captures recorded with a rule disabled will store the matched value verbatim on your machine and include it verbatim in any bug report you share.',
  'settings.privacy.defaultRules.groupHeaders': 'Headers',
  'settings.privacy.defaultRules.groupBodies': 'Bodies',
  'settings.privacy.defaultRules.groupFormFields': 'Form fields',
  'settings.privacy.defaultRules.tooltipScope': 'scope: {scope}',
  'settings.privacy.defaultRules.tooltipToggle': 'scope: {scope} — click to {action}',
  'settings.privacy.defaultRules.actionEnable': 'enable',
  'settings.privacy.defaultRules.actionDisable': 'disable',
  'settings.privacy.customPatterns.heading': 'Custom body patterns',
  'settings.privacy.customPatterns.hint':
    'Regex applied to request and response bodies. Empty by default — add only what your own captures need.',
  'settings.privacy.customPatterns.add': '+ Add pattern',
  'settings.privacy.customPatterns.empty':
    'No custom patterns yet. Click <strong>Add pattern</strong> to start.',
  'settings.privacy.customPatterns.labelPlaceholder': 'My API token',
  'settings.privacy.customPatterns.regexPlaceholder': '\\bsk_live_[A-Za-z0-9]+\\b',
  'settings.privacy.customPatterns.invalidRegex': 'invalid regex — saved but not applied',
  'settings.privacy.customPatterns.applyRequest': 'Apply to request bodies',
  'settings.privacy.customPatterns.applyResponse': 'Apply to response bodies',
  'settings.privacy.origins.heading': 'Never capture on these origins',
  'settings.privacy.origins.hint':
    'Exact origin match (scheme + host + port). Events from these origins are dropped before they hit storage.',
  'settings.privacy.origins.placeholder': 'https://internal.example.com',
  'settings.privacy.origins.add': '+ Add',
  'settings.privacy.origins.empty': 'No origins blocked.',
  'settings.privacy.origins.removeAria': 'Remove {origin}',
  'settings.privacy.origins.invalid': 'Enter a full URL (https://host:port).',
  'settings.privacy.sandbox.heading': 'Test sandbox',
  'settings.privacy.sandbox.hint':
    'Paste a sample body, pick a rule, see what would be masked. Nothing here is saved.',
  'settings.privacy.sandbox.rule': 'Rule',
  'settings.privacy.sandbox.scope': 'Scope',
  'settings.privacy.sandbox.input': 'Sample input',
  'settings.privacy.sandbox.inputPlaceholder': 'Paste a JSON body, header value, or any string...',
  'settings.privacy.sandbox.output': 'Masked output',
  'settings.privacy.sandbox.defaultOption': 'Default · {label}',
  'settings.privacy.sandbox.customOption': 'Custom · {label}',
  'settings.privacy.sandbox.customNoLabel': '(no label)',
  'settings.privacy.sandbox.customFallback': 'Custom pattern',
  'settings.privacy.sandbox.scopeMismatch':
    'Rule does not apply to {scope} (scope is {ruleScope}).',
  'settings.privacy.sandbox.matchesOne': '{n} match masked.',
  'settings.privacy.sandbox.matchesMany': '{n} matches masked.',

  // — Settings: Capture —
  'settings.capture.heading': 'Capture',
  'settings.capture.lead':
    'Pick which event families Hindsight records and how big the per-tab buffer is. Tier 1 events (network requests, navigations, errors) cannot be disabled (<code>PRD §6.1.1</code>).',
  'settings.capture.tier2.heading': 'Tier 2 events',
  'settings.capture.tier2.hint':
    'Clicks, form input changes, WebSocket frames, console.warn / console.info. Disabling stops new captures only — existing buffer stays intact.',
  'settings.capture.tier2.toggle': 'Capture Tier 2 events',
  'settings.capture.tier3.heading': 'Tier 3 events',
  'settings.capture.tier3.hint':
    'Performance long tasks (>100 ms) and layout shifts. Screenshots on error stay on regardless of this toggle.',
  'settings.capture.tier3.toggle': 'Capture performance long tasks + layout shifts',
  'settings.capture.categories.heading': 'Show in side panel',
  'settings.capture.categories.hint':
    'Default event categories shown in the side panel. A side panel can override this per-tab; this is the starting point for newly-opened panels.',
  'settings.capture.categories.network': 'HTTP requests (fetch / XHR)',
  'settings.capture.categories.realtime': 'WebSocket / SSE',
  'settings.capture.categories.console': 'Console (errors, warnings, info)',
  'settings.capture.categories.navigation': 'Navigations',
  'settings.capture.categories.action': 'User actions (clicks, input, recording)',
  'settings.capture.categories.performance': 'Performance (long tasks, layout shifts)',
  'settings.capture.categories.screenshot': 'Screenshots',
  'settings.capture.buffer.heading': 'Per-tab buffer',
  'settings.capture.buffer.hint':
    'Rolling FIFO buffer. When full, the oldest event drops to make room. Closed tabs move to a 7-day archive (read-only until M3 ships the side panel).',
  'settings.capture.buffer.label': 'Maximum events per tab',
  'settings.capture.buffer.defaultSuffix': '(default)',

  // — Settings: Detection —
  'settings.detection.heading': 'Detection',
  'settings.detection.lead':
    'Hindsight watches captures for failed-request cascades, slow requests, and white-screen-after-navigation patterns (<code>PRD §6.2.1</code>). Surfaces them as colored flags in the side panel; optional desktop notifications for high-severity events.',
  'settings.detection.smart.heading': 'Smart detection',
  'settings.detection.smart.hint':
    'When off, no detection rules run and no flags get stamped — the side panel still lists events but the cluster grouping and left-border tints disappear.',
  'settings.detection.smart.toggle': 'Enable smart detection',
  'settings.detection.notifications.heading': 'Desktop notifications',
  'settings.detection.notifications.hint':
    'Optional. Notify on cascades and repeated identical failures. Permission is requested the first time you enable this.',
  'settings.detection.notifications.toggle': 'Show notifications for detected patterns',
  'settings.detection.frequency.label': 'Frequency',
  'settings.detection.frequency.first': 'First occurrence per session',
  'settings.detection.frequency.every': 'Every occurrence',
  'settings.detection.permissionDenied':
    'Notification permission denied. Re-enable it from Chrome settings and try again.',

  // — Settings: Sharing —
  'settings.sharing.heading': 'Sharing',
  'settings.sharing.lead':
    'Optional webhook URLs for Slack, Discord, and Microsoft Teams. Hindsight POSTs shareable bug reports directly to these endpoints; URLs are stored in <code>chrome.storage.local</code> alongside the rest of your settings. Leave blank to disable a destination.',
  'settings.sharing.slack.heading': 'Slack incoming webhook',
  'settings.sharing.slack.hint':
    'Create one at <code>api.slack.com/apps</code> → Incoming Webhooks. URL looks like <code>https://hooks.slack.com/services/...</code>.',
  'settings.sharing.discord.heading': 'Discord webhook',
  'settings.sharing.discord.hint':
    'Server settings → Integrations → Create webhook. URL looks like <code>https://discord.com/api/webhooks/...</code>.',
  'settings.sharing.teams.heading': 'Microsoft Teams webhook',
  'settings.sharing.teams.hint':
    'Channel → ⋯ → Connectors → Incoming Webhook. Configurable outlook.office.com URL.',
  'settings.sharing.github.heading': 'GitHub default repo',
  'settings.sharing.github.hint':
    '"Send to GitHub" opens a new-issue form with the bug report pre-filled. Leave blank to hide the button.',
  'settings.sharing.github.ownerPlaceholder': 'owner',
  'settings.sharing.github.repoPlaceholder': 'repo',
  'settings.sharing.email.heading': 'Default email recipient',
  'settings.sharing.email.hint':
    '"Send to Email" opens a mailto: draft addressed here. Leave blank to let the mail client prompt for a recipient.',
  'settings.sharing.email.placeholder': 'engineer@example.com',

  // — Settings: Advanced —
  'settings.advanced.heading': 'Advanced',
  'settings.advanced.lead':
    'Power-user knobs. Most users never need these — defaults are tuned for the privacy and performance promises in <code>PRD §4</code>.',
  'settings.advanced.debug.heading': 'Debug logging',
  'settings.advanced.debug.hint':
    'Emits verbose service-worker console logs for every captured event. Helpful when debugging Hindsight itself; noisy otherwise.',
  'settings.advanced.debug.toggle': 'Enable verbose service-worker logs',
  'settings.advanced.perfBudget.heading': 'Perf budget threshold',
  'settings.advanced.perfBudget.hint':
    'Soft warning threshold (ms) for capture overhead. PRD §13.1 hard ceiling is 0.5 ms — the CI bench gate enforces it independently. Raise this if you see false-positive perf nudges on slow hardware.',
  'settings.advanced.perfBudget.label': 'Threshold (ms)',
  'settings.advanced.storage.heading': 'Storage usage',
  'settings.advanced.storage.hint':
    'How much room the capture buffers and the closed-tab archive currently take in <code>chrome.storage.local</code>.',
  'settings.advanced.storage.error': 'Unable to read storage: {error}',
  'settings.advanced.reset.heading': 'Reset everything',
  'settings.advanced.reset.hint':
    'Clears every captured session, the closed-tab archive, and resets every settings section to defaults. There is no undo.',
  'settings.advanced.reset.button': 'Reset all data',
  'settings.advanced.reset.confirm':
    'Reset everything? This clears every captured session, the 7-day archive, and resets every settings section to defaults. There is no undo.',
  'settings.advanced.reset.success': 'All data cleared.',
  'settings.advanced.reset.failed': 'Reset failed: {error}',

  // — Settings: status / toasts —
  'settings.status.saved': '✓ Saved',
  'settings.status.saving': 'Saving…',
  'settings.status.saveFailed': 'Save failed — {error}',

  // — Popup —
  'popup.summary.eventsLabel': 'events',
  'popup.summary.errorsSuffixOne': '· 1 error',
  'popup.summary.errorsSuffix': '· {n} errors',
  'popup.summary.title.openFiltered': 'Open side panel filtered to failures',
  'popup.recording.label': 'Recording · {time}',
  'popup.recording.stop': '■ Stop',
  'popup.actions.openPanel': 'Open side panel',
  'popup.actions.downloadBundle': '⤓ Download replay bundle',
  'popup.actions.bundleDownloaded': '✓ Bundle downloaded',
  'popup.page.reload': '↻ Reload',
  'popup.page.reload.title': 'Reload the active tab (Cmd+R equivalent)',
  'popup.page.hardReload': '↻ Hard reload',
  'popup.page.hardReload.title':
    'Reload and refetch every resource — bypass the HTTP cache (Cmd+Shift+R equivalent)',
  'popup.page.clearHistory': '🗑 Clear history',
  'popup.page.clearHistory.title': 'Drop every captured event for this tab. Cannot be undone.',
  'popup.confirmClearOne':
    'Drop every captured event for this tab? 1 event will be removed. This cannot be undone.',
  'popup.confirmClear':
    'Drop every captured event for this tab? {n} events will be removed. This cannot be undone.',
  'popup.share.label': 'Send to',
  'popup.share.button': '→ {label}',
  'popup.share.confirmOne': 'Send 1 event to {destination}?',
  'popup.share.confirm': 'Send {n} events to {destination}?',
  'popup.share.confirmMaskedOne': '\n1 field masked at capture time — payload stays masked.',
  'popup.share.confirmMasked': '\n{n} fields masked at capture time — payload stays masked.',
  'popup.share.sending': '… sending',
  'popup.share.sent': '✓ Sent',
  'popup.share.sentTruncated': '✓ Sent (truncated)',
  'popup.share.failedFallback': '✗ failed',
  'popup.share.failed': '✗ {error}',
  'popup.footer.settings': 'Settings',

  // — Sidepanel: header / filters —
  'sidepanel.filter.failed': 'Failed',
  'sidepanel.filter.failed.title': 'Show only failed events',
  'sidepanel.filter.api': 'API',
  'sidepanel.filter.api.title':
    'Hide static assets and framework internals — show only API/data fetches',
  'sidepanel.filter.all': 'All',
  'sidepanel.filter.all.title': 'Show every captured event',
  'sidepanel.categories.title': 'Show categories (this tab only)',
  'sidepanel.detailSearch.placeholder': 'Find in detail…',
  'sidepanel.detailSearch.prev': 'Previous match',
  'sidepanel.detailSearch.next': 'Next match',
  'sidepanel.theme.toggle': 'Toggle light / dark theme',
  'sidepanel.record.start': '● Record',
  'sidepanel.record.stop': '■ Stop',
  'sidepanel.record.title': 'Start a Tier 4 recording (PRD §6.5)',
  'sidepanel.record.timer': 'Recording · {time}',
  'sidepanel.clear': 'Clear',
  'sidepanel.clear.title': 'Clear captures for this tab',

  // — Sidepanel: search —
  'sidepanel.search.placeholder': 'Search URLs, messages, payloads…',
  'sidepanel.search.label': 'Search captured events',
  'sidepanel.host.label': 'Host',
  'sidepanel.host.clear': 'Clear host filter',
  'sidepanel.results.count': '{n} results',
  'sidepanel.results.countOne': '{n} result',
  'sidepanel.results.none': 'No matches',

  // — Sidepanel: scrubber —
  'sidepanel.scrubber.label': 'Timeline scrubber',
  'sidepanel.scrubber.reset': '↺ reset',
  'sidepanel.scrubber.resetTitle': 'Reset time range to full session',
  'sidepanel.scrubber.startLabel': 'Time range start',
  'sidepanel.scrubber.endLabel': 'Time range end',

  // — Sidepanel: archive —
  'sidepanel.archive.empty': '0 closed sessions',
  'sidepanel.archive.count': '{n} closed sessions',
  'sidepanel.archive.countOne': '1 closed session',
  'sidepanel.archive.clear': 'Clear archive',
  'sidepanel.archive.confirmClear': 'Clear the closed-tab archive? Cannot be undone.',
  'sidepanel.archive.empty.title': 'No closed-tab archive yet.',

  // — Sidepanel: list empty / loading —
  'sidepanel.empty.title': 'No events yet',
  'sidepanel.empty.sub': 'Browse the page — events will appear here.',
  'sidepanel.empty.failed.title': 'No errors yet',
  'sidepanel.empty.failed.sub': 'Switch to "All" to see every captured event.',
  'sidepanel.empty.api.title': 'No API calls yet',
  'sidepanel.empty.api.sub':
    'Framework chunks, static assets, and prefetches are hidden — browse the page and trigger a data fetch.',
  'sidepanel.empty.all.title': 'No events yet',
  'sidepanel.empty.all.sub':
    'Browse the page — clicks, requests, navigations, console errors appear here.',
  'sidepanel.empty.search.title': 'No matches',
  'sidepanel.empty.search.sub':
    'Nothing in the current filter matches your search. Try clearing it or switch to "All".',
  'sidepanel.empty.host.title': 'No events from that host',
  'sidepanel.empty.host.sub':
    'Clear the host filter (× next to the picker) to see events from other origins.',

  // — Sidepanel: event row generic —
  'sidepanel.event.kind.network': 'Network',
  'sidepanel.event.kind.console': 'Console',
  'sidepanel.event.kind.action': 'Action',
  'sidepanel.event.kind.navigation': 'Navigation',
  'sidepanel.event.kind.error': 'Error',
  'sidepanel.event.kind.performance': 'Performance',
  'sidepanel.event.kind.screenshot': 'Screenshot',
  'sidepanel.event.kind.recording': 'Recording',
  'sidepanel.event.kind.detection': 'Detection',

  // — Sidepanel: action labels —
  'sidepanel.action.click': 'Click',
  'sidepanel.action.input': 'Input',
  'sidepanel.action.route': 'Route',
  'sidepanel.action.scroll': 'Scroll',

  // — Sidepanel: detail panel —
  'sidepanel.detail.close': 'Close',
  'sidepanel.detail.request': 'Request',
  'sidepanel.detail.response': 'Response',
  'sidepanel.detail.headers': 'Headers',
  'sidepanel.detail.body': 'Body',
  'sidepanel.detail.empty': 'No body',
  'sidepanel.detail.copyJson': 'Copy JSON',
  'sidepanel.detail.copyCurl': 'Copy as cURL',
  'sidepanel.detail.openInNewTab': 'Open in new tab',
  'sidepanel.detail.stack': 'Stack trace',
  'sidepanel.detail.context': 'Context',
  'sidepanel.detail.metadata': 'Metadata',
  'sidepanel.detail.timing': 'Timing',
  'sidepanel.detail.duration': 'Duration',
  'sidepanel.detail.status': 'Status',
  'sidepanel.detail.url': 'URL',
  'sidepanel.detail.method': 'Method',
  'sidepanel.detail.maskedNote': 'Masked at capture time — original value not stored.',

  // — Sidepanel: bulk action bar —
  'sidepanel.bulk.selected': '{n} selected',
  'sidepanel.bulk.selectedOne': '1 selected',
  'sidepanel.bulk.clearSelection': 'Clear selection',
  'sidepanel.bulk.delete': 'Delete selected',
  'sidepanel.bulk.export': 'Export selected',
  'sidepanel.bulk.share': 'Share selected',
  'sidepanel.bulk.confirmDelete': 'Delete {n} events? Cannot be undone.',

  // — Sidepanel: detection flags —
  'sidepanel.detection.cascade': 'Failure cascade',
  'sidepanel.detection.slow': 'Slow request',
  'sidepanel.detection.whiteScreen': 'White screen',
  'sidepanel.detection.repeatedFailure': 'Repeated failure',
  'sidepanel.detection.summary.cascade': '{n} failed requests in {window}s',
  'sidepanel.detection.summary.slow': '{ms}ms — over budget',

  // — Sidepanel: toasts / status —
  'sidepanel.toast.copied': 'Copied to clipboard.',
  'sidepanel.toast.copyFailed': 'Copy failed.',
  'sidepanel.toast.cleared': 'Captures cleared for this tab.',
  'sidepanel.toast.archiveCleared': 'Closed-tab archive cleared.',
  'sidepanel.toast.recordingStarted': 'Recording started.',
  'sidepanel.toast.recordingStopped': 'Recording stopped.',
  'sidepanel.toast.exportReady': 'Replay bundle ready.',
  'sidepanel.toast.exportFailed': 'Export failed — {error}',
  'sidepanel.toast.shareSent': 'Sent to {destination}.',
  'sidepanel.toast.shareFailed': 'Send failed — {error}',
  'sidepanel.toast.permissionNeeded': 'Permission needed: {permission}',

  // — Background / notifications —
  'bg.notif.cascade.title': 'Hindsight: failure cascade',
  'bg.notif.cascade.message':
    '3+ failures on {origin} within 10s — open the side panel for details.',
  'bg.notif.anomaly.title': 'Hindsight: repeated identical failure',
  'bg.notif.anomaly.message':
    'Same endpoint failing on {origin} — open the side panel for details.',

  // — Errors surfaced to UI —
  'error.network': 'Network error.',
  'error.permissionDenied': 'Permission denied.',
  'error.storageFull': 'Local storage is full — clear some captures first.',
  'error.invalidUrl': 'Enter a valid URL.',
  'error.unknown': 'Something went wrong.',
} as const;

const tr = {
  // — Common —
  'common.cancel': 'Vazgeç',
  'common.save': 'Kaydet',
  'common.delete': 'Sil',
  'common.remove': 'Kaldır',
  'common.add': 'Ekle',
  'common.refresh': 'Yenile',
  'common.close': 'Kapat',
  'common.copy': 'Kopyala',
  'common.copied': 'Kopyalandı',
  'common.reset': 'Sıfırla',
  'common.confirm': 'Onayla',
  'common.any': 'Hepsi',
  'common.empty': '—',
  'common.calculating': 'Hesaplanıyor…',

  // — Settings: shell —
  'settings.title': 'Hindsight Ayarları',
  'settings.subtitle': 'Gizlilik öncelikli varsayılanlar — kayıtlar makinende kalır.',
  'settings.nav.general': 'Genel',
  'settings.nav.privacy': 'Gizlilik',
  'settings.nav.capture': 'Yakalama',
  'settings.nav.detection': 'Algılama',
  'settings.nav.sharing': 'Paylaşım',
  'settings.nav.advanced': 'Gelişmiş',

  // — Settings: General —
  'settings.general.heading': 'Genel',
  'settings.general.theme.label': 'Tema',
  'settings.general.theme.system': 'Sistemle eşle',
  'settings.general.theme.light': 'Açık',
  'settings.general.theme.dark': 'Koyu',
  'settings.general.theme.hint': 'Açılır pencereyi, yan paneli ve ayar sayfasını etkiler.',
  'settings.general.language.label': 'Dil',
  'settings.general.language.en': 'English',
  'settings.general.language.tr': 'Türkçe',
  'settings.general.language.hint':
    'Değişiklik açılır pencere, yan panel ve bu ayar sayfasında anında uygulanır.',

  // — Settings: Privacy —
  'settings.privacy.heading': 'Gizlilik',
  'settings.privacy.lead':
    'Maskeleme yakalama anında yapılır — orijinal değer depolamaya hiçbir zaman yazılmaz (<code>PRD §11.2</code>).',
  'settings.privacy.defaultRules.heading': 'Varsayılan kurallar',
  'settings.privacy.defaultRules.hint':
    'Bir kuralı sonraki yakalamalar için devre dışı bırakmak için çipi tıkla. Devre dışı kurallar sen tekrar açana kadar kapalı kalır — zaten yakalanmış maskeli değerler etkilenmez (PRD §11.2: maskeleme geri alınamaz). Form alanı kuralları devre dışı bırakılamaz.',
  'settings.privacy.defaultRules.warn':
    '⚠ Kural devre dışıyken yapılan yakalamalar eşleşen değeri ham haliyle makinende saklar ve paylaştığın her hata raporunda aynen yer alır.',
  'settings.privacy.defaultRules.groupHeaders': 'Başlıklar',
  'settings.privacy.defaultRules.groupBodies': 'Gövdeler',
  'settings.privacy.defaultRules.groupFormFields': 'Form alanları',
  'settings.privacy.defaultRules.tooltipScope': 'kapsam: {scope}',
  'settings.privacy.defaultRules.tooltipToggle': 'kapsam: {scope} — {action} için tıkla',
  'settings.privacy.defaultRules.actionEnable': 'aç',
  'settings.privacy.defaultRules.actionDisable': 'kapat',
  'settings.privacy.customPatterns.heading': 'Özel gövde desenleri',
  'settings.privacy.customPatterns.hint':
    'İstek ve yanıt gövdelerine uygulanan regex. Varsayılan boş — sadece kendi yakalamalarının ihtiyaç duyduğunu ekle.',
  'settings.privacy.customPatterns.add': '+ Desen ekle',
  'settings.privacy.customPatterns.empty':
    'Henüz özel desen yok. Başlamak için <strong>Desen ekle</strong>’ye tıkla.',
  'settings.privacy.customPatterns.labelPlaceholder': 'API token örneği',
  'settings.privacy.customPatterns.regexPlaceholder': '\\bsk_live_[A-Za-z0-9]+\\b',
  'settings.privacy.customPatterns.invalidRegex': 'geçersiz regex — kaydedildi ama uygulanmıyor',
  'settings.privacy.customPatterns.applyRequest': 'İstek gövdelerine uygula',
  'settings.privacy.customPatterns.applyResponse': 'Yanıt gövdelerine uygula',
  'settings.privacy.origins.heading': 'Bu kaynaklarda asla yakalama',
  'settings.privacy.origins.hint':
    'Tam origin eşleşmesi (şema + host + port). Bu kaynaklardan gelen olaylar depolamaya ulaşmadan düşürülür.',
  'settings.privacy.origins.placeholder': 'https://internal.example.com',
  'settings.privacy.origins.add': '+ Ekle',
  'settings.privacy.origins.empty': 'Engellenmiş kaynak yok.',
  'settings.privacy.origins.removeAria': '{origin} kaldır',
  'settings.privacy.origins.invalid': 'Tam bir URL gir (https://host:port).',
  'settings.privacy.sandbox.heading': 'Test ortamı',
  'settings.privacy.sandbox.hint':
    'Örnek bir gövde yapıştır, kural seç, neyin maskeleneceğini gör. Buradaki hiçbir şey kaydedilmez.',
  'settings.privacy.sandbox.rule': 'Kural',
  'settings.privacy.sandbox.scope': 'Kapsam',
  'settings.privacy.sandbox.input': 'Örnek girdi',
  'settings.privacy.sandbox.inputPlaceholder':
    'Bir JSON gövdesi, başlık değeri veya herhangi bir metin yapıştır...',
  'settings.privacy.sandbox.output': 'Maskeli çıktı',
  'settings.privacy.sandbox.defaultOption': 'Varsayılan · {label}',
  'settings.privacy.sandbox.customOption': 'Özel · {label}',
  'settings.privacy.sandbox.customNoLabel': '(etiket yok)',
  'settings.privacy.sandbox.customFallback': 'Özel desen',
  'settings.privacy.sandbox.scopeMismatch':
    'Kural bu kapsama uygulanmıyor: {scope} (kuralın kapsamı: {ruleScope}).',
  'settings.privacy.sandbox.matchesOne': '{n} eşleşme maskelendi.',
  'settings.privacy.sandbox.matchesMany': '{n} eşleşme maskelendi.',

  // — Settings: Capture —
  'settings.capture.heading': 'Yakalama',
  'settings.capture.lead':
    'Hindsight’ın hangi olay ailelerini kaydedeceğini ve sekme başına tampon boyutunu seç. Tier 1 olaylar (ağ istekleri, yönlendirmeler, hatalar) devre dışı bırakılamaz (<code>PRD §6.1.1</code>).',
  'settings.capture.tier2.heading': 'Tier 2 olaylar',
  'settings.capture.tier2.hint':
    'Tıklamalar, form girdisi değişimleri, WebSocket çerçeveleri, console.warn / console.info. Devre dışı bırakmak yalnızca yeni yakalamaları durdurur — mevcut tampon olduğu gibi kalır.',
  'settings.capture.tier2.toggle': 'Tier 2 olayları yakala',
  'settings.capture.tier3.heading': 'Tier 3 olaylar',
  'settings.capture.tier3.hint':
    'Performans long task’ları (>100 ms) ve layout shift’ler. Hata anında ekran görüntüsü bu anahtardan bağımsız olarak açık kalır.',
  'settings.capture.tier3.toggle': 'Performans long task ve layout shift’leri yakala',
  'settings.capture.categories.heading': 'Yan panelde göster',
  'settings.capture.categories.hint':
    'Yan panelde varsayılan olarak gösterilecek olay kategorileri. Bir yan panel bunu sekmeye özel olarak geçersiz kılabilir; bu, yeni açılan paneller için başlangıç noktasıdır.',
  'settings.capture.categories.network': 'HTTP istekleri (fetch / XHR)',
  'settings.capture.categories.realtime': 'WebSocket / SSE',
  'settings.capture.categories.console': 'Konsol (hata, uyarı, info)',
  'settings.capture.categories.navigation': 'Gezinmeler',
  'settings.capture.categories.action': 'Kullanıcı aksiyonları (tık, giriş, kayıt)',
  'settings.capture.categories.performance': 'Performans (long task, layout shift)',
  'settings.capture.categories.screenshot': 'Ekran görüntüleri',
  'settings.capture.buffer.heading': 'Sekme başına tampon',
  'settings.capture.buffer.hint':
    'Döngüsel FIFO tampon. Dolduğunda en eski olay yer açmak için düşürülür. Kapatılan sekmeler 7 günlük arşive taşınır (yan panel M3 ile gelene kadar salt okunur).',
  'settings.capture.buffer.label': 'Sekme başına maksimum olay',
  'settings.capture.buffer.defaultSuffix': '(varsayılan)',

  // — Settings: Detection —
  'settings.detection.heading': 'Algılama',
  'settings.detection.lead':
    'Hindsight yakalamalarda başarısız istek kümeleri, yavaş istekler ve gezinmeden sonra beyaz ekran kalıplarını izler (<code>PRD §6.2.1</code>). Bunları yan panelde renkli bayraklarla gösterir; yüksek öncelikli olaylar için isteğe bağlı masaüstü bildirimleri vardır.',
  'settings.detection.smart.heading': 'Akıllı algılama',
  'settings.detection.smart.hint':
    'Kapalıyken hiçbir algılama kuralı çalışmaz ve bayrak basılmaz — yan panel hâlâ olayları listeler ama küme gruplaması ve sol kenar rengi kaybolur.',
  'settings.detection.smart.toggle': 'Akıllı algılamayı etkinleştir',
  'settings.detection.notifications.heading': 'Masaüstü bildirimleri',
  'settings.detection.notifications.hint':
    'İsteğe bağlı. Kümelerde ve tekrar eden aynı hatalarda bildirim. İlk açtığında izin sorulur.',
  'settings.detection.notifications.toggle': 'Algılanan kalıplar için bildirim göster',
  'settings.detection.frequency.label': 'Sıklık',
  'settings.detection.frequency.first': 'Oturum başına ilk olduğunda',
  'settings.detection.frequency.every': 'Her olduğunda',
  'settings.detection.permissionDenied':
    'Bildirim izni reddedildi. Chrome ayarlarından tekrar açıp dene.',

  // — Settings: Sharing —
  'settings.sharing.heading': 'Paylaşım',
  'settings.sharing.lead':
    'Slack, Discord ve Microsoft Teams için isteğe bağlı webhook URL’leri. Hindsight paylaşılabilir hata raporlarını doğrudan bu uç noktalara POST eder; URL’ler diğer ayarlarınla birlikte <code>chrome.storage.local</code> içinde saklanır. Bir hedefi devre dışı bırakmak için boş bırak.',
  'settings.sharing.slack.heading': 'Slack incoming webhook',
  'settings.sharing.slack.hint':
    '<code>api.slack.com/apps</code> → Incoming Webhooks üzerinden oluştur. URL şu şekildedir: <code>https://hooks.slack.com/services/...</code>.',
  'settings.sharing.discord.heading': 'Discord webhook',
  'settings.sharing.discord.hint':
    'Server settings → Integrations → Create webhook. URL şu şekildedir: <code>https://discord.com/api/webhooks/...</code>.',
  'settings.sharing.teams.heading': 'Microsoft Teams webhook',
  'settings.sharing.teams.hint':
    'Kanal → ⋯ → Connectors → Incoming Webhook. Yapılandırılabilir outlook.office.com URL’si.',
  'settings.sharing.github.heading': 'Varsayılan GitHub deposu',
  'settings.sharing.github.hint':
    '"GitHub’a Gönder" hata raporu önceden doldurulmuş yeni issue formunu açar. Düğmeyi gizlemek için boş bırak.',
  'settings.sharing.github.ownerPlaceholder': 'sahip',
  'settings.sharing.github.repoPlaceholder': 'depo',
  'settings.sharing.email.heading': 'Varsayılan e-posta alıcısı',
  'settings.sharing.email.hint':
    '"E-postaya Gönder" bu adrese yönelik bir mailto: taslağı açar. Alıcıyı e-posta istemcisinin sorması için boş bırak.',
  'settings.sharing.email.placeholder': 'engineer@example.com',

  // — Settings: Advanced —
  'settings.advanced.heading': 'Gelişmiş',
  'settings.advanced.lead':
    'Uzman kullanıcı ayarları. Çoğu kullanıcının bunlara ihtiyacı olmaz — varsayılanlar <code>PRD §4</code> içindeki gizlilik ve performans sözleri için ayarlanmıştır.',
  'settings.advanced.debug.heading': 'Debug günlüğü',
  'settings.advanced.debug.hint':
    'Her yakalanan olay için ayrıntılı service-worker konsol günlüğü üretir. Hindsight’ı kendisi için debug ederken yararlı; aksi takdirde gürültülü.',
  'settings.advanced.debug.toggle': 'Ayrıntılı service-worker günlüklerini etkinleştir',
  'settings.advanced.perfBudget.heading': 'Performans bütçe eşiği',
  'settings.advanced.perfBudget.hint':
    'Yakalama yükü için yumuşak uyarı eşiği (ms). PRD §13.1 sert tavanı 0.5 ms — CI bench gate bunu bağımsız olarak zorlar. Yavaş donanımda yanlış pozitif performans uyarıları görüyorsan bunu yükselt.',
  'settings.advanced.perfBudget.label': 'Eşik (ms)',
  'settings.advanced.storage.heading': 'Depolama kullanımı',
  'settings.advanced.storage.hint':
    'Yakalama tamponları ve kapatılmış sekme arşivinin <code>chrome.storage.local</code> içinde şu an kapladığı alan.',
  'settings.advanced.storage.error': 'Depolama okunamadı: {error}',
  'settings.advanced.reset.heading': 'Her şeyi sıfırla',
  'settings.advanced.reset.hint':
    'Tüm yakalanmış oturumları, kapatılmış sekme arşivini siler ve tüm ayar bölümlerini varsayılana döndürür. Geri alma yok.',
  'settings.advanced.reset.button': 'Tüm veriyi sıfırla',
  'settings.advanced.reset.confirm':
    'Her şey sıfırlansın mı? Bu işlem tüm yakalanmış oturumları, 7 günlük arşivi siler ve her ayar bölümünü varsayılana döndürür. Geri alma yok.',
  'settings.advanced.reset.success': 'Tüm veri temizlendi.',
  'settings.advanced.reset.failed': 'Sıfırlama başarısız: {error}',

  // — Settings: status / toasts —
  'settings.status.saved': '✓ Kaydedildi',
  'settings.status.saving': 'Kaydediliyor…',
  'settings.status.saveFailed': 'Kaydedilemedi — {error}',

  // — Popup —
  'popup.summary.eventsLabel': 'olay',
  'popup.summary.errorsSuffixOne': '· 1 hata',
  'popup.summary.errorsSuffix': '· {n} hata',
  'popup.summary.title.openFiltered': 'Yan paneli sadece başarısızlarla aç',
  'popup.recording.label': 'Kayıt · {time}',
  'popup.recording.stop': '■ Durdur',
  'popup.actions.openPanel': 'Yan paneli aç',
  'popup.actions.downloadBundle': '⤓ Replay paketini indir',
  'popup.actions.bundleDownloaded': '✓ Paket indirildi',
  'popup.page.reload': '↻ Yenile',
  'popup.page.reload.title': 'Aktif sekmeyi yenile (Cmd+R eşdeğeri)',
  'popup.page.hardReload': '↻ Sert yenile',
  'popup.page.hardReload.title':
    'Her kaynağı yeniden al, HTTP önbelleğini atla (Cmd+Shift+R eşdeğeri)',
  'popup.page.clearHistory': '🗑 Geçmişi temizle',
  'popup.page.clearHistory.title': 'Bu sekme için yakalanan her olayı düşür. Geri alınamaz.',
  'popup.confirmClearOne':
    'Bu sekmenin tüm yakalanmış olayları düşürülsün mü? 1 olay silinecek. Geri alınamaz.',
  'popup.confirmClear':
    'Bu sekmenin tüm yakalanmış olayları düşürülsün mü? {n} olay silinecek. Geri alınamaz.',
  'popup.share.label': 'Gönder',
  'popup.share.button': '→ {label}',
  'popup.share.confirmOne': '{destination} kanalına 1 olay gönderilsin mi?',
  'popup.share.confirm': '{destination} kanalına {n} olay gönderilsin mi?',
  'popup.share.confirmMaskedOne': '\nYakalama anında 1 alan maskelendi — yük maskeli kalır.',
  'popup.share.confirmMasked': '\nYakalama anında {n} alan maskelendi — yük maskeli kalır.',
  'popup.share.sending': '… gönderiliyor',
  'popup.share.sent': '✓ Gönderildi',
  'popup.share.sentTruncated': '✓ Gönderildi (kırpıldı)',
  'popup.share.failedFallback': '✗ başarısız',
  'popup.share.failed': '✗ {error}',
  'popup.footer.settings': 'Ayarlar',

  // — Sidepanel: header / filters —
  'sidepanel.filter.failed': 'Başarısız',
  'sidepanel.filter.failed.title': 'Sadece başarısız olayları göster',
  'sidepanel.filter.api': 'API',
  'sidepanel.filter.api.title':
    'Statik varlıkları ve framework içeriklerini gizle — sadece API/veri çağrılarını göster',
  'sidepanel.filter.all': 'Hepsi',
  'sidepanel.filter.all.title': 'Yakalanan tüm olayları göster',
  'sidepanel.categories.title': 'Kategorileri göster (yalnızca bu sekme)',
  'sidepanel.detailSearch.placeholder': 'Detayda ara…',
  'sidepanel.detailSearch.prev': 'Önceki eşleşme',
  'sidepanel.detailSearch.next': 'Sonraki eşleşme',
  'sidepanel.theme.toggle': 'Açık / koyu temayı değiştir',
  'sidepanel.record.start': '● Kayda al',
  'sidepanel.record.stop': '■ Durdur',
  'sidepanel.record.title': 'Tier 4 kayıt başlat (PRD §6.5)',
  'sidepanel.record.timer': 'Kayıt · {time}',
  'sidepanel.clear': 'Temizle',
  'sidepanel.clear.title': 'Bu sekmenin yakalamalarını temizle',

  // — Sidepanel: search —
  'sidepanel.search.placeholder': 'URL, mesaj veya yük içinde ara…',
  'sidepanel.search.label': 'Yakalanan olaylarda ara',
  'sidepanel.host.label': 'Host',
  'sidepanel.host.clear': 'Host filtresini temizle',
  'sidepanel.results.count': '{n} sonuç',
  'sidepanel.results.countOne': '{n} sonuç',
  'sidepanel.results.none': 'Eşleşme yok',

  // — Sidepanel: scrubber —
  'sidepanel.scrubber.label': 'Zaman çizelgesi sürgüsü',
  'sidepanel.scrubber.reset': '↺ sıfırla',
  'sidepanel.scrubber.resetTitle': 'Zaman aralığını oturumun tamamına sıfırla',
  'sidepanel.scrubber.startLabel': 'Zaman aralığı başlangıcı',
  'sidepanel.scrubber.endLabel': 'Zaman aralığı sonu',

  // — Sidepanel: archive —
  'sidepanel.archive.empty': '0 kapalı oturum',
  'sidepanel.archive.count': '{n} kapalı oturum',
  'sidepanel.archive.countOne': '1 kapalı oturum',
  'sidepanel.archive.clear': 'Arşivi temizle',
  'sidepanel.archive.confirmClear': 'Kapalı sekme arşivi temizlensin mi? Geri alınamaz.',
  'sidepanel.archive.empty.title': 'Henüz kapalı sekme arşivi yok.',

  // — Sidepanel: list empty / loading —
  'sidepanel.empty.title': 'Henüz olay yok',
  'sidepanel.empty.sub': 'Sayfada gezin — olaylar burada görünecek.',
  'sidepanel.empty.failed.title': 'Henüz hata yok',
  'sidepanel.empty.failed.sub': 'Tüm yakalanmış olayları görmek için "Hepsi"ne geç.',
  'sidepanel.empty.api.title': 'Henüz API çağrısı yok',
  'sidepanel.empty.api.sub':
    'Framework parçaları, statik varlıklar ve prefetch’ler gizli — sayfada gezin ve bir veri çağrısı tetikle.',
  'sidepanel.empty.all.title': 'Henüz olay yok',
  'sidepanel.empty.all.sub':
    'Sayfada gezin — tıklamalar, istekler, yönlendirmeler, konsol hataları burada görünür.',
  'sidepanel.empty.search.title': 'Eşleşme yok',
  'sidepanel.empty.search.sub':
    'Mevcut filtrede aramanı karşılayan bir şey yok. Temizle veya "Hepsi"ne geç.',
  'sidepanel.empty.host.title': 'O host’tan olay yok',
  'sidepanel.empty.host.sub':
    'Diğer kaynaklardan olayları görmek için host filtresini temizle (seçicinin yanındaki ×).',

  // — Sidepanel: event row generic —
  'sidepanel.event.kind.network': 'Ağ',
  'sidepanel.event.kind.console': 'Konsol',
  'sidepanel.event.kind.action': 'Aksiyon',
  'sidepanel.event.kind.navigation': 'Yönlendirme',
  'sidepanel.event.kind.error': 'Hata',
  'sidepanel.event.kind.performance': 'Performans',
  'sidepanel.event.kind.screenshot': 'Ekran görüntüsü',
  'sidepanel.event.kind.recording': 'Kayıt',
  'sidepanel.event.kind.detection': 'Algılama',

  // — Sidepanel: action labels —
  'sidepanel.action.click': 'Tıklama',
  'sidepanel.action.input': 'Girdi',
  'sidepanel.action.route': 'Yönlendirme',
  'sidepanel.action.scroll': 'Kaydırma',

  // — Sidepanel: detail panel —
  'sidepanel.detail.close': 'Kapat',
  'sidepanel.detail.request': 'İstek',
  'sidepanel.detail.response': 'Yanıt',
  'sidepanel.detail.headers': 'Başlıklar',
  'sidepanel.detail.body': 'Gövde',
  'sidepanel.detail.empty': 'Gövde yok',
  'sidepanel.detail.copyJson': 'JSON kopyala',
  'sidepanel.detail.copyCurl': 'cURL olarak kopyala',
  'sidepanel.detail.openInNewTab': 'Yeni sekmede aç',
  'sidepanel.detail.stack': 'Stack trace',
  'sidepanel.detail.context': 'Bağlam',
  'sidepanel.detail.metadata': 'Üstveri',
  'sidepanel.detail.timing': 'Zamanlama',
  'sidepanel.detail.duration': 'Süre',
  'sidepanel.detail.status': 'Durum',
  'sidepanel.detail.url': 'URL',
  'sidepanel.detail.method': 'Yöntem',
  'sidepanel.detail.maskedNote': 'Yakalama anında maskelendi — orijinal değer saklanmaz.',

  // — Sidepanel: bulk action bar —
  'sidepanel.bulk.selected': '{n} seçildi',
  'sidepanel.bulk.selectedOne': '1 seçildi',
  'sidepanel.bulk.clearSelection': 'Seçimi temizle',
  'sidepanel.bulk.delete': 'Seçilenleri sil',
  'sidepanel.bulk.export': 'Seçilenleri dışa aktar',
  'sidepanel.bulk.share': 'Seçilenleri paylaş',
  'sidepanel.bulk.confirmDelete': '{n} olay silinsin mi? Geri alınamaz.',

  // — Sidepanel: detection flags —
  'sidepanel.detection.cascade': 'Hata kümesi',
  'sidepanel.detection.slow': 'Yavaş istek',
  'sidepanel.detection.whiteScreen': 'Beyaz ekran',
  'sidepanel.detection.repeatedFailure': 'Tekrar eden hata',
  'sidepanel.detection.summary.cascade': '{window}s içinde {n} başarısız istek',
  'sidepanel.detection.summary.slow': '{ms}ms — bütçe aşımı',

  // — Sidepanel: toasts / status —
  'sidepanel.toast.copied': 'Panoya kopyalandı.',
  'sidepanel.toast.copyFailed': 'Kopyalama başarısız.',
  'sidepanel.toast.cleared': 'Bu sekmenin yakalamaları temizlendi.',
  'sidepanel.toast.archiveCleared': 'Kapalı sekme arşivi temizlendi.',
  'sidepanel.toast.recordingStarted': 'Kayıt başladı.',
  'sidepanel.toast.recordingStopped': 'Kayıt durdu.',
  'sidepanel.toast.exportReady': 'Replay paketi hazır.',
  'sidepanel.toast.exportFailed': 'Dışa aktarım başarısız — {error}',
  'sidepanel.toast.shareSent': '{destination} kanalına gönderildi.',
  'sidepanel.toast.shareFailed': 'Gönderim başarısız — {error}',
  'sidepanel.toast.permissionNeeded': 'İzin gerekli: {permission}',

  // — Background / notifications —
  'bg.notif.cascade.title': 'Hindsight: hata kümesi',
  'bg.notif.cascade.message':
    '{origin} üzerinde 10 saniyede 3+ başarısız istek — ayrıntılar için yan paneli aç.',
  'bg.notif.anomaly.title': 'Hindsight: tekrar eden aynı hata',
  'bg.notif.anomaly.message':
    '{origin} üzerinde aynı uç nokta başarısız oluyor — ayrıntılar için yan paneli aç.',

  // — Errors surfaced to UI —
  'error.network': 'Ağ hatası.',
  'error.permissionDenied': 'İzin reddedildi.',
  'error.storageFull': 'Yerel depolama doldu — önce bazı yakalamaları temizle.',
  'error.invalidUrl': 'Geçerli bir URL gir.',
  'error.unknown': 'Bir şeyler ters gitti.',
} as const;

// — Catalog —
//
// EN is the source of truth; MessageKey is derived from its keyset.
// TR is a Partial<typeof en> at the type level so missing translations
// are a runtime fallback, not a compile error (PRD §14.3: untranslated
// keys fall back to English).

export type MessageKey = keyof typeof en;

export const MESSAGES: Record<Locale, Partial<Record<MessageKey, string>>> = {
  en,
  tr,
};
