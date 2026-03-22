/**
 * MLB Tracker - Client Side Logic
 */

// Constants
const MOCK_DATE = "2026-03-26"; // Used to simulate Opening Day when testing
const SHEET_URL = "https://docs.google.com/spreadsheets/d/1XTmkD-ms9UpE2KVNgp7eEOszJ5MX8oq_rUZ2tyuSlqI/export?format=csv";
const STATS_API_BASE = "https://statsapi.mlb.com/api/v1";

// State
let myTeams = [];
let upcomingGames = [];

// DOM Elements
const statusIndicator = document.getElementById('status-indicator');
const statusText = document.getElementById('status-text');
const teamsContainer = document.getElementById('teams-container');
const teamCount = document.getElementById('team-count');
const gamesContainer = document.getElementById('games-container');
const dateRangeEl = document.getElementById('date-range');

// Initialize App
async function init() {
    try {
        updateStatus('loading', 'Fetching my teams...');
        await fetchTeams();
        renderTeams();
        
        updateStatus('loading', 'Fetching live MLB games...');
        await fetchGames();
        renderGames();
        
        updateStatus('ready', 'Live synced');
    } catch (error) {
        console.error("Initialization error:", error);
        updateStatus('error', 'Error syncing data');
        gamesContainer.innerHTML = `<div class="error-msg">Failed to load data: ${error.message}</div>`;
        teamsContainer.innerHTML = `<div class="error-msg">Failed to load teams</div>`;
    }
}

// Update Header Status
function updateStatus(state, text) {
    statusIndicator.className = `status-indicator status-${state}`;
    statusText.textContent = text;
}

// 1. Fetch Google Sheets CSV
async function fetchTeams() {
    const response = await fetch(SHEET_URL);
    if (!response.ok) throw new Error("Failed to fetch Google Sheet");
    const csvText = await response.text();
    
    // Parse CSV: split by line, skip header, get column N (index 13)
    const lines = csvText.split('\n').map(l => l.trim()).filter(l => l.length > 0);
    const header = lines.shift(); // Remove header row
    
    const teams = new Set();
    for (const line of lines) {
        // Simple distinct column splitting (assuming no complex commas in team names)
        const cols = line.split(',');
        if (cols.length > 13) {
            let team = cols[13].trim();
            // Remove quotes if present
            if (team.startsWith('"') && team.endsWith('"')) {
                team = team.substring(1, team.length - 1);
            }
            if (team) {
                teams.add(team);
            }
        }
    }
    
    myTeams = Array.from(teams).sort();
    console.log("My Teams loaded:", myTeams);
}

// 2. Render Teams Sidebar
function renderTeams() {
    teamCount.textContent = myTeams.length;
    if (myTeams.length === 0) {
        teamsContainer.innerHTML = `<div class="team-pill" style="opacity: 0.6">No teams tracked</div>`;
        return;
    }
    
    teamsContainer.innerHTML = myTeams.map(team => `
        <div class="team-pill">
            <span class="team-dot" style="width:8px; height:8px; border-radius:50%; background:var(--accent-blue)"></span>
            ${team}
        </div>
    `).join('');
}

// 3. Fetch MLB API Games
async function fetchGames() {
    // Generate dates: today to today + 3 days
    // Using MOCK_DATE for testing purposes as real games start Mar 26
    const startDate = new Date(MOCK_DATE);
    const endDate = new Date(startDate);
    endDate.setDate(endDate.getDate() + 3);
    
    const formatDate = (date) => date.toISOString().split('T')[0];
    const startStr = formatDate(startDate);
    const endStr = formatDate(endDate);
    
    dateRangeEl.textContent = `${formatDateDisplay(startDate)} - ${formatDateDisplay(endDate)}`;
    
    const url = `${STATS_API_BASE}/schedule?sportId=1&startDate=${startStr}&endDate=${endStr}&hydrate=probablePitcher,broadcasts`;
    
    const response = await fetch(url);
    if (!response.ok) throw new Error("Failed to fetch MLB API");
    const data = await response.json();
    
    // Process and filter games
    const allGames = [];
    if (data.dates) {
        for (const dateObj of data.dates) {
            for (const game of dateObj.games) {
                allGames.push(game);
            }
        }
    }
    
    // Filter logic
    const oneHourAgo = Date.now() - (60 * 60 * 1000);
    
    upcomingGames = allGames.filter(game => {
        // Exclude games that started over an hour ago from *real* time
        const gameTime = new Date(game.gameDate).getTime();
        if (gameTime < oneHourAgo) return false;
        
        // Include if Home or Away team is in our "My Teams" list
        const awayTeam = game.teams.away.team.name;
        const homeTeam = game.teams.home.team.name;
        
        // Partial match allows for things like "Orioles" matching "Baltimore Orioles"
        const isMyTeam = (teamName) => {
            return myTeams.some(myTeam => 
                teamName.toLowerCase().includes(myTeam.toLowerCase()) || 
                myTeam.toLowerCase().includes(teamName.toLowerCase())
            );
        };
        
        return isMyTeam(awayTeam) || isMyTeam(homeTeam);
    });
    
    // Sort by chronological order
    upcomingGames.sort((a, b) => new Date(a.gameDate).getTime() - new Date(b.gameDate).getTime());
}

