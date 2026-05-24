<?php
/**
 * bananas.php - Fetches Savannah Bananas (Banana Ball) schedule and returns
 * games broadcast on YouTube. Caches results for 4 hours.
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

$cacheFile = 'bananas_cache.json';
$cacheTTL = 4 * 60 * 60;

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

// Hours to add to convert a US local timezone label to Eastern (during DST/summer).
// The Savannah Bananas site uses standard abbreviations (PST/CST) even in summer,
// so we treat them as their daylight saving equivalents.
function tzToEtHours($tz) {
    $map = [
        'EDT' => 0, 'EST' => 0,
        'CDT' => 1, 'CST' => 1,
        'MDT' => 2, 'MST' => 2,
        'PDT' => 3, 'PST' => 3,
        'ET'  => 0, 'CT'  => 1, 'MT' => 2, 'PT' => 3,
    ];
    return $map[strtoupper(trim($tz))] ?? 0;
}

// Convert a time string like "7:00pm" and a timezone label like "CST" to "HH:MM" ET.
function toEtTime($timeStr, $tzLabel) {
    $clean = strtolower(trim(str_replace(' ', '', $timeStr)));
    $dt = DateTime::createFromFormat('g:ia', $clean);
    if (!$dt) $dt = DateTime::createFromFormat('g:i', $clean);
    if (!$dt) return null;
    $add = tzToEtHours($tzLabel);
    if ($add > 0) $dt->modify("+{$add} hours");
    return $dt->format('H:i');
}

// Convert "Sunday, May 24" or "May 24" to YYYY-MM-DD using the current year.
function parseGameDate($str) {
    $year = date('Y');
    $str  = trim(preg_replace('/^[a-zA-Z]+,\s*/', '', $str)); // strip "Sunday, "
    $dt   = DateTime::createFromFormat('F j Y', $str . ' ' . $year);
    if (!$dt) $dt = DateTime::createFromFormat('F jY', $str . $year);
    return $dt ? $dt->format('Y-m-d') : null;
}

