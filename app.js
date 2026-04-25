/**
 * MLB Tracker V2 - Client Side Logic
 */

const SHEET_URL = "https://docs.google.com/spreadsheets/d/1XTmkD-ms9UpE2KVNgp7eEOszJ5MX8oq_rUZ2tyuSlqI/export?format=csv";
const STATS_API_BASE = "https://statsapi.mlb.com/api/v1";

const MLB_OFFICIAL_NAMES = new Set([
    "Orioles", "Red Sox", "Yankees", "Rays", "Blue Jays",
    "White Sox", "Guardians", "Tigers", "Royals", "Twins",
    "Astros", "Angels", "Athletics", "Mariners", "Rangers",
    "Braves", "Marlins", "Mets", "Phillies", "Nationals",
    "Cubs", "Reds", "Brewers", "Pirates", "Cardinals",
    "Diamondbacks", "Rockies", "Dodgers", "Padres", "Giants"
]);

const ELECTRIC_STARTERS = [
    "Skenes", "Skubal", "Yamamoto", "Crochet", "Ohtani", "Misiorowski", 
	"deGrom", "Tong", "Yesavage", "Schlittler", "Greene", "Ragans",
	"Sanchez"
];

const TEAM_ABBR = {
    "Orioles": "BAL", "Red Sox": "BOS", "Yankees": "NYY", "Rays": "TBR", "Blue Jays": "TOR",
    "White Sox": "CHW", "Guardians": "CLE", "Tigers": "DET", "Royals": "KCR", "Twins": "MIN",
    "Astros": "HOU", "Angels": "LAA", "Athletics": "OAK", "Mariners": "SEA", "Rangers": "TEX",
    "Braves": "ATL", "Marlins": "MIA", "Mets": "NYM", "Phillies": "PHI", "Nationals": "WSN",
    "Cubs": "CHC", "Reds": "CIN", "Brewers": "MIL", "Pirates": "PIT", "Cardinals": "STL",
    "Diamondbacks": "ARI", "Rockies": "COL", "Dodgers": "LAD", "Padres": "SDP", "Giants": "SFG"
};

const ABBR_TO_TEAM = Object.fromEntries(Object.entries(TEAM_ABBR).map(([k, v]) => [v, k]));

const TEAM_FUN_SCORES = {
    "Dodgers": 5, "Athletics": 5, "Royals": 5, "Diamondbacks": 5, "Blue Jays": 5,
    "Red Sox": 4, "Braves": 4, "Mets": 4, "Reds": 4, "Phillies": 4,
    "Mariners": 4, "Cubs": 4, "Brewers": 4, "Orioles": 4,
    "Pirates": 3, "Tigers": 3, "Rangers": 3, "Padres": 3, "Rays": 3,
    "Yankees": 4, "Giants": 3, "Guardians": 2, "Twins": 2, "Astros": 2, "Cardinals": 2,
    "Angels": 1, "Rockies": 1, "White Sox": 1, "Marlins": 1, "Nationals": 1
};

function isOfficialMLBTeam(fullName) {
    return [...MLB_OFFICIAL_NAMES].some(n => fullName.includes(n));
}

