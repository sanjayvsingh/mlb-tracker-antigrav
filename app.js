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

function isOfficialMLBTeam(fullName) {
    return [...MLB_OFFICIAL_NAMES].some(n => fullName.includes(n));
}

function getLocalDateString(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// State
let myUnseenTeams = []; 
let allTeamsDetailed = []; // From standings
let gamesData = { today: [], tomorrow: [], dayafter: [] };
let activeTab = 'today';
let filters = { bothUnseen: false, featured: false };

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
        await fetchGoogleSheetTeams();
        loadStaticTeams();
        await fetchSchedule();
        
        renderSidebar();
        renderMetrics();
        renderTabs();
        renderGames();
    } catch (e) {
        console.error(e);
    }
}

function setupListeners() {
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
}

// 1. Google Sheets -> Unseen Teams
async function fetchGoogleSheetTeams() {
    const res = await fetch(SHEET_URL);
    if (!res.ok) throw new Error("Sheet fetch failed");
    const csv = await res.text();
    const lines = csv.split('\n').filter(l => l.trim().length > 0);
    lines.shift(); // shift header
    
    myUnseenTeams = [];
    for (const line of lines) {
        const cols = [];
        let cur = '';
        let inQuotes = false;
        
        for (let i = 0; i < line.length; i++) {
            if (line[i] === '"') {
                inQuotes = !inQuotes;
            } else if (line[i] === ',' && !inQuotes) {
                cols.push(cur);
                cur = '';
            } else {
                cur += line[i];
            }
        }
        cols.push(cur);
        
        if (cols.length > 13 && cols[13].trim()) {
            myUnseenTeams.push(cols[13].trim());
        }
    }
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
                unseen: isTeamMatch(tName)
            });
        });
    }
}

// 3. Schedule -> 3 Day Window
async function fetchSchedule() {
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
}

function processGame(game) {
    const away = game.teams.away.team.name;
    const home = game.teams.home.team.name;
    const awayOfficial = isOfficialMLBTeam(away);
    const homeOfficial = isOfficialMLBTeam(home);
    const awayUnseen = awayOfficial && isTeamMatch(away);
    const homeUnseen = homeOfficial && isTeamMatch(home);
    
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
    
    return {
        id: game.gamePk,
        date: new Date(game.gameDate),
        location: game.venue.name,
        away: { name: away, unseen: awayUnseen, official: awayOfficial, sp: game.teams.away.probablePitcher?.fullName || 'TBD' },
        home: { name: home, unseen: homeUnseen, official: homeOfficial, sp: game.teams.home.probablePitcher?.fullName || 'TBD' },
        bothUnseen: awayUnseen && homeUnseen,
        anyUnseen: awayUnseen || homeUnseen,
        allNetworks: allNetworks.length > 0 ? allNetworks.join(', ') : 'No TV Info',
        featuredNetworks: featuredNetworks
    };
}

// Rendering
function renderSidebar() {
    const divisions = {};
    let unseenCount = 0;
    
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
        const divTeams = divisions[div].sort((a,b) => a.name.localeCompare(b.name));
        const unseenInDiv = divTeams.filter(t => t.unseen).length;
        
        html += `
            <div class="division-group">
                <div class="division-header">
                    <span>${div}</span>
                    <span class="division-counts">${unseenInDiv}/5 Unseen</span>
                </div>
                ${divTeams.map(t => `
                    <div class="team-checklist-item ${t.unseen ? 'is-unseen' : 'is-seen'}">
                        ${t.unseen ? '' : '<div class="custom-checkbox">✓</div>'}
                        ${t.name}
                    </div>
                `).join('')}
            </div>
        `;
    });
    dom.divisionsContainer.innerHTML = html;
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
        return true;
    });
    
    if (filtered.length === 0) {
        dom.gamesContainer.innerHTML = `<div class="error-msg">No games match this filter.</div>`;
        return;
    }
    
    dom.gamesContainer.innerHTML = filtered.map(g => {
        const timeStr = g.date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }) + ' ET';
        
        return `
            <div class="game-card-row">
                <div class="team-split">
                    <div class="matchup-team">
                        ${g.away.official ? (g.away.unseen ? `<span class="unseen-icon">👁</span>` : `<span class="seen-icon">✓</span>`) : ''}
                        <span class="team-name ${g.away.unseen ? 'unseen-text' : ''}">${g.away.name}</span>
                    </div>
                    <div class="matchup-team">
                        ${g.home.official ? (g.home.unseen ? `<span class="unseen-icon">👁</span>` : `<span class="seen-icon">✓</span>`) : ''}
                        <span class="team-name ${g.home.unseen ? 'unseen-text' : ''}">${g.home.name}</span>
                    </div>
                </div>
                
                <div class="pitcher-split">
                    <div>SP ${g.away.sp}</div>
                    <div>SP ${g.home.sp}</div>
                </div>
                
                <div class="game-meta">
                    <div class="game-time"><span class="score-box"></span> ${timeStr}</div>
                    <div class="game-location\">📺 ${g.allNetworks}</div>
                    ${g.bothUnseen ? `<div class="both-unseen-badge">★ BOTH UNSEEN</div>` : ''}
                    ${g.featuredNetworks.map(n => `<div class="network-badge">${n}</div>`).join('')}
                </div>
            </div>
        `;
    }).join('');
}

// Utils
function isTeamMatch(name) {
    return myUnseenTeams.some(u => name.toLowerCase().includes(u.toLowerCase()) || u.toLowerCase().includes(name.toLowerCase()));
}
function formatDateForTab(d, prefix) {
    return `${d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' })}`;
}

document.addEventListener('DOMContentLoaded', init);
