# _FieldKit.ps1 — shared helpers for the Ark Field Kit Windows module.
#
# Dot-source this from every script in this folder:
#     . "$PSScriptRoot\_FieldKit.ps1"
#
# It provides the field-kit conventions in PowerShell form: the authorization
# banner, dry-run/apply mode label, transcript logging into field-kit\logs,
# config loading with validation, and a couple of small environment probes.
#
# Windows PowerShell 5.1+ compatible. No external modules required.

# Version 1.0 catches uninitialized-variable typos without throwing on the
# dynamic ($obj.$name) property access these scripts use against CIM/JSON objects.
Set-StrictMode -Version 1.0

# Tracks whether THIS scope actually started a transcript, so a nested script
# (e.g. Win11-Upgrade calling Win11-Readiness) never stops its parent's log.
$script:FieldKitTranscriptStarted = $false

function Get-KitRoot {
    # This helper lives in field-kit\windows ; the kit root is its parent.
    return (Split-Path -Parent $PSScriptRoot)
}

function Get-ModeLabel {
    param([bool]$Apply)
    if ($Apply) { return "APPLY (making real changes)" }
    return "DRY RUN (no changes)"
}

function Get-DateSlug {
    return (Get-Date -Format "yyyyMMdd")
}

function Get-Timestamp {
    return (Get-Date -Format "yyyy-MM-dd HH:mm:ss K")
}

function Start-FieldKitLog {
    # Starts a PowerShell transcript into field-kit\logs and returns its path.
    param(
        [Parameter(Mandatory = $true)][string]$Module,
        [Parameter(Mandatory = $true)][string]$Slug
    )
    $safeSlug = ($Slug -replace '[^A-Za-z0-9._-]', '_')
    $logDir = Join-Path (Get-KitRoot) "logs"
    if (-not (Test-Path $logDir)) {
        New-Item -ItemType Directory -Path $logDir -Force | Out-Null
    }
    $logPath = Join-Path $logDir ("{0}-{1}-{2}.log" -f $Module, $safeSlug, (Get-DateSlug))
    try {
        Start-Transcript -Path $logPath -Append -ErrorAction Stop | Out-Null
        $script:FieldKitTranscriptStarted = $true
    }
    catch {
        # A transcript may already be running in this host (e.g. a parent script);
        # note it and carry on WITHOUT claiming ownership so we never stop theirs.
        Write-Warning "Could not start transcript ($($_.Exception.Message)). Continuing without one."
    }
    return $logPath
}

function Stop-FieldKitLog {
    # Only stop the transcript if this scope started it.
    if ($script:FieldKitTranscriptStarted) {
        try { Stop-Transcript -ErrorAction SilentlyContinue | Out-Null } catch { }
        $script:FieldKitTranscriptStarted = $false
    }
}

function Get-ReportDir {
    $dir = Join-Path (Get-KitRoot) "reports"
    if (-not (Test-Path $dir)) {
        New-Item -ItemType Directory -Path $dir -Force | Out-Null
    }
    return $dir
}

function Write-Banner {
    # The authorization / what-it-will-do banner, printed before any work.
    param(
        [Parameter(Mandatory = $true)][string]$Title,
        [Parameter(Mandatory = $true)][string]$Site,
        [Parameter(Mandatory = $true)][bool]$Apply,
        [string[]]$WillDo = @(),
        [switch]$ReadOnly
    )
    Write-Host ""
    Write-Host "  +----------------------------------------------------------+"
    Write-Host "  |  ARK FIELD KIT - authorized IT service work only         |"
    Write-Host "  |  Run only on equipment you have permission to service.   |"
    Write-Host "  +----------------------------------------------------------+"
    Write-Host ""
    Write-Host ("  Tool  : {0}" -f $Title)
    Write-Host ("  Site  : {0}" -f $Site)
    if ($ReadOnly) {
        Write-Host "  Mode  : READ-ONLY (this tool never changes the machine)"
    }
    else {
        Write-Host ("  Mode  : {0}" -f (Get-ModeLabel $Apply))
    }
    Write-Host ("  Host  : {0}" -f $env:COMPUTERNAME)
    Write-Host ("  User  : {0}" -f $env:USERNAME)
    Write-Host ("  Time  : {0}" -f (Get-Timestamp))
    if ($WillDo.Count -gt 0) {
        Write-Host ""
        Write-Host "  This tool will:"
        foreach ($item in $WillDo) {
            Write-Host ("    - {0}" -f $item)
        }
    }
    Write-Host ""
}

function Confirm-Authorization {
    # For state-changing runs: require the operator to confirm authorization.
    # A read-only tool prints the banner but need not confirm.
    # -Authorized "<note>" records signed authorization for the log and skips
    # the interactive prompt (for logging, never to bypass intent).
    param(
        [Parameter(Mandatory = $true)][string]$Site,
        [string]$Authorized,
        [switch]$NonInteractive
    )
    if ($Authorized) {
        Write-Host ("  Authorization on file: {0}" -f $Authorized)
        return
    }
    if ($NonInteractive) {
        Write-Host "  Non-interactive run with no -Authorized note supplied - aborting."
        throw "Authorization not confirmed (no -Authorized note in a non-interactive run)."
    }
    Write-Host ("  Target site: {0}" -f $Site)
    Write-Host "  Confirm you have the client's written authorization for this work."
    $answer = Read-Host "  Type 'yes' to proceed"
    if ($answer.Trim().ToLower() -ne "yes") {
        throw "Not authorized - aborting."
    }
    Write-Host "  Authorization confirmed interactively by operator."
}

function Get-FieldKitConfig {
    # Reads a JSON config, validates required fields, returns a PSCustomObject.
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [string[]]$Required = @()
    )
    if (-not (Test-Path $Path)) {
        throw "Config not found: $Path`nCopy config.example.json in this folder and fill it in."
    }
    try {
        $raw = Get-Content -Path $Path -Raw -ErrorAction Stop
        $cfg = $raw | ConvertFrom-Json -ErrorAction Stop
    }
    catch {
        throw "Config is not valid JSON: $($_.Exception.Message)"
    }
    $missing = @()
    foreach ($field in $Required) {
        $has = $cfg.PSObject.Properties.Name -contains $field
        if (-not $has) {
            $missing += $field
            continue
        }
        $val = $cfg.$field
        if ($null -eq $val -or ($val -is [string] -and $val.Trim() -eq "")) {
            $missing += $field
        }
    }
    if ($missing.Count -gt 0) {
        throw ("Config is missing required fields: {0}" -f ($missing -join ", "))
    }
    return $cfg
}

function Test-IsAdmin {
    # True when the current process is elevated (Administrator).
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $p = New-Object System.Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    }
    catch {
        return $false
    }
}

function Write-Section {
    param([Parameter(Mandatory = $true)][string]$Text)
    Write-Host ""
    Write-Host ("=== {0} ===" -f $Text)
}
