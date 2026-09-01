#Requires -Version 5.1
<#
.SYNOPSIS
  Ark Field Kit - Read-only cyber-hygiene audit of a Windows machine.

.DESCRIPTION
  Inspects the local Windows machine and reports its security posture as
  structured JSON that the insurance-report.py builder turns into a
  client-facing deliverable. Checks Defender/AV, firewall, BitLocker,
  Windows Update, local admins, RDP, SMBv1, screen-lock, password policy,
  the guest account, autorun and domain membership.

  This script is READ-ONLY. It never changes a setting. It only reads
  status via built-in cmdlets, WMI/CIM, the registry and 'net accounts'.
  Some checks (BitLocker, full password policy) report richer detail when
  run in an elevated PowerShell; without admin they degrade to "unknown"
  rather than failing.

.PARAMETER SiteName
  Physical site / building this machine belongs to. Shown on the report.

.PARAMETER Client
  Legal client name for the report and invoice trail. Defaults to SiteName.

.PARAMETER Technician
  Who ran the audit. Defaults to "Ark Web Solutions".

.PARAMETER Authorized
  Signed-authorization note, e.g. "Joe's HVAC / signed 2026-01-04". When
  supplied the interactive authorization prompt is skipped (the note is
  recorded instead). Read-only work, but we still record who authorized it.

.PARAMETER OutDir
  Where the JSON report is written. Defaults to the field-kit reports folder.

.EXAMPLE
  .\Invoke-SecurityAudit.ps1 -SiteName "Joe's HVAC" -Authorized "Joe's HVAC / 2026-01-04"

.NOTES
  Windows PowerShell 5.1+ (built into Windows 10/11 and Server 2016+).
  Run in an elevated session for complete results.
#>

