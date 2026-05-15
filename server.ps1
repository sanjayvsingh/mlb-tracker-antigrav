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
                $origin = $context.Request.Headers["Origin"]
                if ($origin -match "http://localhost:8080|http://127.0.0.1:8080|https://mlb.sanvash.com") {
                    $response.AddHeader("Access-Control-Allow-Origin", $origin)
                }
                $response.AddHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS")
                $response.AddHeader("Access-Control-Allow-Headers", "Content-Type, X-App-Token")
                $response.StatusCode = 200
                $response.Close()
                continue
            }

            if ($localPath -eq 'gemini.php' -and $context.Request.HttpMethod -eq 'POST') {
                $origin = $context.Request.Headers["Origin"]
                if ($origin -match "http://localhost:8080|http://127.0.0.1:8080|https://mlb.sanvash.com") {
                    $response.AddHeader("Access-Control-Allow-Origin", $origin)
                }
                
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
                        $lightModel = "gemini-3.1-flash-lite"
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
                $origin = $context.Request.Headers["Origin"]
                if ($origin -match "http://localhost:8080|http://127.0.0.1:8080|https://mlb.sanvash.com") {
                    $response.AddHeader("Access-Control-Allow-Origin", $origin)
                }
                
                $response.ContentType = "application/json"

                $snCacheFile = Join-Path $PSScriptRoot "sportsnet_cache.json"
                $snCacheValid = $false

                if (Test-Path $snCacheFile) {
                    $snLastWrite = (Get-Item $snCacheFile).LastWriteTime
                    if ((Get-Date) - $snLastWrite -lt (New-TimeSpan -Hours 4)) {
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
                        Write-Host "Fetching Sportsnet MLB schedule via API..."
                        $snApiBase = "https://production-cdn.d3-rgr-diva.com/api"
                        
                        try {
                            $snHomepage = Invoke-WebRequest -Uri "https://watch.sportsnet.ca/sportschedule" -UseBasicParsing -TimeoutSec 5 -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                            if ($snHomepage.Content -match "env\.CLIENT_SERVICE_CDN_URL='([^']+)'") {
                                $snApiBase = $matches[1].TrimEnd('/')
                            }
                        } catch {
                            Write-Host "Failed to dynamically discover API URL, using fallback."
                        }
                        
                        $snApiBase = "$snApiBase/sportschedules?competition=cp-mlb"

                        # Fetch today through day+3 to cover 3-day ET window
                        # (a game at 11 PM ET on day X is filed as day X+1 in UTC)
                        $snToday = Get-Date
                        $snDates = @()
                        for ($d = 0; $d -le 3; $d++) {
                            $snDates += $snToday.AddDays($d).ToString('yyyy-MM-dd')
                        }

                        $snGames = @()
                        $snSeenIds = @{}

                        foreach ($dateStr in $snDates) {
                            $snUrl = "$snApiBase&date=$dateStr&page_size=50"
                            try {
                                $snResp = Invoke-RestMethod -Uri $snUrl -UseBasicParsing -TimeoutSec 10 -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                            } catch {
                                Write-Host "  Sportsnet API failed for $dateStr`: $($_.Exception.Message)"
                                continue
                            }

                            if (-not $snResp.items) { continue }

                            foreach ($item in $snResp.items) {
                                if ($item.type -ne 'event') { continue }
                                $itemId = $item.id
                                if ($snSeenIds.ContainsKey($itemId)) { continue }
                                $snSeenIds[$itemId] = $true

                                $title = $item.title
                                $path = $item.path
                                $startUtc = $item.eventStartDate

                                if (-not $title -or -not $startUtc) { continue }

                                # Parse teams from title (e.g., "Toronto @ Tampa Bay")
                                $teamParts = $title -split '\s+@\s+', 2
                                if ($teamParts.Count -ne 2) { continue }

                                $snAway = $teamParts[0].Trim()
                                $snHome = $teamParts[1].Trim()

                                # Determine status
                                $videoStatus = $item.customFields.VideoStatus
                                $snStatus = if ($videoStatus -eq 'Live') { 'LIVE' } else { 'UPCOMING' }

                                # Convert UTC start time to Eastern for local date
                                $utcDt = [DateTime]::Parse($startUtc, $null, [System.Globalization.DateTimeStyles]::RoundtripKind)
                                $etZone = [TimeZoneInfo]::FindSystemTimeZoneById('Eastern Standard Time')
                                $etDt = [TimeZoneInfo]::ConvertTimeFromUtc($utcDt, $etZone)
                                $localDate = $etDt.ToString('yyyy-MM-dd')

                                $eventUrl = "https://watch.sportsnet.ca$path"

                                $snGames += @{
                                    away = $snAway
                                    home = $snHome
                                    status = $snStatus
                                    date = $localDate
                                    url = $eventUrl
                                }
                            }
                        }

                        $snResult = @{ games = $snGames; from_cache = $false }
                        $snJson = ConvertTo-Json $snResult -Depth 5 -Compress
                        
                        # Cache result
                        [System.IO.File]::WriteAllText($snCacheFile, $snJson, [System.Text.Encoding]::UTF8)
                        
                        $snBytes = [System.Text.Encoding]::UTF8.GetBytes($snJson)
                        $response.ContentLength64 = $snBytes.Length
                        $response.OutputStream.Write($snBytes, 0, $snBytes.Length)
                        Write-Host "Sportsnet: Found $($snGames.Count) games across $($snDates.Count) days"
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
            
            # MLB Network scraper endpoint
            if ($localPath -eq 'mlbnetwork.php' -and $context.Request.HttpMethod -eq 'GET') {
                $origin = $context.Request.Headers["Origin"]
                if ($origin -match "http://localhost:8080|http://127.0.0.1:8080|https://mlb.sanvash.com") {
                    $response.AddHeader("Access-Control-Allow-Origin", $origin)
                }
                
                $response.ContentType = "application/json"

                $mlbnCacheFile = Join-Path $PSScriptRoot "mlbnetwork_cache.json"
                $mlbnCacheValid = $false

                if (Test-Path $mlbnCacheFile) {
                    $mlbnLastWrite = (Get-Item $mlbnCacheFile).LastWriteTime
                    if ((Get-Date) - $mlbnLastWrite -lt (New-TimeSpan -Hours 24)) {
                        $mlbnCacheValid = $true
                    }
                }

                if ($mlbnCacheValid) {
                    $mlbnContent = [System.IO.File]::ReadAllBytes($mlbnCacheFile)
                    try {
                        $mlbnStr = [System.Text.Encoding]::UTF8.GetString($mlbnContent)
                        $mlbnObj = ConvertFrom-Json $mlbnStr
                        $mlbnObj | Add-Member -MemberType NoteProperty -Name "from_cache" -Value $true -Force
                        $mlbnContent = [System.Text.Encoding]::UTF8.GetBytes((ConvertTo-Json $mlbnObj -Depth 5 -Compress))
                    } catch {}
                    $response.ContentLength64 = $mlbnContent.Length
                    $response.OutputStream.Write($mlbnContent, 0, $mlbnContent.Length)
                } else {
                    try {
                        Write-Host "Fetching MLB Network schedule..."
                        $mlbnUrl = "https://www.mlb.com/network/modules/shows/mlbn-live-games"
                        $mlbnHtml = Invoke-WebRequest -Uri $mlbnUrl -UseBasicParsing -TimeoutSec 10 -UserAgent "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
                        
                        $mlbnGames = @()
                        
                        $pattern = '(?s)<tr[^>]*>\s*<td[^>]*>([^<]+)</td>\s*<td[^>]*>([^<]+)</td>\s*<td[^>]*>.*?<div[^>]*>([^<]+)</div>'
                        $htmlMatches = [regex]::Matches($mlbnHtml.Content, $pattern)
                        
                        foreach ($m in $htmlMatches) {
                            $dateStr = $m.Groups[1].Value.Trim()
                            $timeStr = $m.Groups[2].Value.Trim()
                            $desc = $m.Groups[3].Value.Trim()
                            
                            try {
                                $dtObj = [datetime]::ParseExact($dateStr, 'MM/dd/yyyy', $null)
                                $formattedDate = $dtObj.ToString('yyyy-MM-dd')
                            } catch {
                                continue
                            }
                            
                            $status = "UPCOMING"
                            if ($desc -match '\[LIVE\]') {
                                $status = "LIVE"
                            }
                            
                            $segments = $desc -split ' or '
                            foreach ($seg in $segments) {
                                $clean = $seg -replace '(?i)( from | on |\s*\(|\s*\[).*', ''
                                $mTeams = [regex]::Match($clean, '(?i)(.+?)\s+(?:at|@)\s+(.+)')
                                if ($mTeams.Success) {
                                    $mlbnGames += @{
                                        away = $mTeams.Groups[1].Value.Trim()
                                        home = $mTeams.Groups[2].Value.Trim()
                                        date = $formattedDate
                                        time = $timeStr
                                        status = $status
                                    }
                                }
                            }
                        }

                        $mlbnResult = @{ games = $mlbnGames; from_cache = $false }
                        $mlbnJson = ConvertTo-Json $mlbnResult -Depth 5 -Compress
                        
                        [System.IO.File]::WriteAllText($mlbnCacheFile, $mlbnJson, [System.Text.Encoding]::UTF8)
                        
                        $mlbnBytes = [System.Text.Encoding]::UTF8.GetBytes($mlbnJson)
                        $response.ContentLength64 = $mlbnBytes.Length
                        $response.OutputStream.Write($mlbnBytes, 0, $mlbnBytes.Length)
                        Write-Host "MLB Network: Found $($mlbnGames.Count) games"
                    } catch {
                        Write-Host "MLB Network fetch failed: $($_.Exception.Message)"
                        $mlbnErrorBytes = [System.Text.Encoding]::UTF8.GetBytes('{"error":"Failed to fetch MLB Network schedule"}')
                        $response.StatusCode = 502
                        $response.ContentLength64 = $mlbnErrorBytes.Length
                        $response.OutputStream.Write($mlbnErrorBytes, 0, $mlbnErrorBytes.Length)
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
