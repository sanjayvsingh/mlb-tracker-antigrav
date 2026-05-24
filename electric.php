<?php
/**
 * electric.php - Dynamically calculates the top electric starters.
 *
 * ElectricScore = (K9_percentile * 1.3) + KBB_percentile
 * Caches daily. Hit directly in a browser or via curl to test.
 */

$cacheFile = 'electric_cache.json';
$cacheTTL  = 24 * 60 * 60;

if (file_exists($cacheFile)) {
    $age = time() - filemtime($cacheFile);
    if ($age < $cacheTTL) {
        $cached = json_decode(file_get_contents($cacheFile), true);
        if ($cached) {
            $cached['from_cache'] = true;
            header('Content-Type: application/json');
            echo json_encode($cached, JSON_PRETTY_PRINT);
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
    echo json_encode(['error' => 'Failed to fetch pitching stats', 'http_code' => $httpCode]);
    exit;
}

$data   = json_decode($json, true);
$splits = $data['stats'][0]['splits'] ?? [];

// Extract and filter
$players = [];
foreach ($splits as $s) {
    $gs  = isset($s['stat']['gamesStarted'])       ? (int)$s['stat']['gamesStarted']         : 0;
    $k9  = isset($s['stat']['strikeoutsPer9Inn'])  ? (float)$s['stat']['strikeoutsPer9Inn']  : null;
    $kbb = isset($s['stat']['strikeoutWalkRatio']) ? (float)$s['stat']['strikeoutWalkRatio'] : null;

    if ($gs < 3 || !$k9 || !$kbb) continue;

    $players[] = [
        'id'       => $s['player']['id'],
        'name'     => $s['player']['fullName'],
        'team'     => $s['team']['name'] ?? '',
        'k9'       => $k9,
        'kbb'      => $kbb,
    ];
}

if (empty($players)) {
    header('Content-Type: application/json');
    echo json_encode(['error' => 'No qualified pitchers found', 'players' => []]);
    exit;
}

// Build sorted arrays for percentile calculation
$k9List  = array_column($players, 'k9');
$kbbList = array_column($players, 'kbb');
$n       = count($players);

function percentile(float $x, array $list): float {
    $count = 0;
    foreach ($list as $v) {
        if ($v <= $x) $count++;
    }
    return $count / count($list);
}

// Score every player
foreach ($players as &$p) {
    $p['k9_pct']  = round(percentile($p['k9'],  $k9List),  4);
    $p['kbb_pct'] = round(percentile($p['kbb'], $kbbList), 4);
    $p['score']   = round(($p['k9_pct'] * 1.3) + $p['kbb_pct'], 4);
}
unset($p);

// Sort descending by score
usort($players, fn($a, $b) => $b['score'] <=> $a['score']);

$top10  = array_slice($players, 0, 10);
$result = ['season' => $season, 'total_qualified' => $n, 'players' => $top10, 'from_cache' => false];

file_put_contents($cacheFile, json_encode($result));

header('Content-Type: application/json');
echo json_encode($result, JSON_PRETTY_PRINT);
?>