function getLocalDateString(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Returns today's date, or a debug override via ?debugDate=YYYY-MM-DD
function getToday() {
    const params = new URLSearchParams(window.location.search);
    const debug = params.get('debugDate');
    if (debug) {
        const d = new Date(debug + 'T12:00:00'); // noon to avoid timezone edge cases
        if (!isNaN(d)) return d;
    }
    return new Date();
}

// Helper for caching heavy API requests
async function fetchJSONWithCache(url, ttlMs) {
    const cacheKey = `mlb_cache_${url}`;
    const cached = localStorage.getItem(cacheKey);
    if (cached) {
        try {
            const parsed = JSON.parse(cached);
            if (Date.now() - parsed.timestamp < ttlMs) {
                return parsed.data;
            }
        } catch (e) {}
    }
    const res = await fetch(url);
    if (!res.ok) throw new Error(`HTTP error! status: ${res.status}`);
    const data = await res.json();
    try {
        localStorage.setItem(cacheKey, JSON.stringify({ timestamp: Date.now(), data }));
    } catch (e) {
        console.warn("Storage full", e);
    }
    return data;
}

// State
let myUnseenTeams = [...MLB_OFFICIAL_NAMES]; 
let allTeamsDetailed = []; // From standings
let standingsData = null; // Store raw standings for record and rank
let gamesData = { today: [], tomorrow: [], dayafter: [] };
let activeTab = 'today';
let filters = { bothUnseen: false, featured: false, electric: false, funGames: false, showcase: false };
let hotHitters = new Map();     // team nickname -> [{name, stat}]
let milestoneWatch = new Map(); // team nickname -> [{name, description}]

// DOM Maps
const dom = {
    metricSeen: document.getElementById('metric-seen'),
    metricRemaining: document.getElementById('metric-remaining'),
    metricPercent: document.getElementById('metric-percent'),
    metric3Day: document.getElementById('metric-3day'),
    metricBoth: document.getElementById('metric-both'),
    metricToday: document.getElementById('metric-today'),
    metricFuture: document.getElementById('metric-future'),
    gamesContainer: document.getElementById('games-container'),
    divisionsContainer: document.getElementById('divisions-container'),
    sidebarRemaining: document.getElementById('sidebar-remaining'),
    sidebarCount: document.getElementById('sidebar-count')
};

async function init() {
    setupListeners();
    await loadEverything();
}

async function loadEverything() {
    try {
        loadStaticTeams();

        // Fire ALL network requests in parallel immediately
        const savedTeamsP = fetchSavedTeams();
        const standingsP = fetchStandings();
        const hotHittersP = fetchHotHittersAndMilestones();

        // Phase 1: Render games as soon as the schedule arrives
        // processGame works with defaults — unseen/fun scores may be approximate
        await fetchSchedule();
        renderSidebar();
        renderMetrics();
        renderTabs();
        renderGames();

        // Phase 2: Wait for enrichment data, then re-process for accurate scores
        await Promise.all([savedTeamsP, standingsP, hotHittersP]);
        reprocessAllGames();
        renderSidebar();
        renderMetrics();
        renderGames();

        // Phase 2.5: Apply Sportsnet featured broadcasts (non-blocking)
        fetchSportsnetGames(); // No await — runs in background

        // Phase 3: Fire Gemini in background (needs all enrichment data for prompt)
        const allGames = [...(gamesData.today || []), ...(gamesData.tomorrow || []), ...(gamesData.dayafter || [])];
        if (allGames.length > 0) {
            applyGeminiRecommendations(allGames); // No await — runs in background
        }
    } catch (e) {
        console.error("Load error:", e);
    } finally {
        // Footer tooltip
        const pauly = document.getElementById('pauly-sheep');
        if (pauly) {
            const sortedStarters = [...ELECTRIC_STARTERS].sort((a,b) => a.localeCompare(b));
            const listStr = sortedStarters.slice(0, -1).join(', ') + ', and ' + sortedStarters.slice(-1);
            pauly.title = `Electric starters are ${listStr}.`;
        }
    }
}

// Re-evaluate unseen status, fun scores, hot hitters, and milestones for all processed games
function reprocessAllGames() {
    [...gamesData.today, ...gamesData.tomorrow, ...gamesData.dayafter].forEach(g => {
        // Update unseen status
        g.away.unseen = g.away.official && isTeamMatch(g.away.name);
        g.home.unseen = g.home.official && isTeamMatch(g.home.name);
        g.bothUnseen = g.away.unseen && g.home.unseen;
        g.anyUnseen = g.away.unseen || g.home.unseen;

        // Recalculate fun score from scratch
        const awayFun = TEAM_FUN_SCORES[g.away.nickname] || 0;
        const homeFun = TEAM_FUN_SCORES[g.home.nickname] || 0;
        let score = awayFun + homeFun;
        if (g.away.electric) score += 1;
        if (g.home.electric) score += 1;

        // Hot hitters
        const awayHH = (hotHitters.get(g.away.nickname) || []).map(h => ({...h, team: g.away.nickname}));
        const homeHH = (hotHitters.get(g.home.nickname) || []).map(h => ({...h, team: g.home.nickname}));
        g.hotHitterInfo = [...awayHH, ...homeHH];
        score += g.hotHitterInfo.length;

        // Milestones
        const awayMS = (milestoneWatch.get(g.away.nickname) || []).map(m => ({...m, team: g.away.nickname}));
        const homeMS = (milestoneWatch.get(g.home.nickname) || []).map(m => ({...m, team: g.home.nickname}));
        g.milestoneInfo = [...awayMS, ...homeMS];
        score += g.milestoneInfo.length * 2;

        // Showcase bonus (preserve if already applied)
        if (g.isShowcase) score += 1;

        g.funScore = score;
        g.isHighFun = score >= 8;
    });

    // Update allTeamsDetailed unseen status to match
    allTeamsDetailed.forEach(t => {
        t.unseen = isTeamMatch(t.name);
    });
}


function setupListeners() {
    document.getElementById('filter-fun').addEventListener('click', (e) => {
        filters.funGames = !filters.funGames;
        e.currentTarget.classList.toggle('active');
        renderGames();
    });

    document.querySelectorAll('.tab-btn').forEach(btn => {
        btn.addEventListener('click', (e) => {
            document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
            const target = e.currentTarget;
            target.classList.add('active');
            activeTab = target.dataset.tab;
            renderGames();
        });
    });

    document.getElementById('filter-unseen').addEventListener('click', (e) => {
        filters.bothUnseen = !filters.bothUnseen;
        e.currentTarget.classList.toggle('active');
        renderGames();
    });

    document.getElementById('filter-broadcasts').addEventListener('click', (e) => {
        filters.featured = !filters.featured;
        e.currentTarget.classList.toggle('active');
        renderGames();
    });

    document.getElementById('filter-electric').addEventListener('click', (e) => {
        filters.electric = !filters.electric;
        e.currentTarget.classList.toggle('active');
        renderGames();
    });

    document.getElementById('filter-showcase').addEventListener('click', (e) => {
        filters.showcase = !filters.showcase;
        e.currentTarget.classList.toggle('active');
        renderGames();
    });

    const shareBtn = document.getElementById('share-link-btn');
    if (shareBtn) {
        shareBtn.addEventListener('click', () => {
            const seenTeams = [...MLB_OFFICIAL_NAMES].filter(t => !myUnseenTeams.some(u => u.toLowerCase() === t.toLowerCase()));
            const seenCodes = seenTeams.map(t => TEAM_ABBR[t] || t);
            // Manually construct the URL to keep literal commas instead of %2C
            const urlStr = `${window.location.origin}${window.location.pathname}?seen=${seenCodes.join(',')}`;
            navigator.clipboard.writeText(urlStr).then(() => {
                const originalHtml = shareBtn.innerHTML;
                shareBtn.innerHTML = '<span class="material-icons" style="font-size: 18px; color: var(--accent-green); margin-right: 6px; vertical-align: middle;">check</span> <span class="filter-text" style="font-weight: 500; vertical-align: middle;">Copied!</span>';
                setTimeout(() => shareBtn.innerHTML = originalHtml, 2000);
            });
        });
    }

    const resetBtn = document.getElementById('reset-btn');
    if (resetBtn) {
        resetBtn.addEventListener('click', () => {
            if (confirm("Clear all locally saved progress and tracking?")) {
                localStorage.clear();
                window.location.href = window.location.origin + window.location.pathname;
            }
        });
    }

    // Event delegation for toggling team seen state
    dom.divisionsContainer.addEventListener('dblclick', (e) => {
        const teamItem = e.target.closest('.team-checklist-item');
        if (teamItem) {
            const teamName = teamItem.dataset.teamName;
            if (teamName) toggleTeamSeen(teamName);
            window.getSelection().removeAllRanges(); // clear accidental text selection
        }
    });
}

/// 1. Google Sheet Fetcher Helper
async function fetchGoogleSheet() {
    try {
        const res = await fetch(SHEET_URL);
        if (!res.ok) {
            console.warn("Sheet fetch failed (Status: " + res.status + ")");
            myUnseenTeams = [...MLB_OFFICIAL_NAMES];
            return;
        }
        const csv = await res.text();
        const lines = csv.split('\n').filter(l => l.trim().length > 0);
        lines.shift(); // shift header
        
        myUnseenTeams = [];
        for (const line of lines) {
            const cols = [];
            let cur = '';
            let inQuotes = false;
            for (let i = 0; i < line.length; i++) {
                if (line[i] === '"') inQuotes = !inQuotes;
                else if (line[i] === ',' && !inQuotes) { cols.push(cur); cur = ''; }
                else cur += line[i];
            }
            cols.push(cur);
            if (cols.length > 13 && cols[13].trim()) {
                myUnseenTeams.push(cols[13].trim());
            }
        }
    } catch (e) {
        console.error("Failed to load spreadsheet.", e);
        myUnseenTeams = [...MLB_OFFICIAL_NAMES]; 
    }
}

// 2. Saved Teams (Owner vs Friends)
async function fetchSavedTeams() {
    const urlParams = new URLSearchParams(window.location.search);
    
    // Check for owner initialization
    if (urlParams.get('u') === 's') {
        localStorage.setItem('mlbTrackerOwner', 'true');
        urlParams.delete('u');
        const newUrl = window.location.origin + window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, document.title, newUrl);
    }
    
    const isOwner = localStorage.getItem('mlbTrackerOwner') === 'true';
    const seenParam = urlParams.get('seen');
    
    // Rule 1: Shared Links (?seen=)
    if (seenParam !== null) {
        const seenList = seenParam.split(',').map(s => {
            const code = s.trim().toUpperCase();
            return (ABBR_TO_TEAM[code] || s.trim()).toLowerCase();
        });
        myUnseenTeams = [...MLB_OFFICIAL_NAMES].filter(t => !seenList.includes(t.toLowerCase()));
        
        if (!isOwner) {
            localStorage.setItem('mlbTrackerSeen', JSON.stringify(seenList));
        }
        urlParams.delete('seen');
        const newUrl = window.location.origin + window.location.pathname + (urlParams.toString() ? '?' + urlParams.toString() : '');
        window.history.replaceState({}, document.title, newUrl);
        return;
    }
    
    // Rule 2: Owners always get the Google Sheet
    if (isOwner) {
        await fetchGoogleSheet();
        return;
    }
    
    // Rule 3: Friends get their personal Local Storage
    const localSeen = localStorage.getItem('mlbTrackerSeen');
    if (localSeen) {
        try {
            const seenList = JSON.parse(localSeen);
            myUnseenTeams = [...MLB_OFFICIAL_NAMES].filter(t => !seenList.includes(t.toLowerCase()));
            return;
        } catch(e) {}
    }
    
    // Rule 4: Blank Slate for new friends
    myUnseenTeams = [...MLB_OFFICIAL_NAMES];
}

