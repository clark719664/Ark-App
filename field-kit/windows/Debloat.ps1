<#
.SYNOPSIS
  Remove a curated, SAFE list of consumer bloatware from a business PC.

.DESCRIPTION
  Removes only well-known consumer Appx packages (casual games, Xbox social
  apps, promotional apps) that have no place on a business build. It never
  touches system components, security, the Store, Calculator, Photos, Notepad,
  Terminal, .NET runtimes, or anything an app might depend on.

  Dry-runs by default: it lists exactly which packages are present and would be
  removed. Pass -Apply to remove them. Removing is done both for the current
  user (Get-AppxPackage) and for the provisioned image (so new users don't get
  them back). It is idempotent - packages already gone are simply skipped.

  Restore: these are all reinstallable free from the Microsoft Store, or, for a
  provisioned app, with:
    Get-AppxPackage -AllUsers <name> | Foreach {Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml"}
  See -ShowRestoreNote.

.PARAMETER Config
  Optional config.json. If it has a "debloat_extra" array, those package name
  patterns are added to the removal list. A "debloat_keep" array removes
  patterns from the list (a safety allow-keep). Site/client labels are used on
  the log if present.

.PARAMETER Apply
  Remove for real. Without it, nothing is changed.

.PARAMETER AllUsers
  Also remove installed copies for all existing user profiles (not just the
  current user). The provisioned-package removal always runs.

.PARAMETER ShowRestoreNote
  Print how to reinstall/restore removed apps and exit.

.PARAMETER Authorized
  Signed-authorization note recorded in the log.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$Config,
    [switch]$Apply,
    [switch]$AllUsers,
    [switch]$ShowRestoreNote,
    [string]$Authorized
)

. "$PSScriptRoot\_FieldKit.ps1"

# Curated safe removal list (Appx package *name* patterns, wildcarded).
# Deliberately conservative: casual games, Xbox social/overlay, promo/consumer
# apps. NOT included (kept): Store, Calculator, Photos, Notepad, Terminal,
# Paint, Snipping Tool, .NET/VCLibs runtimes, security, WebView, Store purchases,
# and productivity apps (Sticky Notes, To Do, OneNote) - add those via
# debloat_extra only if a site truly wants them gone.
$BloatPatterns = @(
    "Microsoft.549981C3F5F10"          # Cortana
    "Microsoft.BingNews"
    "Microsoft.BingWeather"
    "Microsoft.BingFinance"
    "Microsoft.BingSports"
    "Microsoft.GamingApp"              # Xbox app
    "Microsoft.XboxApp"
    "Microsoft.XboxGamingOverlay"
    "Microsoft.XboxGameOverlay"
    "Microsoft.XboxSpeechToTextOverlay"
    "Microsoft.Xbox.TCUI"
    "Microsoft.XboxIdentityProvider"
    "Microsoft.MicrosoftSolitaireCollection"
    "Microsoft.MicrosoftMahjong"
    "Microsoft.MinecraftUWP"
    "Microsoft.MicrosoftOfficeHub"     # "Get Office" / promo hub
    "Microsoft.SkypeApp"
    "Microsoft.People"
    "Microsoft.WindowsFeedbackHub"
    "Microsoft.Getstarted"             # "Tips"
    "Microsoft.Microsoft3DViewer"
    "Microsoft.MixedReality.Portal"
    "Microsoft.Print3D"
    "Microsoft.Wallet"
    "Microsoft.ZuneMusic"              # Groove / Media Player (music)
    "Microsoft.ZuneVideo"             # Movies & TV
    "Microsoft.YourPhone"
    "Clipchamp.Clipchamp"
    "MicrosoftTeams"                   # consumer Teams (personal chat), not work Teams
    "Microsoft.PowerAutomateDesktop"
)

$logPath = Start-FieldKitLog -Module "debloat" -Slug $env:COMPUTERNAME

