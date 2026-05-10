<?php
/**
 * tsn.php - Fetches TSN MLB schedule and returns structured game data.
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

$cacheFile = 'tsn_cache.json';
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

$url = 'https://www.tsn.ca/mlb/article/2025-mlb-on-tsn-schedule/';
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
    // Serve stale cache if available
    $stale = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;
    if ($stale && !empty($stale['games'])) {
        $stale['from_cache'] = true;
        $stale['stale'] = true;
        echo json_encode($stale);
    } else {
        http_response_code(502);
        echo json_encode(["error" => "Failed to fetch TSN schedule"]);
    }
    exit;
}

// Parse HTML
$dom = new DOMDocument();
libxml_use_internal_errors(true);
$dom->loadHTML($html);
libxml_clear_errors();

$xpath = new DOMXPath($dom);
$tables = $xpath->query('//table');
$games = [];

if ($tables->length > 0) {
    // Assume the first table is the schedule
    $rows = $xpath->query('.//tr', $tables->item(0));
    
    $currentYear = date("Y"); // Assuming 2026 based on the context, or just use current year.
    
    foreach ($rows as $row) {
        $cols = $xpath->query('.//td', $row);
        // Table format: Date | Time | Away | Home | Network
        if ($cols->length >= 4) {
            $dateStr = trim($cols->item(0)->textContent);
            $timeStr = trim($cols->item(1)->textContent);
            $away = trim($cols->item(2)->textContent);
            $home = trim($cols->item(3)->textContent);
            
            // Reformat date from "Sunday, May 3" to YYYY-MM-DD
            // Strip out the day of the week to simplify parsing if needed, but createFromFormat works with 'l, F j'
            // Some dates might not have the day of week or format might slightly vary, let's be flexible
            $cleanDateStr = preg_replace('/^[a-zA-Z]+,\s*/', '', $dateStr); // e.g. "May 3"
            $dateObj = DateTime::createFromFormat('F j Y', $cleanDateStr . " " . $currentYear);
            
            if (!$dateObj) continue; // Skip if header row or unparseable
            
            $formattedDate = $dateObj->format('Y-m-d');
            
            $games[] = [
                'away' => $away,
                'home' => $home,
                'date' => $formattedDate,
                'time' => $timeStr,
                'status' => 'UPCOMING' // We can just set to UPCOMING as we don't know LIVE status easily
            ];
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
?>
