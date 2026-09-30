Write-Output "=== recent app crashes/errors (last 20 min) ==="
Get-WinEvent -FilterHashtable @{LogName='Application'; StartTime=(Get-Date).AddMinutes(-20)} -ErrorAction SilentlyContinue |
  Where-Object { $_.ProviderName -in 'Application Error','Windows Error Reporting','.NET Runtime' -or $_.Id -in 1000,1001,1026 } |
  Select-Object TimeCreated, ProviderName, Id, @{n='Msg';e={($_.Message -split "`n")[0..2] -join ' | '}} | Format-List
Write-Output "=== all non-system processes ==="
Get-CimInstance Win32_Process | Where-Object { $_.Name -notmatch 'svchost|dwm|csrss|wininit|winlogon|services|lsass|fontdrvhost|WmiPrvSE|sihost|taskhost|explorer|SearchHost|StartMenu|ShellExperience|RuntimeBroker|ctfmon|dllhost|conhost|SecurityHealth|MsMpEng|NisSrv|powershell|bash|wsl|node' } |
  Select-Object Name, ProcessId | Sort-Object Name | Format-Table -AutoSize
