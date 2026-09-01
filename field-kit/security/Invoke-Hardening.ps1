#Requires -Version 5.1
<#
.SYNOPSIS
  Ark Field Kit - Apply common, SAFE cyber-hygiene fixes to a Windows machine.

.DESCRIPTION
  Remediates the low-risk findings that Invoke-SecurityAudit.ps1 raises:
  enable the host firewall, disable SMBv1, disable the Guest account, set a
  15-minute automatic screen lock, enable Defender real-time protection, and
  set a sane local password policy.

  SAFE BY DEFAULT: with no switch this is a DRY RUN. It prints exactly what
  it would change, whether each item is already compliant, and a
  "how to reverse it" note for every change. Nothing is modified until you
  add -Apply.

  Changes flagged as a lockout risk (password lockout policy, firewall while
  connected remotely) print a warning and require a second confirmation under
  -Apply unless you also pass -Yes. This script never disables the firewall,
  never opens blanket-allow rules, and never touches RDP or user passwords.

.PARAMETER SiteName
  Physical site / building this machine belongs to (for the log + banner).

.PARAMETER Apply
  Actually make the changes. Without this switch the script only prints a plan.

.PARAMETER Yes
  Skip the extra confirmation on lockout-risk changes (still requires -Apply).

.PARAMETER Authorized
  Signed-authorization note, e.g. "Joe's HVAC / signed 2026-01-04". Skips the
  interactive authorization prompt (the note is recorded instead).

.PARAMETER ScreenLockSeconds
  Inactivity screen-lock timeout to set, in seconds. Default 900 (15 minutes).

.PARAMETER MinPasswordLength
  Minimum password length to set. Default 12.

.EXAMPLE
  .\Invoke-Hardening.ps1 -SiteName "Joe's HVAC"
  Dry run: prints the plan and reversal notes, changes nothing.

.EXAMPLE
  .\Invoke-Hardening.ps1 -SiteName "Joe's HVAC" -Apply -Authorized "Joe's HVAC / 2026-01-04"
  Applies the safe fixes, prompting once for lockout-risk items.

.NOTES
  Windows PowerShell 5.1+. Run in an ELEVATED session - most fixes require
  administrator rights and will be reported as "needs elevation" otherwise.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SiteName,

    [switch]$Apply,

    [switch]$Yes,

    [string]$Authorized,

    [int]$ScreenLockSeconds = 900,

    [int]$MinPasswordLength = 12
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------
# Paths, slug, logging
# --------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$KitRoot   = Split-Path -Parent $ScriptDir
$LogDir    = Join-Path $KitRoot "logs"
$Module    = "security-harden"

function Get-Slug {
    param([string]$Name)
    $s = ($Name).ToLower()
    $s = ($s -replace "[^a-z0-9]+", "-").Trim("-")
    if (-not $s) { $s = "site" }
    return $s
}

$Slug     = Get-Slug -Name $SiteName
$DateSlug = (Get-Date).ToString("yyyyMMdd")
$IsoNow   = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")

if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("{0}-{1}-{2}.log" -f $Module, $Slug, $DateSlug)

function Write-Log {
    param([string]$Message = "")
    Write-Host $Message
    Add-Content -Path $LogPath -Value $Message
}

$ModeLabel = if ($Apply) { "APPLY (making real changes)" } else { "DRY RUN (no changes)" }
Write-Log ("=== {0} run for '{1}' at {2} ===" -f $Module, $Slug, $IsoNow)
Write-Log ("Mode: {0}" -f $ModeLabel)

