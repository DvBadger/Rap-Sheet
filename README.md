# Rap Sheet (beta)

A free Windows tool for gamers who want to report cheaters properly. Press one key when you see something suspicious: Rap Sheet saves a recording of the moment, can read player names off your screen, and builds a ready-to-send report. Everything stays on your PC.

> **Beta.** Expect rough edges. Tested so far in Rob Run and War Dogs only.

## What it does

- **One key (default F5)** starts and stops an incident. A normal Windows hotkey, not a keyboard hook.
- **Recording** of your screen for that incident (H.264, 720p or 1080p).
- **Name reading (optional):** reads a small area you choose, such as the kill feed or nameplates, using offline OCR, and suggests the player name.
- **Report builder:** collects the details, evidence and a short description into text you can paste into the game's report channel.
- **Repeat offenders:** tracks players you have reported more than once.
- **Auto-update:** installed copies update themselves from GitHub Releases.

## Install

1. Open the [Releases page](../../releases) and download the newest `RapSheet-Setup-<version>.exe`.
2. Run it. Windows may show "Windows protected your PC" because the beta is not code-signed yet. Click **More info**, then **Run anyway**.
3. Follow the first-run steps, then read the **How to use** tab.

Windows 10 or 11, 64-bit.

## Privacy

Nothing is uploaded. Recordings, screenshots and reports are saved on your PC (Settings, then Open data folder). The only network use is checking GitHub for new versions.

## Anti-cheat note

Rap Sheet captures your screen and registers a global hotkey. Some anti-cheat systems may treat that as suspicious. It has been tested only briefly with Easy Anti-Cheat. Try casual play first and avoid ranked or competitive modes until you know it is safe for your game. You use the beta at your own risk.

## Feedback

In the app: **Settings, then Copy beta feedback**, paste it into a message and fill in the questions. It includes your app version, Windows build, graphics card and recent log lines. It does not include recordings or screenshots.

## Building from source

Needs Node.js 22 on Windows.

```
npm install
npm test
npm run dist
```

The installer appears in the `release` folder. Releases are built by the "Build beta installer" workflow under the Actions tab.

## Third-party software

See `THIRD-PARTY-NOTICES.txt`.

## License

No license has been chosen yet. All rights reserved for now.