// 2. Load 30 Teams Statically
function loadStaticTeams() {
    const MLB_TEAMS_STATIC = {
        "AL East": ["Orioles", "Red Sox", "Yankees", "Rays", "Blue Jays"],
        "AL Central": ["White Sox", "Guardians", "Tigers", "Royals", "Twins"],
        "AL West": ["Astros", "Angels", "Athletics", "Mariners", "Rangers"],
        "NL East": ["Braves", "Marlins", "Mets", "Phillies", "Nationals"],
        "NL Central": ["Cubs", "Reds", "Brewers", "Pirates", "Cardinals"],
        "NL West": ["Diamondbacks", "Rockies", "Dodgers", "Padres", "Giants"]
    };
    
    allTeamsDetailed = [];
    for (const [div, teams] of Object.entries(MLB_TEAMS_STATIC)) {
        teams.forEach(tName => {
            allTeamsDetailed.push({
                name: tName,
                division: div,
                unseen: isTeamMatch(tName),
                wins: 0,
                losses: 0,
                rank: 99
            });
        });
    }
}

// 2.5 Hot Hitters & Milestone Watch
async function fetchHotHittersAndMilestones() {
    const year = getToday().getFullYear();

    // --- HOT HITTERS: season leaders in HR, SLG, and OPS ---
    try {
        // Use a smaller pool early in the season when sample sizes are tiny
        const now = getToday();
        const may1 = new Date(now.getFullYear(), 4, 1); // month is 0-indexed
        const leaderLimit = now < may1 ? 3 : 5;

        const url = `${STATS_API_BASE}/stats/leaders?leaderCategories=homeRuns,sluggingPercentage,onBasePlusSlugging&statGroup=hitting&limit=${leaderLimit}&season=${year}`;
        const TTL_12H = 12 * 60 * 60 * 1000;
        const data = await fetchJSONWithCache(url, TTL_12H);
        (data.leagueLeaders || []).forEach(cat => {
            (cat.leaders || []).forEach(leader => {
                const nickname = findNicknameFromApiName(leader.team?.name);
                if (!nickname) return;
                if (!hotHitters.has(nickname)) hotHitters.set(nickname, []);
                const rawVal = leader.value || '0';
                let statLabel;
                if (cat.leaderCategory === 'homeRuns') {
                    statLabel = `${rawVal} HR`;
                } else if (cat.leaderCategory === 'sluggingPercentage') {
                    statLabel = `${parseFloat(rawVal).toFixed(3).replace(/^0/, '')} SLG`;
                } else {
                    statLabel = `${parseFloat(rawVal).toFixed(3).replace(/^0/, '')} OPS`;
                }
                // Avoid duplicate player entries across categories
                const existing = hotHitters.get(nickname);
                if (!existing.some(h => h.name === leader.person.fullName)) {
                    existing.push({ name: leader.person.fullName, stat: statLabel });
                }
            });
        });
    } catch(e) {
        console.warn('Hot hitters fetch failed:', e);
    }

    // --- MILESTONES: career leaders approaching round-number thresholds ---
    const MILESTONE_DEFS = [
        { category: 'homeRuns',   group: 'hitting',  targets: [500, 600, 700], window: 1,  unit: 'career home runs' },
        { category: 'hits',       group: 'hitting',  targets: [3000, 4000],    window: 2,  unit: 'career hits' },
        { category: 'strikeouts', group: 'pitching', targets: [3000],          window: 6,  unit: 'career strikeouts' }
    ];

    await Promise.all(MILESTONE_DEFS.map(async ({ category, group, targets, window, unit }) => {
        try {
            // Fetch top 100 career leaders; active players near milestones will surface naturally
            const url = `${STATS_API_BASE}/stats/leaders?leaderCategories=${category}&statGroup=${group}&statType=career&limit=100`;
            const TTL_12H = 12 * 60 * 60 * 1000;
            const data = await fetchJSONWithCache(url, TTL_12H);
            ((data.leagueLeaders?.[0]?.leaders) || []).forEach(leader => {
                const value = parseInt(leader.value, 10);
                for (const target of targets) {
                    const gap = target - value;
                    if (gap > 0 && gap <= window) {
                        const nickname = findNicknameFromApiName(leader.team?.name);
                        if (!nickname) return;
                        if (!milestoneWatch.has(nickname)) milestoneWatch.set(nickname, []);
                        milestoneWatch.get(nickname).push({
                            name: leader.person.fullName,
                            description: `${leader.person.fullName} needs ${gap} more to reach ${target.toLocaleString()} ${unit}`
                        });
                        break; // only flag the nearest milestone
                    }
                }
            });
        } catch(e) {
            console.warn(`Milestone fetch for ${category} failed:`, e);
        }
    }));
}

