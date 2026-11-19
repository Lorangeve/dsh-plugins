/**
 * PixPin screen capture bundle.
 *
 * Registers `pixpin_screenshot`, an agent tool that asks PixPin to capture the
 * screen, optionally draws annotations on the capture, and returns the image to
 * the model. A marked capture can also be pinned on the user's desktop through
 * PixPin, which turns the tool into a visual communication channel: the agent
 * points at something on screen and leaves the marked screenshot where the user
 * can see it.
 *
 * Capture paths:
 * - Instant targets use `pixpin.directScreenShotAndSaveTo(rect, path)`, which
 *   writes the PNG directly and needs no clipboard.
 * - `region` opens PixPin's selection UI and copies the selection to the
 *   clipboard; a PowerShell helper watches the clipboard sequence number so a
 *   stale image is never read.
 *
 * Annotations are drawn by a small PowerShell/System.Drawing helper. All
 * annotation coordinates are percentages (0-100) of the image width/height, so
 * the model does not need the exact pixel dimensions of the preview it saw.
 */

import { spawn } from 'node:child_process';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const inject = ['tools', 'attachments'];

/** Instant targets and the PixPin constant that selects each region. */
const TARGETS = {
  'all-screens': 'PixConst.SpRectAllScreen',
  'screen-under-mouse': 'PixConst.SpRectScreenUnderMouse',
  'active-window': 'PixConst.SpRectActiveWindow',
  'last-region': 'PixConst.SpRectLastShotRect',
};

const DEFAULT_TARGET = 'all-screens';
const DEFAULT_CAPTURE_TIMEOUT_MS = 30_000;
const DEFAULT_REGION_TIMEOUT_MS = 120_000;
const POLL_INTERVAL_MS = 120;
const HELPER_READY_TIMEOUT_MS = 20_000;
const HELPER_GRACE_MS = 20_000;
const MAX_ANNOTATIONS = 40;
const PIN_DIRECTORY = join(tmpdir(), 'dsh-pixpin-pins');
const PIN_RETENTION_MS = 3 * 24 * 60 * 60 * 1000;

/** The PowerShell waiter that watches the clipboard for PixPin's capture. */
const CLIPBOARD_HELPER_SCRIPT = String.raw`param(
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][int]$TimeoutMs,
  [int]$IntervalMs = 120
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -Namespace DshPixPin -Name ClipboardApi -MemberDefinition '[DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();'

$deadline = [DateTime]::UtcNow.AddMilliseconds($TimeoutMs)
$baseline = [DshPixPin.ClipboardApi]::GetClipboardSequenceNumber()
[Console]::Out.WriteLine("ready $baseline")
[Console]::Out.Flush()

while ([DateTime]::UtcNow -lt $deadline) {
  $sequence = [DshPixPin.ClipboardApi]::GetClipboardSequenceNumber()
  if ($sequence -ne $baseline) {
    try {
      if ([System.Windows.Forms.Clipboard]::ContainsImage()) {
        $image = [System.Windows.Forms.Clipboard]::GetImage()
        if ($null -ne $image) {
          $width = $image.Width
          $height = $image.Height
          $image.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
          $image.Dispose()
          [Console]::Out.WriteLine("captured $sequence $width $height")
          exit 0
        }
      }
    } catch {
      # The clipboard can be locked by another process for a few milliseconds.
    }
  }
  Start-Sleep -Milliseconds $IntervalMs
}

[Console]::Out.WriteLine('timeout')
exit 3
`;

