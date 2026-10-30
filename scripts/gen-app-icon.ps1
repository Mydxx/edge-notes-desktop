# Generates the application icon (assets/app.ico + assets/app-256.png) used by the
# Windows installer and the packaged executable. Same visual language as the tray
# icon: dark card + blue accent strip on the edge + text lines.
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

function New-IconBitmap {
  param([int]$Size)
  $bmp = New-Object System.Drawing.Bitmap($Size, $Size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
  $g.Clear([System.Drawing.Color]::Transparent)

  $pad = [Math]::Max(0.5, $Size * 0.05)
  $rect = New-Object System.Drawing.RectangleF($pad, $pad, ($Size - 2 * $pad), ($Size - 2 * $pad))
  $radius = [Math]::Max(1.0, $Size * 0.19)

  # soft base so the icon does not look flat on dark taskbars
  $shadow = New-RoundedPath -Rect $rect -Radius $radius
  $shadowBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(70, 15, 23, 42))
  $g.FillPath($shadowBrush, $shadow)

  $inner = New-Object System.Drawing.RectangleF(($rect.X + $Size * 0.012), ($rect.Y + $Size * 0.012), ($rect.Width - $Size * 0.024), ($rect.Height - $Size * 0.024))
  $card = New-RoundedPath -Rect $inner -Radius $radius
  $cardBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 27, 36, 48))
  $g.FillPath($cardBrush, $card)

  # the product's signature edge strip
  $stripeWidth = [Math]::Max(1.5, $Size * 0.19)
  $stripeRect = New-Object System.Drawing.RectangleF($inner.X, $inner.Y, $stripeWidth, $inner.Height)
  $stripePath = New-RoundedPath -Rect $stripeRect -Radius ($stripeWidth / 2)
  $stripeBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 59, 130, 246))
  $g.FillPath($stripeBrush, $stripePath)

  # text lines: 3 rows when there is room, 2 on tiny sizes
  $factors = @(0.30, 0.50, 0.70)
  if ($Size -lt 48) {
    $factors = @(0.34, 0.58)
  }
  $lineBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(238, 201, 212, 230))
  $lineX = $inner.X + $stripeWidth + [Math]::Max(1.0, $Size * 0.10)
  $lineW = $inner.Right - $lineX - [Math]::Max(1.0, $Size * 0.11)
  $lineH = [Math]::Max(1.0, $Size * 0.075)
  for ($i = 0; $i -lt $factors.Count; $i++) {
    $y = $inner.Y + $inner.Height * $factors[$i]
    $width = $lineW
    if ($i -eq $factors.Count - 1) {
      $width = $lineW * 0.62
    }
    $g.FillRectangle($lineBrush, $lineX, $y, $width, $lineH)
  }

  $g.Dispose()
  return $bmp
}

function Get-PngBytes {
  param([System.Drawing.Bitmap]$Bitmap)
  $ms = New-Object System.IO.MemoryStream
  $Bitmap.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
  $bytes = $ms.ToArray()
  $ms.Dispose()
  return $bytes
}

$sizes = @(16, 24, 32, 48, 64, 128, 256)
$entries = New-Object System.Collections.ArrayList
foreach ($size in $sizes) {
  $bmp = New-IconBitmap -Size $size
  [void]$entries.Add([pscustomobject]@{ Size = $size; Bytes = (Get-PngBytes -Bitmap $bmp) })
  if ($size -eq 256) {
    $bmp.Save((Join-Path $outDir 'app-256.png'), [System.Drawing.Imaging.ImageFormat]::Png)
  }
  $bmp.Dispose()
}

# ICO container with PNG-compressed entries (Vista+): 6-byte header + 16 bytes per entry
$icoPath = Join-Path $outDir 'app.ico'
$stream = New-Object System.IO.MemoryStream
$writer = New-Object System.IO.BinaryWriter($stream)
$writer.Write([UInt16]0)
$writer.Write([UInt16]1)
$writer.Write([UInt16]$entries.Count)
$offset = 6 + (16 * $entries.Count)
foreach ($entry in $entries) {
  $dim = 0
  if ($entry.Size -lt 256) { $dim = $entry.Size }
  $writer.Write([byte]$dim)
  $writer.Write([byte]$dim)
  $writer.Write([byte]0)
  $writer.Write([byte]0)
  $writer.Write([UInt16]1)
  $writer.Write([UInt16]32)
  $writer.Write([UInt32]$entry.Bytes.Length)
  $writer.Write([UInt32]$offset)
  $offset += $entry.Bytes.Length
}
foreach ($entry in $entries) {
  $writer.Write([byte[]]$entry.Bytes)
}
$writer.Flush()
[System.IO.File]::WriteAllBytes($icoPath, $stream.ToArray())
$writer.Dispose()
$stream.Dispose()

"saved: $icoPath"
Get-ChildItem $outDir -Filter 'app*' | ForEach-Object { "{0} {1} bytes" -f $_.Name, $_.Length }
