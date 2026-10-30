param(
  [int]$X = 100,
  [int]$Y = 100,
  [int]$Width = 600,
  [int]$Height = 800
)

# A plain, non-topmost white window used to verify that the always-on-top toggle really affects z-order.
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class ZOrderNative {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
}
'@

[ZOrderNative]::SetProcessDPIAware() | Out-Null

$form = New-Object System.Windows.Forms.Form
$form.Text = 'Edge Notes Z-Order Probe'
$form.BackColor = [System.Drawing.Color]::FromArgb(248, 248, 248)
$form.ForeColor = [System.Drawing.Color]::FromArgb(30, 30, 30)
$form.StartPosition = 'Manual'
$form.FormBorderStyle = 'FixedSingle'
$form.SetBounds($X, $Y, $Width, $Height)

$label = New-Object System.Windows.Forms.Label
$label.Text = 'Z-Order Probe Window'
$label.AutoSize = $true
$label.Location = New-Object System.Drawing.Point(24, 24)
$form.Controls.Add($label)

$form.Show()
$form.Activate()
[System.Windows.Forms.Application]::Run($form)