// 4. Render Games
function renderGames() {
    if (upcomingGames.length === 0) {
        gamesContainer.innerHTML = `
            <div class="no-games">
                <div style="font-size: 3rem; margin-bottom: 1rem;">📭</div>
                <h3>No Upcoming Games Found</h3>
                <p style="margin-top: 0.5rem">Check back later or add more teams to your Google Sheet.</p>
            </div>
        `;
        return;
    }
    
    gamesContainer.innerHTML = upcomingGames.map(game => {
        const gameDate = new Date(game.gameDate);
        const awayTeam = game.teams.away;
        const homeTeam = game.teams.home;
        
        // Extract Pitchers
        const awayPitcher = awayTeam.probablePitcher ? awayTeam.probablePitcher.fullName : 'TBD';
        const homePitcher = homeTeam.probablePitcher ? homeTeam.probablePitcher.fullName : 'TBD';
        
        // Discover Broadcasts (Apple TV, Peacock, etc)
        const broadcasts = [];
        if (game.broadcasts) {
            game.broadcasts.forEach(b => {
                const name = b.name.toLowerCase();
                if (name.includes('apple')) broadcasts.push({ name: 'Apple TV+', type: 'apple' });
                else if (name.includes('peacock')) broadcasts.push({ name: 'Peacock', type: 'peacock' });
                else if (name.includes('espn') || name.includes('fox') || name.includes('tbs') || name.includes('fs1')) {
                    // Only add national broadcasts if not already added to avoid duplicates
                    if (!broadcasts.some(br => br.name === b.name)) {
                        broadcasts.push({ name: b.name, type: 'national' });
                    }
                }
            });
        }
        
        // Status Check
        const status = game.status.detailedState;
        const isLive = status === "In Progress" || status === "Warmup";
        const statusClass = isLive ? "live" : "";
        const statusDisplay = isLive ? "LIVE NOW" : status;
        
        // Highlight logic
        const isMyTeam = (teamName) => myTeams.some(myTeam => teamName.toLowerCase().includes(myTeam.toLowerCase()) || myTeam.toLowerCase().includes(teamName.toLowerCase()));
        const awayHighlight = isMyTeam(awayTeam.team.name) ? "highlight" : "";
        const homeHighlight = isMyTeam(homeTeam.team.name) ? "highlight" : "";
        
        return `
            <div class="game-card">
                <div class="game-header">
                    <div class="game-date">${formatDateTime(gameDate)}</div>
                    <div class="game-status ${statusClass}">${statusDisplay}</div>
                </div>
                
                <div class="matchup">
                    <div class="team-row">
                        <span class="team-name ${awayHighlight}">${awayTeam.team.name}</span>
                        <span class="team-score ${awayTeam.isWinner ? 'winner' : ''}">${awayTeam.score !== undefined ? awayTeam.score : ''}</span>
                    </div>
                    <div class="team-row">
                        <span class="team-name ${homeHighlight}">${homeTeam.team.name}</span>
                        <span class="team-score ${homeTeam.isWinner ? 'winner' : ''}">${homeTeam.score !== undefined ? homeTeam.score : ''}</span>
                    </div>
                </div>
                
                <div class="pitchers">
                    <div class="pitcher-row">
                        <span class="pitcher-label">Away Starter:</span>
                        <span class="pitcher-name">${awayPitcher}</span>
                    </div>
                    <div class="pitcher-row">
                        <span class="pitcher-label">Home Starter:</span>
                        <span class="pitcher-name">${homePitcher}</span>
                    </div>
                </div>
                
                ${broadcasts.length > 0 ? `
                    <div class="broadcast-badges">
                        ${broadcasts.map(b => `<span class="broadcast-badge badge-${b.type}">${b.name}</span>`).join('')}
                    </div>
                ` : ''}
            </div>
        `;
    }).join('');
}

// Helpers
function formatDateDisplay(date) {
    return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
}

function formatDateTime(date) {
    const today = new Date();
    let prefix = "";
    
    // Check if it's today or tomorrow relative to MOCK_DATE testing context
    // For simplicity, we just use standard local formatting
    return date.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' }) + 
           " • " + 
           date.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
}

// Start application
document.addEventListener('DOMContentLoaded', init);
