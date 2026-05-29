<?php
// ipinfo.php - IP geolocation proxy using ipinfo.io/lite

if (file_exists('ipinfo_token.php')) {
    $ipinfo_token = require 'ipinfo_token.php';
} else {
    $ipinfo_token = 'YOUR_IPINFO_TOKEN_HERE';
}

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

if ($_SERVER['REQUEST_METHOD'] !== 'GET') {
    http_response_code(405);
    echo json_encode(["error" => "Method not allowed"]);
    exit;
}

// Resolve the real client IP — prefer CDN/proxy forwarding headers
$clientIp = $_SERVER['REMOTE_ADDR'] ?? '';
$forwarded = $_SERVER['HTTP_CF_CONNECTING_IP']
    ?? $_SERVER['HTTP_X_FORWARDED_FOR']
    ?? '';
if ($forwarded) {
    $parts = explode(',', $forwarded);
    $clientIp = trim($parts[0]);
}

if (!filter_var($clientIp, FILTER_VALIDATE_IP)) {
    http_response_code(400);
    echo json_encode(["error" => "Invalid client IP"]);
    exit;
}

$url = "https://api.ipinfo.io/lite/" . urlencode($clientIp);

$ch = curl_init($url);
curl_setopt($ch, CURLOPT_RETURNTRANSFER, true);
curl_setopt($ch, CURLOPT_HTTPHEADER, ["Authorization: Bearer $ipinfo_token"]);
curl_setopt($ch, CURLOPT_SSL_VERIFYPEER, true);
curl_setopt($ch, CURLOPT_TIMEOUT, 5);

$response = curl_exec($ch);
$httpcode = curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);

if ($httpcode === 200) {
    echo $response;
} else {
    http_response_code($httpcode ?: 500);
    echo json_encode(["error" => "ipinfo.io request failed", "http_code" => $httpcode]);
}
?>
