param(
  [string]$OutFile = "$env:TEMP\clipboard-ui.png",
  [string]$ProcessName = "electron",
  [string]$PathFilter = ""
)

Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
public class Win32Util {
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);
}
"@
[Win32Util]::SetProcessDPIAware() | Out-Null

if ($PathFilter) {
  $process = Get-Process -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -like $PathFilter } |
    Select-Object -First 1
} else {
  $process = Get-Process -Name $ProcessName -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne 0 } |
    Select-Object -First 1
}

if (-not $process) {
  Write-Output "window not found"
  exit 1
}

[Win32Util]::ShowWindow($process.MainWindowHandle, 9) | Out-Null
[Win32Util]::SetForegroundWindow($process.MainWindowHandle) | Out-Null
Start-Sleep -Milliseconds 400

$rect = New-Object RECT
[Win32Util]::GetWindowRect($process.MainWindowHandle, [ref]$rect) | Out-Null

$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
  Write-Output "invalid window size"
  exit 1
}

$bmp = New-Object System.Drawing.Bitmap -ArgumentList $width, $height
$graphics = [System.Drawing.Graphics]::FromImage($bmp)
$graphics.CopyFromScreen(
  $rect.Left,
  $rect.Top,
  0,
  0,
  (New-Object System.Drawing.Size -ArgumentList $width, $height)
)
$bmp.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
$graphics.Dispose()
$bmp.Dispose()

Write-Output "saved $OutFile ${width}x${height}"
