<?php
/**
 * sportsnet.php - Scrapes Sportsnet's MLB schedule page and returns
 * structured game data as JSON. Results are cached for 12 hours.
 *
 * Endpoint: GET /sportsnet.php
 * Returns: { "games": [ { "away": "...", "home": "...", "status": "LIVE|UPCOMING", "url": "..." }, ... ], "from_cache": bool }
 */

header('Content-Type: application/json');

// Access Control Setup
$allowed_origins = [
    'https://mlb.sanvash.com',
    'http://localhost:8080',
    'http://127.0.0.1:8080'
];

$origin = isset($_SERVER['HTTP_ORIGIN']) ? $_SERVER['HTTP_ORIGIN'] : '';

if (in_array($origin, $allowed_origins)) {
    header("Access-Control-Allow-Origin: " . $origin);
    header("Access-Control-Allow-Methods: GET, OPTIONS");
    header("Access-Control-Allow-Headers: Content-Type, X-App-Token");
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

// Access Control: Require Custom App Token
$appToken = isset($_SERVER['HTTP_X_APP_TOKEN']) ? $_SERVER['HTTP_X_APP_TOKEN'] : '';
if (function_exists('getallheaders')) {
    $headers = getallheaders();
    if (isset($headers['X-App-Token'])) $appToken = $headers['X-App-Token'];
    elseif (isset($headers['x-app-token'])) $appToken = $headers['x-app-token'];
}

if ($appToken !== 'mlb-tracker-v2') {
    http_response_code(403);
    echo json_encode(["error" => "Forbidden. Invalid or missing App Token."]);
    exit;
}

$cacheFile = 'sportsnet_cache.json';
$cacheTTL = 12 * 60 * 60; // 12 hours in seconds

// Check cache
if (file_exists($cacheFile)) {
    $age = time() - filemtime($cacheFile);
    if ($age < $cacheTTL) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if ($cached) {
            $cached['from_cache'] = true;
            echo json_encode($cached);
            exit;
        }
    }
}

// Fetch the Sportsnet MLB page
$url = 'https://watch.sportsnet.ca/leagues/MLB_155233';

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 15);
curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
$html = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
$curlError = curl_error($ch);
curl_close($ch);

if ($httpCode !== 200 || !$html) {
    http_response_code(502);
    echo json_encode([
        'error' => 'Failed to fetch Sportsnet page',
        'http_code' => $httpCode,
        'curl_error' => $curlError
    ]);
    exit;
}

// Sportsnet event URL slug -> team name mapping
// Slugs use underscores: "Cleveland_Toronto_212498", "Chicago_Cubs_Los_Angeles_Dodgers_212713"
// Order matters: longer/more-specific patterns must come before shorter ones
$SLUG_TEAMS = [
    'New_York_Yankees' => 'New York Yankees',
    'New_York_Mets' => 'New York Mets',
    'Los_Angeles_Dodgers' => 'Los Angeles Dodgers',
    'Los_Angeles_Angels' => 'Los Angeles Angels',
    'Chicago_Cubs' => 'Chicago Cubs',
    'Chicago_White_Sox' => 'Chicago White Sox',
    'San_Francisco' => 'San Francisco',
    'San_Diego' => 'San Diego',
    'St_Louis' => 'St. Louis',
    'Tampa_Bay' => 'Tampa Bay',
    'Kansas_City' => 'Kansas City',
    'New_York' => 'New York',
    'Los_Angeles' => 'Los Angeles',
    'Cleveland' => 'Cleveland',
    'Toronto' => 'Toronto',
    'Boston' => 'Boston',
    'Houston' => 'Houston',
    'Baltimore' => 'Baltimore',
    'Detroit' => 'Detroit',
    'Minnesota' => 'Minnesota',
    'Seattle' => 'Seattle',
    'Texas' => 'Texas',
    'Oakland' => 'Oakland',
    'Atlanta' => 'Atlanta',
    'Miami' => 'Miami',
    'Philadelphia' => 'Philadelphia',
    'Washington' => 'Washington',
    'Cincinnati' => 'Cincinnati',
    'Milwaukee' => 'Milwaukee',
    'Pittsburgh' => 'Pittsburgh',
    'Arizona' => 'Arizona',
    'Colorado' => 'Colorado',
];

/**
 * Parse two team names from a Sportsnet event slug like "Cleveland_Toronto_212498"
 * or "Chicago_Cubs_Los_Angeles_Dodgers_212713".
 */
