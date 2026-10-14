param([string]$Action, [string]$Plan)
$ErrorActionPreference = 'Stop'
function Trace([string]$Text) {
  [IO.File]::AppendAllText(($Plan + '.trace.log'), ([DateTime]::UtcNow.ToString('o') + ' ' + $Text + [Environment]::NewLine))
}
Trace "script entered: $Action"
$settings = Get-Content -Raw -LiteralPath $Plan | ConvertFrom-Json
Trace 'plan read'

function Identity([int]$Number, $NativeRow = $null) {
  $process = $null
  try {
    Trace "identity ${Number}: before GetProcessById"
    $process = [Diagnostics.Process]::GetProcessById($Number)
    Trace "identity ${Number}: process found"
    # Keep a process handle while reading creation time and executable. A process
    # that exits and has its PID reused must not become the target of Kill().
    $handle = $process.Handle
    Trace "identity ${Number}: handle pinned"
    $native = $NativeRow
    if (-not $native) {
      Trace "identity ${Number}: before CIM"
      $native = Get-CimInstance Win32_Process -Filter "ProcessId = $Number" -OperationTimeoutSec 5
      Trace "identity ${Number}: CIM returned"
    }
    Trace "identity ${Number}: before MainModule"
    $executable = $process.MainModule.FileName
    Trace "identity ${Number}: MainModule returned"
    $created = $process.StartTime.ToUniversalTime()
    Trace "identity ${Number}: creation time read"
    return @{
      pid = $Number
      parentPid = [int]$native.ParentProcessId
      executable = $executable
      createdAt = $created.ToFileTimeUtc().ToString()
      startedAt = $created.ToString('o')
      command = $native.CommandLine
    }
  } catch { Trace "identity ${Number}: failed: $_"; return $null } finally { if ($process) { $process.Dispose() } }
}

switch ($Action) {
  'identity' { Identity $settings.pid | ConvertTo-Json -Compress -Depth 5 }
  'list' {
    Trace 'list before CIM'
    $rows = @(Get-CimInstance Win32_Process -OperationTimeoutSec 5 | ForEach-Object {
      $row = Identity ([int]$_.ProcessId) $_
      if ($row) { $row }
    })
    Trace 'list CIM returned'
    ConvertTo-Json -InputObject $rows -Compress -Depth 5
  }
  'threads' {
    $process = [Diagnostics.Process]::GetProcessById([int]$settings.owner.pid)
    try {
      $handle = $process.Handle
      if ($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $settings.owner.createdAt -or $process.MainModule.FileName -ne $settings.owner.executable) { throw 'test process identity changed before thread capture' }
      $rows = @($process.Threads | ForEach-Object {
        $wait = $null
        try { if ($_.ThreadState -eq 'Wait') { $wait = $_.WaitReason.ToString() } } catch {}
        @{ id = $_.Id; state = $_.ThreadState.ToString(); waitReason = $wait; cpuMs = $_.TotalProcessorTime.TotalMilliseconds }
      })
      ConvertTo-Json -InputObject $rows -Compress -Depth 5
    } finally { $process.Dispose() }
  }
  'dump' {
    $process = [Diagnostics.Process]::GetProcessById([int]$settings.owner.pid)
    try {
      $handle = $process.Handle
      if ($process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString() -ne $settings.owner.createdAt -or $process.MainModule.FileName -ne $settings.owner.executable) { throw 'test process identity changed before dump' }
      $arguments = @('-accepteula', '-ma', $settings.owner.pid, ('"{0}"' -f $settings.output))
      $tool = Start-Process -FilePath $settings.procdump -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput ($settings.output + '.out') -RedirectStandardError ($settings.output + '.err')
      try {
        $toolHandle = $tool.Handle
        $finished = $tool.WaitForExit(40000)
        if (-not $finished) { $tool.Kill() }
        @{ status = $(if ($finished -and $tool.ExitCode -eq 0 -and (Test-Path -LiteralPath $settings.output)) { 'captured' } else { 'unavailable' }); exit = $tool.ExitCode; timedOut = -not $finished } | ConvertTo-Json -Compress
      } finally { $tool.Dispose() }
    } finally { $process.Dispose() }
  }
  'terminate' {
    $process = $null
    $terminated = $false
    try {
      $process = [Diagnostics.Process]::GetProcessById([int]$settings.owner.pid)
      $handle = $process.Handle
      $created = $process.StartTime.ToUniversalTime().ToFileTimeUtc().ToString()
      $executable = $process.MainModule.FileName
      if ($created -eq $settings.owner.createdAt -and $executable -eq $settings.owner.executable) {
        $process.Kill()
        $terminated = $true
      }
    } catch {} finally { if ($process) { $process.Dispose() } }
    @{ pid = $settings.owner.pid; terminated = $terminated } | ConvertTo-Json -Compress
  }
}
Trace "script completed: $Action"