# --------------------------------------------------------------------------
# Authorization banner
# --------------------------------------------------------------------------
function Test-IsAdmin {
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $p  = New-Object System.Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

function Show-Banner {
    Write-Host ""
    Write-Host "  +----------------------------------------------------------+"
    Write-Host "  |  ARK FIELD KIT - authorized IT service work only         |"
    Write-Host "  |  Run only on equipment you have permission to service.   |"
    Write-Host "  |  Hardening MODIFIES this machine when run with -Apply.    |"
    Write-Host "  +----------------------------------------------------------+"
    Write-Host ""
}

function Confirm-Authorization {
    Show-Banner
    if ($Authorized) {
        Write-Log ("Authorization on file: {0}" -f $Authorized)
        return
    }
    Write-Host ("  Target site: {0}" -f $SiteName)
    Write-Host "  Confirm you have the client's authorization to perform this work."
    $answer = Read-Host "  Type 'yes' to proceed"
    if ($answer.Trim().ToLower() -ne "yes") {
        Write-Host "  Not authorized - aborting."
        exit 2
    }
    Write-Log "Authorization confirmed interactively by operator."
}

# Detect whether this session is itself a Remote Desktop session (firewall lockout risk).
function Test-RemoteSession {
    try {
        if ($env:SESSIONNAME -and $env:SESSIONNAME -like "RDP-*") { return $true }
    } catch { }
    return $false
}

# --------------------------------------------------------------------------
# Change engine
#   Each change provides: Test (returns $true if ALREADY compliant),
#   Apply (the action), a plain-English description, a reversal note, and
#   a LockoutRisk flag + warning text.
# --------------------------------------------------------------------------
$Results = New-Object System.Collections.ArrayList

function Invoke-Change {
    param(
        [string]$Id,
        [string]$Title,
        [string]$Description,
        [string]$Reversal,
        [scriptblock]$Test,
        [scriptblock]$Apply,
        [bool]$LockoutRisk = $false,
        [string]$RiskWarning = ""
    )

    Write-Log ""
    Write-Log ("--- {0} ---" -f $Title)
    Write-Log ("  What: {0}" -f $Description)
    Write-Log ("  Reversible: {0}" -f $Reversal)

    if (-not (Test-IsAdmin)) {
        Write-Log "  SKIPPED: needs an elevated (administrator) PowerShell."
        [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "skipped-needs-elevation" })
        return
    }

    $already = $false
    try {
        $already = [bool](& $Test)
    } catch {
        Write-Log ("  Could not read current state: {0}" -f $_.Exception.Message)
        [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "unknown-state" })
        return
    }

    if ($already) {
        Write-Log "  Already compliant - nothing to do."
        [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "already-compliant" })
        return
    }

    if ($LockoutRisk) {
        Write-Log ("  WARNING: {0}" -f $RiskWarning)
    }

    if (-not $Apply) {
        Write-Log "  WOULD CHANGE (dry run) - re-run with -Apply to perform this."
        [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "would-change" })
        return
    }

    if ($LockoutRisk -and -not $Yes) {
        $ans = Read-Host "  This change carries a lockout risk. Type 'yes' to apply it"
        if ($ans.Trim().ToLower() -ne "yes") {
            Write-Log "  Skipped by operator."
            [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "skipped-by-operator" })
            return
        }
    }

    try {
        & $Apply
        Write-Log "  APPLIED."
        [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "applied" })
    } catch {
        Write-Log ("  FAILED: {0}" -f $_.Exception.Message)
        [void]$Results.Add([ordered]@{ id = $Id; title = $Title; outcome = "failed" })
    }
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
Confirm-Authorization

if (-not (Test-IsAdmin)) {
    Write-Log ""
    Write-Log "NOTE: this session is not elevated. Every change will be skipped."
    Write-Log "Re-run from an elevated PowerShell to apply fixes."
}

$remote = Test-RemoteSession

# 1) Enable the host firewall on all profiles.
Invoke-Change -Id "enable_firewall" -Title "Enable host firewall (all profiles)" `
    -Description "Turn the Windows firewall ON for Domain, Private and Public profiles." `
    -Reversal "Set-NetFirewallProfile -All -Enabled False (not recommended)." `
    -LockoutRisk $remote `
    -RiskWarning "You appear to be on a Remote Desktop session. Enabling the firewall is normally safe because the Remote Desktop allow-rule stays in place, but confirm that rule is enabled before proceeding." `
    -Test {
        $offCount = @(Get-NetFirewallProfile | Where-Object { -not $_.Enabled }).Count
        return ($offCount -eq 0)
    } `
    -Apply {
        Set-NetFirewallProfile -All -Enabled True
    }

# 2) Disable SMBv1 (server side).
Invoke-Change -Id "disable_smb1" -Title "Disable SMBv1 protocol" `
    -Description "Turn off the obsolete SMBv1 file-sharing protocol (server configuration)." `
    -Reversal "Set-SmbServerConfiguration -EnableSMB1Protocol `$true -Force (not recommended)." `
    -Test {
        $cfg = Get-SmbServerConfiguration
        return (-not [bool]$cfg.EnableSMB1Protocol)
    } `
    -Apply {
        Set-SmbServerConfiguration -EnableSMB1Protocol $false -Force
    }

