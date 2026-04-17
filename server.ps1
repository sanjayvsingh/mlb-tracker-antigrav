$port = 8080
$listener = New-Object System.Net.HttpListener
$listener.Prefixes.Add("http://127.0.0.1:$port/")
$listener.Prefixes.Add("http://localhost:$port/")

try {
    $listener.Start()
    Write-Host "Starting local preview server at http://localhost:$port/"
    Write-Host "Press Ctrl+C to close."
    
    while ($listener.IsListening) {
        try {
            $context = $listener.GetContext()
            $response = $context.Response
            
            $localPath = $context.Request.Url.LocalPath.TrimStart('/')
            if ([string]::IsNullOrEmpty($localPath)) {
                $localPath = "index.html"
            }
            
            if ($context.Request.HttpMethod -eq 'OPTIONS') {
                $response.AddHeader("Access-Control-Allow-Origin", "*")
                $response.AddHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                $response.AddHeader("Access-Control-Allow-Headers", "Content-Type")
                $response.StatusCode = 200
                $response.Close()
                continue
            }

            if ($localPath -eq 'gemini.php' -and $context.Request.HttpMethod -eq 'POST') {
                $response.AddHeader("Access-Control-Allow-Origin", "*")
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
                        
                        $teamCtx = @{}
                        if ($inputObj.teamContext) {
                            $inputObj.teamContext.PSObject.Properties | ForEach-Object {
                                $teamCtx[$_.Name] = $_.Value
                            }
                        }
                        
                        function Get-Ordinal($n) {
                            $s = @('th','st','nd','rd')
                            $v = [int]$n % 100
                            $suffix = $s[($v - 20) % 10]
                            if (-not $suffix) { $suffix = $s[$v] }
                            if (-not $suffix) { $suffix = $s[0] }
                            return "$n$suffix"
                        }
                        
                        $gamesList = ""
                        if ($inputObj.games) {
                            foreach ($g in $inputObj.games) {
                                $dateStr = ""
                                if ($g.date) { $dateStr = $g.date }
                                
                                # Enrich away team info
                                $awayInfo = $g.away
                                if ($teamCtx.ContainsKey($g.away)) {
                                    $tc = $teamCtx[$g.away]
                                    $awayInfo += " ($($tc.record)"
                                    if ($tc.rank) { $awayInfo += ", $(Get-Ordinal $tc.rank) $($tc.div)" }
                                    $awayInfo += ")"
                                }
                                
                                # Enrich home team info
                                $homeInfo = $g.home
                                if ($teamCtx.ContainsKey($g.home)) {
                                    $tc = $teamCtx[$g.home]
                                    $homeInfo += " ($($tc.record)"
                                    if ($tc.rank) { $homeInfo += ", $(Get-Ordinal $tc.rank) $($tc.div)" }
                                    $homeInfo += ")"
                                }
                                
                                $line = "- [$dateStr] $awayInfo @ $homeInfo | Pitchers: $($g.awaySp) vs $($g.homeSp)"
                                
                                # Hot hitters
                                $hotParts = @()
                                if ($teamCtx.ContainsKey($g.away) -and $teamCtx[$g.away].hot) {
                                    $hotParts += $teamCtx[$g.away].hot
                                }
                                if ($teamCtx.ContainsKey($g.home) -and $teamCtx[$g.home].hot) {
                                    $hotParts += $teamCtx[$g.home].hot
                                }
                                if ($hotParts.Count -gt 0) {
                                    $line += " | Hot: $($hotParts -join ', ')"
                                }
                                
                                # Milestones
                                $mileParts = @()
                                if ($teamCtx.ContainsKey($g.away) -and $teamCtx[$g.away].milestones) {
                                    $mileParts += $teamCtx[$g.away].milestones
                                }
                                if ($teamCtx.ContainsKey($g.home) -and $teamCtx[$g.home].milestones) {
                                    $mileParts += $teamCtx[$g.home].milestones
                                }
                                if ($mileParts.Count -gt 0) {
                                    $line += " | Milestone: $($mileParts -join '; ')"
                                }
                                
                                $gamesList += "$line`n"
                            }
                        }
                        
                        $startDateLabel = "today"
                        if ($debugDate) {
                            $startDateLabel = $debugDate
                        }
                        
                        $prompt = "You are an MLB analyst. Below is a list of all MLB games over the next three days (starting $startDateLabel), with each team's current record, division standing, probable pitchers, hot hitters, and milestone watches.`n`nEvaluate ALL of the games below and select the five most compelling to watch. Prioritize:`n- Meaningful rivalry or divisional matchups with playoff implications`n- Exceptional or historic pitching duels`n- Players chasing milestones or on hot streaks`n- Comeback stories, prospect debuts, or unusual storylines`n`nYou MUST ONLY choose from the games listed below. You MUST include the exact date for each pick.`nReturn ONLY valid JSON in this format: {`"games`":[{`"date`":`"YYYY-MM-DD`",`"a`":`"AWAY_TEAM_CODE`",`"h`":`"HOME_TEAM_CODE`",`"r`":`"1 sentence reason`"}]}`n`nGames:`n$gamesList"
                        
                        $model = "gemini-3-flash-preview"
                        if ($debugDate) {
                            $model = "gemini-3.1-flash-lite-preview"
                        }
                        $uri = "https://generativelanguage.googleapis.com/v1beta/models/$model`:`generateContent?key=$geminiApiKey"
                        $body = @{
                            contents = @(
                                @{ parts = @( @{ text = $prompt } ) }
                            )
                            generationConfig = @{ response_mime_type = "application/json" }
                        } | ConvertTo-Json -Depth 5
                        
                        try {
                            Write-Host "Calling Gemini API ($startDateLabel)..."
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
                            Write-Host "Success!"
                        } catch {
                            Write-Host "Gemini API failed: $($_.Exception.Message)"
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
        } catch {
            Write-Host "Request handled but client connection failed or was closed: $($_.Exception.Message)"
            if ($null -ne $response) { try { $response.Close() } catch {} }
        }
    }
} catch {
    Write-Host "Server listener fatal error: $_"
} finally {
    if ($listener.IsListening) {
        $listener.Stop()
    }
}