/** Draws the requested marks onto a PNG. Coordinates arrive as percentages. */
const ANNOTATE_SCRIPT = String.raw`param(
  [Parameter(Mandatory = $true)][string]$InFile,
  [Parameter(Mandatory = $true)][string]$OutFile,
  [Parameter(Mandatory = $true)][string]$MarksFile,
  [switch]$Grid
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$marks = Get-Content -LiteralPath $MarksFile -Raw -Encoding UTF8 | ConvertFrom-Json
if ($null -eq $marks) { $marks = @() }
if ($marks -isnot [System.Array]) { $marks = @($marks) }

$source = [System.Drawing.Bitmap]::FromFile($InFile)
try {
  $bitmap = New-Object System.Drawing.Bitmap($source.Width, $source.Height, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
  $graphics = [System.Drawing.Graphics]::FromImage($bitmap)
  try {
    $graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::AntiAlias
    $graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $graphics.TextRenderingHint = [System.Drawing.Text.TextRenderingHint]::AntiAliasGridFit
    $graphics.DrawImage($source, 0, 0, $source.Width, $source.Height)

    $width = $source.Width
    $height = $source.Height
    $minor = [Math]::Min($width, $height)
    $defaultStroke = [Math]::Max(2, [int]($minor * 0.0035))
    $defaultFont = [Math]::Max(13, [int]($height * 0.022))

    function ConvertTo-Color([string]$value, [int]$alpha) {
      $named = @{
        'red' = '#e11d48'; 'orange' = '#f97316'; 'yellow' = '#eab308'; 'green' = '#16a34a';
        'blue' = '#2563eb'; 'purple' = '#7c3aed'; 'pink' = '#db2777'; 'white' = '#ffffff';
        'black' = '#000000'; 'cyan' = '#0891b2'
      }
      if ([string]::IsNullOrWhiteSpace($value)) { $value = '#e11d48' }
      $value = $value.Trim()
      $lower = $value.ToLowerInvariant()
      if ($named.ContainsKey($lower)) { $value = $named[$lower] }
      if ($value -match '^#([0-9a-fA-F]{6})$') {
        $r = [Convert]::ToInt32($value.Substring(1, 2), 16)
        $g = [Convert]::ToInt32($value.Substring(3, 2), 16)
        $b = [Convert]::ToInt32($value.Substring(5, 2), 16)
        return [System.Drawing.Color]::FromArgb($alpha, $r, $g, $b)
      }
      return [System.Drawing.Color]::FromArgb($alpha, 225, 29, 72)
    }

    function Get-Font([int]$size) {
      foreach ($name in @('Microsoft YaHei UI', 'Microsoft YaHei', 'Segoe UI')) {
        try { return New-Object System.Drawing.Font($name, $size, [System.Drawing.FontStyle]::Bold) } catch { }
      }
      return New-Object System.Drawing.Font([System.Drawing.FontFamily]::GenericSansSerif, $size, [System.Drawing.FontStyle]::Bold)
    }

    function Draw-Label([string]$text, [single]$left, [single]$top, [System.Drawing.Color]$color, [int]$fontPixels) {
      if ([string]::IsNullOrWhiteSpace($text)) { return }
      $font = Get-Font $fontPixels
      try {
        $format = [System.Drawing.StringFormat]::GenericTypographic
        $size = $graphics.MeasureString($text, $font, 100000, $format)
        $pad = [single]([Math]::Max(3, $fontPixels * 0.3))
        $boxX = [single][Math]::Max(2, [Math]::Min($width - $size.Width - 2 * $pad - 2, $left))
        $boxY = [single][Math]::Max(2, [Math]::Min($height - $size.Height - 2 * $pad - 2, $top))
        $back = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(215, 15, 23, 42))
        try { $graphics.FillRectangle($back, $boxX, $boxY, $size.Width + 2 * $pad, $size.Height + 2 * $pad) } finally { $back.Dispose() }
        $brush = New-Object System.Drawing.SolidBrush($color)
        try { $graphics.DrawString($text, $font, $brush, $boxX + $pad, $boxY + $pad, $format) } finally { $brush.Dispose() }
      } finally {
        $font.Dispose()
      }
    }

    function Draw-ArrowHead([single]$fromX, [single]$fromY, [single]$toX, [single]$toY, [System.Drawing.Color]$color, [int]$stroke) {
      $angle = [Math]::Atan2($toY - $fromY, $toX - $fromX)
      $length = [single]([Math]::Max(10.0, $stroke * 5.5))
      $spread = [single]([Math]::PI / 7)
      $p1x = [single]($toX - $length * [Math]::Cos($angle - $spread))
      $p1y = [single]($toY - $length * [Math]::Sin($angle - $spread))
      $p2x = [single]($toX - $length * [Math]::Cos($angle + $spread))
      $p2y = [single]($toY - $length * [Math]::Sin($angle + $spread))
      $brush = New-Object System.Drawing.SolidBrush($color)
      try {
        $graphics.FillPolygon($brush, @(
          (New-Object System.Drawing.PointF($toX, $toY)),
          (New-Object System.Drawing.PointF($p1x, $p1y)),
          (New-Object System.Drawing.PointF($p2x, $p2y))
        ))
      } finally { $brush.Dispose() }
    }

    if ($Grid) {
      $majorPen = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(95, 255, 255, 255)), [single]1)
      $minorPen = New-Object System.Drawing.Pen(([System.Drawing.Color]::FromArgb(45, 255, 255, 255)), [single]1)
      $gridFont = Get-Font ([int][Math]::Max(11, [int]($height * 0.012)))
      $darkBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(255, 15, 23, 42))
      $lightBrush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::FromArgb(235, 255, 255, 255))
      try {
        for ($p = 5; $p -lt 100; $p += 5) {
          $linePen = if (($p % 10) -eq 0) { $majorPen } else { $minorPen }
          $gx = [single]($width * $p / 100.0)
          $gy = [single]($height * $p / 100.0)
          $graphics.DrawLine($linePen, $gx, 0, $gx, $height)
          $graphics.DrawLine($linePen, 0, $gy, $width, $gy)
        }
        for ($p = 10; $p -lt 100; $p += 10) {
          $gx = [single]($width * $p / 100.0)
          $gy = [single]($height * $p / 100.0)
          $label = "$p%"
          $graphics.DrawString($label, $gridFont, $darkBrush, [single]($gx - 13), [single]3)
          $graphics.DrawString($label, $gridFont, $lightBrush, [single]($gx - 14), [single]2)
          $graphics.DrawString($label, $gridFont, $darkBrush, [single]3, [single]($gy - 13))
          $graphics.DrawString($label, $gridFont, $lightBrush, [single]2, [single]($gy - 14))
        }
      } finally {
        $majorPen.Dispose()
        $minorPen.Dispose()
        $gridFont.Dispose()
        $darkBrush.Dispose()
        $lightBrush.Dispose()
      }
    }

    foreach ($mark in $marks) {
      $kind = if ($null -ne $mark.kind) { [string]$mark.kind } else { 'rect' }
      $stroke = if ($null -ne $mark.stroke_width) { [int]$mark.stroke_width } else { $defaultStroke }
      if ($stroke -lt 1) { $stroke = 1 }
      $fontPixels = if ($null -ne $mark.font_size) {
        [int]$mark.font_size
      } elseif ($kind -eq 'text') {
        [Math]::Max(16, [int]($height * 0.028))
      } else {
        $defaultFont
      }
      $color = ConvertTo-Color ([string]$mark.color) 255
      $pen = New-Object System.Drawing.Pen($color, [single]$stroke)
      $pen.LineJoin = [System.Drawing.Drawing2D.LineJoin]::Round
      try {
        switch ($kind) {
          'rect' {
            $x = [single]($mark.x / 100.0 * $width)
            $y = [single]($mark.y / 100.0 * $height)
            $w = [single]($mark.width / 100.0 * $width)
            $h = [single]($mark.height / 100.0 * $height)
            if ($w -lt 0) { $x += $w; $w = -$w }
            if ($h -lt 0) { $y += $h; $h = -$h }
            $graphics.DrawRectangle($pen, $x, $y, $w, $h)
            if ($null -ne $mark.label) { Draw-Label ([string]$mark.label) $x ([single]($y - $fontPixels - 8)) $color $fontPixels }
          }
          'ellipse' {
            $x = [single]($mark.x / 100.0 * $width)
            $y = [single]($mark.y / 100.0 * $height)
            $w = [single]($mark.width / 100.0 * $width)
            $h = [single]($mark.height / 100.0 * $height)
            if ($w -lt 0) { $x += $w; $w = -$w }
            if ($h -lt 0) { $y += $h; $h = -$h }
            $graphics.DrawEllipse($pen, $x, $y, $w, $h)
            if ($null -ne $mark.label) { Draw-Label ([string]$mark.label) $x ([single]($y - $fontPixels - 8)) $color $fontPixels }
          }
          'highlight' {
            $x = [single]($mark.x / 100.0 * $width)
            $y = [single]($mark.y / 100.0 * $height)
            $w = [single]($mark.width / 100.0 * $width)
            $h = [single]($mark.height / 100.0 * $height)
            if ($w -lt 0) { $x += $w; $w = -$w }
            if ($h -lt 0) { $y += $h; $h = -$h }
            $fill = New-Object System.Drawing.SolidBrush((ConvertTo-Color ([string]$mark.color) 70))
            try { $graphics.FillRectangle($fill, $x, $y, $w, $h) } finally { $fill.Dispose() }
            $graphics.DrawRectangle($pen, $x, $y, $w, $h)
            if ($null -ne $mark.label) { Draw-Label ([string]$mark.label) $x ([single]($y - $fontPixels - 8)) $color $fontPixels }
          }
          'line' {
            $x1 = [single]($mark.x1 / 100.0 * $width)
            $y1 = [single]($mark.y1 / 100.0 * $height)
            $x2 = [single]($mark.x2 / 100.0 * $width)
            $y2 = [single]($mark.y2 / 100.0 * $height)
            $graphics.DrawLine($pen, $x1, $y1, $x2, $y2)
          }
          'arrow' {
            $x1 = [single]($mark.x1 / 100.0 * $width)
            $y1 = [single]($mark.y1 / 100.0 * $height)
            $x2 = [single]($mark.x2 / 100.0 * $width)
            $y2 = [single]($mark.y2 / 100.0 * $height)
            $graphics.DrawLine($pen, $x1, $y1, $x2, $y2)
            Draw-ArrowHead $x1 $y1 $x2 $y2 $color $stroke
            if ($null -ne $mark.label) { Draw-Label ([string]$mark.label) ([single](($x1 + $x2) / 2)) ([single](($y1 + $y2) / 2 - $fontPixels - 6)) $color $fontPixels }
          }
          'text' {
            $x = [single]($mark.x / 100.0 * $width)
            $y = [single]($mark.y / 100.0 * $height)
            $text = [string]$mark.text
            if ([string]::IsNullOrWhiteSpace($text)) { $text = [string]$mark.label }
            Draw-Label $text $x $y (ConvertTo-Color ([string]$mark.color) 255) $fontPixels
          }
          'marker' {
            $x = [single]($mark.x / 100.0 * $width)
            $y = [single]($mark.y / 100.0 * $height)
            $radius = [single]([Math]::Max(9, $fontPixels * 0.95))
            $circle = New-Object System.Drawing.SolidBrush($color)
            try { $graphics.FillEllipse($circle, $x - $radius, $y - $radius, 2 * $radius, 2 * $radius) } finally { $circle.Dispose() }
            $label = if ($null -ne $mark.label) { [string]$mark.label } else { '' }
            if ($label -ne '') {
              $font = Get-Font ([int]($radius * 1.15))
              try {
                $format = [System.Drawing.StringFormat]::GenericTypographic
                $format.Alignment = [System.Drawing.StringAlignment]::Center
                $format.LineAlignment = [System.Drawing.StringAlignment]::Center
                $white = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::White)
                try { $graphics.DrawString($label, $font, $white, (New-Object System.Drawing.PointF($x, $y)), $format) } finally { $white.Dispose() }
              } finally { $font.Dispose() }
            }
          }
        }
      } finally {
        $pen.Dispose()
      }
    }
  } finally {
    $graphics.Dispose()
  }
  $bitmap.Save($OutFile, [System.Drawing.Imaging.ImageFormat]::Png)
  $bitmap.Dispose()
} finally {
  $source.Dispose()
}
Write-Output 'annotated'
`;

/** Lists visible top-level window handles owned by PixPin, used to confirm a pin appeared. */
const WINDOW_LIST_SCRIPT = String.raw`Add-Type @"
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public class DshPixPinWindows {
  public delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  public static string ListVisible(uint targetPid) {
    var handles = new List<string>();
    EnumWindows((h, l) => {
      uint winPid;
      GetWindowThreadProcessId(h, out winPid);
      if (winPid == targetPid && IsWindowVisible(h)) handles.Add(h.ToString());
      return true;
    }, IntPtr.Zero);
    return string.Join(",", handles);
  }
}
"@
$procs = Get-Process -Name PixPin -ErrorAction SilentlyContinue
if ($null -eq $procs) { Write-Output ''; exit 0 }
Write-Output ([string][DshPixPinWindows]::ListVisible([uint32]$procs[0].Id))
`;