[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$SiteName,

    [string]$Client,

    [string]$Technician = "Ark Web Solutions",

    [string]$Authorized,

    [string]$OutDir
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = "Stop"

# --------------------------------------------------------------------------
# Paths and constants
# --------------------------------------------------------------------------
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$KitRoot   = Split-Path -Parent $ScriptDir
$LogDir    = Join-Path $KitRoot "logs"
$ReportDir = Join-Path $KitRoot "reports"

if (-not $Client) { $Client = $SiteName }
if (-not $OutDir) { $OutDir = $ReportDir }

$Module = "security-audit"

# --------------------------------------------------------------------------
# Slug + timestamps
# --------------------------------------------------------------------------
function Get-Slug {
    param([string]$Name)
    $s = ($Name).ToLower()
    $s = ($s -replace "[^a-z0-9]+", "-").Trim("-")
    if (-not $s) { $s = "site" }
    return $s
}

$Slug     = Get-Slug -Name $SiteName
$DateSlug = (Get-Date).ToString("yyyyMMdd")
$Stamp    = (Get-Date).ToString("yyyyMMdd-HHmmss")
$IsoNow   = (Get-Date).ToString("yyyy-MM-ddTHH:mm:ssK")

# --------------------------------------------------------------------------
# Logging (stdout + append to a per-run log file)
# --------------------------------------------------------------------------
if (-not (Test-Path $LogDir)) { New-Item -ItemType Directory -Path $LogDir -Force | Out-Null }
$LogPath = Join-Path $LogDir ("{0}-{1}-{2}.log" -f $Module, $Slug, $DateSlug)

function Write-Log {
    param([string]$Message = "")
    Write-Host $Message
    Add-Content -Path $LogPath -Value $Message
}

Write-Log ("=== {0} run for '{1}' at {2} ===" -f $Module, $Slug, $IsoNow)

# --------------------------------------------------------------------------
# Authorization banner
# --------------------------------------------------------------------------
function Show-Banner {
    Write-Host ""
    Write-Host "  +----------------------------------------------------------+"
    Write-Host "  |  ARK FIELD KIT - authorized IT service work only         |"
    Write-Host "  |  Run only on equipment you have permission to service.   |"
    Write-Host "  |  This audit is READ-ONLY. It changes nothing.            |"
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

# --------------------------------------------------------------------------
# Finding accumulator
# --------------------------------------------------------------------------
$Findings = New-Object System.Collections.ArrayList

function Add-Finding {
    param(
        [string]$Id,
        [string]$Title,
        [string]$Category,
        [ValidateSet("good", "warn", "critical", "unknown")]
        [string]$Severity,
        [string]$Status,
        [string]$Explanation,
        [string]$Recommendation = "",
        $Evidence = $null
    )
    $obj = [ordered]@{
        id             = $Id
        title          = $Title
        category       = $Category
        severity       = $Severity
        status         = $Status
        explanation    = $Explanation
        recommendation = $Recommendation
        evidence       = $Evidence
    }
    [void]$Findings.Add($obj)
    $tag = $Severity.ToUpper()
    Write-Log ("  [{0,-8}] {1}: {2}" -f $tag, $Title, $Status)
}

# Small helper: safe registry read that returns $null on any miss.
function Get-RegValue {
    param([string]$Path, [string]$Name)
    try {
        $item = Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop
        return $item.$Name
    } catch {
        return $null
    }
}

function Test-IsAdmin {
    try {
        $id = [System.Security.Principal.WindowsIdentity]::GetCurrent()
        $p  = New-Object System.Security.Principal.WindowsPrincipal($id)
        return $p.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)
    } catch {
        return $false
    }
}

# --------------------------------------------------------------------------
# Individual checks. Each is wrapped so one failing check never aborts the run.
# --------------------------------------------------------------------------

function Check-Defender {
    try {
        $status = Get-MpComputerStatus -ErrorAction Stop
        $rtp = $status.RealTimeProtectionEnabled
        $amRunning = $status.AntivirusEnabled
        $sigAge = $status.AntivirusSignatureAge  # days since last update
        $sigDate = $status.AntivirusSignatureLastUpdated

        $ev = [ordered]@{
            RealTimeProtectionEnabled = $rtp
            AntivirusEnabled          = $amRunning
            SignatureAgeDays          = $sigAge
            SignatureLastUpdated      = ("{0}" -f $sigDate)
            AMServiceEnabled          = $status.AMServiceEnabled
        }

        if (-not $amRunning -or -not $rtp) {
            Add-Finding -Id "defender_rtp" -Title "Endpoint protection (antivirus)" `
                -Category "Endpoint protection" -Severity "critical" `
                -Status "Real-time protection is OFF" `
                -Explanation "Microsoft Defender real-time protection is disabled, so malware is not being blocked as it runs. This is one of the most important protections on the machine." `
                -Recommendation "Turn Defender real-time protection back on (or confirm a managed third-party AV is actively protecting the machine)." `
                -Evidence $ev
        } elseif ($sigAge -ne $null -and $sigAge -gt 7) {
            Add-Finding -Id "defender_rtp" -Title "Endpoint protection (antivirus)" `
                -Category "Endpoint protection" -Severity "warn" `
                -Status ("On, but virus definitions are {0} days old" -f $sigAge) `
                -Explanation "Defender is running but its virus definitions are stale. Out-of-date definitions miss recent threats." `
                -Recommendation "Update Defender signatures (Update-MpSignature) and confirm automatic updates are working." `
                -Evidence $ev
        } else {
            Add-Finding -Id "defender_rtp" -Title "Endpoint protection (antivirus)" `
                -Category "Endpoint protection" -Severity "good" `
                -Status "On, definitions current" `
                -Explanation "Microsoft Defender is running with real-time protection on and recent virus definitions." `
                -Recommendation "" `
                -Evidence $ev
        }
    } catch {
        # Defender cmdlets absent (e.g. third-party AV replaced it). Fall back to Security Center.
        try {
            $av = Get-CimInstance -Namespace "root/SecurityCenter2" -ClassName AntiVirusProduct -ErrorAction Stop
            if ($av) {
                $names = ($av | ForEach-Object { $_.displayName }) -join ", "
                Add-Finding -Id "defender_rtp" -Title "Endpoint protection (antivirus)" `
                    -Category "Endpoint protection" -Severity "warn" `
                    -Status ("Third-party AV detected: {0} (status not verified)" -f $names) `
                    -Explanation "A third-party antivirus product is registered with Windows Security Center. Its real-time status could not be confirmed from here." `
                    -Recommendation "Confirm in the AV console that real-time protection is on and definitions are current." `
                    -Evidence ([ordered]@{ Products = $names })
                return
            }
        } catch { }
        Add-Finding -Id "defender_rtp" -Title "Endpoint protection (antivirus)" `
            -Category "Endpoint protection" -Severity "unknown" `
            -Status "Could not determine antivirus status" `
            -Explanation "Neither the Defender cmdlets nor Windows Security Center returned an antivirus status. The machine may have no AV, or the query was blocked." `
            -Recommendation "Manually verify an active, updating antivirus is installed." `
            -Evidence ([ordered]@{ Error = ("{0}" -f $_.Exception.Message) })
    }
}

function Check-Firewall {
    try {
        $profiles = Get-NetFirewallProfile -ErrorAction Stop
        $off = @($profiles | Where-Object { -not $_.Enabled })
        $ev = [ordered]@{}
        foreach ($p in $profiles) { $ev[$p.Name] = [bool]$p.Enabled }

        if ($off.Count -eq 0) {
            Add-Finding -Id "firewall" -Title "Host firewall" `
                -Category "Network protection" -Severity "good" `
                -Status "Enabled on all profiles (Domain, Private, Public)" `
                -Explanation "The Windows firewall is on for every network profile, blocking unsolicited inbound connections." `
                -Recommendation "" -Evidence $ev
        } else {
            $names = ($off | ForEach-Object { $_.Name }) -join ", "
            Add-Finding -Id "firewall" -Title "Host firewall" `
                -Category "Network protection" -Severity "critical" `
                -Status ("Disabled on: {0}" -f $names) `
                -Explanation "The Windows firewall is off for one or more network profiles, so the machine accepts unsolicited inbound connections on those networks." `
                -Recommendation "Enable the firewall on all profiles (Set-NetFirewallProfile -All -Enabled True)." `
                -Evidence $ev
        }
    } catch {
        # Fall back to netsh for older systems.
        try {
            $raw = netsh advfirewall show allprofiles state 2>$null | Out-String
            $anyOff = $raw -match "OFF"
            if ($anyOff) {
                Add-Finding -Id "firewall" -Title "Host firewall" `
                    -Category "Network protection" -Severity "critical" `
                    -Status "One or more firewall profiles are OFF" `
                    -Explanation "netsh reports the firewall disabled on at least one profile." `
                    -Recommendation "Enable the firewall on all profiles." -Evidence ([ordered]@{ netsh = $raw.Trim() })
            } else {
                Add-Finding -Id "firewall" -Title "Host firewall" `
                    -Category "Network protection" -Severity "good" `
                    -Status "Enabled (per netsh)" `
                    -Explanation "netsh reports the firewall enabled on all profiles." `
                    -Recommendation "" -Evidence ([ordered]@{ netsh = $raw.Trim() })
            }
        } catch {
            Add-Finding -Id "firewall" -Title "Host firewall" `
                -Category "Network protection" -Severity "unknown" `
                -Status "Could not read firewall status" `
                -Explanation "Neither Get-NetFirewallProfile nor netsh returned a status." `
                -Recommendation "Verify the firewall manually in Windows Security." -Evidence $null
        }
    }
}

