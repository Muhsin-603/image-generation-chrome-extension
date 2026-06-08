# Image Gen Automator

A Chrome extension (Manifest V3) that automates batch image generation in ChatGPT from prompt files (.pdf, .docx, .md). It provides a side-panel UI to load prompt files, preview and edit prompts, then automatically injects prompts into ChatGPT, captures generated images, and downloads them in bulk.

## Features
- Upload .pdf, .docx, or .md files to extract prompts
- Manual prompt entry and prompt list management
- Batch generation, pause/resume/cancel controls
- Scrape images from an existing ChatGPT conversation and bulk-download them
- Robust background state (persisted to chrome.storage.local) and retry logic

## Quick start (Load unpacked extension)
1. Open Chrome and go to `chrome://extensions/`.
2. Enable **Developer mode** (top-right).
3. Click **Load unpacked** and select this repository folder.
4. Open a ChatGPT tab (the extension uses `*://chatgpt.com/*` by default). If you use `https://chat.openai.com/`, update `manifest.json` `host_permissions` and any domain checks in `background.js`/`content.js`.
5. Open the extension's side panel (click the extension icon / side panel) and use the UI.

## Usage
- Drop a prompt file (.pdf, .docx, .md) into the side panel or paste/add manual prompts.
- Set the desired download folder name (a subfolder inside your Downloads directory).
- Click **Start Generation** to begin. Monitor progress and logs in the panel.
- Use **Scrape Chat Images** to find images already present in the active ChatGPT tab and **Download Now** to bulk download them.

## Key files & architecture
- `manifest.json` — extension metadata, permissions, side panel, background service worker.
- `sidepanel.html`, `sidepanel.css`, `sidepanel.js` — UI and client logic for the side panel.
- `background.js` — service worker that manages queue, state, and orchestration (START/PAUSE/RESUME/CANCEL flows).
- `content.js` — injected into ChatGPT pages; types prompts, clicks send, waits for generated images, handles modal download and scraping.
- `parsers/` — `pdf-parser.js` (pdfjs), `docx-parser.js` (mammoth), `markdown-parser.js` — extract prompts from files.
- `lib/` — third-party browser bundles (mammoth, pdfjs worker, etc.).

## Development & debugging
- Install dependencies (optional, only if you update libs): `npm install`.
- If you change code, reload the unpacked extension in `chrome://extensions/`.
- Inspect service worker (background) logs: `chrome://extensions/` → find the extension → **Service worker** → Inspect.
- Inspect the side panel UI: open side panel and use DevTools on the panel view.
- Inspect content script behavior in the ChatGPT tab's DevTools (Console) to view messages, element selection issues, or network errors.

## Notes & troubleshooting
- Domain matching: the manifest currently uses `*://chatgpt.com/*`. If ChatGPT is available at `chat.openai.com`, update `manifest.json` and `background.findChatGptTab()` to match the actual domain.
- UI selectors in `content.js` are tuned to current ChatGPT markup and may break if the site updates. If images are not detected or prompts fail to send, update selectors in `content.js`.
- The extension tries to convert `blob:` URLs to data URLs when needed. Cross-origin image downloads may be delegated to the background download flow.

## Security & permissions
- The extension requests `downloads`, `scripting`, `storage`, `tabs`, and `sidePanel` permissions. Review and narrow host permissions if needed.
- Do NOT commit secrets or API keys into the repository.

## Contributing
- Fork, make changes, and open a PR. Describe the change and test steps.

## Contact
Repository: https://github.com/Muhsin-603/image-generation-chrome-extension

---

If you want, I can add a short developer guide (DEVELOPMENT.md) with step-by-step local debug commands, or update `manifest.json` to include `https://chat.openai.com/*` as a default host permission. Which should I do next?