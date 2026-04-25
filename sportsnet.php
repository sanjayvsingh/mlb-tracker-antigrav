<?php
/**
 * sportsnet.php - Scrapes Sportsnet's MLB schedule page and returns
 * structured game data as JSON. Results are cached for 12 hours.
 *
 * Endpoint: GET /sportsnet.php
 * Returns: { "games": [ { "away": "...", "home": "...", "status": "LIVE|UPCOMING", "url": "..." }, ... ], "from_cache": bool }
 */

header('Content-Type: application/json');

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

        // Parse teams from the URL slug (much more reliable than the link text)
        $teams = parseSlugTeams($eventSlug, $SLUG_TEAMS);
        if (!$teams) continue;

        $eventUrl = 'https://watch.sportsnet.ca/event/' . $eventSlug;

        $seen[$eventSlug] = true;
        $games[] = [
            'away' => $teams['away'],
            'home' => $teams['home'],
            'status' => $status,
            'url' => $eventUrl
        ];
    }
}

$result = ['games' => $games, 'from_cache' => false];

// Cache the result
file_put_contents($cacheFile, json_encode($result));

echo json_encode($result);
?>
