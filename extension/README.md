# McGill Lecture to MP3

A lightweight Chrome extension for downloading audio from McGill's myCourses lecture recordings as MP3 files.

As you watch a lecture, the extension detects the recording's media stream, fetches it in resumable chunks while extracting only the audio track on the fly, converts it to MP3 locally in your browser, and saves it directly to a folder you choose.

## Download

> **[Install from the Chrome Web Store](CHROME_WEB_STORE_URL)** *(link coming soon)*

## How to use

1. Install the extension and pin it to your Chrome toolbar.
2. Open a McGill lecture recording on myCourses and press play for a few seconds.
3. Click the extension icon. On your first run, click **Choose folder** to pick where your MP3s will be saved.
4. Pick a filename and click **Download**. You can close the popup while it finishes in the background.

## Features

- **Automatic detection** — picks up lectures as you play them with no DevTools or manual URL copying.
- **Audio-only extraction** — strips out video on the fly and encodes to MP3 locally in Chrome via WebAssembly.
- **Local folder & history** — saves MP3s straight to your chosen folder, tracks already-downloaded lectures, and lets you play saved recordings from the **History** tab.

## Development

For loading the unpacked extension locally, architecture details, permissions, and test scripts, see [DEVELOPMENT.md](DEVELOPMENT.md).
