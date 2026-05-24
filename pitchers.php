<?php
/**
 * pitchers.php - Returns all pitchers with season stats for name autocomplete.
 * Used by the Electric Starters modal to let users search and add custom starters.
 * Caches daily. No CSRF needed — no writes, no quota cost, public MLB data.
 */

$cacheFile = 'pitchers_cache.json';
$cacheTTL  = 24 * 60 * 60;

if (file_exists($cacheFile)) {
    $age = time() - filemtime($cacheFile);
    if ($age < $cacheTTL) {
        $cached = file_get_contents($cacheFile);
        if ($cached) {
            header('Content-Type: application/json');
            echo $cached;
            exit;
        }
    }
}

$season = date('Y');
$url    = "https://statsapi.mlb.com/api/v1/stats?stats=season&group=pitching&season={$season}&playerPool=All&limit=600";

$ch = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0');
$json     = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$json || $httpCode !== 200) {
    http_response_code(502);
    header('Content-Type: application/json');
    echo json_encode(['error' => 'Failed to fetch pitcher roster', 'http_code' => $httpCode]);
    exit;
}

$data   = json_decode($json, true);
$splits = $data['stats'][0]['splits'] ?? [];

$seen    = [];
$players = [];
foreach ($splits as $s) {
    $id = $s['player']['id'] ?? null;
    if (!$id || isset($seen[$id])) continue;
    $seen[$id] = true;
    $players[] = [
        'id'   => $id,
        'name' => $s['player']['fullName'],
        'team' => $s['team']['name'] ?? '',
    ];
}

usort($players, fn($a, $b) => $a['name'] <=> $b['name']);

$result = json_encode(['players' => $players]);
file_put_contents($cacheFile, $result);

header('Content-Type: application/json');
echo $result;
?>
