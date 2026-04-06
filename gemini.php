<?php
// gemini.php - Gemini API proxy and caching script

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
$cacheFile = 'gemini_cache.json';
$cacheValid = false;

if (file_exists($cacheFile)) {
    $filemtime = filemtime($cacheFile);
    // Check if the cache is less than 12 hours old (43200 seconds)
    if (time() - $filemtime < 43200) {
        $cacheValid = true;
    }
}

if ($cacheValid) {
    // Return cached response
    echo file_get_contents($cacheFile);
    exit;
}

// If no valid cache, construct prompt and call Gemini API
$gamesList = "";
foreach ($input['games'] as $g) {
    $gamesList .= "- " . $g['away'] . " @ " . $g['home'] . " (Pitchers: " . $g['awaySp'] . " vs " . $g['homeSp'] . ")\n";
}

$prompt = "Recommend 3 compelling MLB games today. Return ONLY JSON: {\"games\":[{\"a\":\"AWAY_TEAM_CODE\",\"h\":\"HOME_TEAM_CODE\",\"r\":\"1 sentence reason\"}]}. Games: " . $gamesList;

$url = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=" . $gemini_api_key;

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

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, array('Content-Type: application/json'));
curl_setopt($ch, CURLOPT_POST, true);
curl_setopt($ch, CURLOPT_POSTFIELDS, json_encode($data));
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, false); // For local/shared host compatibility

$response = curl_exec($ch);
$httpcode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($httpcode == 200) {
    $responseData = json_decode($response, true);
    // Try to extract the JSON text from Gemini's response structure
    if (isset($responseData['candidates'][0]['content']['parts'][0]['text'])) {
        $geminiText = $responseData['candidates'][0]['content']['parts'][0]['text'];

        // Write the successfully parsed response to cache
        file_put_contents($cacheFile, $geminiText);
        echo $geminiText;
    } else {
        http_response_code(500);
        echo json_encode(["error" => "Unexpected Gemini response structure", "details" => $response]);
    }
} else {
    http_response_code($httpcode);
    echo json_encode(["error" => "Gemini API call failed", "details" => $response]);
}
?>