function findNicknameFromApiName(apiTeamName) {
    if (!apiTeamName) return null;
    const team = allTeamsDetailed.find(t => apiTeamName.includes(t.name) || t.name.includes(apiTeamName));
    return team?.name || null;
}

// 2.5 Standings -> Rank and Record
async function fetchStandings() {
    try {
        const year = getToday().getFullYear();
        const url = `${STATS_API_BASE}/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason`;
        const TTL_1H = 60 * 60 * 1000;
        const data = await fetchJSONWithCache(url, TTL_1H);
        
        if (data && data.records && data.records.length > 0) {
            standingsData = data.records;
            
            let anyTeamHasRecord = false;
            
            // Map stats back to allTeamsDetailed
            data.records.forEach(divRecord => {
                divRecord.teamRecords.forEach(tr => {
                    const apiName = tr.team.name;
                    const team = allTeamsDetailed.find(t => 
                        t.name.includes(apiName) || 
                        apiName.includes(t.name) ||
                        (t.name === "Diamondbacks" && apiName.toLowerCase().includes("d-back"))
                    );
                    if (team) {
                        team.wins = tr.wins;
                        team.losses = tr.losses;
                        team.rank = parseInt(tr.divisionRank);
                        if (tr.wins > 0 || tr.losses > 0) anyTeamHasRecord = true;
                    }
                });
            });

            // If ANY team has a record, then everyone should show a record (even if 0-0)
            if (anyTeamHasRecord || data.records.some(r => r.teamRecords.length > 0)) {
                allTeamsDetailed.forEach(t => {
                    t.hasRecord = true;
                });
            }
        }
    } catch (e) {
        console.error("Failed to fetch standings:", e);
    }
}

// 3. Schedule -> 3 Day Window
async function fetchSchedule() {
    try {
        const today = getToday();
        const tomorrow = new Date(today); tomorrow.setDate(today.getDate() + 1);
        const dayAfter = new Date(today); dayAfter.setDate(today.getDate() + 2);

        const d0Str = getLocalDateString(today);
        const d1Str = getLocalDateString(tomorrow);
        const d2Str = getLocalDateString(dayAfter);
        
        const url = `${STATS_API_BASE}/schedule?sportId=1&startDate=${d0Str}&endDate=${d2Str}&hydrate=probablePitcher,broadcasts`;
        const res = await fetch(url);
        const data = await res.json();
        
        gamesData = { today: [], tomorrow: [], dayafter: [] };
        
        if (data.dates) {
            data.dates.forEach(dateObj => {
                const games = dateObj.games.map(processGame).sort((a,b) => a.date - b.date);
                
                if (dateObj.date === d0Str) gamesData.today = games;
                else if (dateObj.date === d1Str) gamesData.tomorrow = games;
                else if (dateObj.date === d2Str) gamesData.dayafter = games;
            });
        }
    } catch (e) {
        console.error("Failed to fetch schedule:", e);
    }
}

