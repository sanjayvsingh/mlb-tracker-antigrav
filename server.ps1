$port = 8080
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    Write-Host "Starting local preview server at http://localhost:$port/"
    Write-Host "Press Ctrl+C to close."
    
    while ($listener.IsListening) {
        $context = $listener.GetContext()
        $response = $context.Response
        
        $localPath = $context.Request.Url.LocalPath.TrimStart('/')
        if ([string]::IsNullOrEmpty($localPath)) {
            $localPath = "index.html"
        }
        
        $filePath = Join-Path $PSScriptRoot $localPath
        
        if (Test-Path $filePath -PathType Leaf) {
            $content = [System.IO.File]::ReadAllBytes($filePath)
            
            if ($filePath -match '\.html$') { $response.ContentType = "text/html"}
            elseif ($filePath -match '\.css$') { $response.ContentType = "text/css"}
            elseif ($filePath -match '\.js$') { $response.ContentType = "application/javascript"}
            
            $response.ContentLength64 = $content.Length
            $response.OutputStream.Write($content, 0, $content.Length)
        } else {
            $response.StatusCode = 404
        }
        $response.Close()
    }
} catch {
    Write-Host "Error details: $_"
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
}