/** Detect the installed PixPin executable. `PIXPIN_PATH` wins. */
function detectPixpinPath() {
  const overridden = typeof process.env.PIXPIN_PATH === 'string' ? process.env.PIXPIN_PATH.trim() : '';
  if (overridden.length > 0) return overridden;
  const candidates = [];
  if (typeof process.env.LOCALAPPDATA === 'string') {
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'PixPin', 'PixPin.exe'));
  }
  for (const key of ['ProgramFiles', 'ProgramFiles(x86)', 'ProgramW6432']) {
    const base = process.env[key];
    if (typeof base === 'string') candidates.push(join(base, 'PixPin', 'PixPin.exe'));
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Default Windows PowerShell host; `pwsh` is not required for the helpers. */
function defaultPowershellPath() {
  const root = process.env.SystemRoot ?? 'C:\\Windows';
  return join(root, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
}

/** Resolve the effective plugin settings. */
function resolveSettings(config) {
  const value = config !== null && typeof config === 'object' ? config : {};
  const number = (name, fallback) => {
    const candidate = value[name];
    return Number.isFinite(candidate) && candidate > 0 ? Math.floor(candidate) : fallback;
  };
  return {
    pixpinPath: typeof value.pixpinPath === 'string' ? value.pixpinPath.trim() : '',
    powershellPath: typeof value.powershellPath === 'string' ? value.powershellPath.trim() : '',
    captureTimeoutMs: number('captureTimeoutMs', DEFAULT_CAPTURE_TIMEOUT_MS),
    regionTimeoutMs: number('regionTimeoutMs', DEFAULT_REGION_TIMEOUT_MS),
    autohotkeyPath: typeof value.autohotkeyPath === 'string' ? value.autohotkeyPath.trim() : '',
  };
}

/** Escape a Windows path for a PixPin script string literal. */
function scriptPath(filePath) {
  return JSON.stringify(filePath.replaceAll('\\', '/'));
}

/** Build the PixPin script that captures straight into a file. */
function buildDirectCaptureScript(target, outPath) {
  const rect = TARGETS[target];
  return `pixpin.directScreenShotAndSaveTo(pixpin.getSpRect(${rect}), ${scriptPath(outPath)});\n`;
}

/** Build the PixPin script that pins the given files on the desktop. */
function buildPinScript(files) {
  return `pixpin.pinFromFiles([${files.map((file) => scriptPath(file)).join(', ')}]);\n`;
}

/** Build the PixPin script for an interactive region capture copied to the clipboard. */
function buildRegionCaptureScript() {
  return 'pixpin.screenShot(ShotAction.Copy);\n';
}

/** Reject a pending promise when the tool call is cancelled. */
function onAbort(signal) {
  if (signal === undefined || typeof signal.addEventListener !== 'function') {
    return { promise: new Promise(() => {}), dispose: () => {} };
  }
  let dispose = () => {};
  const promise = new Promise((_, reject) => {
    if (signal.aborted) {
      reject(new Error('the screen capture was cancelled'));
      return;
    }
    const listener = () => reject(new Error('the screen capture was cancelled'));
    signal.addEventListener('abort', listener, { once: true });
    dispose = () => signal.removeEventListener('abort', listener);
  });
  return { promise, dispose };
}

/** Race a promise against a timeout that is cleared when the promise settles. */
function withTimeout(promise, timeoutMs, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise.finally(() => clearTimeout(timer)), timeout]);
}

/** Sleep helper. */
function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** True when the buffer ends with a complete PNG IEND chunk. */
function isCompletePng(buffer) {
  if (buffer.length < 24) return false;
  const signature = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let index = 0; index < signature.length; index += 1) {
    if (buffer[index] !== signature[index]) return false;
  }
  const tail = buffer.subarray(buffer.length - 8);
  return tail[0] === 73 && tail[1] === 69 && tail[2] === 78 && tail[3] === 68; // IEND
}

/** Wait until PixPin finished writing a complete PNG. */
async function waitForCompletePng(filePath, timeoutMs, signal) {
  const abort = onAbort(signal);
  const deadline = Date.now() + timeoutMs;
  try {
    while (Date.now() < deadline) {
      await Promise.race([delay(POLL_INTERVAL_MS), abort.promise]);
      try {
        const buffer = readFileSync(filePath);
        if (isCompletePng(buffer)) return buffer;
      } catch {
        // Not written yet.
      }
    }
    throw new Error('PixPin did not finish saving the screenshot in time');
  } finally {
    abort.dispose();
  }
}

/** Run a standalone PowerShell script file and collect its output. */
function runPowerShellFile(powershellPath, scriptPathArg, params, timeoutMs, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(powershellPath, ['-NoProfile', '-STA', '-ExecutionPolicy', 'Bypass', '-File', scriptPathArg, ...params], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      if (error) reject(error);
      else resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(new Error(`could not run Windows PowerShell: ${error.message}`)));
    child.on('close', (code) => {
      if (code === 0) finish(null, stdout);
      else finish(new Error(`a Windows PowerShell helper failed with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`));
    });
    if (signal !== undefined && typeof signal.addEventListener === 'function') {
      const listener = () => finish(new Error('the screen capture was cancelled'));
      signal.addEventListener('abort', listener, { once: true });
      child.on('close', () => signal.removeEventListener('abort', listener));
    }
    const timer = setTimeout(() => finish(new Error('a Windows PowerShell helper did not finish in time')), timeoutMs);
    timer.unref?.();
    child.on('close', () => clearTimeout(timer));
  });
}

/** Run one capture end to end and return the PNG bytes. */
async function runClipboardCapture(options) {
  const child = spawn(
    options.powershellPath,
    [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      options.helperPath,
      '-OutFile',
      options.pngPath,
      '-TimeoutMs',
      String(options.timeoutMs),
      '-IntervalMs',
      String(POLL_INTERVAL_MS),
    ],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let stdout = '';
  let stderr = '';
  let ready = false;
  let resolveReady;
  const readyPromise = new Promise((resolve) => {
    resolveReady = resolve;
  });

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    stdout += chunk;
    if (!ready && stdout.includes('ready')) {
      ready = true;
      resolveReady();
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    stderr += chunk;
  });

  const closed = new Promise((resolve) => {
    child.on('close', (code) => resolve({ code }));
    child.on('error', (error) => resolve({ error }));
  });

  const abort = onAbort(options.signal);
  let pixpinError = null;
  try {
    await withTimeout(
      Promise.race([
        readyPromise,
        abort.promise,
        closed.then(() => Promise.reject(new Error('the clipboard helper exited before it was ready'))),
      ]),
      HELPER_READY_TIMEOUT_MS,
      'the clipboard helper did not start in time',
    );

    const pixpin = spawn(options.pixpinPath, ['-f', options.scriptPath], { stdio: 'ignore', windowsHide: true });
    pixpin.on('error', (error) => {
      pixpinError = error;
    });
    pixpin.unref();

    const outcome = await withTimeout(
      Promise.race([closed, abort.promise]),
      options.timeoutMs + HELPER_GRACE_MS,
      'the screen capture did not finish in time',
    );
    if (pixpinError !== null) throw new Error(`could not start PixPin: ${pixpinError.message}`);
    if (outcome.error !== undefined) throw new Error(`could not run the clipboard helper: ${outcome.error.message}`);
    if (outcome.code === 0) return readFileSync(options.pngPath);
    if (outcome.code === 3) {
      throw new Error(
        'PixPin did not copy a screenshot to the clipboard in time; the capture was cancelled or PixPin did not respond. ' +
          'Check that PixPin is installed, that its script permission works, and try again.',
      );
    }
    throw new Error(`the clipboard helper exited with code ${String(outcome.code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`);
  } finally {
    abort.dispose();
    try {
      child.kill();
    } catch {
      // Already exited.
    }
  }
}

/** Validate and normalize the model's annotation list. */
function normalizeAnnotations(rawAnnotations) {
  if (!Array.isArray(rawAnnotations)) return [];
  const allowed = new Set(['rect', 'ellipse', 'highlight', 'arrow', 'line', 'text', 'marker']);
  const marks = [];
  for (const entry of rawAnnotations.slice(0, MAX_ANNOTATIONS)) {
    if (entry === null || typeof entry !== 'object') continue;
    const kind = typeof entry.kind === 'string' && allowed.has(entry.kind) ? entry.kind : 'rect';
    const number = (name) => {
      const value = Number(entry[name]);
      return Number.isFinite(value) ? value : undefined;
    };
    const mark = { kind };
    for (const key of ['x', 'y', 'width', 'height', 'x1', 'y1', 'x2', 'y2']) {
      const value = number(key);
      if (value !== undefined) mark[key] = value;
    }
    if (typeof entry.label === 'string' && entry.label.trim() !== '') mark.label = entry.label.slice(0, 120);
    if (typeof entry.text === 'string' && entry.text.trim() !== '') mark.text = entry.text.slice(0, 200);
    if (typeof entry.color === 'string' && entry.color.trim() !== '') mark.color = entry.color.trim();
    const stroke = number('stroke_width');
    if (stroke !== undefined && stroke > 0) mark.stroke_width = Math.min(24, Math.round(stroke));
    const fontSize = number('font_size');
    if (fontSize !== undefined && fontSize > 0) mark.font_size = Math.min(160, Math.round(fontSize));
    marks.push(mark);
  }
  return marks;
}

