param(
  [int]$RelX = 32,
  [int]$RelY = 30,
  [string]$PathFilter = "*v1.0.0*"
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class ClickUtil {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
[ClickUtil]::SetProcessDPIAware() | Out-Null

$process = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like $PathFilter } |
  Select-Object -First 1
if (-not $process) {
  Write-Output 'WINDOW_NOT_FOUND'
  exit 1
}

$handle = $process.MainWindowHandle
[ClickUtil]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 250

$rect = New-Object RECT
[ClickUtil]::GetWindowRect($handle, [ref]$rect) | Out-Null
$targetX = $rect.Left + $RelX
$targetY = $rect.Top + $RelY

[ClickUtil]::SetCursorPos($targetX, $targetY) | Out-Null
Start-Sleep -Milliseconds 100
[ClickUtil]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
Start-Sleep -Milliseconds 60
[ClickUtil]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
Write-Output ("CLICKED=" + $targetX + "," + $targetY)
