<#
.SYNOPSIS
  Standardize a new (or re-imaged) business PC from one config file.

.DESCRIPTION
  Reads a config.json and brings a PC to the client's standard build:
    * rename the computer
    * join a workgroup (domain join is prompted for credentials, never stored)
    * set timezone
    * set the active power plan
    * set the AC monitor (display-off) timeout (not a screen lock or sleep)
    * install a list of winget app IDs (idempotent - skips already-installed)

  Dry-runs by default and prints exactly what it would change. Pass -Apply to
  execute. Re-running is safe: each step checks current state first.

.PARAMETER Config
  Path to your filled-in config.json.

.PARAMETER Apply
  Execute for real. Without it, nothing is changed.

.PARAMETER Yes
  Skip the confirmation prompt before a rename (which needs a reboot).

.PARAMETER Authorized
  Signed-authorization note recorded in the log.
#>
[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)][string]$Config,
    [switch]$Apply,
    [switch]$Yes,
    [string]$Authorized
)

. "$PSScriptRoot\_FieldKit.ps1"

$cfg = Get-FieldKitConfig -Path $Config -Required @("site_name")
$site = $cfg.site_name

function Get-CfgValue {
    param([string]$Name, $Default = $null)
    if ($cfg.PSObject.Properties.Name -contains $Name) {
        $v = $cfg.$Name
        if ($null -ne $v -and -not ($v -is [string] -and $v.Trim() -eq "")) { return $v }
    }
    return $Default
}

$computerName = Get-CfgValue "computer_name" $null
$timezone = Get-CfgValue "timezone" $null
$powerPlan = Get-CfgValue "power_plan" $null
$monitorTimeout = Get-CfgValue "monitor_timeout_min" $null
$workgroup = Get-CfgValue "workgroup" $null
$domain = Get-CfgValue "domain" $null
$apps = @(Get-CfgValue "winget_apps" @())

$logPath = Start-FieldKitLog -Module "newpcsetup" -Slug $site