/** Draw the marks onto the captured PNG and return the annotated bytes. */
async function annotatePng(options) {
  const marksPath = join(options.workDir, 'marks.json');
  const annotatedPath = join(options.workDir, 'annotated.png');
  writeFileSync(marksPath, JSON.stringify(options.annotations), 'utf8');
  const args = ['-InFile', options.pngPath, '-OutFile', annotatedPath, '-MarksFile', marksPath];
  if (options.grid === true) args.push('-Grid');
  await runPowerShellFile(options.powershellPath, options.annotateScriptPath, args, Math.min(60_000, Math.max(15_000, options.timeoutMs)), options.signal);
  return annotatedPath;
}

/** List PixPin's visible window handles; used to confirm that a pin appeared. */
async function pixpinVisibleWindows(options) {
  try {
    const output = await runPowerShellFile(options.powershellPath, options.windowListScriptPath, [], 15_000, options.signal);
    const line = output.trim().split(/\r?\n/u).pop() ?? '';
    return line === '' ? [] : line.split(',').map((handle) => handle.trim()).filter((handle) => handle !== '');
  } catch {
    return null;
  }
}

/** Remove pinned-image copies older than the retention window. */
function prunePinnedImages() {
  try {
    const now = Date.now();
    for (const name of readdirSync(PIN_DIRECTORY)) {
      const file = join(PIN_DIRECTORY, name);
      try {
        if (now - statSync(file).mtimeMs > PIN_RETENTION_MS) unlinkSync(file);
      } catch {
        // Best effort.
      }
    }
  } catch {
    // The directory does not exist yet.
  }
}

/** Maximum number of orchestrated input steps in one desktop_action call. */
const AHK_MAX_STEPS = 50;
/** AHK key names that map to a braced send token. */
const AHK_KEY_NAMES = {
  enter: '{Enter}',
  return: '{Enter}',
  tab: '{Tab}',
  esc: '{Esc}',
  escape: '{Esc}',
  space: '{Space}',
  backspace: '{Backspace}',
  delete: '{Delete}',
  del: '{Delete}',
  insert: '{Insert}',
  home: '{Home}',
  end: '{End}',
  pageup: '{PgUp}',
  pagedown: '{PgDn}',
  up: '{Up}',
  down: '{Down}',
  left: '{Left}',
  right: '{Right}',
  capslock: '{CapsLock}',
  printscreen: '{PrintScreen}',
  pause: '{Pause}',
  apps: '{AppsKey}',
};

/** Detect the installed AutoHotkey v2 executable. `AUTOHOTKEY_PATH` wins. */
function detectAutoHotkeyPath() {
  const overridden = typeof process.env.AUTOHOTKEY_PATH === 'string' ? process.env.AUTOHOTKEY_PATH.trim() : '';
  if (overridden.length > 0) return overridden;
  const candidates = [];
  if (typeof process.env.LOCALAPPDATA === 'string') {
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey64.exe'));
    candidates.push(join(process.env.LOCALAPPDATA, 'Programs', 'AutoHotkey', 'v2', 'AutoHotkey32.exe'));
  }
  for (const key of ['ProgramFiles', 'ProgramW6432']) {
    const base = process.env[key];
    if (typeof base === 'string') {
      candidates.push(join(base, 'AutoHotkey', 'v2', 'AutoHotkey64.exe'));
      candidates.push(join(base, 'AutoHotkey', 'v2', 'AutoHotkey32.exe'));
    }
  }
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}

/** Escape one value for an AutoHotkey v2 double-quoted string literal. */
function ahkQuote(value) {
  return `"${String(value).replaceAll('`', '``').replaceAll('"', '`"')}"`;
}

/**
 * Translate a friendly shortcut (`ctrl+shift+s`, `enter`, `alt+f4`) or a raw
 * AutoHotkey send string into AutoHotkey syntax.
 */
