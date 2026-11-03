# 60-second demo script

For the store video (CWS / Edge "YouTube video URL") and the website.
Self-recorded, 1280 × 800 browser window, no music, cursor visible.
Voice-over lines are in quotes; keep each under its time slot.

**Setup (not recorded):** fresh Chrome profile with Hindsight 1.0.0
pinned. Start the fictional demo shop with
`node scripts/store-shots.mjs --serve` and open the URL it prints;
`POST /api/checkout` returns 500 there. Side panel closed.

| Time      | On screen                                                                                                                                       | Voice-over                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- |
| 0:00–0:06 | Checkout page. Fill email, password, card. Press **Pay**. Red "Payment failed".                                                                 | "A checkout just failed. DevTools wasn't open."                                        |
| 0:06–0:12 | Toolbar badge shows the failure count. Click the Hindsight icon: popup lists 500 / 401 / 404.                                                   | "Hindsight was already recording."                                                     |
| 0:12–0:20 | **Open side panel.** Timeline with the cascade row; scrub the range handles.                                                                    | "Every request, console error and click, in order."                                    |
| 0:20–0:32 | Click `POST /api/checkout 500`. Scroll headers: `Authorization: ***MASKED***`, body `card: ***MASKED***`, response `payment_intent is missing`. | "The full request and the exact error. Secrets were masked before anything was saved." |
| 0:32–0:38 | **Copy → cURL**. Paste into a terminal, run it, same 500.                                                                                       | "Hand a developer the exact request."                                                  |
| 0:38–0:50 | **Bundle**. Open the downloaded `.html` in a different browser: timeline, narrative, request.                                                   | "Or share the whole session as one HTML file. No install, no account."                 |
| 0:50–0:60 | Closing card: icon, "Hindsight", three lines: _Stays on your computer · No telemetry · Open source (MIT)_. Store URL.                           | "Hindsight. The DevTools you forgot to open."                                          |

Notes

- If a "Copy as fetch" format ships (workstream C/D), use it at 0:32
  instead of cURL and say "Paste it into the console".
- Record light theme; the dark theme is covered by screenshot 5.
- Export 1080p H.264, upload to YouTube as **Unlisted**, paste the URL
  in CWS and Edge.
