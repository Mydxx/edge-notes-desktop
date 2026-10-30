# Generates the tray icons used by the app (assets/tray.png + assets/tray@2x.png).
# Kept in the repo so the icon is reproducible and never depends on a temp path.
# ASCII only: Windows PowerShell 5.1 decodes BOM-less scripts as ANSI.

Add-Type -AssemblyName System.Drawing

$root = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$outDir = Join-Path $root 'assets'
New-Item -ItemType Directory -Force -Path $outDir | Out-Null

function New-RoundedPath {
  param([System.Drawing.RectangleF]$Rect, [float]$Radius)
  $path = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $Radius * 2
  $path.AddArc($Rect.X, $Rect.Y, $d, $d, 180, 90)
  $path.AddArc($Rect.Right - $d, $Rect.Y, $d, $d, 270, 90)
  $path.AddArc($Rect.Right - $d, $Rect.Bottom - $d, $d, $d, 0, 90)
  $path.AddArc($Rect.X, $Rect.Bottom - $d, $d, $d, 90, 90)
  $path.CloseFigure()
  return $path
}

function New-TrayIcon {
  param([int]$Size, [string]$Path)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(0.5, $Size * 0.06)
  $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad))
  $radius = [Math]::Max(1.0, $Size * 0.18)

  # card body
  $card = New-RoundedPath -Rect $rect -Radius $radius
  $cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 27, 36, 48))
  $g.FillPath($cardBrush, $card)

  # accent edge on the left (the product's signature 4px strip)
  $stripeWidth = [Math]::Max(1.5, $Size * 0.16)
  $stripeRect = New-Object System.Drawing.RectangleF($rect.X, $rect.Y, $stripeWidth, $rect.Height)
  $stripePath = New-RoundedPath -Rect $stripeRect -Radius ($stripeWidth / 2)
  $stripeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 59, 130, 246))
  $g.FillPath($stripeBrush, $stripePath)

  # two text lines
  $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 201, 212, 230))
  $lineX = $rect.X + $stripeWidth + [Math]::Max(1.0, $Size * 0.10)
  $lineW = $rect.Right - $lineX - [Math]::Max(1.0, $Size * 0.12)
  $lineH = [Math]::Max(1.0, $Size * 0.09)
  foreach ($factor in @(0.34, 0.56)) {
    $y = $rect.Y + $rect.Height * $factor
    $g.FillRectangle($lineBrush, $lineX, $y, $lineW, $lineH)
  }

  $g.Dispose()
  $bmp.Save($Path, [System.Drawing.Imaging.ImageFormat]::Png)
  $bmp.Dispose()
  return $Path
}

$small = New-TrayIcon -Size 16 -Path (Join-Path $outDir 'tray.png')
$large = New-TrayIcon -Size 32 -Path (Join-Path $outDir 'tray@2x.png')
"saved: $small"
"saved: $large"
Get-ChildItem $outDir -Filter 'tray*.png' | ForEach-Object { "{0} {1} bytes" -f $_.Name, $_.Length }
