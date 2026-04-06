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
        
        if ($localPath -eq 'gemini.php' -and $context.Request.HttpMethod -eq 'POST') {
            $response.ContentType = "application/json"
            $cacheFile = Join-Path $PSScriptRoot "gemini_cache.json"
            $cacheValid = $false
            if (Test-Path $cacheFile) {
                $lastWrite = (Get-Item $cacheFile).LastWriteTime
                if ((Get-Date) - $lastWrite -lt (New-TimeSpan -Hours 6)) {
                    $cacheValid = $true
                }
            }

            if ($cacheValid) {
                $content = [System.IO.File]::ReadAllBytes($cacheFile)
                $response.ContentLength64 = $content.Length
                $response.OutputStream.Write($content, 0, $content.Length)
            } else {
                $keyFile = Join-Path $PSScriptRoot "api_key.php"
                if (-not (Test-Path $keyFile)) {
                    $errorBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error": "API key file api_key.php not found for local testing."}')
                    $response.StatusCode = 500
                    $response.ContentLength64 = $errorBytes.Length
                    $response.OutputStream.Write($errorBytes, 0, $errorBytes.Length)
                } else {
                    $keyContent = Get-Content $keyFile | Out-String
                    $geminiApiKey = ""
                    if ($keyContent -match 'return\s+["'']([^"'']+)["'']') {
                        $geminiApiKey = $matches[1]
                    }
                    $reader = New-Object System.IO.StreamReader($context.Request.InputStream)
                    $inputJson = $reader.ReadToEnd()
                    $inputObj = $inputJson | ConvertFrom-Json
                    
                    $gamesList = ""
                    if ($inputObj.games) {
                        foreach ($g in $inputObj.games) {
                            $gamesList += "- $($g.away) @ $($g.home) (Pitchers: $($g.awaySp) vs $($g.homeSp))`n"
                        }
                    }
                    
                    $prompt = "Recommend 3 compelling MLB games today. Return ONLY JSON: {`"games`":[{`"a`":`"AWAY_TEAM_CODE`",`"h`":`"HOME_TEAM_CODE`",`"r`":`"1 sentence reason`"}]}. Games: $gamesList"
                    
                    $uri = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$geminiApiKey"
                    $body = @{
                        contents = @(
                            @{ parts = @( @{ text = $prompt } ) }
                        )
                        generationConfig = @{ response_mime_type = "application/json" }
                    } | ConvertTo-Json -Depth 5
                    
                    try {
                        $geminiResp = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json"
                        $geminiText = $geminiResp.candidates[0].content.parts[0].text
                        $responseBytes = [System.Text.Encoding]::UTF8.GetBytes($geminiText)
                        
                        [System.IO.File]::WriteAllBytes($cacheFile, $responseBytes)
                        
                        $response.ContentLength64 = $responseBytes.Length
                        $response.OutputStream.Write($responseBytes, 0, $responseBytes.Length)
                    } catch {
                        $errorMsg = "{ `"error`": `"Gemini API call failed.`", `"details`": `"$($_.Exception.Message)`" }"
                        $errorBytes = [System.Text.Encoding]::UTF8.GetBytes($errorMsg)
                        $response.StatusCode = 500
                        $response.ContentLength64 = $errorBytes.Length
                        $response.OutputStream.Write($errorBytes, 0, $errorBytes.Length)
                    }
                }
            }
            $response.Close()
            continue
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
