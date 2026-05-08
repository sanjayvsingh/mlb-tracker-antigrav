<?php
/**
 * sheet.php - Fetches the owner's unseen-teams list from Google Sheets.
 * Parses column 13 (0-indexed) from each data row and returns a JSON array.
 * Caches results for 30 minutes.
 */

require_once 'token.php';

header('Content-Type: application/json');

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

$cacheFile = 'sheet_cache.json';
$cacheTTL  = 30 * 60; // 30 minutes

if (file_exists($cacheFile)) {
    $age = time() - filemtime($cacheFile);
    if ($age < $cacheTTL) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if ($cached !== null) {
            $cached['from_cache'] = true;
            echo json_encode($cached);
            exit;
        }
    }
}

$sheetId  = getenv('SHEET_ID');
$sheetUrl = "https://docs.google.com/spreadsheets/d/{$sheetId}/export?format=csv";

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL,            $sheetUrl);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_TIMEOUT,        10);
$csv      = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$csv || $httpCode !== 200) {
    $stale = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;
    if ($stale !== null) {
        $stale['from_cache'] = true;
        $stale['stale']      = true;
        echo json_encode($stale);
    } else {
        http_response_code(502);
        echo json_encode(['error' => 'Failed to fetch sheet']);
    }
    exit;
}

// Parse CSV — extract column 13 (0-indexed) from each row after the header
$teams = [];
$lines = explode("\n", $csv);
array_shift($lines); // skip header row

foreach ($lines as $line) {
    $line = trim($line);
    if (!$line) continue;

    $cols     = [];
    $cur      = '';
    $inQuotes = false;
    for ($i = 0; $i < strlen($line); $i++) {
        if ($line[$i] === '"') {
            $inQuotes = !$inQuotes;
        } elseif ($line[$i] === ',' && !$inQuotes) {
            $cols[] = $cur;
            $cur    = '';
        } else {
            $cur .= $line[$i];
        }
    }
    $cols[] = $cur;

    if (count($cols) > 13 && trim($cols[13]) !== '') {
        $teams[] = trim($cols[13]);
    }
}

$result = ['teams' => $teams, 'from_cache' => false];
file_put_contents($cacheFile, json_encode($result));
echo json_encode($result);
?>