function processGame(game) {
    const away = game.teams.away.team.name;
    const home = game.teams.home.team.name;
    const awayOfficial = isOfficialMLBTeam(away);
    const homeOfficial = isOfficialMLBTeam(home);
    const awayUnseen = awayOfficial && isTeamMatch(away);
    const homeUnseen = homeOfficial && isTeamMatch(home);
    
    const awaySP = game.teams.away.probablePitcher?.fullName || 'TBD';
    const homeSP = game.teams.home.probablePitcher?.fullName || 'TBD';

    const isElectricAway = ELECTRIC_STARTERS.some(name => awaySP.includes(name));
    const isElectricHome = ELECTRIC_STARTERS.some(name => homeSP.includes(name));

    let featuredNetworks = [];
    let allNetworks = [];
    if (game.broadcasts) {
        game.broadcasts.forEach(b => {
            // Filter duplicates out of the list for clean UI
            if (!allNetworks.includes(b.name)) allNetworks.push(b.name);
            const n = b.name.toLowerCase();
            if (n.includes('apple') || n.includes('peacock') || n.includes('netflix') || n.includes('free')) {
                if (!featuredNetworks.includes(b.name)) featuredNetworks.push(b.name);
            }
        });
    }
    
    // Static featured events (from featured-events.js)
    const gameDateStr = game.gameDate.substring(0, 10); // e.g. "2026-04-15"
    let featuredEventBonus = 0;
    FEATURED_EVENTS.forEach(event => {
        if (!event.dates.includes(gameDateStr)) return;
        if (event.teams === null) {
            // All games on this date are featured (e.g. Jackie Robinson Day)
            if (!featuredNetworks.includes(event.label)) {
                featuredNetworks.push(event.label);
                featuredEventBonus++;
            }
        } else {
            // Both specified teams must be in this matchup
            const teamsInGame = [away, home];
            const allMatch = event.teams.every(t => teamsInGame.some(name => name.includes(t) || t.includes(name)));
            if (allMatch && !featuredNetworks.includes(event.label)) {
                featuredNetworks.push(event.label);
                featuredEventBonus++;
            }
        }
    });

    // Calculate Fun Score
    const awayNickname = allTeamsDetailed.find(t => away.includes(t.name) || t.name.includes(away))?.name || away;
    const homeNickname = allTeamsDetailed.find(t => home.includes(t.name) || t.name.includes(home))?.name || home;
    const awayFun = TEAM_FUN_SCORES[awayNickname] || 0;
    const homeFun = TEAM_FUN_SCORES[homeNickname] || 0;
    let gameFunScore = awayFun + homeFun;
    if (isElectricAway) gameFunScore += 1;
    if (isElectricHome) gameFunScore += 1;

    // Hot Hitters bonus (+1 per unique hot hitter in this game)
    const awayHotHitters = (hotHitters.get(awayNickname) || []).map(h => ({...h, team: awayNickname}));
    const homeHotHitters = (hotHitters.get(homeNickname) || []).map(h => ({...h, team: homeNickname}));
    const allGameHotHitters = [...awayHotHitters, ...homeHotHitters];
    gameFunScore += allGameHotHitters.length;

    // Milestone Watch bonus (+2 per milestone player in this game)
    const awayMilestones = (milestoneWatch.get(awayNickname) || []).map(m => ({...m, team: awayNickname}));
    const homeMilestones = (milestoneWatch.get(homeNickname) || []).map(m => ({...m, team: homeNickname}));
    const allGameMilestones = [...awayMilestones, ...homeMilestones];
    gameFunScore += allGameMilestones.length * 2;

    return {
        id: game.gamePk,
        date: new Date(game.gameDate),
        location: game.venue.name,
        funScore: gameFunScore,
        isHighFun: gameFunScore >= 8,
        away: { name: away, nickname: awayNickname, unseen: awayUnseen, official: awayOfficial, sp: awaySP, electric: isElectricAway },
        home: { name: home, nickname: homeNickname, unseen: homeUnseen, official: homeOfficial, sp: homeSP, electric: isElectricHome },
        bothUnseen: awayUnseen && homeUnseen,
        anyUnseen: awayUnseen || homeUnseen,
        anyElectric: isElectricAway || isElectricHome,
        allNetworks: allNetworks.length > 0 ? allNetworks.join(', ') : 'No TV Info',
        featuredNetworks: featuredNetworks,
        featuredEventBonus: featuredEventBonus,
        hotHitterInfo: allGameHotHitters,
        milestoneInfo: allGameMilestones
    };
}

// Rendering
function renderSidebar() {
    const divisions = {};
    let unseenCount = 0;
    
    // Check for teams with electric starters in the 3-day window
    const electricInfo = new Map(); // nickname -> { dateStr, pitcher }

    // Check for teams in featured events in the 3-day window
    const featuredTeamInfo = new Map(); // nickname -> event label
    [...gamesData.today, ...gamesData.tomorrow, ...gamesData.dayafter].forEach(g => {
        if (!g.featuredEventBonus) return;
        const eventLabel = g.featuredNetworks.find(n => FEATURED_EVENTS.some(e => e.label === n)) || 'Featured Event';
        if (g.away.nickname && !featuredTeamInfo.has(g.away.nickname)) featuredTeamInfo.set(g.away.nickname, eventLabel);
        if (g.home.nickname && !featuredTeamInfo.has(g.home.nickname)) featuredTeamInfo.set(g.home.nickname, eventLabel);
    });
    [...gamesData.today, ...gamesData.tomorrow, ...gamesData.dayafter].forEach(g => {
        const dateStr = formatDateForTab(g.date);
        
        // Find the nickname for away and home teams
        const awayNickname = g.away.nickname;
        const homeNickname = g.home.nickname;

        if (g.away.electric && awayNickname && !electricInfo.has(awayNickname)) {
            electricInfo.set(awayNickname, { date: dateStr, pitcher: g.away.sp });
        }
        if (g.home.electric && homeNickname && !electricInfo.has(homeNickname)) {
            electricInfo.set(homeNickname, { date: dateStr, pitcher: g.home.sp });
        }
    });
    
    allTeamsDetailed.forEach(team => {
        if (!divisions[team.division]) divisions[team.division] = [];
        divisions[team.division].push(team);
        if (team.unseen) unseenCount++;
    });
    
    // Header
    dom.sidebarRemaining.textContent = `${unseenCount} of 30 remaining`;
    dom.sidebarCount.textContent = unseenCount;
    
    // Metric Shelf Goal
    const seenCount = 30 - unseenCount;
    const percent = Math.round((seenCount/30)*100);
    dom.metricSeen.textContent = seenCount;
    dom.metricRemaining.textContent = `${unseenCount} teams remaining`;
    dom.metricPercent.textContent = `${percent}%`;
    dom.metricPercent.parentElement.style.setProperty('--progress', percent);
    if (seenCount === 30) dom.metricPercent.parentElement.style.borderColor = "var(--accent-green)";

    // Divisions HTML
    let html = '';
    const sortedDivs = ["AL East", "AL Central", "AL West", "NL East", "NL Central", "NL West"];
    sortedDivs.forEach(div => {
        // Sort by rank if we have it and it's not the default 99, else alphabetical
        const divTeams = divisions[div].sort((a,b) => {
            if (a.rank !== 99 && b.rank !== 99) return a.rank - b.rank;
            return a.name.localeCompare(b.name);
        });
        
        const unseenInDiv = divTeams.filter(t => t.unseen).length;
        
        html += `
            <div class="division-group">
                <div class="division-header">
                    <span>${escapeHTML(div)}</span>
                    <span class="division-counts">${unseenInDiv}/5 Unseen</span>
                </div>
                ${divTeams.map(t => {
                    const record = t.hasRecord ? `<span class="team-record">(${escapeHTML(t.wins)}-${escapeHTML(t.losses)})</span>` : '';
                    const info = electricInfo.get(t.name);
                    const electricIcon = info ? `<span class="material-icons sidebar-bolt" title="Electric starter: ${escapeHTML(info.pitcher)} (${escapeHTML(info.date)})">bolt</span>` : '';
                    const featuredLabel = featuredTeamInfo.get(t.name);
                    const featuredIcon = featuredLabel ? `<span class="material-icons sidebar-featured" title="Featured game: ${escapeHTML(featuredLabel)}">diamond</span>` : '';
                    return `
                        <div class="team-checklist-item ${t.unseen ? 'is-unseen' : 'is-seen'}" data-team-name="${escapeHTML(t.name)}" style="cursor: pointer; user-select: none;" title="Double-click to toggle seen state">
                            ${t.unseen ? '' : '<div class="custom-checkbox"><span class="material-icons">check</span></div>'}
                            ${escapeHTML(t.name)}${electricIcon}${featuredIcon}${record}
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    });
    dom.divisionsContainer.innerHTML = html;
}

