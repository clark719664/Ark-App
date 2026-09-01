<#
.SYNOPSIS
  Windows 11 hardware readiness check. READ-ONLY.

.DESCRIPTION
  Checks the official Windows 11 minimum requirements on the machine it runs on
  and prints a clear PASS / FAIL / REVIEW per requirement plus an overall
  verdict. It changes nothing. A transcript log is written to field-kit\logs and
  an HTML report to field-kit\reports.

  Requirements checked:
    * TPM 2.0 present, enabled and activated
    * UEFI firmware with Secure Boot capable/enabled
    * CPU: 64-bit, >= 2 cores, >= 1 GHz, and a best-effort model/generation note
    * RAM  >= 4 GB
    * System disk >= 64 GB total
    * Windows currently 64-bit

.PARAMETER Config
  Optional path to a config.json (only used for site/client labels on the log
  and report). If omitted, the machine name is used.

.PARAMETER Authorized
  Optional signed-authorization note recorded in the log.

.NOTES
  Exact CPU compatibility is a long Microsoft-maintained allow-list. This script
  cannot reproduce it offline, so CPU generation is reported as a REVIEW item
  with the detected model when it cannot be confirmed. Verify surprising results
  against Microsoft's supported-processor list.
#>
[CmdletBinding()]
param(
    [string]$Config,
    [string]$Authorized
)

. "$PSScriptRoot\_FieldKit.ps1"

# Exit code communicates the verdict to callers (e.g. Win11-Upgrade pre-flight):
#   0 = READY or READY (with review) ; 1 = NOT READY (a hard requirement FAILED)
$script:ReadinessExit = 0

$site = $env:COMPUTERNAME
$client = ""
if ($Config) {
    try {
        $cfg = Get-FieldKitConfig -Path $Config
        if ($cfg.PSObject.Properties.Name -contains "site_name" -and $cfg.site_name) { $site = $cfg.site_name }
        if ($cfg.PSObject.Properties.Name -contains "client" -and $cfg.client) { $client = $cfg.client }
    }
    catch {
        Write-Warning "Could not read config ($($_.Exception.Message)); continuing with defaults."
    }
}

