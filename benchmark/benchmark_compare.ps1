# benchmark_compare.ps1
# Zalo PC vs Zalo Mod vs Zalo Ultra Performance & Memory Benchmark
# Usage: powershell -ExecutionPolicy Bypass -File .\benchmark_compare.ps1

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "             ZALO CLIENT MULTI-INSTANCE BENCHMARK & COMPARISON                  " -ForegroundColor Yellow
Write-Host "================================================================================" -ForegroundColor Cyan

function Format-Bytes($bytes) {
    return [Math]::Round($bytes / 1MB, 2)
}

$allZalo = Get-Process | Where-Object { $_.ProcessName -like "*Zalo*" }

if (-not $allZalo) {
    Write-Host "[!] No Zalo processes currently running on the system." -ForegroundColor Yellow
    exit 0
}

Write-Host "[*] Found $($allZalo.Count) Zalo-related processes active.`n" -ForegroundColor Green

# Query detailed process info with WMI / CIM
$procDetails = Get-CimInstance Win32_Process | Where-Object { $_.Name -like "*Zalo*" }

$groups = @{
    "Zalo Official (Original)" = @()
    "Zalo Ultra (Supervisor)"  = @()
    "Zalo Mod / Test Env"      = @()
    "Other Zalo Processes"     = @()
}

foreach ($p in $procDetails) {
    $cmd = $p.CommandLine
    $path = $p.ExecutablePath
    $pidNum = $p.ProcessId
    $psObj = $allZalo | Where-Object { $_.Id -eq $pidNum } | Select-Object -First 1

    if (-not $psObj) { continue }

    $ws = $psObj.WorkingSet64
    $commit = $p.PageFileUsage * 1KB # PageFileUsage is in KB in Win32_Process

    $item = [PSCustomObject]@{
        Id          = $pidNum
        Name        = $p.Name
        WorkingSet  = $ws
        Commit      = $commit
        CommandLine = $cmd
        Path        = $path
    }

    if ($p.Name -like "*zalo-ultra*") {
        $groups["Zalo Ultra (Supervisor)"] += $item
    }
    elseif ($cmd -like "*remote-debugging-port=9333*" -or $cmd -like "*ultra*" -or $cmd -like "*D:\Zalo_Test_Env*") {
        # Check if running under ultra mode
        $groups["Zalo Ultra (Supervisor)"] += $item
    }
    elseif ($path -like "*C:\Users\phamn\AppData\Local\Programs\Zalo*") {
        $groups["Zalo Official (Original)"] += $item
    }
    else {
        $groups["Zalo Mod / Test Env"] += $item
    }
}

$summaryTable = @()

foreach ($groupName in $groups.Keys) {
    $procs = $groups[$groupName]
    if ($procs.Count -eq 0) { continue }

    $totalWs = ($procs | Measure-Object -Property WorkingSet -Sum).Sum
    $totalCommit = ($procs | Measure-Object -Property Commit -Sum).Sum

    $summaryTable += [PSCustomObject]@{
        "Client Instance" = $groupName
        "Process Count"   = $procs.Count
        "RAM WS (MB)"     = Format-Bytes $totalWs
        "Commit (MB)"     = Format-Bytes $totalCommit
        "Avg RAM/Proc"    = Format-Bytes ($totalWs / $procs.Count)
    }
}

$summaryTable | Format-Table -AutoSize

Write-Host "`nDetailed Process Breakdown:" -ForegroundColor Cyan
Write-Host "--------------------------------------------------------------------------------"
foreach ($groupName in $groups.Keys) {
    $procs = $groups[$groupName]
    if ($procs.Count -eq 0) { continue }

    Write-Host "`n=== $groupName ($($procs.Count) processes) ===" -ForegroundColor Yellow
    $procs | Select-Object Id, Name, @{N="RAM (MB)";E={Format-Bytes $_.WorkingSet}}, @{N="Commit (MB)";E={Format-Bytes $_.Commit}} | Format-Table -AutoSize
}

Write-Host "================================================================================" -ForegroundColor Cyan
Write-Host "Benchmark completed successfully." -ForegroundColor Green
