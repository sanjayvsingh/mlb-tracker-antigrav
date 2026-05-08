# MLB Tracker

A real-time baseball game tracker designed to help you catch the games that matter most.

## 🚀 Project Overview

This is my **first Antigravity project**! The goal is to solve a very specific challenge: **watching every MLB team play at least once a year.**

Last year, I managed to do this using a clever Google Sheet, but it was always a struggle to find which games were available to watch — especially as the season progressed and the list of "unseen" teams got smaller. This app directly streamlines that process by highlighting exactly which games feature teams I still need to see.

While built for personal use, it's also a great way for any fan to see what interesting matchups are coming up.

## ✨ Features

- **Real-time Game Tracking**: Fetches live data from the MLB Stats API.
- **Unseen Team Highlights**: Automatically identifies matchups with teams you haven't watched yet.
- **Priority Filtering**: Filter for "Top Priority" games where both teams are unseen.
- **Gemini AI Recommendations**: Uses AI to automatically identify and showcase 5 compelling games across the 3-day window.
- **Showcase Toast Notifications**: Visual confirmation when AI recommendations load or encounter errors.
- **Metrics Shelf**: Visual representation of your season progress.
- **Material Icons**: Clean, consistent UI using Material Design iconography.
- **Mobile Responsive**: Designed to look great on any device.

## 📡 API Usage

The application integrates data from multiple real-time sources to calculate the **Fun Score**:

- **MLB Stats API**:
  - `standings`: Fetches division ranks and win/loss records.
  - `stats/leaders`: Identifies "Hot Hitters" (league leaders in HR, SLG, OPS) and players near career milestones.
  - `schedule`: Retrieves the 3-day game window, hydrated with `probablePitcher` and `broadcasts`.

- **Google Gemini API**:
  - `gemini-3-flash-preview`: Securely proxied through a PHP backend (`gemini.php`) to fetch short, dynamic reasons to watch targeted MLB games and caches them locally for 6 hours to conserve API limits.
  - `gemini-3.1-flash-lite-preview`: Serves as an automatic fallback if the primary model reaches its rate limit (429) or is unavailable (503). Also used automatically when `debugDate` is set to conserve quota during testing.

- **Sportsnet Scraping API**:
  - `sportsnet.php`: A backend scraper that parses live and upcoming MLB matchups from Sportsnet's internal schedule API. Includes a geo-IP check so that badges are only shown to confirmed Canadian users (fails closed — Sportsnet is skipped if geo-detection is unavailable). Fetches up to 4 dates in parallel using `curl_multi` and caches results for 4 hours.

- **MLB Network Scraping**:
  - `mlbnetwork.php`: A backend scraper that fetches and parses the MLB Network live games schedule from `mlb.com`. Extracts game matchups, dates, and times and caches results for 24 hours. Games broadcast on MLB Network are surfaced as Featured Broadcasts in the UI.

## 🔗 URL Parameters

You can customize the application state using the following parameters:

| Parameter | Value | Description |
| :--- | :--- | :--- |
| `u` | `s` | **Owner Mode**: Initializes your local device as the "Owner" to sync with the master Google Sheet. |
| `seen` | `CSV` (e.g., `ARI,ATL`) | **Share Mode**: Overrides local seen status with a specific list of team abbreviations (ideal for sharing with friends). |
| `debugDate`| `YYYY-MM-DD` | **Debug Mode**: Mocks the "current" date to view historical or future schedules. Also switches to a lighter Gemini model to conserve API quota. |

## 🛠️ Tech Stack

- **Frontend**: Vanilla HTML5, JavaScript (ES6+), CSS3.
- **Backend Proxy**: PHP (`index.php` for session/CSRF token seeding; `gemini.php`, `sportsnet.php`, `mlbnetwork.php` for proxying external APIs; `token.php` as a shared auth helper). PowerShell (`server.ps1`) for local development.
- **Data Source**: MLB Stats API, Google Gemini API.
- **Icons**: [Material Icons](https://fonts.google.com/icons)

## 🔒 Security

The backend proxy scripts include several layers of security to prevent unauthorized usage and quota abuse:

- **Session-Based CSRF Tokens**: `index.php` generates a cryptographically random token per PHP session and injects it into the page as `window.CSRF_TOKEN`. Every request to a proxy endpoint must include this token in the `X-CSRF-Token` header, verified server-side with `hash_equals()`. Unlike a hardcoded static token, this cannot be replayed without a valid session cookie.
- **Secure Session Cookies**: PHP sessions use `secure`, `httponly`, and `SameSite=Lax` cookie parameters. `Lax` (rather than `Strict`) is used so that shared links work correctly on first click from an external page.
- **Origin Validation**: All proxy scripts validate the `Origin` header and only set CORS headers for `mlb.sanvash.com` or local development environments.
- **Geo-Gated Sportsnet**: Sportsnet broadcasts are only surfaced to confirmed Canadian users. The geo-check is fail-closed — if the detection request fails for any reason, Sportsnet is skipped entirely.

## 🎯 Goal

The primary goal of this project is to turn a manual tracking process into a seamless, automated experience. It's a practical use case for developing AI-assisted coding skills while building a tool that provides real, daily value to a baseball fan.