$logPath = Start-FieldKitLog -Module "win11readiness" -Slug $site
try {
    Write-Banner -Title "Win11-Readiness (read-only)" -Site $site -Apply $false -ReadOnly `
        -WillDo @("Inspect TPM, Secure Boot, CPU, RAM and disk", "Write a PASS/FAIL report", "Change nothing on this machine")
    if ($Authorized) { Write-Host ("  Authorization on file: {0}" -f $Authorized) }
    if (-not (Test-IsAdmin)) {
        Write-Warning "Not running elevated. Some checks (TPM, Secure Boot) may be unavailable; results marked REVIEW."
    }

    $results = New-Object System.Collections.ArrayList

    function Add-Result {
        param([string]$Name, [string]$Status, [string]$Detail)
        [void]$results.Add([PSCustomObject]@{ Requirement = $Name; Status = $Status; Detail = $Detail })
        $pad = $Name.PadRight(22)
        Write-Host ("  [{0}] {1} {2}" -f $Status.PadRight(6), $pad, $Detail)
    }

    Write-Section "Checking Windows 11 requirements"

    # --- TPM 2.0 ---
    try {
        $tpm = Get-CimInstance -Namespace "root\cimv2\security\microsofttpm" -ClassName Win32_Tpm -ErrorAction Stop
        if ($null -eq $tpm) {
            Add-Result "TPM 2.0" "FAIL" "No TPM detected."
        }
        else {
            $spec = ""
            if ($tpm.PSObject.Properties.Name -contains "SpecVersion") { $spec = [string]$tpm.SpecVersion }
            $is20 = $spec -match "2\.0"
            $enabled = $false
            $activated = $false
            try { $enabled = [bool]$tpm.IsEnabled_InitialValue } catch { }
            try { $activated = [bool]$tpm.IsActivated_InitialValue } catch { }
            if ($is20 -and $enabled -and $activated) {
                Add-Result "TPM 2.0" "PASS" ("SpecVersion {0}, enabled and activated." -f ($spec -split ',')[0])
            }
            elseif ($is20) {
                Add-Result "TPM 2.0" "REVIEW" ("TPM 2.0 present but enabled=$enabled activated=$activated - enable in firmware.")
            }
            else {
                Add-Result "TPM 2.0" "FAIL" ("TPM present but not 2.0 (SpecVersion '{0}')." -f $spec)
            }
        }
    }
    catch {
        Add-Result "TPM 2.0" "REVIEW" ("Could not query TPM ({0}). Check firmware / run elevated." -f $_.Exception.Message)
    }

    # --- Secure Boot / UEFI ---
    $firmware = ""
    try {
        $ci = Get-ComputerInfo -Property BiosFirmwareType -ErrorAction Stop
        $firmware = [string]$ci.BiosFirmwareType
    }
    catch { }
    try {
        $sb = Confirm-SecureBootUEFI -ErrorAction Stop
        if ($sb) {
            Add-Result "Secure Boot" "PASS" "UEFI Secure Boot is enabled."
        }
        else {
            Add-Result "Secure Boot" "REVIEW" "UEFI present but Secure Boot is OFF - enable it in firmware."
        }
    }
    catch {
        if ($firmware -eq "Bios") {
            Add-Result "Secure Boot" "FAIL" "Legacy BIOS firmware - Secure Boot not supported (needs UEFI)."
        }
        else {
            Add-Result "Secure Boot" "REVIEW" ("Could not confirm Secure Boot ({0}). Needs UEFI + elevation." -f $_.Exception.Message)
        }
    }

    # --- CPU ---
    try {
        $cpu = Get-CimInstance -ClassName Win32_Processor -ErrorAction Stop | Select-Object -First 1
        $cores = [int]$cpu.NumberOfCores
        $mhz = [int]$cpu.MaxClockSpeed
        $arch = [int]$cpu.Architecture   # 9 = x64, 12 = ARM64
        $name = ([string]$cpu.Name).Trim()
        $is64 = ($arch -eq 9 -or $arch -eq 12)
        $basicsOk = ($is64 -and $cores -ge 2 -and $mhz -ge 1000)
        if ($basicsOk) {
            Add-Result "CPU cores/speed" "PASS" ("{0} core(s), {1} MHz, 64-bit." -f $cores, $mhz)
        }
        else {
            Add-Result "CPU cores/speed" "FAIL" ("{0} core(s), {1} MHz, 64-bit={2} (need >=2 cores, >=1GHz, 64-bit)." -f $cores, $mhz, $is64)
        }
        # Generation is a Microsoft allow-list we cannot fully reproduce offline.
        Add-Result "CPU model/gen" "REVIEW" ("Detected '{0}'. Verify against Microsoft's supported-processor list." -f $name)
    }
    catch {
        Add-Result "CPU cores/speed" "REVIEW" ("Could not query CPU ({0})." -f $_.Exception.Message)
    }

    # --- RAM ---
    try {
        $cs = Get-CimInstance -ClassName Win32_ComputerSystem -ErrorAction Stop
        $ramGB = [math]::Round($cs.TotalPhysicalMemory / 1GB, 1)
        if ($ramGB -ge 4) {
            Add-Result "RAM >= 4 GB" "PASS" ("{0} GB installed." -f $ramGB)
        }
        else {
            Add-Result "RAM >= 4 GB" "FAIL" ("{0} GB installed (need >= 4 GB)." -f $ramGB)
        }
    }
    catch {
        Add-Result "RAM >= 4 GB" "REVIEW" ("Could not query RAM ({0})." -f $_.Exception.Message)
    }

    # --- System disk >= 64 GB total ---
    try {
        $sysDrive = ($env:SystemDrive).TrimEnd(':')
        $disk = Get-CimInstance -ClassName Win32_LogicalDisk -Filter ("DeviceID='{0}:'" -f $sysDrive) -ErrorAction Stop
        $totalGB = [math]::Round($disk.Size / 1GB, 1)
        $freeGB = [math]::Round($disk.FreeSpace / 1GB, 1)
        if ($totalGB -ge 64) {
            Add-Result "Storage >= 64 GB" "PASS" ("{0}: is {1} GB total, {2} GB free." -f $sysDrive, $totalGB, $freeGB)
        }
        else {
            Add-Result "Storage >= 64 GB" "FAIL" ("{0}: is {1} GB total (need >= 64 GB)." -f $sysDrive, $totalGB)
        }
    }
    catch {
        Add-Result "Storage >= 64 GB" "REVIEW" ("Could not query system disk ({0})." -f $_.Exception.Message)
    }

    # --- OS is 64-bit ---
    if ([Environment]::Is64BitOperatingSystem) {
        Add-Result "64-bit OS" "PASS" "Current Windows is 64-bit."
    }
    else {
        Add-Result "64-bit OS" "FAIL" "Current Windows is 32-bit - Windows 11 requires 64-bit."
    }

    # --- Overall verdict ---
    $fails = @($results | Where-Object { $_.Status -eq "FAIL" })
    $reviews = @($results | Where-Object { $_.Status -eq "REVIEW" })
    if ($fails.Count -gt 0) {
        $verdict = "NOT READY"
        $verdictNote = ("{0} requirement(s) FAILED. This machine does not meet Windows 11 minimums as-is." -f $fails.Count)
        $script:ReadinessExit = 1
    }
    elseif ($reviews.Count -gt 0) {
        $verdict = "READY (with review)"
        $verdictNote = ("No hard failures, but {0} item(s) need manual review (often a firmware toggle or the CPU allow-list)." -f $reviews.Count)
    }
    else {
        $verdict = "READY"
        $verdictNote = "All checked requirements pass."
    }

    Write-Section "OVERALL VERDICT: $verdict"
    Write-Host ("  {0}" -f $verdictNote)

    # --- HTML report ---
    $reportDir = Get-ReportDir
    $stamp = Get-Date -Format "yyyyMMdd-HHmmss"
    $safeSite = ($site -replace '[^A-Za-z0-9._-]', '_')
    $reportPath = Join-Path $reportDir ("win11readiness-{0}-{1}.html" -f $safeSite, $stamp)

    Add-Type -AssemblyName System.Web -ErrorAction SilentlyContinue

    $rowsHtml = ""
    foreach ($r in $results) {
        $cls = $r.Status.ToLower()
        $rowsHtml += ("      <tr><td>{0}</td><td class='st {1}'>{2}</td><td>{3}</td></tr>`n" -f `
            [System.Web.HttpUtility]::HtmlEncode($r.Requirement), $cls, $r.Status, [System.Web.HttpUtility]::HtmlEncode($r.Detail))
    }

    $html = @"
