param(
  [Parameter(Mandatory = $true)][ValidateSet('metrics', 'move', 'click', 'drag', 'shot', 'hover', 'jitter', 'strip', 'probe', 'dialog-open', 'dialog-focus', 'dialog-close', 'panel-topmost', 'panel-physical', 'zorder-compare', 'count-instances', 'close-window', 'kill-renderer', 'clipboard-save', 'clipboard-set', 'clipboard-set-image', 'clipboard-restore', 'hotkey-wake')][string]$Command,
  [string]$OutDir = '',
  [int]$X = -1,
  [int]$Y = -1,
  [int]$Width = 0,
  [int]$Height = 0,
  [int]$ToX = -1,
  [int]$ToY = -1,
  [int]$Wait = 0,
  [int]$TargetPid = 0,
  [int]$PanelPid = 0,
  [string]$Name = 'shot',
  [string]$Image = '',
  [string]$TextFile = '',
  [string]$Prefix = '',
  [ValidateSet('left', 'right')][string]$Side = 'right'
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class EdgeNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool BringWindowToTop(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int GetWindowLong(IntPtr hWnd, int nIndex);
  [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);
  [DllImport("user32.dll")] public static extern void mouse_event(uint dwFlags, uint dx, uint dy, uint dwData, UIntPtr dwExtraInfo);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
  [DllImport("dwmapi.dll")] public static extern int DwmGetWindowAttribute(IntPtr hWnd, int attr, out RECT rect, int size);
  [DllImport("user32.dll")] public static extern bool PostMessage(IntPtr hWnd, uint msg, IntPtr wParam, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);
  public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);
  // EnumWindows 按 Z 序从上到下枚举，索引越小越靠上
  public static int ZIndex(IntPtr target) {
    int index = 0;
    int found = -1;
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (h == target) { found = index; return false; }
      index++;
      return true;
    }, IntPtr.Zero);
    return found;
  }
}
'@

# Must declare DPI awareness before reading screen metrics, otherwise Windows returns virtualized coordinates.
[EdgeNative]::SetProcessDPIAware() | Out-Null

$screenInfo = [System.Windows.Forms.Screen]::PrimaryScreen
$bounds = $screenInfo.Bounds
$wa = $screenInfo.WorkingArea
$midY = [int](($wa.Top + $wa.Bottom) / 2)

if ($Side -eq 'right') {
  $edgeX = $wa.Right - 2
  $insideX = $wa.Right - 120
  $parkX = $wa.Left + 400
} else {
  $edgeX = $wa.Left + 2
  $insideX = $wa.Left + 120
  $parkX = $wa.Right - 400
}

function Move-Cursor([int]$px, [int]$py) {
  [EdgeNative]::SetCursorPos($px, $py) | Out-Null
}

function Save-Shot([string]$shotName) {
  if (-not $OutDir) {
    throw 'shot requires -OutDir'
  }
  $cropWidth = 700
  $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
  $graphics = [System.Drawing.Graphics]::FromImage($bmp)
  $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
  $graphics.Dispose()

  if ($Side -eq 'right') {
    $srcX = $bounds.Width - $cropWidth
  } else {
    $srcX = 0
  }

  $crop = New-Object System.Drawing.Bitmap($cropWidth, $bounds.Height)
  $cropGraphics = [System.Drawing.Graphics]::FromImage($crop)
  $srcRect = New-Object System.Drawing.Rectangle($srcX, 0, $cropWidth, $bounds.Height)
  $dstRect = New-Object System.Drawing.Rectangle(0, 0, $cropWidth, $bounds.Height)
  $cropGraphics.DrawImage($bmp, $dstRect, $srcRect, [System.Drawing.GraphicsUnit]::Pixel)
  $cropGraphics.Dispose()

  $path = Join-Path $OutDir "$Prefix$shotName.png"
  $crop.Save($path, [System.Drawing.Imaging.ImageFormat]::Png)
  $crop.Dispose()
  $bmp.Dispose()
  Write-Output "SHOT $Prefix$shotName"
}