function normalizeKeys(input) {
  const text = String(input ?? '').trim();
  if (text === '') throw new Error('key step needs a non-empty "keys" value');
  if (/^[\^!+#{]/u.test(text)) return text;
  const parts = text
    .toLowerCase()
    .split('+')
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  const base = parts.pop();
  let prefix = '';
  for (const part of parts) {
    if (part === 'ctrl' || part === 'control') prefix += '^';
    else if (part === 'shift') prefix += '+';
    else if (part === 'alt') prefix += '!';
    else if (part === 'win' || part === 'windows') prefix += '#';
    else throw new Error(`unsupported modifier "${part}" in key "${text}"`);
  }
  if (base.length === 1) return prefix + base;
  if (/^f([1-9]|1[0-9]|2[0-4])$/u.test(base)) return `${prefix}{${base.toUpperCase()}}`;
  const named = AHK_KEY_NAMES[base];
  if (named !== undefined) return prefix + named;
  throw new Error(`unsupported key "${base}" in "${text}"`);
}

/** Parse and validate the model's action steps. */
function normalizeActionSteps(rawSteps) {
  if (!Array.isArray(rawSteps) || rawSteps.length === 0) throw new Error('steps must be a non-empty array of actions');
  if (rawSteps.length > AHK_MAX_STEPS) throw new Error(`steps must contain at most ${AHK_MAX_STEPS} actions`);
  const percent = (entry, name, stepIndex) => {
    const value = Number(entry[name]);
    if (!Number.isFinite(value)) throw new Error(`step ${stepIndex + 1}: "${name}" must be a number`);
    return Math.max(0, Math.min(100, value));
  };
  const steps = [];
  for (const [index, entry] of rawSteps.entries()) {
    if (entry === null || typeof entry !== 'object') throw new Error(`step ${index + 1} must be an object`);
    const action = typeof entry.action === 'string' ? entry.action : '';
    switch (action) {
      case 'click': {
        const button = entry.button === 'right' || entry.button === 'middle' ? entry.button : 'left';
        const count = entry.count === 2 ? 2 : 1;
        steps.push({ action, x: percent(entry, 'x', index), y: percent(entry, 'y', index), button, count });
        break;
      }
      case 'move':
        steps.push({ action, x: percent(entry, 'x', index), y: percent(entry, 'y', index) });
        break;
      case 'drag': {
        const duration = Number(entry.duration_ms);
        steps.push({
          action,
          x1: percent(entry, 'x1', index),
          y1: percent(entry, 'y1', index),
          x2: percent(entry, 'x2', index),
          y2: percent(entry, 'y2', index),
          durationMs: Number.isFinite(duration) ? Math.max(50, Math.min(5000, Math.round(duration))) : 400,
        });
        break;
      }
      case 'type': {
        if (typeof entry.text !== 'string' || entry.text.length === 0) throw new Error(`step ${index + 1}: type needs non-empty "text"`);
        steps.push({ action, text: entry.text.slice(0, 4000), enter: entry.enter === true });
        break;
      }
      case 'key':
        steps.push({ action, keys: normalizeKeys(entry.keys) });
        break;
      case 'wheel': {
        const delta = Number(entry.delta);
        steps.push({
          action,
          delta: Number.isFinite(delta) ? Math.max(-20, Math.min(20, Math.round(delta))) : 3,
          ...(entry.x === undefined && entry.y === undefined ? {} : { x: percent(entry, 'x', index), y: percent(entry, 'y', index) }),
        });
        break;
      }
      case 'activate': {
        if (typeof entry.title !== 'string' || entry.title.trim() === '') throw new Error(`step ${index + 1}: activate needs a window "title"`);
        steps.push({ action, title: entry.title.trim().slice(0, 300) });
        break;
      }
      case 'wait': {
        const ms = Number(entry.ms);
        steps.push({ action, ms: Number.isFinite(ms) ? Math.max(0, Math.min(30000, Math.round(ms))) : 300 });
        break;
      }
      default:
        throw new Error(
          `step ${index + 1}: unsupported action "${action}" (use click, move, drag, type, key, wheel, activate, wait)`,
        );
    }
  }
  return steps;
}

/** AHK statements for one normalized step. */
function ahkStepCode(step) {
  const x = (value) => `PctX(${value})`;
  const y = (value) => `PctY(${value})`;
  switch (step.action) {
    case 'click': {
      const lines = [`MouseMove(${x(step.x)}, ${y(step.y)}, 0)`];
      const click = step.button === 'right' ? 'Click("Right")' : step.button === 'middle' ? 'Click("Middle")' : 'Click()';
      lines.push(click);
      if (step.count === 2) lines.push('Sleep(80)', click);
      lines.push('Sleep(150)');
      return lines;
    }
    case 'move':
      return [`MouseMove(${x(step.x)}, ${y(step.y)}, 0)`];
    case 'drag': {
      const frames = 16;
      return [
        `MouseMove(${x(step.x1)}, ${y(step.y1)}, 0)`,
        'Click("Down")',
        `dx := ${x(step.x2)} - ${x(step.x1)}`,
        `dy := ${y(step.y2)} - ${y(step.y1)}`,
        `stepPause := Max(1, Round(${step.durationMs} / ${frames}))`,
        `Loop ${frames} {`,
        '    ratio := A_Index / ' + frames,
        '    MouseMove(' + x(step.x1) + ' + dx * ratio, ' + y(step.y1) + ' + dy * ratio, 0)',
        '    Sleep(stepPause)',
        '}',
        'Click("Up")',
        'Sleep(150)',
      ];
    }
    case 'type': {
      const lines = [];
      const chunks = step.text.split(/\r?\n/u);
      for (const [index, chunk] of chunks.entries()) {
        if (chunk.length > 0) lines.push(`SendText(${ahkQuote(chunk)})`);
        if (index < chunks.length - 1) lines.push('Send("{Enter}")');
      }
      if (step.enter) lines.push('Send("{Enter}")');
      lines.push('Sleep(120)');
      return lines;
    }
    case 'key':
      return [`Send(${ahkQuote(step.keys)})`, 'Sleep(150)'];
    case 'wheel': {
      const lines = [];
      if (step.x !== undefined && step.y !== undefined) lines.push(`MouseMove(${x(step.x)}, ${y(step.y)}, 0)`);
      const direction = step.delta >= 0 ? 'WheelUp' : 'WheelDown';
      lines.push(`Send("{${direction} ${Math.abs(step.delta)}}")`, 'Sleep(150)');
      return lines;
    }
    case 'activate':
      return [
        `if !WinExist(${ahkQuote(step.title)})`,
        `    throw Error("window not found: " . ${ahkQuote(step.title)})`,
        `WinActivate(${ahkQuote(step.title)})`,
        'Sleep(250)',
      ];
    case 'wait':
      return [`Sleep(${step.ms})`];
    default:
      throw new Error(`unsupported action "${step.action}"`);
  }
}

/** Total wall-clock budget for one orchestrated script. */
function ahkTimeoutMs(steps) {
  let ms = 10_000;
  for (const step of steps) if (step.action === 'wait') ms += step.ms;
  return ms + steps.length * 600;
}

/** Build the complete AutoHotkey v2 script for a normalized action list. */
function buildAhkScript(steps, logPath) {
  const lines = [
    '#Requires AutoHotkey v2.0',
    '#NoTrayIcon',
    '#SingleInstance Off',
    'CoordMode "Mouse", "Screen"',
    'SetTitleMatchMode 2',
    `logFile := FileOpen(${ahkQuote(logPath)}, "w", "UTF-8")`,
    'vx := SysGet(76)',
    'vy := SysGet(77)',
    'vw := SysGet(78)',
    'vh := SysGet(79)',
    'PctX(p) => vx + vw * p / 100',
    'PctY(p) => vy + vh * p / 100',
    'exitCode := 0',
    'try {',
  ];
  for (const [index, step] of steps.entries()) {
    lines.push(`    ; step ${index + 1}: ${step.action}`);
    for (const code of ahkStepCode(step)) lines.push(`    ${code}`);
    lines.push(`    logFile.WriteLine("step ${index + 1} ${step.action} ok")`);
  }
  lines.push('    logFile.WriteLine("OK")', '} catch Error as err {', '    exitCode := 1', '    logFile.WriteLine("ERROR " err.Message " | line " err.Line)', '}');
  lines.push('logFile.Close()', 'ExitApp(exitCode)');
  return `${lines.join('\n')}\n`;
}

/**
 * Run one generated AutoHotkey script and collect its log.
 * @returns {Promise<{ok: boolean, executed: number, error: string | null, log: string}>}
 */
function runAhkScript(options) {
  return new Promise((resolve) => {
    const args = ['/ErrorStdOut', options.scriptPath];
    const child = spawn(options.autohotkeyPath, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        child.kill();
      } catch {
        // Already exited.
      }
      resolve(value);
    };
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      stdout += chunk;
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) =>
      finish({ ok: false, executed: 0, error: `could not start AutoHotkey: ${error.message}`, log: '' }),
    );
    child.on('close', (code) => {
      let log = '';
      try {
        log = readFileSync(options.logPath, 'utf8').replace(/^\uFEFF/u, '');
      } catch {
        // The script may not have reached its log yet.
      }
      const executed = log.split(/\r?\n/u).filter((line) => /^step \d+ /u.test(line)).length;
      const errorLine = log.split(/\r?\n/u).find((line) => line.startsWith('ERROR '));
      const error =
        errorLine !== undefined
          ? errorLine.slice(6)
          : code === 0
            ? null
            : `AutoHotkey exited with code ${String(code)}${stderr.trim() === '' ? '' : `: ${stderr.trim()}`}`;
      finish({ ok: code === 0 && error === null, executed, error, log: log.trim() });
    });
    const timer = setTimeout(
      () => finish({ ok: false, executed: 0, error: 'the AutoHotkey script did not finish in time', log: '' }),
      options.timeoutMs,
    );
    if (options.signal !== undefined && typeof options.signal.addEventListener === 'function') {
      const listener = () => finish({ ok: false, executed: 0, error: 'the desktop actions were cancelled', log: '' });
      options.signal.addEventListener('abort', listener, { once: true });
      child.on('close', () => options.signal.removeEventListener('abort', listener));
    }
  });
}

