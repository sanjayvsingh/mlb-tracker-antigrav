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

// State
let myUnseenTeams = []; 
let allTeamsDetailed = []; // From standings
let standingsData = null; // Store raw standings for record and rank
let gamesData = { today: [], tomorrow: [], dayafter: [] };
let activeTab = 'today';
let filters = { bothUnseen: false, featured: false, electric: false, funGames: false };

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
        await fetchSavedTeams();
        loadStaticTeams();
        await Promise.all([
            fetchStandings(), // Get current year standings
            fetchSchedule()
        ]);
    } catch (e) {
        console.error("Load error:", e);
    } finally {
        renderSidebar();
        renderMetrics();
        renderTabs();
        renderGames();

        // Footer tooltip
        const pauly = document.getElementById('pauly-sheep');
        if (pauly) {
            const sortedStarters = [...ELECTRIC_STARTERS].sort((a,b) => a.localeCompare(b));
            const listStr = sortedStarters.slice(0, -1).join(', ') + ', and ' + sortedStarters.slice(-1);
            pauly.title = `Electric starters are ${listStr}.`;
        }
    }
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

// 2.5 Standings -> Rank and Record
async function fetchStandings() {
    try {
        const year = new Date().getFullYear();
        const url = `${STATS_API_BASE}/standings?leagueId=103,104&season=${year}&standingsTypes=regularSeason`;
        const res = await fetch(url);
        const data = await res.json();
        
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
        const today = new Date();
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
                const games = dateObj.games.map(processGame);
                
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
    
    // Calculate Fun Score
    const awayNickname = allTeamsDetailed.find(t => away.includes(t.name) || t.name.includes(away))?.name || away;
    const homeNickname = allTeamsDetailed.find(t => home.includes(t.name) || t.name.includes(home))?.name || home;
    const awayFun = TEAM_FUN_SCORES[awayNickname] || 0;
    const homeFun = TEAM_FUN_SCORES[homeNickname] || 0;
    let gameFunScore = awayFun + homeFun;
    if (isElectricAway) gameFunScore += 1;
    if (isElectricHome) gameFunScore += 1;

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
        featuredNetworks: featuredNetworks
    };
}

// Rendering
function renderSidebar() {
    const divisions = {};
    let unseenCount = 0;
    
    // Check for teams with electric starters in the 3-day window
    const electricInfo = new Map(); // nickname -> { dateStr, pitcher }
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
    dom.metricSeen.textContent = seenCount;
    dom.metricRemaining.textContent = `${unseenCount} teams remaining`;
    dom.metricPercent.textContent = `${Math.round((seenCount/30)*100)}%`;
    if (seenCount === 30) dom.metricPercent.style.borderColor = "var(--accent-green)";

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
                    return `
                        <div class="team-checklist-item ${t.unseen ? 'is-unseen' : 'is-seen'}" data-team-name="${escapeHTML(t.name)}" style="cursor: pointer; user-select: none;" title="Double-click to toggle seen state">
                            ${t.unseen ? '' : '<div class="custom-checkbox"><span class="material-icons">check</span></div>'}
                            ${escapeHTML(t.name)}${electricIcon}${record}
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
    const d0 = new Date();
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
    const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
    
    // Apply filters
    const filtered = list.filter(g => {
        if (g.date < oneHourAgo) return false;
        if (filters.bothUnseen && !g.bothUnseen) return false;
        if (filters.featured && g.featuredNetworks.length === 0) return false;
        if (filters.electric && !g.anyElectric) return false;
        if (filters.funGames && !g.isHighFun) return false;
        return true;
    });
    
    if (filtered.length === 0) {
        dom.gamesContainer.innerHTML = `<div class="error-msg">No games match this filter.</div>`;
        return;
    }
    
    dom.gamesContainer.innerHTML = filtered.map(g => {
        const timeStr = escapeHTML(g.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' ET');
        const badgesHtml = [
            `<div class="badge fun-badge" title="Fun Score: ${escapeHTML(g.funScore)} (Teams: ${escapeHTML(TEAM_FUN_SCORES[g.away.nickname])}+${escapeHTML(TEAM_FUN_SCORES[g.home.nickname])}, Electric Bonus: +${escapeHTML(g.funScore - (TEAM_FUN_SCORES[g.away.nickname] + TEAM_FUN_SCORES[g.home.nickname]))})"><span class="material-icons" style="color: inherit; font-size: 14px; vertical-align: middle; margin-right: 2px;">diamond</span>${escapeHTML(g.funScore)}</div>`,
            g.bothUnseen ? `<div class="badge both-unseen-badge"><span class="material-icons" style="font-size: inherit; vertical-align: middle; margin-right: 4px;">star</span>BOTH UNSEEN</div>` : '',
            g.anyElectric ? `<div class="badge electric-badge mobile-only"><span class="material-icons" style="font-size: 14px; vertical-align: middle; margin-right: 2px;">bolt</span>ELECTRIC SP</div>` : '',
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
                    <div class="game-location">${escapeHTML(g.location || '')}</div>
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

document.addEventListener('DOMContentLoaded', init);
