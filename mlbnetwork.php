<?php
/**
 * mlbnetwork.php - Fetches MLB Network schedule and returns structured game data.
 * Caches results for 24 hours.
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

$cacheFile = 'mlbnetwork_cache.json';
$cacheTTL = 24 * 60 * 60; // 24 hours in seconds

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

$url = 'https://www.mlb.com/network/modules/shows/mlbn-live-games';
$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36');
$html = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$html || $httpCode !== 200) {
    http_response_code(502);
    echo json_encode(["error" => "Failed to fetch MLB Network schedule"]);
    exit;
}

// Parse HTML
$dom = new DOMDocument();
libxml_use_internal_errors(true);
$dom->loadHTML($html);
libxml_clear_errors();

$xpath = new DOMXPath($dom);
$rows = $xpath->query('//table/tbody/tr');

$games = [];

if ($rows) {
    foreach ($rows as $row) {
        $cols = $xpath->query('.//td', $row);
        if ($cols->length >= 3) {
            $dateStr = trim($cols->item(0)->textContent);
            $timeStr = trim($cols->item(1)->textContent);
            $desc = trim($cols->item(2)->textContent);

            // Reformat date from MM/DD/YYYY to YYYY-MM-DD
            $dateObj = DateTime::createFromFormat('m/d/Y', $dateStr);
            if (!$dateObj) continue;
            $formattedDate = $dateObj->format('Y-m-d');

            $status = strpos(strtoupper($desc), '[LIVE]') !== false ? 'LIVE' : 'UPCOMING';

            $segments = explode(" or ", $desc);
            foreach ($segments as $seg) {
                // Remove everything starting with " from ", " on ", "(", "["
                $clean = preg_replace('/( from | on |\s*\(|\s*\[).*/', '', $seg);
                if (preg_match('/(.+?)\s+(?:at|@)\s+(.+)/i', trim($clean), $m)) {
                    $away = trim($m[1]);
                    $home = trim($m[2]);
                    
                    $games[] = [
                        'away' => $away,
                        'home' => $home,
                        'date' => $formattedDate,
                        'time' => $timeStr,
                        'status' => $status
                    ];
                }
            }
        }
    }
}

if (!empty($games)) {
    $result = ["games" => $games, "from_cache" => false];
    $json = json_encode($result);
    file_put_contents($cacheFile, $json);
    echo $json;
} else {
    // Fresh fetch returned nothing — serve stale cache rather than an empty response
    $stale = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;
    if ($stale && !empty($stale['games'])) {
        $stale['from_cache'] = true;
        $stale['stale'] = true;
        echo json_encode($stale);
    } else {
        echo json_encode(["games" => [], "from_cache" => false]);
    }
}