try {
    if ($ShowRestoreNote) {
        Write-Section "How to restore removed apps"
        Write-Host "  1) Simplest: reinstall the app from the Microsoft Store (all are free)."
        Write-Host "  2) Re-provision one for the current user, if its files remain:"
        Write-Host '     Get-AppxPackage -AllUsers <PackageName> | ForEach-Object {'
        Write-Host '         Add-AppxPackage -DisableDevelopmentMode -Register "$($_.InstallLocation)\AppXManifest.xml" }'
        Write-Host "  3) Provisioned (new-user) copies removed with -Apply are re-added by"
        Write-Host "     reinstalling from the Store; there is no offline rollback for the image."
        Write-Host ("  Log written: {0}" -f $logPath)
        return
    }

    $site = $env:COMPUTERNAME
    if ($Config) {
        try {
            $cfg = Get-FieldKitConfig -Path $Config
            if ($cfg.PSObject.Properties.Name -contains "site_name" -and $cfg.site_name) { $site = $cfg.site_name }
            if ($cfg.PSObject.Properties.Name -contains "debloat_extra") {
                foreach ($p in @($cfg.debloat_extra)) { if ($p) { $BloatPatterns += [string]$p } }
            }
            if ($cfg.PSObject.Properties.Name -contains "debloat_keep") {
                foreach ($k in @($cfg.debloat_keep)) {
                    $BloatPatterns = $BloatPatterns | Where-Object { $_ -ne [string]$k }
                }
            }
        }
        catch {
            Write-Warning "Could not read config ($($_.Exception.Message)); using the built-in list."
        }
    }

    Write-Banner -Title "Debloat" -Site $site -Apply ([bool]$Apply) `
        -WillDo @("Scan for a curated list of consumer bloatware Appx packages",
        "List each one present on this machine",
        ("Remove them (current user{0}) + provisioned image on -Apply" -f $(if ($AllUsers) { ' + all users' } else { '' })),
        "Never touch system, security, Store, or productivity apps")
    Write-Host ("  Effective mode: {0}" -f (Get-ModeLabel ([bool]$Apply)))

    if (-not (Test-IsAdmin)) {
        Write-Warning "Not elevated. Provisioned-package removal and -AllUsers need Administrator; per-user removal may be limited."
    }
    if ($Apply) {
        Confirm-Authorization -Site $site -Authorized $Authorized
    }
    elseif ($Authorized) {
        Write-Host ("  Authorization on file: {0}" -f $Authorized)
    }

    Write-Section "Scanning installed Appx packages"
    $scope = if ($AllUsers) { "AllUsers" } else { "CurrentUser" }
    if ($AllUsers) {
        $installed = Get-AppxPackage -AllUsers -ErrorAction SilentlyContinue
    }
    else {
        $installed = Get-AppxPackage -ErrorAction SilentlyContinue
    }
    $provisioned = @()
    try {
        $provisioned = Get-AppxProvisionedPackage -Online -ErrorAction Stop
    }
    catch {
        Write-Warning "Could not list provisioned packages ($($_.Exception.Message)). Provisioned removal will be skipped."
    }

    $removedCount = 0
    $foundAny = $false

    foreach ($pattern in $BloatPatterns) {
        $userMatches = @($installed | Where-Object { $_.Name -like ("{0}*" -f $pattern) })
        $provMatches = @($provisioned | Where-Object { $_.DisplayName -like ("{0}*" -f $pattern) })
        if ($userMatches.Count -eq 0 -and $provMatches.Count -eq 0) {
            continue
        }
        $foundAny = $true
        Write-Host ("  [found] {0}" -f $pattern)

        foreach ($pkg in $userMatches) {
            Write-Host ("    - installed ({0}): {1}" -f $scope, $pkg.PackageFullName)
            if ($Apply -and $PSCmdlet.ShouldProcess($pkg.PackageFullName, "Remove-AppxPackage")) {
                try {
                    if ($AllUsers) {
                        Remove-AppxPackage -Package $pkg.PackageFullName -AllUsers -ErrorAction Stop
                    }
                    else {
                        Remove-AppxPackage -Package $pkg.PackageFullName -ErrorAction Stop
                    }
                    Write-Host "      [removed]"
                    $removedCount++
                }
                catch {
                    Write-Warning ("      could not remove: {0}" -f $_.Exception.Message)
                }
            }
        }

        foreach ($pp in $provMatches) {
            Write-Host ("    - provisioned image: {0}" -f $pp.DisplayName)
            if ($Apply -and $PSCmdlet.ShouldProcess($pp.DisplayName, "Remove-AppxProvisionedPackage")) {
                try {
                    Remove-AppxProvisionedPackage -Online -PackageName $pp.PackageName -ErrorAction Stop | Out-Null
                    Write-Host "      [de-provisioned]"
                    $removedCount++
                }
                catch {
                    Write-Warning ("      could not de-provision: {0}" -f $_.Exception.Message)
                }
            }
        }
    }

    if (-not $foundAny) {
        Write-Host "  No bloatware from the curated list is present. Nothing to do."
    }

    $endLabel = if ($Apply) { "Debloat complete" } else { "DRY RUN complete" }
    Write-Section $endLabel
    if ($Apply) {
        Write-Host ("  Removed {0} package instance(s)." -f $removedCount)
    }
    else {
        Write-Host "  No changes were made. Re-run with -Apply to remove the listed packages."
    }
    Write-Host "  Restore any app free from the Microsoft Store. See -ShowRestoreNote for details."
    Write-Host ("  Log written: {0}" -f $logPath)
}
catch {
    Write-Host ""
    Write-Host ("  ERROR: {0}" -f $_.Exception.Message)
    Write-Host ("  Log written: {0}" -f $logPath)
    exit 1
}
finally {
    Stop-FieldKitLog
}