function Check-BitLocker {
    try {
        $vols = Get-BitLockerVolume -ErrorAction Stop
        $sys = $vols | Where-Object { $_.VolumeType -eq "OperatingSystem" } | Select-Object -First 1
        if (-not $sys) { $sys = $vols | Select-Object -First 1 }
        $ev = [ordered]@{}
        foreach ($v in $vols) {
            $ev[("{0}" -f $v.MountPoint)] = ("{0} / {1}" -f $v.VolumeStatus, $v.ProtectionStatus)
        }
        $prot = ("{0}" -f $sys.ProtectionStatus)
        $vstat = ("{0}" -f $sys.VolumeStatus)
        if ($prot -eq "On" -or $vstat -eq "FullyEncrypted") {
            Add-Finding -Id "bitlocker" -Title "Disk encryption at rest" `
                -Category "Encryption" -Severity "good" `
                -Status ("System drive encrypted ({0})" -f $vstat) `
                -Explanation "The operating-system drive is protected with BitLocker, so data is unreadable if the device is lost or stolen." `
                -Recommendation "" -Evidence $ev
        } else {
            Add-Finding -Id "bitlocker" -Title "Disk encryption at rest" `
                -Category "Encryption" -Severity "critical" `
                -Status ("System drive NOT encrypted ({0} / protection {1})" -f $vstat, $prot) `
                -Explanation "The system drive is not encrypted. If the laptop or disk is lost or stolen, its data can be read directly. Encryption at rest is a standard cyber-insurance requirement." `
                -Recommendation "Enable BitLocker on the system drive (requires a TPM or a startup key) and escrow the recovery key." `
                -Evidence $ev
        }
    } catch {
        $admin = Test-IsAdmin
        $sev = "unknown"
        $expl = "BitLocker status could not be read."
        if (-not $admin) {
            $expl = "BitLocker status needs an elevated session to read reliably; this run was not elevated."
        }
        Add-Finding -Id "bitlocker" -Title "Disk encryption at rest" `
            -Category "Encryption" -Severity $sev `
            -Status "Encryption status unknown" `
            -Explanation $expl `
            -Recommendation "Re-run this audit from an elevated PowerShell, or check 'manage-bde -status' manually." `
            -Evidence ([ordered]@{ Elevated = $admin; Error = ("{0}" -f $_.Exception.Message) })
    }
}

function Check-WindowsUpdate {
    $ev = [ordered]@{}
    $lastPatch = $null
    try {
        $hf = Get-HotFix -ErrorAction Stop | Where-Object { $_.InstalledOn } | Sort-Object InstalledOn -Descending
        if ($hf) {
            $lastPatch = $hf[0].InstalledOn
            $ev["LastHotfix"] = ("{0} ({1})" -f $hf[0].HotFixID, $lastPatch.ToString("yyyy-MM-dd"))
        }
    } catch { }

    # Best-effort pending-update count via the Windows Update COM API.
    $pending = $null
    $pendingCritical = $null
    try {
        $session  = New-Object -ComObject Microsoft.Update.Session
        $searcher = $session.CreateUpdateSearcher()
        $result   = $searcher.Search("IsInstalled=0 and IsHidden=0")
        $pending  = $result.Updates.Count
        $pendingCritical = 0
        foreach ($u in $result.Updates) {
            $sevText = ("{0}" -f $u.MsrcSeverity)
            if ($sevText -eq "Critical" -or $sevText -eq "Important") { $pendingCritical++ }
        }
        $ev["PendingUpdates"] = $pending
        $ev["PendingCriticalOrImportant"] = $pendingCritical
    } catch {
        $ev["PendingUpdates"] = "unknown (Windows Update query unavailable)"
    }

    $daysSince = $null
    if ($lastPatch) { $daysSince = [int]((Get-Date) - $lastPatch).TotalDays }

    if ($pendingCritical -ne $null -and $pendingCritical -gt 0) {
        Add-Finding -Id "patching" -Title "Patch cadence (Windows Update)" `
            -Category "Patch management" -Severity "critical" `
            -Status ("{0} critical/important update(s) pending" -f $pendingCritical) `
            -Explanation "Important or critical Windows updates are available but not installed. Unpatched systems are the most common ransomware entry point." `
            -Recommendation "Install all pending critical/important updates and confirm automatic updates are enabled." `
            -Evidence $ev
    } elseif ($daysSince -ne $null -and $daysSince -gt 45) {
        Add-Finding -Id "patching" -Title "Patch cadence (Windows Update)" `
            -Category "Patch management" -Severity "warn" `
            -Status ("Last patched {0} days ago" -f $daysSince) `
            -Explanation "The machine has not installed an update in over 45 days. Patch cadence should be monthly at minimum." `
            -Recommendation "Run Windows Update, install available patches, and verify the update service is running." `
            -Evidence $ev
    } elseif ($daysSince -ne $null) {
        Add-Finding -Id "patching" -Title "Patch cadence (Windows Update)" `
            -Category "Patch management" -Severity "good" `
            -Status ("Last patched {0} days ago" -f $daysSince) `
            -Explanation "The machine has been patched recently and no critical updates are pending." `
            -Recommendation "" -Evidence $ev
    } else {
        Add-Finding -Id "patching" -Title "Patch cadence (Windows Update)" `
            -Category "Patch management" -Severity "unknown" `
            -Status "Could not determine last patch date" `
            -Explanation "Windows Update history was not readable from here." `
            -Recommendation "Check Settings > Windows Update history manually." -Evidence $ev
    }
}

function Check-LocalAdmins {
    try {
        $members = Get-LocalGroupMember -Group "Administrators" -ErrorAction Stop
        $names = @($members | ForEach-Object { $_.Name })
        $count = $names.Count
        $ev = [ordered]@{ Administrators = ($names -join ", "); Count = $count }

        # Built-in Administrator (RID 500) enabled?
        $builtinDisabled = $null
        try {
            $admin = Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -like "*-500" } | Select-Object -First 1
            if ($admin) {
                $builtinDisabled = -not $admin.Enabled
                $ev["BuiltinAdminAccount"] = $admin.Name
                $ev["BuiltinAdminEnabled"] = [bool]$admin.Enabled
            }
        } catch { }

        if ($builtinDisabled -eq $false) {
            Add-Finding -Id "builtin_admin" -Title "Built-in Administrator account" `
                -Category "Account hygiene" -Severity "warn" `
                -Status "Built-in Administrator is ENABLED" `
                -Explanation "The default built-in Administrator account is active. Because its name is predictable, it is a common brute-force / lateral-movement target." `
                -Recommendation "Disable the built-in Administrator and use named admin accounts instead." `
                -Evidence $ev
        } elseif ($builtinDisabled -eq $true) {
            Add-Finding -Id "builtin_admin" -Title "Built-in Administrator account" `
                -Category "Account hygiene" -Severity "good" `
                -Status "Built-in Administrator is disabled" `
                -Explanation "The predictable built-in Administrator account is disabled, as recommended." `
                -Recommendation "" -Evidence $ev
        }

        if ($count -gt 3) {
            Add-Finding -Id "local_admins" -Title "Local administrator accounts" `
                -Category "Account hygiene" -Severity "warn" `
                -Status ("{0} members of local Administrators" -f $count) `
                -Explanation "There are more local administrators than typical. Every admin account is a high-value target and widens the attack surface." `
                -Recommendation "Review the Administrators group and remove any accounts that do not need admin rights (least privilege)." `
                -Evidence $ev
        } else {
            Add-Finding -Id "local_admins" -Title "Local administrator accounts" `
                -Category "Account hygiene" -Severity "good" `
                -Status ("{0} local administrator account(s)" -f $count) `
                -Explanation "The local Administrators group is a reasonable size." `
                -Recommendation "" -Evidence $ev
        }
    } catch {
        Add-Finding -Id "local_admins" -Title "Local administrator accounts" `
            -Category "Account hygiene" -Severity "unknown" `
            -Status "Could not enumerate local administrators" `
            -Explanation "The local Administrators group could not be read (this can happen on domain-joined machines without local query rights)." `
            -Recommendation "Review local administrators manually (lusrmgr.msc)." `
            -Evidence ([ordered]@{ Error = ("{0}" -f $_.Exception.Message) })
    }
}

function Check-Rdp {
    $deny = Get-RegValue -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server" -Name "fDenyTSConnections"
    $nla = Get-RegValue -Path "HKLM:\System\CurrentControlSet\Control\Terminal Server\WinStations\RDP-Tcp" -Name "UserAuthentication"
    $ev = [ordered]@{ fDenyTSConnections = $deny; NlaUserAuthentication = $nla }

    # fDenyTSConnections = 0 means RDP is ENABLED.
    $rdpEnabled = ($deny -ne $null -and [int]$deny -eq 0)
    $ruleOn = $null
    try {
        $rules = Get-NetFirewallRule -DisplayGroup "Remote Desktop" -ErrorAction Stop | Where-Object { $_.Enabled -eq "True" -and $_.Direction -eq "Inbound" }
        $ruleOn = (@($rules).Count -gt 0)
        $ev["FirewallRemoteDesktopInboundEnabled"] = $ruleOn
    } catch { }

    if ($rdpEnabled) {
        $sev = "warn"
        if ($nla -ne $null -and [int]$nla -eq 0) { $sev = "critical" }
        $extra = ""
        if ($nla -ne $null -and [int]$nla -eq 0) { $extra = " with Network Level Authentication OFF" }
        Add-Finding -Id "rdp" -Title "Remote Desktop (RDP) exposure" `
            -Category "Remote access" -Severity $sev `
            -Status ("RDP is ENABLED{0}" -f $extra) `
            -Explanation "Remote Desktop accepts inbound connections. RDP is a leading ransomware entry point, especially when reachable from the internet or without Network Level Authentication and MFA." `
            -Recommendation "If RDP is not needed, disable it. If it is, require Network Level Authentication, restrict it to a VPN/jump host, and put MFA in front of it." `
            -Evidence $ev
    } else {
        Add-Finding -Id "rdp" -Title "Remote Desktop (RDP) exposure" `
            -Category "Remote access" -Severity "good" `
            -Status "RDP is disabled" `
            -Explanation "Remote Desktop is turned off, removing a common remote-attack surface." `
            -Recommendation "" -Evidence $ev
    }
}

