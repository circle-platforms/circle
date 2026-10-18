# DIAGNOSTIC ONLY: every half second, who has the debugging port, which installer
# PowerShell runs and how each Circle main process was started.
param([int]$Port, [string]$Out, [int]$Seconds = 300)
$end = (Get-Date).AddSeconds($Seconds)
while ((Get-Date) -lt $end -and -not (Test-Path -LiteralPath "$Out.stop")) {
  $now = (Get-Date).ToString('HH:mm:ss.fff')
  $tcp = @(Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue | ForEach-Object {
      $alive = [bool](Get-Process -Id $_.OwningProcess -ErrorAction SilentlyContinue)
      '{0}:{1}>{2}:{3}/{4}/owner={5}{6}' -f $_.LocalAddress, $_.LocalPort, $_.RemoteAddress, $_.RemotePort, $_.State, $_.OwningProcess, $(if ($alive) { '' } else { '(gone)' })
    })
  $installers = @(Get-CimInstance Win32_Process -Filter "Name='powershell.exe'" | Where-Object { $_.CommandLine -match 'install\.ps1' } | ForEach-Object {
      '{0}<{1}{2}' -f $_.ProcessId, $_.ParentProcessId, $(if ($_.CommandLine -match '-Start') { '(start)' } else { '' })
    })
  $circle = @(Get-CimInstance Win32_Process -Filter "Name='Circle.exe'" | Where-Object { $_.CommandLine -notmatch '--type=' } | ForEach-Object {
      '{0}<{1} {2}' -f $_.ProcessId, $_.ParentProcessId, ($_.CommandLine -replace '^.*?Circle\.exe"?\s*', '')
    })
  $msi = @(Get-Process msiexec -ErrorAction SilentlyContinue).Count
  Add-Content -LiteralPath $Out -Value ("$now tcp=[{0}] installer=[{1}] circle=[{2}] msiexec={3}" -f ($tcp -join ' '), ($installers -join ' '), ($circle -join ' | '), $msi)
  Start-Sleep -Milliseconds 500
}