$url = 'https://thesavannahbananas.com/schedule/';
$ch  = curl_init();
curl_setopt($ch, CURLOPT_URL, $url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_FOLLOWLOCATION, true);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 10);
curl_setopt($ch, CURLOPT_USERAGENT, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');
$html     = curl_exec($ch);
$httpCode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if (!$html || $httpCode !== 200) {
    $stale = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;
    if ($stale && !empty($stale['games'])) {
        $stale['from_cache'] = true;
        $stale['stale'] = true;
        echo json_encode($stale);
    } else {
        http_response_code(502);
        echo json_encode(['error' => 'Failed to fetch Bananas schedule', 'http_code' => $httpCode]);
    }
    exit;
}

$games = [];

// --- Strategy 1: JSON-LD structured data ---
preg_match_all('/<script[^>]+type=["\']application\/ld\+json["\'][^>]*>\s*(.*?)\s*<\/script>/si', $html, $jsonLdMatches);
foreach ($jsonLdMatches[1] as $jsonStr) {
    $data = json_decode($jsonStr, true);
    if (!$data) continue;
    $items = isset($data['@graph']) ? $data['@graph'] : [$data];
    foreach ($items as $item) {
        if (!isset($item['@type'])) continue;
        $types = is_array($item['@type']) ? $item['@type'] : [$item['@type']];
        if (!array_intersect($types, ['Event', 'SportsEvent', 'SportsGame', 'EntertainmentEvent'])) continue;
        $blob = strtolower(json_encode($item));
        if (stripos($blob, 'youtube') === false) continue;

        $startDate = $item['startDate'] ?? '';
        if (!$startDate) continue;
        try {
            $dt = new DateTime($startDate);
            $dt->setTimezone(new DateTimeZone('America/New_York'));
            $date   = $dt->format('Y-m-d');
            $timeEt = $dt->format('H:i');
        } catch (Exception $e) { continue; }

        $name = $item['name'] ?? '';
        $away = $home = '';
        if (preg_match('/^(.+?)\s+(?:vs\.?|@|at)\s+(.+?)(?:\s*[-–|]|$)/i', $name, $m)) {
            $away = trim($m[1]);
            $home = trim($m[2]);
        }
        $loc = $item['location'] ?? '';
        $venue = is_string($loc) ? $loc
               : (($loc['name'] ?? '') . (isset($loc['address']['addressLocality']) ? ', ' . $loc['address']['addressLocality'] : ''));

        $games[] = ['away' => $away ?: $name, 'home' => $home, 'date' => $date, 'time_et' => $timeEt, 'venue' => trim($venue, ', ')];
    }
}

// --- Strategy 2: Embedded JSON blob (Next.js __NEXT_DATA__ or similar) ---
if (empty($games)) {
    if (preg_match('/<script[^>]+id=["\']__NEXT_DATA__["\'][^>]*>(.*?)<\/script>/si', $html, $m)) {
        $nextData = json_decode($m[1], true);
        if ($nextData) {
            // Recursively search for arrays of objects that look like schedule events
            $blob = json_encode($nextData);
            // Look for youtube + date + matchup patterns in the raw JSON
            if (preg_match_all('/"date"\s*:\s*"([^"]+)".{0,400}?"youtube"/si', $blob, $mx)) {
                // Fallthrough to strategy 3 which handles the raw text
            }
        }
    }
}

// --- Strategy 3: DOM-based extraction ---
if (empty($games)) {
    $dom = new DOMDocument();
    libxml_use_internal_errors(true);
    $dom->loadHTML('<?xml encoding="utf-8" ?>' . $html);
    libxml_clear_errors();
    $xpath = new DOMXPath($dom);

    // Find all text nodes containing "youtube"
    $ytNodes = $xpath->query('//*[contains(translate(., "ABCDEFGHIJKLMNOPQRSTUVWXYZ", "abcdefghijklmnopqrstuvwxyz"), "youtube")]');
    $seen = [];

    foreach ($ytNodes as $node) {
        // Walk up to find a container div/article/section that likely wraps one event
        $container = $node;
        for ($i = 0; $i < 7; $i++) {
            if (!$container->parentNode || $container->parentNode->nodeName === 'body') break;
            $container = $container->parentNode;
        }

        $containerText = preg_replace('/\s+/', ' ', trim($container->textContent));
        $key = md5($containerText);
        if (isset($seen[$key])) continue;
        $seen[$key] = true;

        // Date
        if (!preg_match('/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i', $containerText, $dm)) continue;
        $date = parseGameDate($dm[0]);
        if (!$date) continue;

        // Time + timezone
        $timeEt = null;
        if (preg_match('/(\d{1,2}:\d{2}\s*[ap]m)\s*([A-Z]{2,3}T)\b/i', $containerText, $tm)) {
            $timeEt = toEtTime($tm[1], $tm[2]);
        } elseif (preg_match('/(\d{1,2}:\d{2}\s*[ap]m)/i', $containerText, $tm)) {
            $timeEt = toEtTime($tm[1], 'ET'); // assume ET if no label
        }
        if (!$timeEt) continue;

        // Matchup "Team A vs Team B" or "Team A @ Team B"
        $away = $home = '';
        if (preg_match('/([A-Za-z][A-Za-z ]{2,30}?)\s+(?:vs\.?|@)\s+([A-Za-z][A-Za-z ]{2,30}?)(?=\s*(?:\d|Sold|YouTube|$))/i', $containerText, $mm)) {
            $away = trim($mm[1]);
            $home = trim($mm[2]);
        }

        // Venue – look for "Stadium|Field|Park|Arena|Center|Complex"
        $venue = '';
        if (preg_match('/([A-Z][A-Za-z .\']+(?:Stadium|Field|Park|Arena|Center|Complex)[^,\n]{0,40}(?:,\s*[A-Za-z ]+(?:,\s*[A-Z]{2})?)?)/i', $containerText, $vm)) {
            $venue = trim($vm[1]);
        }

        $games[] = ['away' => $away, 'home' => $home, 'date' => $date, 'time_et' => $timeEt, 'venue' => $venue];
    }
}

// --- Strategy 4: Raw-text pattern matching ---
if (empty($games)) {
    $text = preg_replace('/\s+/', ' ', strip_tags($html));
    // Find "youtube" occurrences and examine a 600-char window around each
    $offset = 0;
    $seen = [];
    while (($pos = stripos($text, 'youtube', $offset)) !== false) {
        $offset = $pos + 1;
        $start  = max(0, $pos - 400);
        $window = substr($text, $start, 800);
        $key    = md5($window);
        if (isset($seen[$key])) continue;
        $seen[$key] = true;

        if (!preg_match('/\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}\b/i', $window, $dm)) continue;
        $date = parseGameDate($dm[0]);
        if (!$date) continue;

        $timeEt = null;
        if (preg_match('/(\d{1,2}:\d{2}\s*[ap]m)\s*([A-Z]{2,3}T)\b/i', $window, $tm)) {
            $timeEt = toEtTime($tm[1], $tm[2]);
        } elseif (preg_match('/(\d{1,2}:\d{2}\s*[ap]m)/i', $window, $tm)) {
            $timeEt = toEtTime($tm[1], 'ET');
        }
        if (!$timeEt) continue;

        $away = $home = '';
        if (preg_match('/([A-Za-z][A-Za-z ]{2,30}?)\s+(?:vs\.?|@)\s+([A-Za-z][A-Za-z ]{2,30}?)(?=\s*(?:\d|Sold|YouTube|$))/i', $window, $mm)) {
            $away = trim($mm[1]);
            $home = trim($mm[2]);
        }

        $venue = '';
        if (preg_match('/([A-Z][A-Za-z .\']+(?:Stadium|Field|Park|Arena|Center|Complex)[^,\n]{0,40})/i', $window, $vm)) {
            $venue = trim($vm[1]);
        }

        $games[] = ['away' => $away, 'home' => $home, 'date' => $date, 'time_et' => $timeEt, 'venue' => $venue];
    }
}

// Filter to games within the next 14 days and deduplicate
$todayTs   = strtotime(date('Y-m-d'));
$windowEnd = $todayTs + (14 * 24 * 60 * 60);
$deduped   = [];
$dedupKeys = [];
foreach ($games as $g) {
    $ts = strtotime($g['date'] ?? '');
    if (!$ts || $ts < $todayTs || $ts > $windowEnd) continue;
    $k = $g['date'] . '|' . strtolower($g['away']) . '|' . strtolower($g['home']);
    if (isset($dedupKeys[$k])) continue;
    $dedupKeys[$k] = true;
    $deduped[] = $g;
}

if (!empty($deduped)) {
    $result = ['games' => $deduped, 'from_cache' => false];
    file_put_contents($cacheFile, json_encode($result));
    echo json_encode($result);
} else {
    $stale = file_exists($cacheFile) ? json_decode(file_get_contents($cacheFile), true) : null;
    if ($stale && !empty($stale['games'])) {
        $stale['from_cache'] = true;
        $stale['stale'] = true;
        echo json_encode($stale);
    } else {
        echo json_encode(['games' => [], 'from_cache' => false]);
    }
}
?>
