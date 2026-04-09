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
            $cacheValid = $false
            
            $reader = New-Object System.IO.StreamReader($context.Request.InputStream)
            $inputJson = $reader.ReadToEnd()
            $inputObj = $inputJson | ConvertFrom-Json
            
            $debugDate = $null
            if ($inputObj.debugDate) {
                $debugDate = $inputObj.debugDate
            }

            $safeDebugDate = ""
            if ($debugDate) {
                $safeDebugDate = $debugDate -replace '[^0-9-]', ''
            }
            
            $cacheFileName = "gemini_cache.json"
            if ($safeDebugDate) {
                $cacheFileName = "gemini_cache_$safeDebugDate.json"
            }
            $cacheFile = Join-Path $PSScriptRoot $cacheFileName
            
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
                    
                    $gamesList = ""
                    if ($inputObj.games) {
                        foreach ($g in $inputObj.games) {
                            $dateStr = ""
                            if ($g.date) {
                                $dateStr = "[" + $g.date + "] "
                            }
                            $gamesList += "- {0}{1} @ {2} (Pitchers: {3} vs {4})`n" -f $dateStr, $g.away, $g.home, $g.awaySp, $g.homeSp
                        }
                    }
                    
                    $startDateLabel = "today"
                    if ($debugDate) {
                        $startDateLabel = $debugDate
                    }
                    
                    $prompt = "From the following list of MLB games over the next three days (starting $startDateLabel), recommend the five most compelling ones with the most interesting storylines. You MUST ONLY choose from the games provided in the list below, and you MUST include the exact date. Return ONLY JSON: {`"games`":[{`"date`":`"YYYY-MM-DD`",`"a`":`"AWAY_TEAM_CODE`",`"h`":`"HOME_TEAM_CODE`",`"r`":`"1 sentence reason`"}]}. Games list:`n$gamesList"
                    
                    $uri = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=$geminiApiKey"
                    $body = @{
                        contents = @(
                            @{ parts = @( @{ text = $prompt } ) }
                        )
                        generationConfig = @{ response_mime_type = "application/json" }
                    } | ConvertTo-Json -Depth 5
                    
                    try {
                        $maxRetries = 3
                        $geminiResp = $null
                        
                        for ($i = 0; $i -lt $maxRetries; $i++) {
                            try {
                                $geminiResp = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json"
                                break
                            } catch {
                                if ($i -eq $maxRetries - 1) { throw }
                                Start-Sleep -Seconds 2
                            }
                        }
                        
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
