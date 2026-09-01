<#
.SYNOPSIS
  Unattended in-place upgrade to Windows 11, field-kit style.

.DESCRIPTION
  Dry-runs by default: runs pre-flight checks and prints the exact upgrade plan
  without touching the machine. Pass -Apply to actually perform the upgrade.

  Source is chosen in the config:
    * "iso"                  - path to a mounted-or-mountable Windows 11 ISO
    * "installationassistant"- download + run the Windows 11 Installation Assistant

  Pre-flight (always, even in dry run):
    * hardware readiness (delegates to Win11-Readiness.ps1)
    * on AC power (not on battery)
    * enough free disk space
    * (on -Apply) create a System Restore point first

  Supported-but-blocked hardware: only with the explicit -AllowUnsupported
  switch does this set Microsoft's documented registry workaround
  (HKLM\SYSTEM\Setup\MoSetup\AllowUpgradesWithUnsupportedTPMOrCPU = 1). A loud
  warning about Microsoft's stance is printed and logged. This still requires
  TPM 1.2 and is an unsupported configuration.

.PARAMETER Config
  Path to your filled-in config.json.

.PARAMETER Apply
  Perform the upgrade for real. Without it, nothing is changed.

.PARAMETER AllowUnsupported
  Set the documented unsupported-hardware registry workaround. Off by default.

.PARAMETER Yes
  Skip the extra confirmation prompt before the (destructive) upgrade launch.

.PARAMETER Authorized
  Signed-authorization note recorded in the log (skips the interactive prompt).
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)][string]$Config,
    [switch]$Apply,
    [switch]$AllowUnsupported,
    [switch]$Yes,
    [string]$Authorized
)

. "$PSScriptRoot\_FieldKit.ps1"

$cfg = Get-FieldKitConfig -Path $Config -Required @("site_name", "upgrade_source")
$site = $cfg.site_name
$source = ([string]$cfg.upgrade_source).ToLower().Trim()

# Optional tunables with safe defaults.
$minFreeGB = 25
if ($cfg.PSObject.Properties.Name -contains "min_free_gb" -and $cfg.min_free_gb) { $minFreeGB = [int]$cfg.min_free_gb }
$isoPath = ""
if ($cfg.PSObject.Properties.Name -contains "iso_path") { $isoPath = [string]$cfg.iso_path }
$assistantUrl = "https://go.microsoft.com/fwlink/?linkid=2171764"
if ($cfg.PSObject.Properties.Name -contains "installation_assistant_url" -and $cfg.installation_assistant_url) {
    $assistantUrl = [string]$cfg.installation_assistant_url
}
$downloadDir = Join-Path $env:TEMP "ArkFieldKit-Win11"

$logPath = Start-FieldKitLog -Module "win11upgrade" -Slug $site
$restorePointMade = $false
$mountedIso = $false   # referenced in finally; must exist even on an early error