function Check-Smb1 {
    $enabled = $null
    $ev = [ordered]@{}
    try {
        $cfg = Get-SmbServerConfiguration -ErrorAction Stop
        $enabled = [bool]$cfg.EnableSMB1Protocol
        $ev["EnableSMB1Protocol"] = $enabled
    } catch {
        try {
            $feat = Get-WindowsOptionalFeature -Online -FeatureName "SMB1Protocol" -ErrorAction Stop
            $enabled = ($feat.State -eq "Enabled")
            $ev["SMB1ProtocolFeatureState"] = ("{0}" -f $feat.State)
        } catch {
            $reg = Get-RegValue -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters" -Name "SMB1"
            if ($reg -ne $null) {
                $enabled = ([int]$reg -ne 0)
                $ev["LanmanServerSMB1"] = $reg
            }
        }
    }

    if ($enabled -eq $true) {
        Add-Finding -Id "smb1" -Title "SMBv1 file-sharing protocol" `
            -Category "Legacy protocols" -Severity "critical" `
            -Status "SMBv1 is ENABLED" `
            -Explanation "SMBv1 is an obsolete file-sharing protocol exploited by WannaCry / EternalBlue. It has no place on a modern network." `
            -Recommendation "Disable the SMBv1 protocol (server and client). Modern Windows uses SMBv2/3." `
            -Evidence $ev
    } elseif ($enabled -eq $false) {
        Add-Finding -Id "smb1" -Title "SMBv1 file-sharing protocol" `
            -Category "Legacy protocols" -Severity "good" `
            -Status "SMBv1 is disabled" `
            -Explanation "The obsolete SMBv1 protocol is turned off, as recommended." `
            -Recommendation "" -Evidence $ev
    } else {
        Add-Finding -Id "smb1" -Title "SMBv1 file-sharing protocol" `
            -Category "Legacy protocols" -Severity "unknown" `
            -Status "Could not determine SMBv1 state" `
            -Explanation "SMBv1 status was not readable from here." `
            -Recommendation "Check 'Get-SmbServerConfiguration | Select EnableSMB1Protocol' in an elevated session." `
            -Evidence $ev
    }
}

