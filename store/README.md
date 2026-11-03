# Store listings

Paste-ready text for the three stores. Edit here first; the docs in
`docs/` point to these files.

| Path                     | Store                  | Contents                                                    |
| ------------------------ | ---------------------- | ----------------------------------------------------------- |
| `cws/description-en.txt` | Chrome Web Store       | Description, English (also used by Edge, AMO)               |
| `cws/description-tr.txt` | Chrome Web Store       | Description, Turkish                                        |
| `amo/listing-en.md`      | Firefox Add-ons        | Summary, categories, privacy text, release + reviewer notes |
| `amo/listing-tr.md`      | Firefox Add-ons        | Turkish summary                                             |
| `amo/SOURCE-BUILD.md`    | Firefox Add-ons        | Build-from-source steps for the source upload               |
| `edge/listing-en.md`     | Microsoft Edge Add-ons | Properties, short description, search terms, cert notes     |
| `edge/listing-tr.md`     | Microsoft Edge Add-ons | Turkish listing                                             |

Rules for every text here:

- Claims match shipped behaviour (check before each release).
- Permissions described exactly as `manifest.json` declares them.
- No gradients in any image; images come from `scripts/store-shots.mjs`.