try {
    $willDo = @(
        "Run Windows 11 readiness pre-flight",
        "Verify AC power and >= $minFreeGB GB free on the system drive",
        "Create a System Restore point (on -Apply)",
        ("Launch an unattended in-place upgrade from source: {0}" -f $source)
    )
    if ($AllowUnsupported) { $willDo += "Set Microsoft's UNSUPPORTED-hardware registry workaround (MoSetup)" }
    Write-Banner -Title "Win11-Upgrade" -Site $site -Apply ([bool]$Apply) -WillDo $willDo
    Write-Host ("  Effective mode: {0}" -f (Get-ModeLabel ([bool]$Apply)))

    if (-not (Test-IsAdmin)) {
        throw "This tool must run elevated (Administrator). Re-launch PowerShell as Administrator."
    }
    if ($Apply) {
        Confirm-Authorization -Site $site -Authorized $Authorized
    }
    else {
        if ($Authorized) { Write-Host ("  Authorization on file: {0}" -f $Authorized) }
    }

    # ------- Pre-flight: readiness -------
    Write-Section "Pre-flight 1/4: hardware readiness"
    $readiness = Join-Path $PSScriptRoot "Win11-Readiness.ps1"
    $readyOk = $true
    if (Test-Path $readiness) {
        try {
            & $readiness -Authorized $Authorized | Out-Host
            # Readiness exits 1 when a hard requirement FAILED (NOT READY).
            if ($LASTEXITCODE -ne 0) {
                $readyOk = $false
                Write-Warning "Readiness verdict: NOT READY (a hard requirement failed)."
            }
        }
        catch {
            Write-Warning "Readiness sub-check reported: $($_.Exception.Message)"
            $readyOk = $false
        }
    }
    else {
        Write-Warning "Win11-Readiness.ps1 not found next to this script; skipping delegated readiness."
    }

    # ------- Pre-flight: AC power -------
    Write-Section "Pre-flight 2/4: power"
    $onAC = $true
    try {
        $batt = Get-CimInstance -ClassName Win32_Battery -ErrorAction Stop
        if ($batt) {
            # Win32_Battery.BatteryStatus == 1 means the battery is discharging
            # (i.e. running on battery). Any other value implies AC is connected.
            $statuses = @($batt | ForEach-Object { [int]$_.BatteryStatus })
            if ($statuses -contains 1) { $onAC = $false }
        }
    }
    catch {
        # No Win32_Battery usually means a desktop on mains power.
        $onAC = $true
    }
    if ($onAC) {
        Write-Host "  [PASS] On AC power (or desktop)."
    }
    else {
        Write-Host "  [FAIL] Running on battery. Plug in before upgrading."
        if ($Apply) { throw "Not on AC power - refusing to start a Windows 11 upgrade on battery." }
        Write-Host "  (An -Apply run would abort here until the machine is on AC power.)"
    }

    # ------- Pre-flight: disk space -------
    Write-Section "Pre-flight 3/4: disk space"
    $sysDrive = ($env:SystemDrive).TrimEnd(':')
    $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='{0}:'" -f $sysDrive) -ErrorAction Stop
    $freeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
    if ($freeGB -ge $minFreeGB) {
        Write-Host ("  [PASS] {0}: has {1} GB free (need >= {2} GB)." -f $sysDrive, $freeGB, $minFreeGB)
    }
    else {
        Write-Host ("  [FAIL] {0}: has only {1} GB free (need >= {2} GB)." -f $sysDrive, $freeGB, $minFreeGB)
        if ($Apply) { throw "Insufficient free disk space for a safe in-place upgrade." }
        Write-Host "  (An -Apply run would abort here until more free space is available.)"
    }

    # ------- Resolve the source -------
    Write-Section "Pre-flight 4/4: source"
    $setupExe = $null
    $setupArgs = @()

    if ($source -eq "iso") {
        if (-not $isoPath) { throw "upgrade_source is 'iso' but iso_path is empty in the config." }
        if (-not (Test-Path $isoPath)) { throw "iso_path not found: $isoPath" }
        Write-Host ("  Source ISO: {0}" -f $isoPath)
        Write-Host "  Plan: mount the ISO, run setup.exe with unattended upgrade flags, then dismount."
    }
    elseif ($source -eq "installationassistant") {
        Write-Host ("  Source: Windows 11 Installation Assistant")
        Write-Host ("  Download URL: {0}" -f $assistantUrl)
        Write-Host ("  Download to : {0}" -f (Join-Path $downloadDir 'Windows11InstallationAssistant.exe'))
        Write-Host "  Plan: download the assistant and run it silently (/QuietInstall /SkipEULA)."
    }
    else {
        throw "upgrade_source must be 'iso' or 'installationassistant' (got '$source')."
    }

    # ------- Unsupported-hardware workaround (opt-in only) -------
    if ($AllowUnsupported) {
        Write-Section "UNSUPPORTED HARDWARE WORKAROUND REQUESTED"
        Write-Host "  !! WARNING - READ BEFORE CONTINUING !!"
        Write-Host "  You passed -AllowUnsupported. This sets Microsoft's documented registry key"
        Write-Host "  HKLM\SYSTEM\Setup\MoSetup\AllowUpgradesWithUnsupportedTPMOrCPU = 1 so the"
        Write-Host "  in-place upgrade proceeds on a CPU/TPM combination Microsoft does not support."
        Write-Host "  Microsoft's stance: such PCs are NOT guaranteed to receive updates (including"
        Write-Host "  security updates), may be unstable, and the configuration is unsupported. The"
        Write-Host "  machine still needs at least TPM 1.2 and UEFI+Secure Boot. Get the client's"
        Write-Host "  informed, written sign-off before using this on production hardware."
    }

    # ------- DRY RUN stops here -------
    if (-not $Apply) {
        Write-Section "DRY RUN complete"
        Write-Host "  No changes were made. Re-run with -Apply to perform the upgrade."
        if (-not $readyOk) {
            if ($AllowUnsupported) {
                Write-Host "  Readiness: NOT READY, but -AllowUnsupported was given, so -Apply would proceed via the MoSetup workaround."
            }
            else {
                Write-Host "  Readiness: NOT READY - an -Apply run would ABORT unless you pass -AllowUnsupported (with client sign-off)."
            }
        }
        if ($AllowUnsupported) { Write-Host "  (-AllowUnsupported would set the MoSetup registry key on -Apply.)" }
        Write-Host ("  Log written: {0}" -f $logPath)
        return
    }

    # =========================== APPLY PATH ===========================
    if (-not $readyOk -and -not $AllowUnsupported) {
        throw "Readiness pre-flight reported problems and -AllowUnsupported was not given. Aborting."
    }

    if (-not $Yes) {
        Write-Host ""
        Write-Host "  This will begin an in-place upgrade to Windows 11 and reboot the machine."
        $go = Read-Host "  Type 'UPGRADE' to continue"
        if ($go -ne "UPGRADE") { throw "Confirmation not given - aborting." }
    }

    # Restore point first.
    Write-Section "Creating System Restore point"
    if ($PSCmdlet.ShouldProcess($env:COMPUTERNAME, "Create System Restore point")) {
        try {
            Enable-ComputerRestore -Drive "$env:SystemDrive\" -ErrorAction SilentlyContinue
            Checkpoint-Computer -Description "Ark Field Kit - pre Win11 upgrade" -RestorePointType "MODIFY_SETTINGS" -ErrorAction Stop
            $restorePointMade = $true
            Write-Host "  Restore point created."
        }
        catch {
            Write-Warning "Could not create a restore point ($($_.Exception.Message))."
            if (-not $Yes) {
                $cont = Read-Host "  Continue WITHOUT a restore point? Type 'yes'"
                if ($cont.Trim().ToLower() -ne "yes") { throw "Aborted - no restore point." }
            }
        }
    }

    # Registry workaround (apply-time).
    if ($AllowUnsupported) {
        Write-Section "Applying MoSetup registry workaround"
        if ($PSCmdlet.ShouldProcess("HKLM\SYSTEM\Setup\MoSetup", "Set AllowUpgradesWithUnsupportedTPMOrCPU = 1")) {
            $moKey = "HKLM:\SYSTEM\Setup\MoSetup"
            if (-not (Test-Path $moKey)) { New-Item -Path $moKey -Force | Out-Null }
            New-ItemProperty -Path $moKey -Name "AllowUpgradesWithUnsupportedTPMOrCPU" -Value 1 -PropertyType DWord -Force | Out-Null
            Write-Host "  Set AllowUpgradesWithUnsupportedTPMOrCPU = 1 (unsupported configuration)."
        }
    }

    # Launch the upgrade.
    Write-Section "Launching Windows 11 upgrade"
    if ($source -eq "iso") {
        if ($PSCmdlet.ShouldProcess($isoPath, "Mount ISO and run setup.exe unattended upgrade")) {
            $img = Mount-DiskImage -ImagePath $isoPath -PassThru -ErrorAction Stop
            $mountedIso = $true
            Start-Sleep -Seconds 2
            $vol = ($img | Get-Volume).DriveLetter
            if (-not $vol) { throw "Mounted the ISO but could not determine its drive letter." }
            $setupExe = ("{0}:\setup.exe" -f $vol)
            if (-not (Test-Path $setupExe)) { throw "setup.exe not found on mounted ISO at $setupExe." }
            $setupArgs = @("/auto", "upgrade", "/quiet", "/eula", "accept",
                "/dynamicupdate", "disable", "/noreboot")
            Write-Host ("  Running: {0} {1}" -f $setupExe, ($setupArgs -join ' '))
            $proc = Start-Process -FilePath $setupExe -ArgumentList $setupArgs -PassThru -Wait
            Write-Host ("  setup.exe exit code: {0}" -f $proc.ExitCode)
            Write-Host "  (/noreboot used: reboot the machine when ready to finish the upgrade.)"
        }
    }
    else {
        if ($PSCmdlet.ShouldProcess($assistantUrl, "Download and run Windows 11 Installation Assistant silently")) {
            if (-not (Test-Path $downloadDir)) { New-Item -ItemType Directory -Path $downloadDir -Force | Out-Null }
            $exe = Join-Path $downloadDir "Windows11InstallationAssistant.exe"
            Write-Host ("  Downloading assistant to {0}" -f $exe)
            $oldPref = $ProgressPreference
            $ProgressPreference = "SilentlyContinue"
            try {
                Invoke-WebRequest -Uri $assistantUrl -OutFile $exe -UseBasicParsing -ErrorAction Stop
            }
            finally {
                $ProgressPreference = $oldPref
            }
            $setupArgs = @("/QuietInstall", "/SkipEULA", "/auto", "Upgrade", "/NoRestartUI")
            Write-Host ("  Running: {0} {1}" -f $exe, ($setupArgs -join ' '))
            $proc = Start-Process -FilePath $exe -ArgumentList $setupArgs -PassThru
            Write-Host ("  Installation Assistant launched (PID {0}). It continues in the background." -f $proc.Id)
        }
    }

    Write-Section "Upgrade launched"
    Write-Host "  Monitor the machine; it will reboot one or more times to complete."
    if ($restorePointMade) { Write-Host "  A restore point was created before starting." }
    Write-Host ("  Log written: {0}" -f $logPath)
}
catch {
    Write-Host ""
    Write-Host ("  ERROR: {0}" -f $_.Exception.Message)
    Write-Host ("  Log written: {0}" -f $logPath)
    exit 1
}
finally {
    if ($mountedIso -and $isoPath) {
        try { Dismount-DiskImage -ImagePath $isoPath -ErrorAction SilentlyContinue | Out-Null } catch { }
    }
    Stop-FieldKitLog
}
