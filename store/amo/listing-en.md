# Firefox Add-ons (AMO) — listing, EN

Paste each block into the matching field of the AMO Developer Hub
(addons.mozilla.org/developers → Hindsight → Edit product page).

## Name (≤ 50)

```
Hindsight
```

## Summary (≤ 250)

```
The DevTools you forgot to open. Records network requests, console errors and clicks in the background, so when something breaks you can scrub back and share one HTML bug report. Everything stays on your computer.
```

## Description

AMO renders a small subset of Markdown-like formatting; plain text with
blank lines is safest. Use [`../cws/description-en.txt`](../cws/description-en.txt)
unchanged, with one Firefox-specific edit: replace "side panel" with
"sidebar" (Firefox builds use `sidebar_action`).

## Categories

- Web Development
- Privacy & Security

## Tags

`debugging`, `developer tools`, `network`, `bug report`, `privacy`

## Support email / site

- Support site: https://github.com/osmnnl/hindsight/issues
- Homepage: https://osmnnl.github.io/hindsight/

## License

MIT License

## Privacy policy

Tick "This add-on has a privacy policy" and paste the body of
`docs/PRIVACY-POLICY.md` (AMO stores the text itself, not a URL), or
this short version if the field is limited:

```
Hindsight stores everything it records (network requests, console messages, user actions, screenshots) in your browser's local extension storage on your computer. It has no server, sends no telemetry and makes no network requests of its own. Data leaves your computer only when you explicitly save a file or press Send to a destination you configured yourself (a Slack, Teams or Discord webhook, a GitHub issue or an email). Authorization, Cookie and API-key headers, password fields and card numbers are masked when they are captured. Full policy: https://osmnnl.github.io/hindsight/privacy.html
```

## Version release notes (1.0.0)

```
1.0.0: first stable release. Fewer permissions (scripting, downloads, tabs and webNavigation removed), a first-run welcome page, Replay asks for one site at a time and can be revoked in Settings, form fields are named by their label, page loads are recorded again. Security and accessibility fixes; see the changelog: https://github.com/osmnnl/hindsight/blob/main/CHANGELOG.md
```

## Notes to reviewer

```
Hindsight is a passive, local-only bug recorder for developers and testers.

- Content scripts match <all_urls> because the recording has to be running before the user knows a page will break. They only observe the page's own fetch/XHR/console/user actions; they make no requests.
- The optional host permission <all_urls> is never requested as a whole: the Replay button requests the single origin of the request being replayed (permissions.request({origins:[origin + "/*"]})).
- No remote code, no eval, no analytics. data_collection_permissions: none.
- innerHTML warnings from web-ext lint: every interpolated captured value goes through the escapeHtml helper of that page (popup.ts, sidepanel.ts, settings.ts); captured page content is never inserted as HTML.
- The code is bundled with Vite. Source code and build steps are in the uploaded source archive; see SOURCE-BUILD.md inside it.

How to test: open any site that makes requests, open the Hindsight sidebar, click a request, then press "Bundle" to save a single HTML replay file.
```

## Source code

Upload a zip of the repository at the release tag (`git archive
--format=zip -o hindsight-1.0.0-source.zip v1.0.0`). Build steps are in
[`SOURCE-BUILD.md`](./SOURCE-BUILD.md).
