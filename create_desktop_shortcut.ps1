# create_desktop_shortcut.ps1
# Creates a convenient Desktop Shortcut for Zalo Ultra Client with custom Ultra icon

$desktopPath = [Environment]::GetFolderPath("Desktop")
$shortcutPath = Join-Path $desktopPath "Zalo Ultra Client.lnk"

$vbsTarget = "C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client\Start_Zalo_Ultra.vbs"
$workingDir = "C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client"

# Use the custom Zalo Ultra icon
$iconPath = "C:\Users\phamn\.gemini\antigravity\scratch\zalo-ultra-client\zalo-ultra.ico"

$WshShell = New-Object -ComObject WScript.Shell
$Shortcut = $WshShell.CreateShortcut($shortcutPath)
$Shortcut.TargetPath = "wscript.exe"
$Shortcut.Arguments = "`"$vbsTarget`""
$Shortcut.WorkingDirectory = $workingDir
$Shortcut.Description = "Zalo Ultra Client - High Performance, Zero Bloat, Ultra-Low RAM"
if (Test-Path $iconPath) {
    $Shortcut.IconLocation = "$iconPath, 0"
}
$Shortcut.Save()

Write-Host "[+] Desktop shortcut successfully created at: $shortcutPath" -ForegroundColor Green
Write-Host "    Target: $vbsTarget" -ForegroundColor Gray
Write-Host "    Icon:   $iconPath" -ForegroundColor Gray