function Check-ScreenLock {
    # Machine policy first, then current-user screensaver settings.
    $inactivity = Get-RegValue -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\System" -Name "InactivityTimeoutSecs"
    $secure = Get-RegValue -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaverIsSecure"
    $timeout = Get-RegValue -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveTimeOut"
    $active = Get-RegValue -Path "HKCU:\Control Panel\Desktop" -Name "ScreenSaveActive"
    $ev = [ordered]@{
        InactivityTimeoutSecs = $inactivity
        ScreenSaverIsSecure   = $secure
        ScreenSaveTimeOutSecs = $timeout
        ScreenSaveActive      = $active
    }

    $secs = $null
    if ($inactivity -ne $null -and [int]$inactivity -gt 0) {
        $secs = [int]$inactivity
    } elseif ($active -ne $null -and [int]$active -eq 1 -and $secure -ne $null -and [int]$secure -eq 1 -and $timeout -ne $null) {
        $secs = [int]$timeout
    }

    if ($secs -eq $null -or $secs -eq 0) {
        Add-Finding -Id "screenlock" -Title "Automatic screen lock" `
            -Category "Account hygiene" -Severity "warn" `
            -Status "No enforced automatic screen lock detected" `
            -Explanation "The machine does not appear to lock automatically when idle. An unlocked, unattended machine gives anyone physical access full control." `
            -Recommendation "Set an inactivity lock of 15 minutes or less (a secure screensaver, or the machine inactivity-limit policy)." `
            -Evidence $ev
    } elseif ($secs -gt 900) {
        Add-Finding -Id "screenlock" -Title "Automatic screen lock" `
            -Category "Account hygiene" -Severity "warn" `
            -Status ("Locks after {0} minutes (over 15)" -f [int]($secs / 60)) `
            -Explanation "The machine locks when idle, but the timeout is longer than the recommended 15 minutes." `
            -Recommendation "Reduce the inactivity lock to 15 minutes (900 seconds) or less." `
            -Evidence $ev
    } else {
        Add-Finding -Id "screenlock" -Title "Automatic screen lock" `
            -Category "Account hygiene" -Severity "good" `
            -Status ("Locks after {0} minute(s) idle" -f [int]($secs / 60)) `
            -Explanation "The machine locks automatically within the recommended window when left idle." `
            -Recommendation "" -Evidence $ev
    }
}

