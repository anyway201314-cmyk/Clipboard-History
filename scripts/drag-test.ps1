param(
  [int]$DeltaX = 60,
  [int]$DeltaY = 40
)

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class DragUtil {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, uint dx, uint dy, uint data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
}
"@
[DragUtil]::SetProcessDPIAware() | Out-Null

$process = Get-Process -ErrorAction SilentlyContinue |
  Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like '*v1.0.0*' } |
  Select-Object -First 1

if (-not $process) {
  Write-Output 'WINDOW_NOT_FOUND'
  exit 1
}

$handle = $process.MainWindowHandle
[DragUtil]::SetForegroundWindow($handle) | Out-Null
Start-Sleep -Milliseconds 300

$before = New-Object RECT
[DragUtil]::GetWindowRect($handle, [ref]$before) | Out-Null

function Drag-By([int]$dx, [int]$dy) {
  [DragUtil]::SetForegroundWindow($handle) | Out-Null
  Start-Sleep -Milliseconds 200
  $rect = New-Object RECT
  [DragUtil]::GetWindowRect($handle, [ref]$rect) | Out-Null
  $startX = [int](($rect.Left + $rect.Right) / 2)
  $startY = $rect.Top + 30
  [DragUtil]::SetCursorPos($startX, $startY) | Out-Null
  Start-Sleep -Milliseconds 80
  [DragUtil]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
  for ($i = 1; $i -le 10; $i++) {
    [DragUtil]::SetCursorPos($startX + [int]($dx * $i / 10), $startY + [int]($dy * $i / 10)) | Out-Null
    Start-Sleep -Milliseconds 20
  }
  [DragUtil]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
}

Drag-By $DeltaX $DeltaY
$after = New-Object RECT
[DragUtil]::GetWindowRect($handle, [ref]$after) | Out-Null

Write-Output ("BEFORE=" + $before.Left + "," + $before.Top)
Write-Output ("AFTER=" + $after.Left + "," + $after.Top)
Write-Output ("MOVED=" + (($after.Left - $before.Left).ToString()) + "," + (($after.Top - $before.Top).ToString()))

# 拖回原位置
Drag-By (-$DeltaX) (-$DeltaY)
$restored = New-Object RECT
[DragUtil]::GetWindowRect($handle, [ref]$restored) | Out-Null
Write-Output ("RESTORED=" + $restored.Left + "," + $restored.Top)
