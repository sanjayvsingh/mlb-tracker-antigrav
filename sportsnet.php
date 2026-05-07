<?php
/**
 * sportsnet.php - Fetches Sportsnet's MLB schedule via their internal API
 * and returns structured game data as JSON. Results are cached for 4 hours.
 *
 * Uses the sportschedules API endpoint which returns clean JSON per date,
 * with accurate UTC event start times. We fetch today through day-after-tomorrow
 * (plus an extra day to catch late-night UTC offsets) and group games by their
 * Eastern Time local date.
 *
 * Endpoint: GET /sportsnet.php
 * Returns: { "games": [ { "away": "...", "home": "...", "status": "LIVE|UPCOMING",
 *            "date": "YYYY-MM-DD", "url": "..." }, ... ], "from_cache": bool }
 */

require_once 'token.php';

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
    header("Access-Control-Allow-Headers: Content-Type, X-CSRF-Token");
}

if ($_SERVER['REQUEST_METHOD'] === 'OPTIONS') {
    http_response_code(200);
    exit;
}

csrf_verify();

$cacheFile = 'sportsnet_cache.json';
$cacheTTL = 4 * 60 * 60; // 4 hours in seconds

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

// Default fallback API base URL
$apiBase = 'https://production-cdn.d3-rgr-diva.com/api';

// Dynamically discover the API base URL from the Sportsnet homepage
$homepageHtml = @file_get_contents('https://watch.sportsnet.ca/sportschedule', false, stream_context_create([
    'http' => [
        'method' => 'GET',
        'header' => 'User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'timeout' => 5
    ]
]));

if ($homepageHtml && preg_match("/env\.CLIENT_SERVICE_CDN_URL='([^']+)'/", $homepageHtml, $matches)) {
    $apiBase = rtrim($matches[1], '/');
}

// Ensure the base URL points to the sportschedules endpoint for MLB
$apiBase .= '/sportschedules?competition=cp-mlb';

// We need to fetch enough dates to cover the 3-day window in ET.
// A game at 11 PM ET on May 5 is filed as May 6 in UTC (3 AM UTC).
// So we fetch today through day+3 to catch all games that fall within
// our 3-day ET window.
$today = new DateTime('now', new DateTimeZone('America/Toronto'));
$dates = [];
for ($i = 0; $i <= 3; $i++) {
    $d = clone $today;
    $d->modify("+$i day");
    $dates[] = $d->format('Y-m-d');
}

$games = [];
$seen = [];
$et = new DateTimeZone('America/Toronto');

// Build all handles and fire them in parallel
$multiHandle = curl_multi_init();
$handles = [];
foreach ($dates as $dateStr) {
    $url = $apiBase . '&date=' . $dateStr . '&page_size=50';
    $ch = curl_init();
    curl_setopt($ch, CURLOPT_URL, $url);
    curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
    curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
    curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
    curl_setopt($ch, CURLOPT_TIMEOUT, 10);
    curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
    curl_multi_add_handle($multiHandle, $ch);
    $handles[$dateStr] = $ch;
}

$running = null;
do {
    curl_multi_exec($multiHandle, $running);
    curl_multi_select($multiHandle);
} while ($running > 0);

foreach ($dates as $dateStr) {
    $ch = $handles[$dateStr];
    $body = curl_multi_getcontent($ch);
    $httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    curl_multi_remove_handle($multiHandle, $ch);
    curl_close($ch);

    if ($httpCode !== 200 || !$body) continue;

    $data = json_decode($body, true);
    if (!$data || !isset($data['items'])) continue;

    foreach ($data['items'] as $item) {
        // Skip non-events or already-seen items
        if (($item['type'] ?? '') !== 'event') continue;
        $id = $item['id'] ?? '';
        if (isset($seen[$id])) continue;
        $seen[$id] = true;

        $title = $item['title'] ?? '';
        $path = $item['path'] ?? '';
        $startUtc = $item['eventStartDate'] ?? '';

        if (!$title || !$startUtc) continue;

        // Parse teams from title (format: "Toronto @ Tampa Bay" or "Los Angeles Dodgers @ Houston")
        $parts = preg_split('/\s+@\s+/', $title, 2);
        if (count($parts) !== 2) continue;

        $away = trim($parts[0]);
        $home = trim($parts[1]);

        // Determine status from VideoStatus field
        $videoStatus = $item['customFields']['VideoStatus'] ?? 'Scheduled';
        $status = (strtolower($videoStatus) === 'live') ? 'LIVE' : 'UPCOMING';

        // Convert UTC start time to Eastern for the local date
        $startDt = new DateTime($startUtc, new DateTimeZone('UTC'));
        $startDt->setTimezone($et);
        $localDate = $startDt->format('Y-m-d');

        // Build the watch URL from the path
        $eventUrl = 'https://watch.sportsnet.ca' . $path;

        $games[] = [
            'away' => $away,
            'home' => $home,
            'status' => $status,
            'date' => $localDate,
            'url' => $eventUrl
        ];
    }
}

curl_multi_close($multiHandle);

$result = ['games' => $games, 'from_cache' => false];

// Cache the result
file_put_contents($cacheFile, json_encode($result));

echo json_encode($result);
?>