function parseSlugTeams($slug, $teamMap) {
    // Remove trailing numeric ID
    $slug = preg_replace('/_\d+$/', '', $slug);

    $away = null;
    $remaining = $slug;

    // Try to match the away team from the start of the slug
    foreach ($teamMap as $pattern => $name) {
        if (strpos($remaining, $pattern) === 0) {
            $away = $name;
            // Remove the matched portion plus the separator underscore
            $remaining = substr($remaining, strlen($pattern));
            $remaining = ltrim($remaining, '_');
            break;
        }
    }

    if (!$away || empty($remaining)) return null;

    // Now match the home team from what's left
    $home = null;
    foreach ($teamMap as $pattern => $name) {
        if ($remaining === $pattern) {
            $home = $name;
            break;
        }
    }

    if (!$home) return null;
    return ['away' => $away, 'home' => $home];
}

$games = [];
$seen = [];

/**
 * Parse the broadcast date from the Sportsnet link text.
 * Examples:
 *   "LIVE10:00 PM..."           → today
 *   "UPCOMINGToday @ 10:00 PM..." → today
 *   "UPCOMINGTomorrow @ 12:00 AM..." → tomorrow
 *   "UPCOMINGThu, May 7 @ 4:30 PM..." → 2026-05-07
 * Returns an ISO date string (YYYY-MM-DD) or null if unparseable.
 */
function parseBroadcastDate($linkText) {
    $today = new DateTime('now', new DateTimeZone('America/Toronto'));

    // LIVE games are always today
    if (stripos($linkText, 'LIVE') !== false) {
        return $today->format('Y-m-d');
    }

    // Strip the "UPCOMING" prefix
    $text = preg_replace('/^.*?UPCOMING/i', '', $linkText);
    $text = trim($text);

    // "Today @ ..."
    if (stripos($text, 'Today') === 0) {
        return $today->format('Y-m-d');
    }

    // "Tomorrow @ ..."
    if (stripos($text, 'Tomorrow') === 0) {
        $tomorrow = clone $today;
        $tomorrow->modify('+1 day');
        return $tomorrow->format('Y-m-d');
    }

    // Absolute date like "Thu, May 7 @ 4:30 PM..." or "Sat, May 9 @ 2:00 AM..."
    // Match pattern: "Day, Month Day @"
    if (preg_match('/^[A-Za-z]+,\s+([A-Za-z]+)\s+(\d+)\s+@/i', $text, $dm)) {
        $monthStr = $dm[1];
        $dayNum = intval($dm[2]);
        $year = intval($today->format('Y'));
        $parsed = DateTime::createFromFormat('Y M j', "$year $monthStr $dayNum", new DateTimeZone('America/Toronto'));
        if ($parsed) {
            // Handle year rollover (e.g., December scrape showing January games)
            if ($parsed < $today && intval($today->format('n')) >= 10 && intval($parsed->format('n')) <= 3) {
                $parsed->modify('+1 year');
            }
            return $parsed->format('Y-m-d');
        }
    }

    return null;
}

// Match all event links in the HTML
if (preg_match_all('/<a[^>]*href=["\']([^"\']*\/event\/([^"\']+))["\'][^>]*>(.*?)<\/a>/si', $html, $matches, PREG_SET_ORDER)) {
    foreach ($matches as $m) {
        $eventSlug = $m[2];
        $linkText = strip_tags($m[3]);

        // Skip duplicates
        if (isset($seen[$eventSlug])) continue;

        // Only include LIVE or UPCOMING games (skip REPLAY)
        if (stripos($linkText, 'REPLAY') !== false) continue;
        if (stripos($linkText, 'LIVE') === false && stripos($linkText, 'UPCOMING') === false) continue;

        // Determine status
        $status = (stripos($linkText, 'LIVE') !== false) ? 'LIVE' : 'UPCOMING';

        // Parse broadcast date from the link text
        $broadcastDate = parseBroadcastDate($linkText);

        // Parse teams from the URL slug (much more reliable than the link text)
        $teams = parseSlugTeams($eventSlug, $SLUG_TEAMS);
        if (!$teams) continue;

        $eventUrl = 'https://watch.sportsnet.ca/event/' . $eventSlug;

        $seen[$eventSlug] = true;
        $game = [
            'away' => $teams['away'],
            'home' => $teams['home'],
            'status' => $status,
            'url' => $eventUrl
        ];
        if ($broadcastDate) {
            $game['date'] = $broadcastDate;
        }
        $games[] = $game;
    }
}

$result = ['games' => $games, 'from_cache' => false];

// Cache the result
file_put_contents($cacheFile, json_encode($result));

echo json_encode($result);
?>
