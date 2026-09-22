# Turn the repo-root app image into the icons electron-builder and Electron need.
#
# Run from the repo root after replacing CTE2COB.jpg:
#
#     powershell -File tools/make-icons.ps1
#
# Writes packages/app/build/icon.ico (16..256, the one stamped into the .exe and the installer)
# and packages/app/build/icon.png (512, the window icon `npm run dev` uses).
#
# System.Drawing rather than a node dependency: this repo ships no image library, the two
# artefacts are committed so nobody but the person changing the image ever runs this, and the
# only packaging target is Windows. The ICO is assembled by hand because System.Drawing's own
# Icon.Save writes a single 32x32 frame and throws away every other size.

param(
    [string]$Source = (Join-Path $PSScriptRoot "..\CTE2COB.jpg"),
    [string]$OutDir = (Join-Path $PSScriptRoot "..\packages\app\build")
)

$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Drawing

if (-not (Test-Path $Source)) { throw "No source image at $Source" }
New-Item -ItemType Directory -Force -Path $OutDir | Out-Null

$img = [System.Drawing.Image]::FromFile((Resolve-Path $Source))

function Get-Scaled([System.Drawing.Image]$image, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap $size, $size
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.DrawImage($image, (New-Object System.Drawing.Rectangle 0, 0, $size, $size))
    $g.Dispose()
    return $bmp
}

# The window icon.
$png = Get-Scaled $img 512
$png.Save((Join-Path $OutDir "icon.png"), [System.Drawing.Imaging.ImageFormat]::Png)
$png.Dispose()

# The executable and installer icon. Every frame is stored PNG-compressed, which Vista and
# later read directly and which keeps a 256x256 frame from costing 256KB of raw bitmap.
$sizes = @(16, 24, 32, 48, 64, 128, 256)
$frames = @()
foreach ($size in $sizes) {
    $bmp = Get-Scaled $img $size
    $ms = New-Object System.IO.MemoryStream
    $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
    $bmp.Dispose()
    $frames += , @($size, $ms.ToArray())
    $ms.Dispose()
}
$img.Dispose()

$fs = [System.IO.File]::Create((Join-Path $OutDir "icon.ico"))
$bw = New-Object System.IO.BinaryWriter $fs
# ICONDIR: reserved, type 1 (icon), image count.
$bw.Write([UInt16]0); $bw.Write([UInt16]1); $bw.Write([UInt16]$frames.Count)
$offset = 6 + (16 * $frames.Count)
foreach ($frame in $frames) {
    $size = $frame[0]
    $bytes = $frame[1]
    # 256 is written as 0: the width and height fields are single bytes.
    $dim = [Byte]$(if ($size -ge 256) { 0 } else { $size })
    $bw.Write($dim); $bw.Write($dim)
    $bw.Write([Byte]0); $bw.Write([Byte]0)
    $bw.Write([UInt16]1); $bw.Write([UInt16]32)
    $bw.Write([UInt32]$bytes.Length); $bw.Write([UInt32]$offset)
    $offset += $bytes.Length
}
foreach ($frame in $frames) { $bw.Write($frame[1]) }
$bw.Flush(); $bw.Close(); $fs.Close()

Write-Output "icon.ico ($($frames.Count) sizes) and icon.png written to $OutDir"