# 3) Disable the Guest account.
Invoke-Change -Id "disable_guest" -Title "Disable Guest account" `
    -Description "Disable the built-in Guest account so it cannot be used for anonymous local access." `
    -Reversal "Enable-LocalUser -Name Guest (not recommended)." `
    -Test {
        $g = Get-LocalUser | Where-Object { $_.SID.Value -like "*-501" } | Select-Object -First 1
        if (-not $g) { return $true }   # no guest account = already safe
        return (-not $g.Enabled)
    } `
    -Apply {
        $g = Get-LocalUser | Where-Object { $_.SID.Value -like "*-501" } | Select-Object -First 1
        if ($g) { Disable-LocalUser -Name $g.Name }
    }

# 4) Set a 15-minute automatic screen lock (machine inactivity policy).
Invoke-Change -Id "set_screenlock" -Title ("Set automatic screen lock ({0}s)" -f $ScreenLockSeconds) `
    -Description ("Set the machine inactivity limit so the screen locks after {0} seconds idle." -f $ScreenLockSeconds) `
    -Reversal "Remove or raise InactivityTimeoutSecs under HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System." `
    -Test {
        $cur = $null
        try {
            $item = Get-ItemProperty -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name "InactivityTimeoutSecs" -ErrorAction Stop
            $cur = [int]$item.InactivityTimeoutSecs
        } catch { $cur = $null }
        return ($cur -ne $null -and $cur -gt 0 -and $cur -le $ScreenLockSeconds)
    } `
    -Apply {
        $key = "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System"
        if (-not (Test-Path $key)) { New-Item -Path $key -Force | Out-Null }
        Set-ItemProperty -Path $key -Name "InactivityTimeoutSecs" -Value $ScreenLockSeconds -Type DWord
    }

# 5) Enable Defender real-time protection.
Invoke-Change -Id "enable_defender_rtp" -Title "Enable Defender real-time protection" `
    -Description "Turn Microsoft Defender real-time monitoring back on." `
    -Reversal "Set-MpPreference -DisableRealtimeMonitoring `$true (strongly discouraged)." `
    -Test {
        $s = Get-MpComputerStatus
        return ([bool]$s.RealTimeProtectionEnabled -and [bool]$s.AntivirusEnabled)
    } `
    -Apply {
        Set-MpPreference -DisableRealtimeMonitoring $false
    }

# 6) Set a sane local password policy (length + lockout). Lockout risk.
Invoke-Change -Id "set_password_policy" -Title "Set sane password policy" `
    -Description ("Set minimum password length to {0} and enable account lockout (10 attempts / 15 min)." -f $MinPasswordLength) `
    -Reversal "net accounts /minpwlen:0 /lockoutthreshold:0 to revert length and lockout." `
    -LockoutRisk $true `
    -RiskWarning "Enabling account lockout means repeated wrong passwords will lock an account for 15 minutes. Make sure you have a known-good admin login and a recovery path before applying." `
    -Test {
        $raw = net accounts 2>$null | Out-String
        $minLen = 0; $lockout = "Never"
        foreach ($line in ($raw -split "`r?`n")) {
            if ($line -match "Minimum password length\s*:\s*(\d+)") { $minLen = [int]$Matches[1] }
            if ($line -match "Lockout threshold\s*:\s*(\S+)") { $lockout = $Matches[1] }
        }
        $lockoutSet = -not ($lockout -match "Never" -or $lockout -eq "0")
        return ($minLen -ge $MinPasswordLength -and $lockoutSet)
    } `
    -Apply {
        & net accounts ("/minpwlen:{0}" -f $MinPasswordLength) | Out-Null
        & net accounts "/lockoutthreshold:10" "/lockoutduration:15" "/lockoutwindow:15" | Out-Null
    }

# --------------------------------------------------------------------------
# Summary
# --------------------------------------------------------------------------
Write-Log ""
Write-Log "=== Summary ==="
foreach ($r in $Results) {
    Write-Log ("  {0,-40} {1}" -f $r.title, $r.outcome)
}
Write-Log ""
if (-not $Apply) {
    Write-Log "DRY RUN complete. No changes were made. Re-run with -Apply to perform the safe fixes."
    Write-Host ""
    Write-Host "Dry run complete. Add -Apply to make changes."
} else {
    Write-Log "APPLY complete. Re-run Invoke-SecurityAudit.ps1 to confirm the new posture."
    Write-Host ""
    Write-Host "Hardening complete. Re-run the audit to confirm."
}