function Check-PasswordPolicy {
    try {
        $raw = net accounts 2>$null | Out-String
        $ev = [ordered]@{}
        $minLen = $null; $lockout = $null; $maxAge = $null; $history = $null
        foreach ($line in ($raw -split "`r?`n")) {
            if ($line -match "Minimum password length\s*:\s*(\d+)") { $minLen = [int]$Matches[1] }
            if ($line -match "Lockout threshold\s*:\s*(\S+)") { $lockout = $Matches[1] }
            if ($line -match "Maximum password age.*:\s*(\S+)") { $maxAge = $Matches[1] }
            if ($line -match "Length of password history maintained\s*:\s*(\S+)") { $history = $Matches[1] }
        }
        $ev["MinimumPasswordLength"] = $minLen
        $ev["LockoutThreshold"]      = $lockout
        $ev["MaximumPasswordAge"]    = $maxAge
        $ev["PasswordHistory"]       = $history

        $problems = @()
        if ($minLen -eq $null -or $minLen -lt 12) { $problems += ("minimum length is {0} (want 12+)" -f $minLen) }
        $lockNever = ($lockout -eq $null -or $lockout -match "Never" -or $lockout -eq "0")
        if ($lockNever) { $problems += "no account lockout after failed logons" }

        if ($problems.Count -gt 0) {
            Add-Finding -Id "password_policy" -Title "Password policy" `
                -Category "Account hygiene" -Severity "warn" `
                -Status ("Weak: {0}" -f ($problems -join "; ")) `
                -Explanation "The local password policy is weaker than recommended. Short passwords and no lockout make brute-force and password-guessing attacks far easier." `
                -Recommendation "Set a minimum password length of 12+ and enable account lockout (e.g. 10 attempts / 15 minutes). Complexity should be on." `
                -Evidence $ev
        } else {
            Add-Finding -Id "password_policy" -Title "Password policy" `
                -Category "Account hygiene" -Severity "good" `
                -Status ("Minimum length {0}, lockout enabled" -f $minLen) `
                -Explanation "The local password policy meets the recommended baseline for length and lockout." `
                -Recommendation "" -Evidence $ev
        }
    } catch {
        Add-Finding -Id "password_policy" -Title "Password policy" `
            -Category "Account hygiene" -Severity "unknown" `
            -Status "Could not read password policy" `
            -Explanation "'net accounts' did not return a readable policy." `
            -Recommendation "Review the local security policy (secpol.msc) manually." `
            -Evidence $null
    }
}

function Check-Guest {
    try {
        $guest = Get-LocalUser -ErrorAction Stop | Where-Object { $_.SID.Value -like "*-501" } | Select-Object -First 1
        if (-not $guest) {
            $guest = Get-LocalUser -Name "Guest" -ErrorAction SilentlyContinue
        }
        if ($guest) {
            $ev = [ordered]@{ Name = $guest.Name; Enabled = [bool]$guest.Enabled }
            if ($guest.Enabled) {
                Add-Finding -Id "guest" -Title "Guest account" `
                    -Category "Account hygiene" -Severity "critical" `
                    -Status "Guest account is ENABLED" `
                    -Explanation "The Guest account allows unauthenticated local access with no password. It should always be disabled." `
                    -Recommendation "Disable the Guest account." -Evidence $ev
            } else {
                Add-Finding -Id "guest" -Title "Guest account" `
                    -Category "Account hygiene" -Severity "good" `
                    -Status "Guest account is disabled" `
                    -Explanation "The Guest account is disabled, as recommended." `
                    -Recommendation "" -Evidence $ev
            }
        } else {
            Add-Finding -Id "guest" -Title "Guest account" `
                -Category "Account hygiene" -Severity "good" `
                -Status "No Guest account present" `
                -Explanation "No Guest account exists on this machine." `
                -Recommendation "" -Evidence $null
        }
    } catch {
        Add-Finding -Id "guest" -Title "Guest account" `
            -Category "Account hygiene" -Severity "unknown" `
            -Status "Could not read Guest account" `
            -Explanation "The Guest account state was not readable." `
            -Recommendation "Check local users (lusrmgr.msc) manually." -Evidence $null
    }
}

function Check-Autorun {
    # NoDriveTypeAutoRun = 255 (0xFF) disables autorun on all drive types.
    $machine = Get-RegValue -Path "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" -Name "NoDriveTypeAutoRun"
    $user = Get-RegValue -Path "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Policies\Explorer" -Name "NoDriveTypeAutoRun"
    $ev = [ordered]@{ Machine_NoDriveTypeAutoRun = $machine; User_NoDriveTypeAutoRun = $user }
    $val = $machine
    if ($val -eq $null) { $val = $user }

    if ($val -ne $null -and [int]$val -ge 255) {
        Add-Finding -Id "autorun" -Title "AutoRun / AutoPlay for removable media" `
            -Category "Legacy protocols" -Severity "good" `
            -Status "AutoRun disabled on all drive types" `
            -Explanation "AutoRun is disabled, so plugging in an infected USB stick will not automatically execute code." `
            -Recommendation "" -Evidence $ev
    } else {
        Add-Finding -Id "autorun" -Title "AutoRun / AutoPlay for removable media" `
            -Category "Legacy protocols" -Severity "warn" `
            -Status "AutoRun is not fully disabled" `
            -Explanation "AutoRun/AutoPlay is not disabled for all drive types. A malicious USB device can auto-execute code when inserted." `
            -Recommendation "Set NoDriveTypeAutoRun to 255 to disable AutoRun on all drive types." `
            -Evidence $ev
    }
}

function Check-DomainMembership {
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $partOfDomain = [bool]$cs.PartOfDomain
        $ev = [ordered]@{
            PartOfDomain = $partOfDomain
            Domain       = ("{0}" -f $cs.Domain)
            Workgroup    = ("{0}" -f $cs.Workgroup)
        }
        if ($partOfDomain) {
            Add-Finding -Id "domain" -Title "Domain / workgroup membership" `
                -Category "Management" -Severity "good" `
                -Status ("Domain-joined: {0}" -f $cs.Domain) `
                -Explanation "The machine is joined to a domain, so it can receive centrally managed security policy and identity." `
                -Recommendation "" -Evidence $ev
        } else {
            Add-Finding -Id "domain" -Title "Domain / workgroup membership" `
                -Category "Management" -Severity "warn" `
                -Status ("Workgroup / standalone: {0}" -f $cs.Workgroup) `
                -Explanation "The machine is not domain-joined. Standalone machines are managed one-by-one, so security settings can drift. This is common for small offices and not necessarily wrong, but worth noting." `
                -Recommendation "Consider central management (domain, Azure AD/Entra join, or an RMM) so policy is applied consistently." `
                -Evidence $ev
        }
    } catch {
        Add-Finding -Id "domain" -Title "Domain / workgroup membership" `
            -Category "Management" -Severity "unknown" `
            -Status "Could not read domain membership" `
            -Explanation "Win32_ComputerSystem was not readable." `
            -Recommendation "Check System properties manually." -Evidence $null
    }
}