function toggleTeamSeen(teamName) {
    const isOwner = localStorage.getItem('mlbTrackerOwner') === 'true';
    const isUnseen = myUnseenTeams.some(u => u.toLowerCase() === teamName.toLowerCase());
    if (isUnseen) {
        myUnseenTeams = myUnseenTeams.filter(u => u.toLowerCase() !== teamName.toLowerCase());
    } else {
        myUnseenTeams.push(teamName);
    }
    
    // Friends save their state to localStorage
    if (!isOwner) {
        const seenTeams = [...MLB_OFFICIAL_NAMES].filter(t => !myUnseenTeams.some(u => u.toLowerCase() === t.toLowerCase()));
        localStorage.setItem('mlbTrackerSeen', JSON.stringify(seenTeams));
    }
    
    const teamObj = allTeamsDetailed.find(t => t.name === teamName);
    if (teamObj) teamObj.unseen = !isUnseen;
    
    // Re-evaluate game objects
    [...gamesData.today, ...gamesData.tomorrow, ...gamesData.dayafter].forEach(g => {
        g.away.unseen = isTeamMatch(g.away.name);
        g.home.unseen = isTeamMatch(g.home.name);
        g.bothUnseen = g.away.unseen && g.home.unseen;
        g.anyUnseen = g.away.unseen || g.home.unseen;
    });
    
    // Re-render affected parts
    renderSidebar();
    renderMetrics();
    renderGames();
}

function renderMetrics() {
    // Collect all games in 3-day
    const all = [...gamesData.today, ...gamesData.tomorrow, ...gamesData.dayafter];
    
    const anyUnseenCount = all.filter(g => g.anyUnseen).length;
    const bothUnseenCount = all.filter(g => g.bothUnseen).length;
    
    dom.metric3Day.textContent = anyUnseenCount;
    dom.metricBoth.textContent = bothUnseenCount;
    
    dom.metricToday.textContent = gamesData.today.length;
    dom.metricFuture.textContent = `${gamesData.tomorrow.length} tomorrow • ${gamesData.dayafter.length} day after`;
}

function renderTabs() {
    // Just populate dates dynamically onto the tabs
    const d0 = getToday();
    const d1 = new Date(d0); d1.setDate(d0.getDate() + 1);
    const d2 = new Date(d0); d2.setDate(d0.getDate() + 2);
    
    document.getElementById('tab-date-0').textContent = formatDateForTab(d0, "Today");
    document.getElementById('tab-date-1').textContent = formatDateForTab(d1, "Tomorrow");
    document.getElementById('tab-date-2').textContent = formatDateForTab(d2, "Day After");
    
    document.getElementById('badge-today').textContent = gamesData.today.length;
    document.getElementById('badge-tomorrow').textContent = gamesData.tomorrow.length;
    document.getElementById('badge-dayafter').textContent = gamesData.dayafter.length;
}

