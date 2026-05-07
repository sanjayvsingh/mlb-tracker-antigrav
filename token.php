<?php
// Shared CSRF session helper.
// All proxy endpoints (gemini.php, sportsnet.php, mlbnetwork.php) require this file.

session_set_cookie_params([
    'lifetime' => 86400,  // 24 hours
    'path'     => '/',
    'secure'   => true,
    'httponly' => true,
    'samesite' => 'Lax'   // Lax (not Strict) so shared links work on first click
]);
session_start();

// Returns true if the request is from localhost (dev server bypass).
function is_local() {
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    return $ip === '127.0.0.1' || $ip === '::1';
}

// Called from index.php: creates a token for this session if one doesn't exist.
function csrf_generate() {
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(16));
    }
    return $_SESSION['csrf_token'];
}

// Called from proxy endpoints: verifies the submitted token matches the session.
// Exits with 403 on failure. Localhost requests are bypassed for local dev.
function csrf_verify() {
    if (is_local()) return;

    $submitted = '';
    if (function_exists('getallheaders')) {
        $headers = getallheaders();
        $submitted = $headers['X-CSRF-Token'] ?? $headers['x-csrf-token'] ?? '';
    }
    if (empty($submitted)) {
        $submitted = $_SERVER['HTTP_X_CSRF_TOKEN'] ?? '';
    }

    if (empty($_SESSION['csrf_token']) || !hash_equals($_SESSION['csrf_token'], $submitted)) {
        http_response_code(403);
        echo json_encode(['error' => 'Forbidden. Invalid or missing CSRF token.']);
        exit;
    }
}
?>