# --------------------------------------------------------------------------
# Host facts for the report header
# --------------------------------------------------------------------------
function Get-HostInfo {
    $info = [ordered]@{
        ComputerName = $env:COMPUTERNAME
        UserName     = $env:USERNAME
        Elevated     = (Test-IsAdmin)
        OS           = "unknown"
        OSVersion    = "unknown"
        Manufacturer = "unknown"
        Model        = "unknown"
    }
    try {
        $os = Get-CimInstance -ClassName Win32_OperatingSystem -ErrorAction Stop
        $info.OS = ("{0}" -f $os.Caption)
        $info.OSVersion = ("{0} (build {1})" -f $os.Version, $os.BuildNumber)
    } catch { }
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $info.Manufacturer = ("{0}" -f $cs.Manufacturer)
        $info.Model = ("{0}" -f $cs.Model)
    } catch { }
    return $info
}

# --------------------------------------------------------------------------
# Main
# --------------------------------------------------------------------------
Confirm-Authorization

Write-Log ""
Write-Log ("Auditing machine '{0}' (read-only)..." -f $env:COMPUTERNAME)
if (-not (Test-IsAdmin)) {
    Write-Log "  NOTE: not running elevated - some checks (BitLocker, full policy) may report 'unknown'."
}
Write-Log ""