function renderGames() {
    const list = gamesData[activeTab] || [];
    const oneHourAgo = new Date(getToday() - 60 * 60 * 1000);
    
    // Apply filters
    const filtered = list.filter(g => {
        if (g.date < oneHourAgo) return false;
        if (filters.bothUnseen && !g.bothUnseen) return false;
        if (filters.featured && g.featuredNetworks.length === 0) return false;
        if (filters.electric && !g.anyElectric) return false;
        if (filters.funGames && !g.isHighFun) return false;
        if (filters.showcase && !g.isShowcase) return false;
        return true;
    });
    
    if (filtered.length === 0) {
        dom.gamesContainer.innerHTML = `<div class="error-msg">No games match this filter.</div>`;
        return;
    }
    
    dom.gamesContainer.innerHTML = filtered.map(g => {
        const timeStr = escapeHTML(g.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' ET');
        const funTooltip = (() => {
            const components = [];
            const awayScore = TEAM_FUN_SCORES[g.away.nickname] || 0;
            const homeScore = TEAM_FUN_SCORES[g.home.nickname] || 0;
            const electric = (g.away.electric ? 1 : 0) + (g.home.electric ? 1 : 0);
            const hotBonus = g.hotHitterInfo.length;
            const milestoneBonus = g.milestoneInfo.length * 2;
            
            if (awayScore > 0) components.push(`${awayScore} ${g.away.nickname}`);
            if (homeScore > 0) components.push(`${homeScore} ${g.home.nickname}`);
            if (electric > 0) components.push(`+${electric} Electric starter`);
            if (hotBonus > 0) components.push(`+${hotBonus} Hot hitters`);
            if (milestoneBonus > 0) components.push(`+${milestoneBonus} Milestones`);
            if (g.isShowcase) components.push(`+1 Showcase game`);
            
            return `Fun score: ${g.funScore}${components.length > 0 ? ` (${components.join(', ')})` : ''}`;
        })();
        const hotHitterTooltip = g.hotHitterInfo.map(h => `${h.name} (${h.stat})`).join(', ');
        const milestoneTooltip = g.milestoneInfo.map(m => m.description).join(' • ');
        const badgesHtml = [
            `<div class="badge fun-badge" title="${escapeHTML(funTooltip)}"><span class="material-icons" style="color: inherit; font-size: 14px; vertical-align: middle; margin-right: 2px;">diamond</span>${escapeHTML(g.funScore)}</div>`,
            g.isShowcase ? `<div class="badge showcase-badge" title="${escapeHTML(g.showcaseReason)}"><span class="material-icons" style="font-size: 14px; vertical-align: middle; margin-right: 2px;">auto_awesome</span>SHOWCASE</div>` : '',
            g.bothUnseen ? `<div class="badge both-unseen-badge"><span class="material-icons" style="font-size: inherit; vertical-align: middle; margin-right: 4px;">star</span>BOTH UNSEEN</div>` : '',
            g.anyElectric ? `<div class="badge electric-badge mobile-only"><span class="material-icons" style="font-size: 14px; vertical-align: middle; margin-right: 2px;">bolt</span>ELECTRIC SP</div>` : '',
            g.hotHitterInfo.length > 0 ? `<div class="badge hot-hitter-badge" title="${escapeHTML(hotHitterTooltip)}"><span class="material-icons" style="color: inherit; font-size: 14px; vertical-align: middle; margin-right: 2px;">local_fire_department</span>HOT BATS</div>` : '',
            g.milestoneInfo.length > 0 ? `<div class="badge milestone-badge" title="${escapeHTML(milestoneTooltip)}"><span class="material-icons" style="color: inherit; font-size: 14px; vertical-align: middle; margin-right: 2px;">emoji_events</span>MILESTONE</div>` : '',
            ...g.featuredNetworks.map(n => `<div class="badge network-badge">${escapeHTML(n)}</div>`)
        ].join('');
        
        return `
            <div class="game-card-row">
                <div class="team-split">
                    <div class="matchup-team">
                        ${g.away.official ? (g.away.unseen ? `<span class="material-icons unseen-icon">visibility</span>` : `<span class="material-icons seen-icon">check</span>`) : ''}
                        <span class="team-name ${g.away.unseen ? 'unseen-text' : ''}">${escapeHTML(g.away.name)}</span>
                    </div>
                    <div class="matchup-team">
                        ${g.home.official ? (g.home.unseen ? `<span class="material-icons unseen-icon">visibility</span>` : `<span class="material-icons seen-icon">check</span>`) : ''}
                        <span class="team-name ${g.home.unseen ? 'unseen-text' : ''}">${escapeHTML(g.home.name)}</span>
                    </div>
                </div>
                
                <div class="pitcher-split">
                    <div class="${g.away.electric ? 'electric-sp' : ''}">
                        ${escapeHTML(g.away.sp)} ${g.away.electric ? '<span class="material-icons electric-star">bolt</span>' : ''}
                    </div>
                    <div class="${g.home.electric ? 'electric-sp' : ''}">
                        ${escapeHTML(g.home.sp)} ${g.home.electric ? '<span class="material-icons electric-star">bolt</span>' : ''}
                    </div>
                </div>
                
                <div class="game-meta">
                    <div class="game-time">${timeStr}</div>
                    <div class="game-badges">
                        ${badgesHtml}
                    </div>
                </div>
            </div>
        `;
    }).join('');
}