<!doctype html>
<html><head><meta charset="utf-8"><title>Windows 11 Readiness - $safeSite</title>
<style>
 body{font-family:Segoe UI,Arial,sans-serif;margin:2rem;color:#1b1b1b}
 h1{margin-bottom:.2rem} .sub{color:#555;margin-top:0}
 table{border-collapse:collapse;width:100%;margin-top:1rem}
 th,td{border:1px solid #ccc;padding:.5rem .6rem;text-align:left;vertical-align:top}
 th{background:#f2f2f2}
 .st{font-weight:bold;text-align:center;white-space:nowrap}
 .pass{color:#0a7d24} .fail{color:#b00020} .review{color:#a15c00}
 .verdict{margin-top:1.2rem;padding:.8rem 1rem;border-radius:6px;font-size:1.1rem;font-weight:bold}
 .v-ready{background:#e6f4ea;color:#0a7d24} .v-review{background:#fff4e0;color:#a15c00} .v-fail{background:#fdecea;color:#b00020}
 footer{margin-top:2rem;color:#777;font-size:.85rem}
</style></head><body>
<h1>Windows 11 Readiness Report</h1>
<p class="sub">Site: $([System.Web.HttpUtility]::HtmlEncode($site)) &middot; Host: $env:COMPUTERNAME &middot; Client: $([System.Web.HttpUtility]::HtmlEncode($client)) &middot; Generated: $(Get-Timestamp)</p>
<div class="verdict $(if ($verdict -eq 'NOT READY'){'v-fail'} elseif ($verdict -eq 'READY'){'v-ready'} else {'v-review'})">Overall verdict: $verdict</div>
<p>$([System.Web.HttpUtility]::HtmlEncode($verdictNote))</p>
<table>
  <thead><tr><th>Requirement</th><th>Status</th><th>Detail</th></tr></thead>
  <tbody>
$rowsHtml
  </tbody>
</table>
<footer>Ark Field Kit - Win11-Readiness. Read-only hardware check. REVIEW items are usually a firmware toggle or a CPU-model lookup against Microsoft's supported-processor list, not a hard failure.</footer>
</body></html>
"@

    Set-Content -Path $reportPath -Value $html -Encoding UTF8
    Write-Host ""
    Write-Host ("  Report written: {0}" -f $reportPath)
    Write-Host ("  Log written   : {0}" -f $logPath)
}
finally {
    Stop-FieldKitLog
}

exit $script:ReadinessExit
