$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$startupDir = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupDir 'localPrintZebra.lnk'
$targetPath = Join-Path $scriptDir 'start-windows-hidden.vbs'

if (-not (Test-Path $targetPath)) {
    throw "Launcher not found: $targetPath"
}

$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $targetPath
$shortcut.WorkingDirectory = $scriptDir
$shortcut.WindowStyle = 7
$shortcut.IconLocation = "$env:SystemRoot\System32\shell32.dll,220"
$shortcut.Save()

Write-Output "Autostart shortcut created: $shortcutPath"
Write-Output "Windows will launch localPrintZebra automatically after login."