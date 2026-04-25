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
                    try {
                        $cacheStr = [System.Text.Encoding]::UTF8.GetString($content)
                        $cacheObj = ConvertFrom-Json $cacheStr
                        $cacheObj | Add-Member -MemberType NoteProperty -Name "from_cache" -Value $true
                        $content = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $cacheObj -Depth 5 -Compress))
                    } catch {}
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
                        if ($safeDebugDate) {
                            $startDateLabel = $safeDebugDate
                        }
                        
                        $prompt = "You are an MLB analyst. Below is a list of all MLB games over the next three days (starting $startDateLabel), with each team's current record, division standing, probable pitchers, hot hitters, and milestone watches.`n`nEvaluate ALL of the games below and select the five most compelling to watch. Prioritize:`n- Meaningful rivalry or divisional matchups with playoff implications`n- Exceptional or historic pitching duels`n- Players chasing milestones or on hot streaks`n- Comeback stories, prospect debuts, or unusual storylines`n`nYou MUST ONLY choose from the games listed below. You MUST include the exact date for each pick.`nReturn ONLY valid JSON in this format: {`"games`":[{`"date`":`"YYYY-MM-DD`",`"a`":`"AWAY_TEAM_CODE`",`"h`":`"HOME_TEAM_CODE`",`"r`":`"1 sentence reason`"}]}`n`nGames:`n$gamesList"
                        
                        $primaryModel = "gemini-3-flash-preview"
                        $lightModel = "gemini-3.1-flash-lite-preview"
                        $currentModel = $primaryModel
                        
                        if ($debugDate) {
                            $currentModel = $lightModel
                        }
                        
                        $bodyObj = @{
                            contents = @(
                                @{ parts = @( @{ text = $prompt } ) }
                            )
                            generationConfig = @{ response_mime_type = "application/json" }
                        }
                        $body = $bodyObj | ConvertTo-Json -Depth 5
                        
                        try {
                            Write-Host "Calling Gemini API ($startDateLabel)..."
                            $maxRetries = 3
                            $geminiResp = $null
                            
                            for ($i = 0; $i -lt $maxRetries; $i++) {
                                try {
                                    $uri = "https://generativelanguage.googleapis.com/v1beta/models/$currentModel`:`generateContent?key=$geminiApiKey"
                                    $geminiResp = Invoke-RestMethod -Uri $uri -Method Post -Body $body -ContentType "application/json"
                                    break
                                } catch {
                                    if (($_.Exception.Message -match "429" -or $_.Exception.Message -match "503") -and $currentModel -ne $lightModel) {
                                        # Fall back to light model
                                        $currentModel = $lightModel
                                        continue
                                    }
                                    
                                    if ($i -eq $maxRetries - 1) { throw }
                                    Start-Sleep -Seconds 2
                                }
                            }
                            
                            $geminiText = $geminiResp.candidates[0].content.parts[0].text
                            
                            # Inject model_used
                            $cleanText = $geminiText -replace '(?i)^```json\s*|\s*```$', ''
                            try {
                                $geminiObj = ConvertFrom-Json $cleanText
                                $geminiObj | Add-Member -MemberType NoteProperty -Name "model_used" -Value $currentModel
                                $geminiText = ConvertTo-Json $geminiObj -Depth 5 -Compress
                            } catch { 
                                # Ignore parse errors and just return raw text
                            }
                            
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
            
            # Sportsnet scraper endpoint
            if ($localPath -eq 'sportsnet.php' -and $context.Request.HttpMethod -eq 'GET') {
                $response.AddHeader("Access-Control-Allow-Origin", "*")
                $response.ContentType = "application/json"

                $snCacheFile = Join-Path $PSScriptRoot "sportsnet_cache.json"
                $snCacheValid = $false

                if (Test-Path $snCacheFile) {
                    $snLastWrite = (Get-Item $snCacheFile).LastWriteTime
                    if ((Get-Date) - $snLastWrite -lt (New-TimeSpan -Hours 12)) {
                        $snCacheValid = $true
                    }
                }

                if ($snCacheValid) {
                    $snContent = [System.IO.File]::ReadAllBytes($snCacheFile)
                    try {
                        $snStr = [System.Text.Encoding]::UTF8.GetString($snContent)
                        $snObj = ConvertFrom-Json $snStr
                        $snObj | Add-Member -MemberType NoteProperty -Name "from_cache" -Value $true -Force
                        $snContent = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $snObj -Depth 5 -Compress))
                    } catch {}
                    $response.ContentLength64 = $snContent.Length
                    $response.OutputStream.Write($snContent, 0, $snContent.Length)
                } else {
                    try {
                        Write-Host "Fetching Sportsnet MLB schedule..."
                        $snUrl = "https://watch.sportsnet.ca/leagues/MLB_155233"
                        $snHtml = Invoke-WebRequest -Uri $snUrl -UseBasicParsing -TimeoutSec 15 -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"

                        $snText = $snHtml.Content

                        # Slug-to-team mapping (longest patterns first for greedy match)
                        $slugTeams = [ordered]@{
                            'New_York_Yankees' = 'New York Yankees'
                            'New_York_Mets' = 'New York Mets'
                            'Los_Angeles_Dodgers' = 'Los Angeles Dodgers'
                            'Los_Angeles_Angels' = 'Los Angeles Angels'
                            'Chicago_Cubs' = 'Chicago Cubs'
                            'Chicago_White_Sox' = 'Chicago White Sox'
                            'San_Francisco' = 'San Francisco'
                            'San_Diego' = 'San Diego'
                            'St_Louis' = 'St. Louis'
                            'Tampa_Bay' = 'Tampa Bay'
                            'Kansas_City' = 'Kansas City'
                            'New_York' = 'New York'
                            'Los_Angeles' = 'Los Angeles'
                            'Cleveland' = 'Cleveland'
                            'Toronto' = 'Toronto'
                            'Boston' = 'Boston'
                            'Houston' = 'Houston'
                            'Baltimore' = 'Baltimore'
                            'Detroit' = 'Detroit'
                            'Minnesota' = 'Minnesota'
                            'Seattle' = 'Seattle'
                            'Texas' = 'Texas'
                            'Oakland' = 'Oakland'
                            'Atlanta' = 'Atlanta'
                            'Miami' = 'Miami'
                            'Philadelphia' = 'Philadelphia'
                            'Washington' = 'Washington'
                            'Cincinnati' = 'Cincinnati'
                            'Milwaukee' = 'Milwaukee'
                            'Pittsburgh' = 'Pittsburgh'
                            'Arizona' = 'Arizona'
                            'Colorado' = 'Colorado'
                        }

                        $snGames = @()
                        $snSeen = @{}

                        # Extract event URLs and their surrounding text
                        $eventMatches = [regex]::Matches($snText, '<a[^>]*href="([^"]*?/event/([^"]+))"[^>]*>(.*?)</a>', [System.Text.RegularExpressions.RegexOptions]::Singleline)
                        
                        foreach ($em in $eventMatches) {
                            $eventSlug = $em.Groups[2].Value
                            $linkText = $em.Groups[3].Value -replace '<[^>]+>', ''
                            
                            # Skip duplicates and replays
                            if ($snSeen.ContainsKey($eventSlug)) { continue }
                            if ($linkText -match 'REPLAY') { continue }
                            if ($linkText -notmatch '(LIVE|UPCOMING)') { continue }

                            $snStatus = "UPCOMING"
                            if ($linkText -match 'LIVE') { $snStatus = "LIVE" }

                            # Parse teams from slug (e.g. "Cleveland_Toronto_212498")
                            $slugClean = $eventSlug -replace '_\d+$', ''
                            
                            $snAway = $null
                            $remaining = $slugClean
                            foreach ($pattern in $slugTeams.Keys) {
                                if ($remaining.StartsWith($pattern)) {
                                    $snAway = $slugTeams[$pattern]
                                    $remaining = $remaining.Substring($pattern.Length).TrimStart('_')
                                    break
                                }
                            }
                            
                            $snHome = $null
                            if ($snAway -and $remaining) {
                                foreach ($pattern in $slugTeams.Keys) {
                                    if ($remaining -eq $pattern) {
                                        $snHome = $slugTeams[$pattern]
                                        break
                                    }
                                }
                            }
                            
                            if (-not $snAway -or -not $snHome) { continue }

                            $snSeen[$eventSlug] = $true
                            $snGames += @{
                                away = $snAway
                                home = $snHome
                                status = $snStatus
                                url = "https://watch.sportsnet.ca/event/$eventSlug"
                            }
                        }

                        $snResult = @{ games = $snGames; from_cache = $false }
                        $snJson = ConvertTo-Json $snResult -Depth 5 -Compress
                        
                        # Cache result
                        [System.IO.File]::WriteAllText($snCacheFile, $snJson, [System.Text.Encoding]::UTF8)
                        
                        $snBytes = [System.Text.Encoding]::UTF8.GetBytes($snJson)
                        $response.ContentLength64 = $snBytes.Length
                        $response.OutputStream.Write($snBytes, 0, $snBytes.Length)
                        Write-Host "Sportsnet: Found $($snGames.Count) games"
                    } catch {
                        Write-Host "Sportsnet fetch failed: $($_.Exception.Message)"
                        $snError = '{"error":"Failed to fetch Sportsnet schedule","details":"' + ($_.Exception.Message -replace '"', "'") + '"}'
                        $snErrorBytes = [System.Text.Encoding]::UTF8.GetBytes($snError)
                        $response.StatusCode = 502
                        $response.ContentLength64 = $snErrorBytes.Length
                        $response.OutputStream.Write($snErrorBytes, 0, $snErrorBytes.Length)
                    }
                }
                $response.Close()
                continue
            }

            $filePath = Join-Path $PSScriptRoot $localPath
            
            # Block sensitive file extensions
            if ($filePath -match '\.(php|ps1|md|env|gitignore|git|log|json)$' -and $localPath -ne 'al_standings.json' -and $localPath -ne 'schedule.json' -and $localPath -ne 'season_leaders.json') {
                $response.StatusCode = 403
                $response.Close()
                continue
            }

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