/** Execute one orchestrated action batch, optionally capturing the result. */
async function runDesktopActions(request) {
  const { steps, captureAfter, pin = false, settings, signal } = request;
  const autohotkeyPath = settings.autohotkeyPath !== '' ? settings.autohotkeyPath : detectAutoHotkeyPath();
  if (autohotkeyPath === null) {
    throw new Error(
      'AutoHotkey v2 was not found. Install AutoHotkey v2, or set AUTOHOTKEY_PATH to AutoHotkey64.exe (for example ' +
        '%LOCALAPPDATA%\\Programs\\AutoHotkey\\v2\\AutoHotkey64.exe).',
    );
  }
  if (!existsSync(autohotkeyPath)) {
    throw new Error(`AutoHotkey was not found at "${autohotkeyPath}". Correct autohotkeyPath or set AUTOHOTKEY_PATH.`);
  }
  const workDir = mkdtempSync(join(tmpdir(), 'dsh-pixpin-action-'));
  const scriptPath = join(workDir, 'actions.ahk');
  const logPath = join(workDir, 'actions.log');
  try {
    const script = buildAhkScript(steps, logPath);
    writeFileSync(scriptPath, `\uFEFF${script}`, 'utf8');
    const result = await runAhkScript({ autohotkeyPath, scriptPath, logPath, timeoutMs: ahkTimeoutMs(steps), signal });
    let image = null;
    let captureError = null;
    let pinned = false;
    let pinWarning = null;
    if (captureAfter) {
      try {
        const capture = await captureWithPixPin({ target: 'all-screens', annotations: [], pin: pin === true, settings, signal });
        pinned = capture.pinned;
        pinWarning = capture.pinWarning;
        const attachments = request.attachments;
        const ref = await attachments.saveImage({
          data: new Uint8Array(capture.png),
          mediaType: 'image/png',
          name: 'pixpin-desktop-action.png',
        });
        image = {
          attachmentId: ref.attachmentId,
          mediaType: ref.mediaType,
          bytes: ref.bytes,
          width: ref.width,
          height: ref.height,
          ...(ref.name === undefined ? {} : { name: ref.name }),
          ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
        };
      } catch (error) {
        captureError = error instanceof Error ? error.message : String(error);
      }
    }
    return { ...result, image, captureError, pinned, pinWarning };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Build a screenshot plan: numbered marks for every position-based step. */
function planAnnotationsForSteps(steps) {
  const marks = [];
  const plan = [];
  for (const [index, step] of steps.entries()) {
    const number = index + 1;
    if (step.action === 'click' || step.action === 'move' || step.action === 'wheel') {
      if (typeof step.x !== 'number' || typeof step.y !== 'number') continue;
      const color = step.action === 'click' ? 'red' : step.action === 'wheel' ? 'orange' : 'blue';
      marks.push({ kind: 'marker', x: step.x, y: step.y, label: String(number), color, font_size: 20 });
      plan.push({ index: number, action: step.action, x: step.x, y: step.y });
    } else if (step.action === 'drag') {
      marks.push({ kind: 'arrow', x1: step.x1, y1: step.y1, x2: step.x2, y2: step.y2, color: 'purple', label: String(number) });
      plan.push({ index: number, action: 'drag', fromX: step.x1, fromY: step.y1, toX: step.x2, toY: step.y2 });
    }
  }
  return { marks, plan };
}

/** Build a non-destructive plan preview: screenshot with numbered target positions. */
async function buildActionPreview(request) {
  const { steps, pin, settings, signal } = request;
  const { marks, plan } = planAnnotationsForSteps(steps);
  const capture = await captureWithPixPin({ target: 'all-screens', annotations: marks, pin: pin === true, grid: true, settings, signal });
  const attachments = request.attachments;
  const ref = await attachments.saveImage({
    data: new Uint8Array(capture.png),
    mediaType: 'image/png',
    name: 'pixpin-desktop-plan.png',
  });
  return {
    plan,
    image: {
      attachmentId: ref.attachmentId,
      mediaType: ref.mediaType,
      bytes: ref.bytes,
      width: ref.width,
      height: ref.height,
      ...(ref.name === undefined ? {} : { name: ref.name }),
      ...(ref.originalDimensions === undefined ? {} : { originalDimensions: { ...ref.originalDimensions } }),
    },
    pinned: capture.pinned,
    pinWarning: capture.pinWarning,
  };
}

/** Render the desktop_action result. */
function actionResultContent(value) {
  if (value.dryRun === true) {
    return [
      {
        type: 'text',
        text: `Dry run: the generated AutoHotkey v2 script for ${value.stepCount} step(s). Nothing was executed.\n\n\`\`\`autohotkey\n${value.script}\`\`\``,
      },
    ];
  }
  if (value.preview === true) {
    const lines = [
      `Plan preview: ${value.stepCount} step(s), nothing was executed.`,
      'The screenshot has a 10% coordinate grid and numbered markers at every position-based step.',
    ];
    for (const step of Array.isArray(value.plan) ? value.plan : []) {
      if (step.action === 'drag') lines.push(`#${step.index} drag ${step.fromX}%,${step.fromY}% -> ${step.toX}%,${step.toY}%`);
      else lines.push(`#${step.index} ${step.action} ${step.x}%,${step.y}%`);
    }
    if (value.pinned === true) lines.push('The plan preview was pinned on the desktop.');
    if (typeof value.pinWarning === 'string' && value.pinWarning !== '') lines.push(`Pin note: ${value.pinWarning}`);
    const blocks = [{ type: 'text', text: lines.join('\n') }];
    if (value.image !== null && value.image !== undefined) {
      const image = value.image;
      blocks.push({
        type: 'text',
        text: `<type>image</type>\n<content>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes\n</content>`,
      });
      blocks.push({ type: 'image', attachment: toAttachmentRef(image) });
    }
    return blocks;
  }
  const lines = [`Executed ${value.executed} of ${value.stepCount} action(s).`];
  if (value.ok === false && typeof value.error === 'string') lines.push(`Error: ${value.error}`);
  if (typeof value.captureError === 'string') lines.push(`Screenshot after the actions failed: ${value.captureError}`);
  if (value.image !== null && value.image !== undefined) lines.push('A fresh screenshot after the actions is attached.');
  if (value.pinned === true) lines.push('The result screenshot was pinned on the desktop.');
  if (typeof value.pinWarning === 'string' && value.pinWarning !== '') lines.push(`Pin note: ${value.pinWarning}`);
  const blocks = [{ type: 'text', text: lines.join('\n') }];
  if (typeof value.log === 'string' && value.log !== '') blocks[0].text += `\n\nLog:\n${value.log}`;
  if (value.image !== null && value.image !== undefined) {
    const image = value.image;
    blocks.push({
      type: 'text',
      text: `<type>image</type>\n<content>\n${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes\n</content>`,
    });
    blocks.push({ type: 'image', attachment: toAttachmentRef(image) });
  }
  return blocks;
}

/** Pin one PNG on the desktop with PixPin and report whether a pin window appeared. */
async function pinImageFile(options) {
  const { powershellPath, pixpinPath, imagePath, signal } = options;
  let workDir = null;
  try {
    workDir = mkdtempSync(join(tmpdir(), 'dsh-pixpin-pin-'));
    mkdirSync(PIN_DIRECTORY, { recursive: true });
    prunePinnedImages();
    const stamp = new Date().toISOString().replace(/[:.]/gu, '-');
    const pinPath = join(PIN_DIRECTORY, `pixpin-${stamp}-${Math.random().toString(36).slice(2, 8)}.png`);
    copyFileSync(imagePath, pinPath);
    const windowListScriptPath = join(workDir, 'window-list.ps1');
    writeFileSync(windowListScriptPath, WINDOW_LIST_SCRIPT, 'utf8');
    const before = (await pixpinVisibleWindows({ powershellPath, windowListScriptPath, signal })) ?? [];
    const pinScriptPath = join(workDir, 'pin.js');
    writeFileSync(pinScriptPath, buildPinScript([pinPath]), 'utf8');
    const pinner = spawn(pixpinPath, ['-f', pinScriptPath], { stdio: 'ignore', windowsHide: true });
    pinner.on('error', () => {});
    pinner.unref();
    let pinned = false;
    for (let attempt = 0; attempt < 20 && !pinned; attempt += 1) {
      await delay(150);
      const after = await pixpinVisibleWindows({ powershellPath, windowListScriptPath, signal });
      // PixPin may hide the previously pinned window while showing the new one,
      // so compare handle sets instead of counting visible windows.
      pinned = after !== null && after.some((handle) => !before.includes(handle));
    }
    if (pinned) return { pinned: true, pinWarning: null };
    return { pinned: false, pinWarning: 'PixPin did not report a new pin window, so the image may not be pinned on the desktop.' };
  } catch (error) {
    return { pinned: false, pinWarning: `pinning failed: ${error instanceof Error ? error.message : String(error)}` };
  } finally {
    if (workDir !== null) rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Capture the screen through PixPin, optionally annotate it (or overlay a
 * coordinate grid), and optionally pin the final image on the user's desktop.
 * @returns {Promise<{png: Buffer, annotated: boolean, grid: boolean, pinned: boolean, pinWarning: string | null}>}
 */
async function captureWithPixPin(request) {
  const { target, annotations, pin, grid = false, settings, signal } = request;
  const pixpinPath = settings.pixpinPath !== '' ? settings.pixpinPath : detectPixpinPath();
  if (pixpinPath === null) {
    throw new Error(
      'PixPin was not found. Install PixPin, or set PIXPIN_PATH to the PixPin executable (for example ' +
        'C:\\Users\\<you>\\AppData\\Local\\Programs\\PixPin\\PixPin.exe).',
    );
  }
  if (!existsSync(pixpinPath)) {
    throw new Error(`PixPin was not found at "${pixpinPath}". Correct pixpinPath or set PIXPIN_PATH.`);
  }
  const powershellPath = settings.powershellPath !== '' ? settings.powershellPath : defaultPowershellPath();
  if (!existsSync(powershellPath)) {
    throw new Error(`Windows PowerShell was not found at "${powershellPath}". Set powershellPath to a working powershell.exe.`);
  }

  const workDir = mkdtempSync(join(tmpdir(), 'dsh-pixpin-'));
  const capturePath = join(workDir, 'capture.png');
  const timeoutMs = target === 'region' ? settings.regionTimeoutMs : settings.captureTimeoutMs;
  try {
    if (target === 'region') {
      const helperPath = join(workDir, 'wait-clipboard.ps1');
      const scriptPath = join(workDir, 'capture.js');
      writeFileSync(helperPath, CLIPBOARD_HELPER_SCRIPT, 'utf8');
      writeFileSync(scriptPath, buildRegionCaptureScript(), 'utf8');
      const png = await runClipboardCapture({
        pixpinPath,
        powershellPath,
        helperPath,
        scriptPath,
        pngPath: capturePath,
        timeoutMs,
        signal,
      });
      writeFileSync(capturePath, png);
    } else {
      const scriptPath = join(workDir, 'capture.js');
      writeFileSync(scriptPath, buildDirectCaptureScript(target, capturePath), 'utf8');
      const pixpin = spawn(pixpinPath, ['-f', scriptPath], { stdio: 'ignore', windowsHide: true });
      pixpin.on('error', () => {});
      pixpin.unref();
      await waitForCompletePng(capturePath, timeoutMs, signal);
    }

    let imagePath = capturePath;
    if (annotations.length > 0 || grid) {
      const annotateScriptPath = join(workDir, 'annotate.ps1');
      writeFileSync(annotateScriptPath, ANNOTATE_SCRIPT, 'utf8');
      imagePath = await annotatePng({ powershellPath, annotateScriptPath, pngPath: capturePath, workDir, annotations, grid, timeoutMs, signal });
    }

    const pinResult = pin ? await pinImageFile({ powershellPath, pixpinPath, imagePath, signal }) : { pinned: false, pinWarning: null };
    return {
      png: readFileSync(imagePath),
      annotated: annotations.length > 0,
      grid,
      pinned: pinResult.pinned,
      pinWarning: pinResult.pinWarning,
    };
  } finally {
    rmSync(workDir, { recursive: true, force: true });
  }
}

/** Serialize captures: two concurrent runs would race on the clipboard and pins. */
let captureChain = Promise.resolve();
function serializeCapture(task) {
  const run = captureChain.then(task, task);
  captureChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/** Serialize input batches: real mouse/keyboard actions must not interleave. */
let desktopChain = Promise.resolve();
function serializeDesktop(task) {
  const run = desktopChain.then(task, task);
  desktopChain = run.then(
    () => {},
    () => {},
  );
  return run;
}

/**
 * Refuse the capture when the current model route explicitly declares no image
 * input; an attachment the model cannot inspect would only waste a screenshot.
 */
async function assertImageCapable(ctx, exec) {
  const llm = ctx.get('llm');
  if (llm === undefined || typeof llm.resolveModelInfo !== 'function') return;
  const routed = exec?.agent?.session?.requestHeader?.()?.config;
  const provider = routed?.provider ?? exec?.agent?.options?.provider;
  const model = routed?.model ?? exec?.agent?.options?.model;
  if (typeof provider !== 'string' || typeof model !== 'string') return;
  let info;
  try {
    info = await llm.resolveModelInfo(provider, model, exec.signal);
  } catch {
    return;
  }
  const modalities = info?.inputModalities;
  if (Array.isArray(modalities) && modalities.length > 0 && !modalities.includes('image')) {
    throw new Error(
      `cannot capture the screen: the current model "${model}" does not declare image input. Switch to an image-capable model first.`,
    );
  }
}

/** Project one stored attachment reference into the image content block. */
function toAttachmentRef(image) {
  return {
    attachmentId: image.attachmentId,
    mediaType: image.mediaType,
    bytes: image.bytes,
    width: image.width,
    height: image.height,
    ...(image.name === undefined ? {} : { name: image.name }),
    ...(image.originalDimensions === undefined
      ? {}
      : { originalDimensions: { ...image.originalDimensions } }),
  };
}

/** Render the tool result as a short envelope plus the (possibly marked) screenshot. */
function imageResultContent(value) {
  const image = value.image;
  const scaled =
    image.originalDimensions === undefined
      ? ''
      : ` (downscaled from ${image.originalDimensions.width}x${image.originalDimensions.height} px)`;
  const lines = [
    `<source>${value.source}</source>`,
    '<type>image</type>',
    '<content>',
    `${image.mediaType} image, ${image.width}x${image.height} px, ${image.bytes} bytes${scaled}`,
    '</content>',
  ];
  if (value.annotations > 0) lines.push(`${value.annotations} annotation(s) are drawn on this screenshot.`);
  if (value.grid === true) lines.push('A 10% coordinate grid with percentage labels is drawn on this screenshot.');
  if (value.pinned) lines.push('The marked screenshot was pinned on the user\'s desktop with PixPin.');
  else if (typeof value.pinWarning === 'string' && value.pinWarning !== '') lines.push(`Pin note: ${value.pinWarning}`);
  if (value.source === 'pixpin/region') lines.push('PixPin also left this screenshot on the clipboard.');
  return [
    { type: 'text', text: lines.join('\n') },
    { type: 'image', attachment: toAttachmentRef(image) },
  ];
}

/**
 * Register the screen-capture tool.
 * @param {import('@deepseek-ai/cordis').Context} ctx registrant context.
 * @param {Record<string, unknown>} [config] optional row configuration.
 */
export function apply(ctx, config) {
  const settings = resolveSettings(config);
  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'pixpin_screenshot',
        description:
          'Capture the user\'s screen through PixPin, optionally draw annotations on it, and return the screenshot so you can look at it. ' +
          'Call this whenever you need to see what is currently on screen. ' +
          'Use target "all-screens" (default) to capture every monitor immediately without user interaction, ' +
          '"screen-under-mouse", "active-window" or "last-region" for instant captures of a narrower area, ' +
          'and "region" to open PixPin\'s selection UI and wait for the user to drag an area. ' +
          'To communicate visually with the user, pass annotations (percent coordinates, 0-100 of the image size) to draw ' +
          'rectangles, ellipses, highlights, lines, arrows, numbered markers, and text labels, and set pin=true to leave the ' +
          'marked screenshot floating on the user\'s desktop as a PixPin pin. ' +
          'Set grid=true to overlay a 10% coordinate grid with percentage labels when you plan desktop_action positions.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            target: {
              type: 'string',
              enum: ['all-screens', 'screen-under-mouse', 'active-window', 'last-region', 'region'],
              description: 'What to capture. Defaults to "all-screens".',
            },
            annotations: {
              type: 'array',
              description:
                'Marks to draw on the capture, in order. Coordinates are percentages (0-100) of the image width and height. ' +
                'Each mark: kind plus the fields that kind needs. ' +
                'rect/ellipse/highlight: x, y, width, height, optional label. ' +
                'line/arrow: x1, y1, x2, y2, optional label (label sits at the midpoint for arrows). ' +
                'marker: x, y, optional label (drawn inside the circle). ' +
                'text: x, y, text. All marks accept color (name or #RRGGBB), stroke_width, and font_size.',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['rect', 'ellipse', 'highlight', 'arrow', 'line', 'text', 'marker'],
                    description: 'Mark shape. Defaults to "rect".',
                  },
                  x: { type: 'number', description: 'X position in percent of image width (0-100).' },
                  y: { type: 'number', description: 'Y position in percent of image height (0-100).' },
                  width: { type: 'number', description: 'Width in percent of image width.' },
                  height: { type: 'number', description: 'Height in percent of image height.' },
                  x1: { type: 'number', description: 'Line/arrow start X in percent.' },
                  y1: { type: 'number', description: 'Line/arrow start Y in percent.' },
                  x2: { type: 'number', description: 'Line/arrow end X in percent.' },
                  y2: { type: 'number', description: 'Line/arrow end Y in percent.' },
                  label: { type: 'string', description: 'Short label drawn beside (or inside) the mark.' },
                  text: { type: 'string', description: 'Text for kind "text".' },
                  color: { type: 'string', description: 'Color name (red, orange, yellow, green, blue, purple, pink, cyan, white, black) or #RRGGBB.' },
                  stroke_width: { type: 'integer', description: 'Line width in pixels of the original image.' },
                  font_size: { type: 'integer', description: 'Label/text font size in pixels of the original image.' },
                },
              },
            },
            pin: {
              type: 'boolean',
              description:
                'Pin the screenshot on the user\'s desktop with PixPin so they can see it outside the chat. ' +
                'Defaults to true when annotations are given, false otherwise.',
            },
            grid: {
              type: 'boolean',
              description:
                'Overlay a 10% coordinate grid with percentage labels on the screenshot. Use it to read precise positions ' +
                'before planning desktop_action steps.',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              source: { type: 'string' },
              capturedAt: { type: 'string' },
              annotations: { type: 'integer' },
              grid: { type: 'boolean' },
              pinned: { type: 'boolean' },
              pinWarning: { type: 'string' },
              image: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attachmentId: { type: 'string' },
                  mediaType: { type: 'string' },
                  bytes: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                  name: { type: 'string' },
                  originalDimensions: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
          render: (_args, value) => imageResultContent(value),
        },
        // A region capture waits for the user, so the tool timeout follows the
        // configured region timeout.
        timeoutMs: Math.max(settings.captureTimeoutMs, settings.regionTimeoutMs) + 60_000,
        async execute(args, exec) {
          const requested = typeof args?.target === 'string' ? args.target : DEFAULT_TARGET;
          const target = requested === 'region' || Object.hasOwn(TARGETS, requested) ? requested : DEFAULT_TARGET;
          const annotations = normalizeAnnotations(args?.annotations);
          const grid = args?.grid === true;
          const shouldPin = args?.pin === true || (args?.pin === undefined && annotations.length > 0);
          await assertImageCapable(ctx, exec);
          const result = await serializeCapture(() =>
            captureWithPixPin({ target, annotations, pin: shouldPin, grid, settings, signal: exec?.signal }),
          );
          const attachments = ctx.get('attachments');
          if (attachments === undefined) throw new Error('the attachment store is not mounted; a screenshot cannot be shown to the model');
          const ref = await attachments.saveImage({
            data: new Uint8Array(result.png),
            mediaType: 'image/png',
            name: `pixpin-${target}${result.annotated ? '-annotated' : ''}${grid ? '-grid' : ''}.png`,
          });
          return {
            source: `pixpin/${target}`,
            capturedAt: new Date().toISOString(),
            annotations: annotations.length,
            grid,
            pinned: result.pinned,
            ...(result.pinWarning === null ? {} : { pinWarning: result.pinWarning }),
            image: {
              attachmentId: ref.attachmentId,
              mediaType: ref.mediaType,
              bytes: ref.bytes,
              width: ref.width,
              height: ref.height,
              ...(ref.name === undefined ? {} : { name: ref.name }),
              ...(ref.originalDimensions === undefined
                ? {}
                : { originalDimensions: { ...ref.originalDimensions } }),
            },
          };
        },
        presentCall: (args) => ({
          card: 'generic',
          title:
            `See the screen with PixPin (${typeof args?.target === 'string' ? args.target : DEFAULT_TARGET}` +
            `${Array.isArray(args?.annotations) && args.annotations.length > 0 ? ', annotated' : ''})`,
          kind: 'other',
          rawInput: args ?? {},
        }),
      }),
    'pixpin-screen.tool',
  );

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'desktop_action',
        description:
          'Run a sequence of real mouse and keyboard actions on this Windows desktop through AutoHotkey v2, then optionally ' +
          'capture the result with PixPin. Use it only when the user asked you to operate the GUI. ' +
          'Coordinates are percentages (0-100) of the full virtual screen, the same geometry as a pixpin_screenshot ' +
          '"all-screens" capture, so take a screenshot first and copy the target position. ' +
          'Steps run in order inside one AutoHotkey script: click, move, drag, type, key, wheel, activate (a window-title ' +
          'substring), and wait. Use dry_run to inspect the generated script without touching anything. ' +
          'Use preview=true to capture the screen with a coordinate grid and numbered markers at every planned position ' +
          'without executing anything, so the plan can be checked (and shown to the user) first; set pin=true to pin that ' +
          'preview or the result screenshot on the desktop.',
        parameters: {
          type: 'object',
          additionalProperties: false,
          properties: {
            steps: {
              type: 'array',
              description:
                'Actions to execute in order. click: x, y, optional button (left|right|middle) and count (1|2). ' +
                'move: x, y. drag: x1, y1, x2, y2, optional duration_ms. type: text, optional enter. ' +
                'key: keys (for example "ctrl+s", "enter", "alt+f4", or raw AutoHotkey syntax "^s"). ' +
                'wheel: delta (positive scrolls up), optional x, y. activate: title. wait: ms.',
              items: {
                type: 'object',
                properties: {
                  action: {
                    type: 'string',
                    enum: ['click', 'move', 'drag', 'type', 'key', 'wheel', 'activate', 'wait'],
                    description: 'The action to perform.',
                  },
                  x: { type: 'number', description: 'X position in percent of the virtual screen width (0-100).' },
                  y: { type: 'number', description: 'Y position in percent of the virtual screen height (0-100).' },
                  button: { type: 'string', enum: ['left', 'right', 'middle'], description: 'Mouse button for click. Defaults to left.' },
                  count: { type: 'integer', description: 'Click count for click: 1 or 2. Defaults to 1.' },
                  x1: { type: 'number', description: 'Drag start X in percent.' },
                  y1: { type: 'number', description: 'Drag start Y in percent.' },
                  x2: { type: 'number', description: 'Drag end X in percent.' },
                  y2: { type: 'number', description: 'Drag end Y in percent.' },
                  duration_ms: { type: 'integer', description: 'Drag duration in milliseconds. Defaults to 400.' },
                  text: { type: 'string', description: 'Text to type for kind type.' },
                  enter: { type: 'boolean', description: 'Press Enter after typing.' },
                  keys: { type: 'string', description: 'Key or shortcut to press for kind key.' },
                  delta: { type: 'integer', description: 'Wheel steps for kind wheel, positive scrolls up.' },
                  title: { type: 'string', description: 'Window title substring for kind activate.' },
                  ms: { type: 'integer', description: 'Milliseconds for kind wait.' },
                },
              },
              required: ['steps'],
            },
            dry_run: {
              type: 'boolean',
              description: 'Return the generated AutoHotkey script without executing it.',
            },
            preview: {
              type: 'boolean',
              description:
                'Do not execute: capture the screen with a coordinate grid and numbered markers at every position-based ' +
                'step, and return that plan screenshot. Defaults to false.',
            },
            pin: {
              type: 'boolean',
              description: 'Pin the preview screenshot (or the after-actions screenshot) on the desktop. Defaults to false.',
            },
            capture_after: {
              type: 'boolean',
              description: 'Take a fresh PixPin screenshot after the actions and return it. Defaults to true.',
            },
          },
        },
        output: {
          schema: {
            type: 'object',
            additionalProperties: false,
            properties: {
              dryRun: { type: 'boolean' },
              preview: { type: 'boolean' },
              stepCount: { type: 'integer' },
              executed: { type: 'integer' },
              ok: { type: 'boolean' },
              error: { type: 'string' },
              log: { type: 'string' },
              script: { type: 'string' },
              captureError: { type: 'string' },
              pinned: { type: 'boolean' },
              pinWarning: { type: 'string' },
              plan: {
                type: 'array',
                items: {
                  type: 'object',
                  additionalProperties: false,
                  properties: {
                    index: { type: 'integer' },
                    action: { type: 'string' },
                    x: { type: 'number' },
                    y: { type: 'number' },
                    fromX: { type: 'number' },
                    fromY: { type: 'number' },
                    toX: { type: 'number' },
                    toY: { type: 'number' },
                  },
                },
              },
              image: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  attachmentId: { type: 'string' },
                  mediaType: { type: 'string' },
                  bytes: { type: 'integer' },
                  width: { type: 'integer' },
                  height: { type: 'integer' },
                  name: { type: 'string' },
                  originalDimensions: {
                    type: 'object',
                    additionalProperties: false,
                    properties: {
                      width: { type: 'integer' },
                      height: { type: 'integer' },
                    },
                  },
                },
              },
            },
          },
          render: (_args, value) => actionResultContent(value),
        },
        timeoutMs: 180_000,
        async execute(args, exec) {
          const steps = normalizeActionSteps(args?.steps);
          const dryRun = args?.dry_run === true;
          if (dryRun) {
            const script = buildAhkScript(steps, join(tmpdir(), 'dsh-pixpin-dry-run.log'));
            return {
              dryRun: true,
              stepCount: steps.length,
              executed: 0,
              ok: true,
              log: '',
              script,
            };
          }
          const attachments = ctx.get('attachments');
          if (attachments === undefined) throw new Error('the attachment store is not mounted; a result screenshot cannot be shown to the model');
          if (args?.preview === true) {
            const preview = await serializeDesktop(() =>
              buildActionPreview({ steps, pin: args?.pin === true, settings, signal: exec?.signal, attachments }),
            );
            const payload = {
              dryRun: false,
              preview: true,
              stepCount: steps.length,
              executed: 0,
              ok: true,
              log: '',
              plan: preview.plan,
            };
            if (preview.image !== null) payload.image = preview.image;
            if (preview.pinned === true) payload.pinned = true;
            if (typeof preview.pinWarning === 'string' && preview.pinWarning !== '') payload.pinWarning = preview.pinWarning;
            return payload;
          }
          const captureAfter = args?.capture_after !== false;
          const result = await serializeDesktop(() =>
            runDesktopActions({ steps, captureAfter, pin: args?.pin === true, settings, signal: exec?.signal, attachments }),
          );
          const payload = {
            dryRun: false,
            stepCount: steps.length,
            executed: result.executed,
            ok: result.ok,
            log: result.log,
          };
          if (typeof result.error === 'string') payload.error = result.error;
          if (result.image !== null) payload.image = result.image;
          if (typeof result.captureError === 'string') payload.captureError = result.captureError;
          if (result.pinned === true) payload.pinned = true;
          if (typeof result.pinWarning === 'string' && result.pinWarning !== '') payload.pinWarning = result.pinWarning;
          return payload;
        },
        presentCall: (args) => ({
          card: 'generic',
          title: `Desktop actions (${Array.isArray(args?.steps) ? args.steps.length : 0} step(s))`,
          kind: 'execute',
          rawInput: args ?? {},
        }),
      }),
    'pixpin-screen.desktop-action',
  );
}