$checks = @(
    ${function:Check-Defender},
    ${function:Check-Firewall},
    ${function:Check-BitLocker},
    ${function:Check-WindowsUpdate},
    ${function:Check-LocalAdmins},
    ${function:Check-Rdp},
    ${function:Check-Smb1},
    ${function:Check-ScreenLock},
    ${function:Check-PasswordPolicy},
    ${function:Check-Guest},
    ${function:Check-Autorun},
    ${function:Check-DomainMembership}
)

foreach ($c in $checks) {
    try {
        & $c
    } catch {
        Write-Log ("  [ERROR   ] a check failed unexpectedly: {0}" -f $_.Exception.Message)
    }
}

# --------------------------------------------------------------------------
# Assemble and write JSON
# --------------------------------------------------------------------------
$hostInfo = Get-HostInfo

$severityCounts = [ordered]@{ good = 0; warn = 0; critical = 0; unknown = 0 }
foreach ($f in $Findings) {
    $s = $f.severity
    if ($severityCounts.Contains($s)) { $severityCounts[$s] = $severityCounts[$s] + 1 }
}

$authNote = "Confirmed interactively by operator"
if ($Authorized) { $authNote = $Authorized }

$report = [ordered]@{
    schema        = "ark-security-audit/1"
    module        = $Module
    generated     = $IsoNow
    site_name     = $SiteName
    client        = $Client
    technician    = $Technician
    authorization = $authNote
    host          = $hostInfo
    summary       = $severityCounts
    findings      = @($Findings)
}

if (-not (Test-Path $OutDir)) { New-Item -ItemType Directory -Path $OutDir -Force | Out-Null }
$jsonPath = Join-Path $OutDir ("{0}-{1}-{2}.json" -f $Module, $Slug, $Stamp)
$report | ConvertTo-Json -Depth 8 | Out-File -FilePath $jsonPath -Encoding UTF8

Write-Log ""
Write-Log ("Audit complete. {0} good / {1} warn / {2} critical / {3} unknown." -f `
    $severityCounts.good, $severityCounts.warn, $severityCounts.critical, $severityCounts.unknown)
Write-Log ("JSON report written: {0}" -f $jsonPath)
Write-Log ""
Write-Log "Next: build the client-facing insurance report with"
Write-Log ("  python3 insurance-report.py <config.json> --audit `"{0}`"" -f $jsonPath)

Write-Host ""
Write-Host ("Audit JSON: {0}" -f $jsonPath)