switch ($Command) {
  'metrics' {
    @{
      bounds      = @{ x = $bounds.X; y = $bounds.Y; width = $bounds.Width; height = $bounds.Height }
      workingArea = @{ x = $wa.X; y = $wa.Y; width = $wa.Width; height = $wa.Height }
    } | ConvertTo-Json -Compress
  }
  'move' {
    Move-Cursor $X $Y
    if ($Wait -gt 0) {
      Start-Sleep -Milliseconds $Wait
    }
    "MOVED $X $Y"
  }
  'hotkey-wake' {
    # 真实键盘事件触发全局快捷键 Ctrl+Alt+N（RegisterHotKey 是系统级的，不要求窗口在前台）
    [EdgeNative]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)
    [EdgeNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    [EdgeNative]::keybd_event(0x4E, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 90
    [EdgeNative]::keybd_event(0x4E, 0, 2, [UIntPtr]::Zero)
    [EdgeNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    [EdgeNative]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 300
    'HOTKEY-SENT ctrl+alt+n'
  }
  'shot' {
    Save-Shot $Name
  }
  'click' {
    Move-Cursor $X $Y
    Start-Sleep -Milliseconds 150
    [EdgeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 70
    [EdgeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    "CLICKED $X $Y"
  }
  'hover' {
    # 1. park far away, confirm collapsed
    Move-Cursor $parkX $midY
    Start-Sleep -Milliseconds 1000
    Save-Shot '01-collapsed'

    # 2. touch the trigger strip -> should expand
    Move-Cursor $edgeX $midY
    Start-Sleep -Milliseconds 600
    Save-Shot '02-expanded'

    # 3. leave for 400ms (less than the 700ms delay) then come back -> collapse must be cancelled
    Move-Cursor $parkX $midY
    Start-Sleep -Milliseconds 400
    Save-Shot '03-away-400ms'
    Move-Cursor $insideX $midY
    Start-Sleep -Milliseconds 500
    Save-Shot '04-reenter-cancelled'

    # 4. leave and wait past the delay + animation -> should collapse
    Move-Cursor $parkX $midY
    Start-Sleep -Milliseconds 1600
    Save-Shot '05-collapsed-again'
    'HOVER-DONE'
  }
  'jitter' {
    # rapid in/out 8 times across the trigger strip, looking for oscillation
    for ($i = 0; $i -lt 8; $i++) {
      Move-Cursor $edgeX $midY
      Start-Sleep -Milliseconds 70
      Move-Cursor $parkX $midY
      Start-Sleep -Milliseconds 70
    }
    Start-Sleep -Milliseconds 2000
    Save-Shot '06-jitter-settled'
    'JITTER-DONE'
  }
  'probe' {
    # Sample a few columns around the panel's inner edge to tell whether Edge Notes is covered by another window.
    $bmp = New-Object System.Drawing.Bitmap($bounds.Width, $bounds.Height)
    $graphics = [System.Drawing.Graphics]::FromImage($bmp)
    $graphics.CopyFromScreen($bounds.Left, $bounds.Top, 0, 0, $bmp.Size)
    $graphics.Dispose()

    $row = $midY - $bounds.Top
    $accent = 0
    $samples = @()
    $from = [Math]::Max(0, $X - 3)
    $to = [Math]::Min($bmp.Width - 1, $X + 4)
    for ($px = $from; $px -le $to; $px++) {
      $c = $bmp.GetPixel($px, $row)
      $samples += "$px=$($c.R),$($c.G),$($c.B)"
      # blue-dominant test: works for both the full accent color and the muted resting strip color
      if ($c.B -ge 60 -and ($c.B - $c.R) -ge 30) { $accent++ }
    }
    $bmp.Dispose()
    "PROBE accent=$accent " + ($samples -join ' ')
  }
  'dialog-open' {
    $script = Join-Path $PSScriptRoot 'zorder-window.ps1'
    $proc = Start-Process -FilePath 'powershell' -PassThru -ArgumentList @(
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', $script,
      '-X', $X, '-Y', $Y, '-Width', $Width, '-Height', $Height
    )
    $hwnd = [IntPtr]::Zero
    for ($i = 0; $i -lt 40; $i++) {
      Start-Sleep -Milliseconds 250
      $proc.Refresh()
      if ($proc.HasExited) { break }
      if ($proc.MainWindowHandle -ne [IntPtr]::Zero) {
        $hwnd = $proc.MainWindowHandle
        break
      }
    }
    if ($hwnd -eq [IntPtr]::Zero) {
      throw 'z-order probe window was not created'
    }
    Start-Sleep -Milliseconds 300
    "DIALOG-OPEN pid=$($proc.Id) hwnd=$hwnd"
  }
  'dialog-focus' {
    $proc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $proc) {
      throw 'z-order probe process not found'
    }
    $proc.Refresh()
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) {
      throw 'z-order probe window handle not available'
    }
    # A synthetic ALT press releases the foreground lock, otherwise SetForegroundWindow is ignored for background processes.
    [EdgeNative]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [EdgeNative]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 60
    [void][EdgeNative]::BringWindowToTop($hwnd)
    [void][EdgeNative]::SetForegroundWindow($hwnd)
    Start-Sleep -Milliseconds 500
    $foreground = [EdgeNative]::GetForegroundWindow()
    "DIALOG-FOCUS hwnd=$hwnd foreground=$foreground match=$($foreground -eq $hwnd)"
  }
  'drag' {
    # 按住左键从 (X,Y) 分步拖到 (ToX,ToY)，用于验证拖拽调宽
    Move-Cursor $X $Y
    Start-Sleep -Milliseconds 150
    [EdgeNative]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 120
    $steps = 14
    for ($i = 1; $i -le $steps; $i++) {
      $nx = [int]($X + ($ToX - $X) * $i / $steps)
      $ny = [int]($Y + ($ToY - $Y) * $i / $steps)
      [EdgeNative]::SetCursorPos($nx, $ny) | Out-Null
      Start-Sleep -Milliseconds 35
    }
    Start-Sleep -Milliseconds 180
    [EdgeNative]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)
    Start-Sleep -Milliseconds 250
    "DRAGGED $X,$Y -> $ToX,$ToY"
  }
  'clipboard-save' {
    $value = ''
    try { $value = Get-Clipboard -Raw -ErrorAction Stop } catch { $value = '' }
    if ($null -eq $value) { $value = '' }
    [System.IO.File]::WriteAllText($TextFile, $value, (New-Object System.Text.UTF8Encoding($false)))
    "CLIPBOARD-SAVED $($value.Length)"
  }
  'clipboard-set-image' {
    # Put a real bitmap on the clipboard so Ctrl+V produces an image paste event.
    Add-Type -AssemblyName System.Windows.Forms
    Add-Type -AssemblyName System.Drawing
    $w = if ($Width -gt 0) { $Width } else { 64 }
    $h = if ($Height -gt 0) { $Height } else { 48 }
    $bmp = New-Object System.Drawing.Bitmap($w, $h)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.Clear([System.Drawing.Color]::FromArgb(255, 47, 111, 237))
    $g.FillEllipse([System.Drawing.Brushes]::White, [int]($w / 4), [int]($h / 4), [int]($w / 2), [int]($h / 2))
    $g.Dispose()
    try {
      [System.Windows.Forms.Clipboard]::SetImage($bmp)
    } catch {
      throw "SetImage failed (STA required?): $($_.Exception.Message)"
    }
    $bmp.Dispose()
    "CLIPBOARD-IMAGE-SET ${w}x${h} types=$(([System.Windows.Forms.Clipboard]::GetDataObject()).GetFormats() -join ',')"
  }
  'clipboard-set' {
    if (-not $TextFile -or -not (Test-Path $TextFile)) { throw 'clipboard-set requires -TextFile' }
    $value = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
    Set-Clipboard -Value $value
    "CLIPBOARD-SET $($value.Length)"
  }
  'clipboard-restore' {
    if ($TextFile -and (Test-Path $TextFile)) {
      $value = [System.IO.File]::ReadAllText($TextFile, [System.Text.Encoding]::UTF8)
      if ($value.Length -gt 0) { Set-Clipboard -Value $value }
    }
    'CLIPBOARD-RESTORED'
  }
  'panel-topmost' {
    if ($PanelPid -gt 0) {
      $target = Get-Process -Id $PanelPid -ErrorAction SilentlyContinue
    } else {
      $target = Get-Process -Name electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq 'Edge Notes' } |
        Select-Object -First 1
    }
    if (-not $target) {
      'PANEL-TOPMOST hwnd=0 topmost=unknown'
    } else {
      $target.Refresh()
      $hwnd = $target.MainWindowHandle
      $exStyle = [EdgeNative]::GetWindowLong($hwnd, -20)
      "PANEL-TOPMOST hwnd=$hwnd topmost=$([bool]($exStyle -band 0x8))"
    }
  }
  'close-window' {
    # Post WM_CLOSE to the panel window: same code path as Alt+F4 / system close,
    # without stealing focus from whatever the user is doing.
    if ($PanelPid -gt 0) {
      $proc = Get-Process -Id $PanelPid -ErrorAction SilentlyContinue
    } else {
      $proc = Get-Process -Name electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq 'Edge Notes' } |
        Select-Object -First 1
    }
    if (-not $proc) { throw 'panel process not found' }
    $proc.Refresh()
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { throw 'panel window handle not available' }
    $ok = [EdgeNative]::PostMessage($hwnd, 0x0010, [IntPtr]::Zero, [IntPtr]::Zero)
    "CLOSE-SENT hwnd=$hwnd ok=$ok"
  }
  'count-instances' {
    # Count electron processes whose command line mentions the given user-data dir.
    if (-not $TextFile) { throw 'count-instances requires -TextFile' }
    $n = (Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
      Where-Object { $_.CommandLine -like ("*" + $TextFile + "*") } |
      Measure-Object).Count
    "INSTANCES $n"
  }
  'kill-renderer' {
    # Kill the renderer child process to verify the main process recovery path.
    if ($PanelPid -le 0) { throw 'kill-renderer requires -PanelPid' }
    $child = Get-CimInstance Win32_Process -Filter "Name='electron.exe'" |
      Where-Object { $_.ParentProcessId -eq $PanelPid -and $_.CommandLine -like '*--type=renderer*' } |
      Select-Object -First 1
    if (-not $child) { throw 'renderer process not found' }
    Stop-Process -Id $child.ProcessId -Force
    Start-Sleep -Milliseconds 300
    "KILL-RENDERER pid=$($child.ProcessId)"
  }
  'panel-physical' {
    # Visible window rect in physical pixels (DWM extended frame bounds), independent of DIP rounding.
    if ($PanelPid -gt 0) {
      $proc = Get-Process -Id $PanelPid -ErrorAction SilentlyContinue
    } else {
      $proc = Get-Process -Name electron -ErrorAction SilentlyContinue |
        Where-Object { $_.MainWindowTitle -eq 'Edge Notes' } |
        Select-Object -First 1
    }
    if (-not $proc) { throw 'panel process not found' }
    $proc.Refresh()
    $hwnd = $proc.MainWindowHandle
    if ($hwnd -eq [IntPtr]::Zero) { throw 'panel window handle not available' }
    $rect = New-Object EdgeNative+RECT
    $hr = [EdgeNative]::DwmGetWindowAttribute($hwnd, 9, [ref]$rect, 16)
    $wa = [System.Windows.Forms.Screen]::PrimaryScreen.WorkingArea
    "PANEL-PHYSICAL hr=$hr left=$($rect.Left) top=$($rect.Top) right=$($rect.Right) bottom=$($rect.Bottom) workLeft=$($wa.Left) workTop=$($wa.Top) workRight=$($wa.Right) workBottom=$($wa.Bottom)"
  }
  'zorder-compare' {
    # 直接比较两个窗口在系统 Z 序里的位置，不依赖屏幕像素，避免被第三个窗口干扰
    if ($PanelPid -le 0 -or $TargetPid -le 0) {
      throw 'zorder-compare requires -PanelPid and -TargetPid'
    }
    $panelProc = Get-Process -Id $PanelPid -ErrorAction SilentlyContinue
    $otherProc = Get-Process -Id $TargetPid -ErrorAction SilentlyContinue
    if (-not $panelProc -or -not $otherProc) {
      throw 'process not found'
    }
    $panelProc.Refresh()
    $otherProc.Refresh()
    $panelHwnd = $panelProc.MainWindowHandle
    $otherHwnd = $otherProc.MainWindowHandle
    if ($panelHwnd -eq [IntPtr]::Zero -or $otherHwnd -eq [IntPtr]::Zero) {
      throw 'window handle missing'
    }
    $panelIndex = [EdgeNative]::ZIndex($panelHwnd)
    $otherIndex = [EdgeNative]::ZIndex($otherHwnd)
    "ZORDER panel=$panelIndex other=$otherIndex"
  }
  'dialog-close' {
    Stop-Process -Id $TargetPid -Force -ErrorAction SilentlyContinue
    "DIALOG-CLOSE $TargetPid"
  }
  'strip' {
    # Measure how wide the accent stripe is at the screen edge in a screenshot.
    if (-not $Image -or -not (Test-Path $Image)) {
      throw 'strip requires a valid -Image'
    }
    $img = [System.Drawing.Bitmap]::FromFile($Image)
    $row = [int]($img.Height / 2)
    if ($Side -eq 'right') {
      $startX = $img.Width - 1
      $step = -1
    } else {
      $startX = 0
      $step = 1
    }
    $run = 0
    $x = $startX
    while ($x -ge 0 -and $x -lt $img.Width) {
      $pixel = $img.GetPixel($x, $row)
      if ($pixel.B -ge 60 -and $pixel.B - $pixel.R -ge 30) {
        $run++
        $x += $step
      } else {
        break
      }
    }
    $edgePixel = $img.GetPixel($startX, $row)
    $img.Dispose()
    "STRIP $run rgb($($edgePixel.R),$($edgePixel.G),$($edgePixel.B))"
  }
}
