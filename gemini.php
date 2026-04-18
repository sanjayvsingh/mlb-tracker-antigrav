<?php
// gemini.php - Gemini API proxy and caching script

function ordinal($n) {
    $n = intval($n);
    $s = ['th', 'st', 'nd', 'rd'];
    $v = $n % 100;
    return $n . ($s[($v - 20) % 10] ?? $s[$v] ?? $s[0]);
}

if (file_exists('api_key.php')) {
    $gemini_api_key = require 'api_key.php';
} else {
    // Set this to your actual Gemini API key before uploading to your web host
    $gemini_api_key = "YOUR_API_KEY_HERE";
}

header('Content-Type: application/json');

// Only allow POST requests
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(["error" => "Only POST requests are allowed"]);
    exit;
}

// Read the incoming JSON body (the schedule)
$inputJSON = file_get_contents('php://input');
$input = json_decode($inputJSON, true);

if (!$input || !isset($input['games'])) {
    http_response_code(400);
    echo json_encode(["error" => "Invalid input. Expected JSON with a 'games' array."]);
    exit;
}

// Caching logic
$debugDate = isset($input['debugDate']) ? $input['debugDate'] : null;
// Clean debugDate to prevent path traversal
$safeDebugDate = $debugDate ? preg_replace('/[^0-9-]/', '', $debugDate) : '';
$cacheFile = $safeDebugDate ? 'gemini_cache_' . $safeDebugDate . '.json' : 'gemini_cache.json';
$cacheValid = false;

if (file_exists($cacheFile)) {
    $filemtime = filemtime($cacheFile);
    // Check if the cache is less than 6 hours old (21600 seconds)
    if (time() - $filemtime < 21600) {
        $cacheValid = true;
    }
}

if ($cacheValid) {
    // Return cached response
    $cachedData = file_get_contents($cacheFile);
    $cachedObj = json_decode($cachedData, true);
    if ($cachedObj) {
        $cachedObj['from_cache'] = true;
        echo json_encode($cachedObj);
    } else {
        echo $cachedData;
    }
    exit;
}

// If no valid cache, construct prompt and call Gemini API
$teamContext = isset($input['teamContext']) ? $input['teamContext'] : [];

$gamesList = "";
foreach ($input['games'] as $g) {
    $date = isset($g['date']) ? $g['date'] : '';
    $away = $g['away'];
    $home = $g['home'];
    
    // Build enriched away team info
    $awayInfo = $away;
    if (isset($teamContext[$away])) {
        $tc = $teamContext[$away];
        $awayInfo .= " (" . $tc['record'];
        if (isset($tc['rank'])) $awayInfo .= ", " . ordinal($tc['rank']) . " " . $tc['div'];
        $awayInfo .= ")";
    }
    
    // Build enriched home team info
    $homeInfo = $home;
    if (isset($teamContext[$home])) {
        $tc = $teamContext[$home];
        $homeInfo .= " (" . $tc['record'];
        if (isset($tc['rank'])) $homeInfo .= ", " . ordinal($tc['rank']) . " " . $tc['div'];
        $homeInfo .= ")";
    }
    
    $line = "- [$date] $awayInfo @ $homeInfo | Pitchers: " . $g['awaySp'] . " vs " . $g['homeSp'];
    
    // Append hot hitters
    $hotParts = [];
    if (isset($teamContext[$away]['hot'])) {
        foreach ($teamContext[$away]['hot'] as $h) $hotParts[] = $h;
    }
    if (isset($teamContext[$home]['hot'])) {
        foreach ($teamContext[$home]['hot'] as $h) $hotParts[] = $h;
    }
    if (!empty($hotParts)) {
        $line .= " | Hot: " . implode(", ", $hotParts);
    }
    
    // Append milestones
    $mileParts = [];
    if (isset($teamContext[$away]['milestones'])) {
        foreach ($teamContext[$away]['milestones'] as $m) $mileParts[] = $m;
    }
    if (isset($teamContext[$home]['milestones'])) {
        foreach ($teamContext[$home]['milestones'] as $m) $mileParts[] = $m;
    }
    if (!empty($mileParts)) {
        $line .= " | Milestone: " . implode("; ", $mileParts);
    }
    
    $gamesList .= $line . "\n";
}

