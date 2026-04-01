# Epic: MLB Tracker Application

## Overview
As a baseball fan and product manager, I want an application that tracks upcoming MLB games and highlights matchups featuring teams I haven't watched yet this season, so that I can easily achieve my goal of watching every MLB team play at least once a year.

## Prototype Reference
A working prototype exists using vanilla HTML, CSS, and JS. The goal for the offshore development team is to review the prototype and build a robust, scalable, and maintainable version of the application using modern web development practices while retaining all existing functionality.

---

## User Stories

### Epic 1: Data Integration & Backend APIs
**STORY 1.1: Fetch Live Schedule Data**
- **As a** user
- **I want** the application to fetch the live MLB schedule from the official MLB Stats API
- **So that** I have accurate data for games happening today, tomorrow, and the day after.
- **Acceptance Criteria:**
  - Retrieve games within a 3-day window starting from the current local date.
  - Include hydrated data for `probablePitcher` and `broadcasts`.

**STORY 1.2: Fetch Live Standings Data**
- **As a** user
- **I want** the application to fetch current MLB season standings from the MLB Stats API
- **So that** I can see the Win-Loss record and division ranking for every team.
- **Acceptance Criteria:**
  - Retrieve current regular-season standings.
  - Update team data with Wins, Losses, and Division Rank (1-5).

**STORY 1.3: Personal Progress Sync (Owner Data)**
- **As the** app owner
- **I want** the application to fetch my "unseen teams" base list from a specified Google Sheets CSV
- **So that** my long-term progress tracked in my spreadsheet is reflected in the app.
- **Acceptance Criteria:**
  - Load and parse CSV data from a predefined URL.
  - If the user is identified as the "owner" (via local storage flag), populate their unseen teams array based on the parsed CSV data.

---

### Epic 2: State Management & Sharing
**STORY 2.1: Friend Mode (Local Storage Progress)**
- **As a** friend/visitor
- **I want** to track my own unseen teams without affecting the owner's master sheet
- **So that** I can use the app to track my personal viewing goals interactively.
- **Acceptance Criteria:**
  - Unless identified as the owner, progress changes must be saved exclusively to the browser's Local Storage.
  - Allow users to reset their local tracking progress entirely.

**STORY 2.2: Shareable Links**
- **As a** user
- **I want** to generate a URL summarizing the teams I have already seen
- **So that** I can share my tracker status with friends.
- **Acceptance Criteria:**
  - Implement a "Share" button that copies a generated URL to the clipboard.
  - The URL must include a `?seen=TABBR,TABBR...` query parameter (using standard MLB team abbreviations).
  - When a visitor loads a URL with the `?seen` parameter, initialize their local state by removing those teams from the "unseen" list.

---

### Epic 3: User Interface & Dashboard
**STORY 3.1: Metrics Shelf Dashboard**
- **As a** user
- **I want** a quick, top-level dashboard indicating my season progress
- **So that** I am encouraged to complete my goal.
- **Acceptance Criteria:**
  - Display a "Season Goal" showing the number of teams seen out of 30, a percentage completion circle, and teams remaining.
  - Show a count of games in the 3-day window that feature unseen teams.
  - Show a count of "Top Priority" matchups (both teams are unseen).
  - Summarize total game counts for Today, Tomorrow, and Day After.

**STORY 3.2: Main Schedule View & Tabs**
- **As a** user
- **I want** games divided into Today, Tomorrow, and Day After tabs
- **So that** I can easily plan my viewing schedule.
- **Acceptance Criteria:**
  - The schedule defaults to the "Today" tab.
  - Clicking a tab filters the main feed to games on that specific date.
  - Dynamic badges on tabs must show the total number of games for that day.

**STORY 3.3: Sidebar Standings & Tracking Toggle**
- **As a** user
- **I want** a sidebar displaying teams grouped by division, sorted by rank
- **So that** I can scan league standings and see which teams I still need to watch.
- **Acceptance Criteria:**
  - Teams should be visually marked as "seen" (checked) or "unseen" (highlighted or no check).
  - Teams must show their win-loss record next to their name.
  - Double-clicking a team toggles its unseen/seen status. This status must instantly reflect everywhere else in the UI.
  - An icon should appear next to the team if their probable pitcher is flagged as "Electric" in an upcoming game.

---

### Epic 4: Game Cards & Badges
**STORY 4.1: Game Matchup Details**
- **As a** user
- **I want** to see the away and home team, location, start time, and probable pitchers for each game
- **So that** I know exactly who is playing, and when and where to watch.
- **Acceptance Criteria:**
  - Show the team names. Show an "eye" visibility icon next to the team if they are an "unseen" team.
  - Show the start time converted properly to Eastern Time (or local time).
  - Show probable pitchers.

**STORY 4.2: Game Prioritization & Badges**
- **As a** user
- **I want** special visual indicators highlighting "fun" games, games with "both teams unseen," TV broadcast availability, and "electric" starters
- **So that** the most exciting and relevant matchups instantly draw my attention.
- **Acceptance Criteria:**
  - **Fun Score Badge:** A dynamic score based on base team fun scores plus "electric starter" bonuses. (Highlight prominently if the score is >= 8).
  - **Both Unseen Badge:** Prominent badge if both the home and away teams are unseen.
  - **Electric Pitcher Label:** Add a lightning bolt next to the pitcher's name if they are on the "Electric Starters" list.
  - **Network Badges:** Display networks broadcasting the game, highlighting featured ones (e.g., Apple, Netflix, Peacock).

---

### Epic 5: Filtering Schedule
**STORY 5.1: Dynamic Game Filtering**
- **As a** user
- **I want** to toggle various filters (Fun Games, Both Unseen, Electric Starters, Featured Broadcasts)
- **So that** I can quickly narrow down the list of games to my specific interests.
- **Acceptance Criteria:**
  - All filters should be toggleable on/off and can be combined.
  - **Fun Games:** Shows only games with a Fun Score of 8 or higher.
  - **Both Unseen:** Shows only games where both teams are on my unseen list.
  - **Electric Starters:** Shows only games featuring at least one "electric" probable pitcher.
  - **Featured Broadcasts:** Shows only games airing on national/featured networks.
  - Show a "No games match" state if the resulting list is empty.

## Technical & Non-Functional Requirements
- Ensure responsive design; the layout must be functional and clean on a mobile device (411px width target).
- Utilize Material Icons for consistent graphic representation.
- Ensure state updates (toggling a team) recalculate metrics and redrawn games efficiently without full page reloads.
- Keep the design aesthetic aligning closely with the existing index.html and styles.css rules.