// Utils
function escapeHTML(str) {
    if (str === null || str === undefined) return '';
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

function isTeamMatch(name) {
    return myUnseenTeams.some(u => name.toLowerCase().includes(u.toLowerCase()) || u.toLowerCase().includes(name.toLowerCase()));
}
function formatDateForTab(d, prefix) {
    return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }).replace(',', '')}`;
}

function showToast(type) {
    const existing = document.getElementById('gemini-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.id = 'gemini-toast';
    toast.className = `toast-notification ${type === 'success' ? 'toast-success success-anim' : 'toast-error error-anim'}`;
    
    const icon = document.createElement('span');
    icon.className = 'material-icons toast-icon';
    icon.textContent = 'auto_awesome';

    const text = document.createElement('span');
    text.className = 'toast-text';
    text.textContent = type === 'success' ? 'Showcase Games Loaded' : 'Showcase Loading Error';

    toast.appendChild(icon);
    toast.appendChild(text);
    document.body.appendChild(toast);

    setTimeout(() => {
        if (toast.parentNode) toast.remove();
    }, type === 'success' ? 3000 : 5000);
}

async function applyGeminiRecommendations(gamesList) {
    if (!gamesList || gamesList.length === 0) return;
    
    const params = new URLSearchParams(window.location.search);
    const debugDate = params.get('debugDate');

    // Build team context: standings, hot hitters, milestones
    const teamContext = {};
    allTeamsDetailed.forEach(t => {
        const abbr = TEAM_ABBR[t.name];
        if (!abbr) return;
        const ctx = {
            record: `${t.wins}-${t.losses}`,
            div: t.division,
            rank: t.rank !== 99 ? t.rank : null
        };
        const hh = hotHitters.get(t.name);
        if (hh && hh.length > 0) {
            ctx.hot = hh.map(h => `${h.name} (${h.stat})`);
        }
        const ms = milestoneWatch.get(t.name);
        if (ms && ms.length > 0) {
            ctx.milestones = ms.map(m => m.description);
        }
        teamContext[abbr] = ctx;
    });

    const payload = {
        debugDate: debugDate,
        teamContext: teamContext,
        games: gamesList.map(g => ({
            date: getLocalDateString(g.date),
            away: TEAM_ABBR[g.away.nickname || g.away.name] || g.away.nickname || g.away.name,
            home: TEAM_ABBR[g.home.nickname || g.home.name] || g.home.nickname || g.home.name,
            awaySp: g.away.sp,
            homeSp: g.home.sp
        }))
    };

    try {
        const res = await fetch('gemini.php', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        
        if (!res.ok) {
            const errData = await res.json().catch(() => ({}));
            console.warn("Gemini API call failed:", errData);
            showToast('error');
            return;
        }
        
        const text = await res.text();
        const cleanText = text.replace(/```json/g, '').replace(/```/g, '').trim();
        const data = JSON.parse(cleanText);
        
        if (data && data.games) {
            if (data.from_cache) {
                console.log(`[Gemini Proxy] Results loaded from cache.`);
            }
            if (data.model_used) {
                console.log(`[Gemini Proxy] Response generated using model: ${data.model_used}`);
            }
            const allStorage = [gamesData.today, gamesData.tomorrow, gamesData.dayafter];
            data.games.forEach(reco => {
                const awayTeam = reco.a || reco.awayTeam;
                const homeTeam = reco.h || reco.homeTeam;
                const recoDate = reco.date || reco.d;
                const reason = reco.r || reco.reason;

                console.log(`Gemini reco: ${awayTeam} @ ${homeTeam} on ${recoDate} - ${reason}`);

                allStorage.forEach(dayList => {
                    if (!dayList) return;
                    const match = dayList.find(g => {
                        const aCode = TEAM_ABBR[g.away.nickname || g.away.name] || g.away.nickname || g.away.name;
                        const hCode = TEAM_ABBR[g.home.nickname || g.home.name] || g.home.nickname || g.home.name;
                        const isMatch = (aCode === awayTeam || aCode === TEAM_ABBR[awayTeam]) && 
                                        (hCode === homeTeam || hCode === TEAM_ABBR[homeTeam]);
                                        
                        if (!isMatch) return false;
                        
                        if (recoDate) {
                            return getLocalDateString(g.date) === recoDate;
                        }
                        return true;
                    });
                    
                    if (match) {
                        console.log(`Matched! Added to game ${match.id}`);
                        match.funScore += 1;
                        match.isHighFun = match.funScore >= 8;
                        match.isShowcase = true;
                        match.showcaseReason = reason;
                    }
                });
            });
            // Re-render once matches are applied
            renderGames();
            showToast('success');
        } else {
            showToast('error');
        }
    } catch (e) {
        console.warn("Skipping Gemini recommendations locally:", e);
        showToast('error');
    }
}

// Sportsnet name -> MLB nickname mapping
// Sportsnet uses city names (e.g., "Cleveland", "Toronto") while MLB API uses
// full names ("Cleveland Guardians"). This lookup handles ambiguous cities.
const SPORTSNET_TEAM_MAP = {
    'New York Yankees': 'Yankees',
    'New York Mets': 'Mets',
    'Chicago Cubs': 'Cubs',
    'Chicago White Sox': 'White Sox',
    'Los Angeles Dodgers': 'Dodgers',
    'Los Angeles Angels': 'Angels',
    'Los Angeles': 'Dodgers',
    'Cleveland': 'Guardians',
    'Toronto': 'Blue Jays',
    'Boston': 'Red Sox',
    'Houston': 'Astros',
    'Baltimore': 'Orioles',
    'Detroit': 'Tigers',
    'Minnesota': 'Twins',
    'Seattle': 'Mariners',
    'Texas': 'Rangers',
    'Oakland': 'Athletics',
    'Atlanta': 'Braves',
    'Miami': 'Marlins',
    'Philadelphia': 'Phillies',
    'Washington': 'Nationals',
    'Cincinnati': 'Reds',
    'Milwaukee': 'Brewers',
    'Pittsburgh': 'Pirates',
    'St. Louis': 'Cardinals',
    'Arizona': 'Diamondbacks',
    'Colorado': 'Rockies',
    'San Diego': 'Padres',
    'San Francisco': 'Giants',
    'Tampa Bay': 'Rays',
    'Kansas City': 'Royals',
    // Also map full team names
    'New York': 'Yankees' // Fallback — Sportsnet typically specifies "New York Yankees" or "New York Mets"
};

function sportsnetToNickname(snName) {
    if (!snName) return null;
    // Direct lookup first
    if (SPORTSNET_TEAM_MAP[snName]) return SPORTSNET_TEAM_MAP[snName];
    // Try partial matching
    for (const [key, val] of Object.entries(SPORTSNET_TEAM_MAP)) {
        if (snName.includes(key) || key.includes(snName)) return val;
    }
    // Last resort: check if the name IS a nickname already
    if (MLB_OFFICIAL_NAMES.has(snName)) return snName;
    return null;
}

async function fetchSportsnetGames() {
    try {
        // Only show Sportsnet broadcasts for Canadian users
        try {
            const geoRes = await fetch('https://ipapi.co/json/', { signal: AbortSignal.timeout(3000) });
            if (geoRes.ok) {
                const geo = await geoRes.json();
                const country = geo.country_code || geo.country || 'unknown';
                console.log(`[Sportsnet] User detected in ${geo.country_name || country}`);
                if (country !== 'CA') {
                    console.log('[Sportsnet] Skipping — Sportsnet broadcasts are Canada-only');
                    return;
                }
            }
        } catch (geoErr) {
            // If geo-detection fails, proceed anyway (fail-open)
            console.warn('[Sportsnet] Geo-detection failed, proceeding:', geoErr.message);
        }

        const res = await fetch('sportsnet.php');
        if (!res.ok) {
            console.warn('Sportsnet fetch failed:', res.status);
            return;
        }
        const data = await res.json();
        if (data.from_cache) {
            console.log('[Sportsnet] Loaded from cache');
        }
        if (!data.games || data.games.length === 0) {
            console.log('[Sportsnet] No games found');
            return;
        }

        console.log(`[Sportsnet] ${data.games.length} broadcasts available`);

        const allSchedule = [...gamesData.today, ...gamesData.tomorrow, ...gamesData.dayafter];
        let matched = 0;
        const claimedIds = new Set(); // Track games already matched to avoid duplicates

        data.games.forEach(snGame => {
            const awayNick = sportsnetToNickname(snGame.away);
            const homeNick = sportsnetToNickname(snGame.home);
            if (!awayNick || !homeNick) {
                console.warn(`[Sportsnet] Could not map: ${snGame.away} @ ${snGame.home}`);
                return;
            }

            // Find an unclaimed matching game in the schedule
            const match = allSchedule.find(g => {
                if (claimedIds.has(g.id)) return false;
                const gAway = g.away.nickname;
                const gHome = g.home.nickname;
                return gAway === awayNick && gHome === homeNick;
            });

            if (match) {
                claimedIds.add(match.id);
                // Add Sportsnet to featured networks if not already there
                if (!match.featuredNetworks.includes('Sportsnet')) {
                    match.featuredNetworks.push('Sportsnet');
                    matched++;
                }
                // Store the Sportsnet URL for potential linking
                if (snGame.url) {
                    match.sportsnetUrl = snGame.url;
                }
            }
        });

        if (matched > 0) {
            console.log(`[Sportsnet] Matched ${matched} games in 3-day window`);
            renderGames();
        }
    } catch (e) {
        console.warn('Sportsnet integration skipped:', e);
    }
}

document.addEventListener('DOMContentLoaded', init);