$startDateLabel = $safeDebugDate ? $safeDebugDate : "today";
$prompt = "You are an MLB analyst. Below is a list of all MLB games over the next three days (starting " . $startDateLabel . "), with each team's current record, division standing, probable pitchers, hot hitters, and milestone watches.\n\n"
    . "Evaluate ALL of the games below and select the five most compelling to watch. Prioritize:\n"
    . "- Meaningful rivalry or divisional matchups with playoff implications\n"
    . "- Exceptional or historic pitching duels\n"
    . "- Players chasing milestones or on hot streaks\n"
    . "- Comeback stories, prospect debuts, or unusual storylines\n\n"
    . "You MUST ONLY choose from the games listed below. You MUST include the exact date for each pick.\n"
    . "Return ONLY valid JSON in this format: {\"games\":[{\"date\":\"YYYY-MM-DD\",\"a\":\"AWAY_TEAM_CODE\",\"h\":\"HOME_TEAM_CODE\",\"r\":\"1 sentence reason\"}]}\n\n"
    . "Games:\n" . $gamesList;


$primaryModel = "gemini-3-flash-preview";
$lightModel = "gemini-3.1-flash-lite-preview";

$currentModel = $debugDate ? $lightModel : $primaryModel;

$data = [
    "contents" => [
        [
            "parts" => [
                ["text" => $prompt]
            ]
        ]
    ],
    "generationConfig" => [
        "response_mime_type" => "application/json"
    ]
];

$ch = curl_init();
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type: application/json'));
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true); // Enforce SSL to prevent MITM

$maxRetries = 3;
$response = false;
$httpcode = 500;
$curlError = "";

for ($i = 0; $i < $maxRetries; $i++) {
    $url = "https://generativelanguage.googleapis.com/v1beta/models/" . $currentModel . ":generateContent?key=" . $gemini_api_key;
    curl_setopt($ch, CURLOPT_URL, $url);
    
    $response = curl_exec($ch);
    $httpcode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
    
    if ($httpcode == 200) {
        break;
    }
    
    $curlError = curl_error($ch);
    
    // Fall back to the light model if primary hits rate limit or is unavailable
    if (($httpcode == 429 || $httpcode == 503) && $currentModel !== $lightModel) {
        $currentModel = $lightModel;
        continue;
    }
    
    // Wait 2 seconds before retrying if rate limited (on light model) or server error
    if ($i < $maxRetries - 1) sleep(2);
}

curl_close($ch);

if ($httpcode == 200) {
    $responseData = json_decode($response, true);
    // Try to extract the JSON text from Gemini's response structure
    if (isset($responseData['candidates'][0]['content']['parts'][0]['text'])) {
        $geminiText = $responseData['candidates'][0]['content']['parts'][0]['text'];

        $cleanText = preg_replace('/```json|```/i', '', $geminiText);
        $geminiObj = json_decode(trim($cleanText), true);
        if ($geminiObj) {
            $geminiObj['model_used'] = $currentModel;
            $geminiText = json_encode($geminiObj);
        }

        // Write the successfully parsed response to cache
        file_put_contents($cacheFile, $geminiText);
        echo $geminiText;
    } else {
        http_response_code(500);
        echo json_encode([
            "error" => "Unexpected Gemini response structure",
            "details" => $response,
            "http_code" => $httpcode
        ]);
    }
} else {
    http_response_code($httpcode ?: 500);
    echo json_encode([
        "error" => "Gemini API call failed",
        "details" => $response,
        "curl_error" => $curlError,
        "http_code" => $httpcode
    ]);
}
?>