try {
    $willDo = @()
    if ($computerName) { $willDo += "Rename computer to '$computerName' (needs reboot)" }
    if ($workgroup) { $willDo += "Join workgroup '$workgroup'" }
    if ($domain) { $willDo += "Join domain '$domain' (will prompt for credentials)" }
    if ($timezone) { $willDo += "Set timezone to '$timezone'" }
    if ($powerPlan) { $willDo += "Set active power plan to '$powerPlan'" }
    if ($monitorTimeout) { $willDo += "Set AC monitor (display-off) timeout to $monitorTimeout min" }
    if ($apps.Count -gt 0) { $willDo += ("Install {0} winget app(s), skipping any already present" -f $apps.Count) }
    if ($willDo.Count -eq 0) { $willDo += "Nothing configured - fill in the config to give it work." }

    Write-Banner -Title "New-PC-Setup" -Site $site -Apply ([bool]$Apply) -WillDo $willDo
    Write-Host ("  Effective mode: {0}" -f (Get-ModeLabel ([bool]$Apply)))

    if (-not (Test-IsAdmin)) {
        throw "This tool must run elevated (Administrator). Re-launch PowerShell as Administrator."
    }
    if ($Apply) {
        Confirm-Authorization -Site $site -Authorized $Authorized
    }
    elseif ($Authorized) {
        Write-Host ("  Authorization on file: {0}" -f $Authorized)
    }

    # ---- Rename ----
    if ($computerName) {
        Write-Section "Computer name"
        if ($env:COMPUTERNAME -ieq $computerName) {
            Write-Host ("  [skip] Already named '{0}'." -f $computerName)
        }
        else {
            Write-Host ("  [plan] Rename '{0}' -> '{1}'." -f $env:COMPUTERNAME, $computerName)
            if ($Apply) {
                $doRename = $true
                if (-not $Yes) {
                    $ans = Read-Host "  Confirm rename (needs a reboot later)? Type 'yes'"
                    $doRename = ($ans.Trim().ToLower() -eq "yes")
                }
                if ($doRename -and $PSCmdlet.ShouldProcess($computerName, "Rename-Computer")) {
                    Rename-Computer -NewName $computerName -Force -ErrorAction Stop
                    Write-Host "  [done] Renamed. A reboot is required to finish."
                }
                else {
                    Write-Host "  [skip] Rename not confirmed."
                }
            }
        }
    }

    # ---- Workgroup / domain ----
    if ($domain) {
        Write-Section "Domain join"
        $cs = Get-CimInstance Win32_ComputerSystem
        if ($cs.PartOfDomain -and ($cs.Domain -ieq $domain)) {
            Write-Host ("  [skip] Already joined to '{0}'." -f $domain)
        }
        else {
            Write-Host ("  [plan] Join domain '{0}'." -f $domain)
            if ($Apply -and $PSCmdlet.ShouldProcess($domain, "Add-Computer -DomainName")) {
                Write-Host "  Enter domain-join credentials when prompted (never stored/logged)."
                $cred = Get-Credential -Message ("Credentials to join domain {0}" -f $domain)
                Add-Computer -DomainName $domain -Credential $cred -Force -ErrorAction Stop
                Write-Host "  [done] Domain join requested. Reboot to complete."
            }
        }
    }
    elseif ($workgroup) {
        Write-Section "Workgroup"
        $curWg = (Get-CimInstance Win32_ComputerSystem).Workgroup
        if ($curWg -ieq $workgroup) {
            Write-Host ("  [skip] Already in workgroup '{0}'." -f $workgroup)
        }
        else {
            Write-Host ("  [plan] Join workgroup '{0}' (currently '{1}')." -f $workgroup, $curWg)
            if ($Apply -and $PSCmdlet.ShouldProcess($workgroup, "Add-Computer -WorkGroupName")) {
                Add-Computer -WorkGroupName $workgroup -Force -ErrorAction Stop
                Write-Host "  [done] Workgroup set."
            }
        }
    }

    # ---- Timezone ----
    if ($timezone) {
        Write-Section "Timezone"
        $cur = (Get-TimeZone).Id
        if ($cur -ieq $timezone) {
            Write-Host ("  [skip] Already '{0}'." -f $timezone)
        }
        else {
            Write-Host ("  [plan] Set timezone '{0}' -> '{1}'." -f $cur, $timezone)
            if ($Apply -and $PSCmdlet.ShouldProcess($timezone, "Set-TimeZone")) {
                try {
                    Set-TimeZone -Id $timezone -ErrorAction Stop
                    Write-Host "  [done] Timezone set."
                }
                catch {
                    Write-Warning "Could not set timezone: $($_.Exception.Message). Check the exact Id with 'Get-TimeZone -ListAvailable'."
                }
            }
        }
    }

    # ---- Power plan ----
    if ($powerPlan) {
        Write-Section "Power plan"
        Write-Host ("  [plan] Set active power plan to '{0}'." -f $powerPlan)
        if ($Apply -and $PSCmdlet.ShouldProcess($powerPlan, "powercfg /setactive")) {
            $guid = $null
            $known = @{
                "balanced"         = "381b4222-f694-41f0-9685-ff5bb260df2e"
                "high performance" = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
                "power saver"      = "a1841308-3541-4fab-bc81-f71556f20b4a"
                "high-performance" = "8c5e7fda-e8bf-4a96-9a85-a6e23a8c635c"
            }
            $key = $powerPlan.ToLower().Trim()
            if ($known.ContainsKey($key)) { $guid = $known[$key] }
            if ($guid) {
                & powercfg /setactive $guid
                Write-Host ("  [done] Active plan set to '{0}'." -f $powerPlan)
            }
            else {
                Write-Warning "Unknown power plan name '$powerPlan'. Use Balanced, High performance, or Power saver."
            }
        }
    }

    # ---- Monitor (display-off) timeout (AC) ----
    if ($monitorTimeout) {
        Write-Section "Monitor timeout (AC)"
        $mins = [int]$monitorTimeout
        Write-Host ("  [plan] Set AC monitor (display-off) timeout to {0} minute(s)." -f $mins)
        if ($Apply -and $PSCmdlet.ShouldProcess("AC monitor timeout", ("powercfg /change monitor-timeout-ac {0}" -f $mins))) {
            & powercfg /change monitor-timeout-ac $mins
            Write-Host "  [done] Monitor timeout (AC) set."
        }
    }

    # ---- winget apps ----
    if ($apps.Count -gt 0) {
        Write-Section "Business software (winget)"
        $winget = Get-Command winget -ErrorAction SilentlyContinue
        if (-not $winget) {
            Write-Warning "winget not found on this machine. Install 'App Installer' from the Microsoft Store, then re-run."
        }
        else {
            foreach ($id in $apps) {
                $id = [string]$id
                if (-not $id) { continue }
                $installed = $false
                try {
                    $list = & winget list --id $id --exact 2>$null
                    if ($LASTEXITCODE -eq 0 -and ($list -join "`n") -match [regex]::Escape($id)) { $installed = $true }
                }
                catch { }
                if ($installed) {
                    Write-Host ("  [skip] {0} already installed." -f $id)
                    continue
                }
                Write-Host ("  [plan] Install {0}." -f $id)
                if ($Apply -and $PSCmdlet.ShouldProcess($id, "winget install")) {
                    & winget install --id $id --exact --silent --accept-package-agreements --accept-source-agreements
                    if ($LASTEXITCODE -eq 0) {
                        Write-Host ("  [done] Installed {0}." -f $id)
                    }
                    else {
                        Write-Warning ("winget returned exit code {0} for {1}." -f $LASTEXITCODE, $id)
                    }
                }
            }
        }
    }

    $endLabel = if ($Apply) { "Setup complete" } else { "DRY RUN complete" }
    Write-Section $endLabel
    if (-not $Apply) { Write-Host "  No changes were made. Re-run with -Apply to execute." }
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
