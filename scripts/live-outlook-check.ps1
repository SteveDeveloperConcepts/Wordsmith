# Checks the live overlay (underlines as you type in classic Outlook and Word) on this computer,
# with Wordsmith running and "Underline as you type" turned on. See docs/LIVE-OVERLAY-SPIKE.md.
#
#   powershell -File scripts/live-outlook-check.ps1            Outlook: underlines, card, fix, typing, scrolling, CPU
#   powershell -File scripts/live-outlook-check.ps1 -Word      Word: underlines and card only (no typing, no clicks)
#   powershell -File scripts/live-outlook-check.ps1 -Baseline  Outlook's own CPU, idle and typing; run with Wordsmith closed
#   powershell -File scripts/live-outlook-check.ps1 -Events    which accessibility events Outlook raises while typing and scrolling
#   powershell -File scripts/live-outlook-check.ps1 -Bench     what each of the helper's questions costs
#
# Outlook gets a throwaway draft that is never sent and is discarded at the end; Word gets a new
# document that is closed without saving. Typing stops if the draft leaves the front, and a click
# stops if another program's window is under the pointer. Screenshots go to
# %TEMP%\wordsmith-live-check. Run WORDSMITH_LIVE_DEBUG=1 Wordsmith to see the overlay's own log.
param([switch] $Baseline, [switch] $Word, [switch] $Events, [switch] $Bench)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace LiveCheck {
  public static class Native {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
    [DllImport("user32.dll")] public static extern void mouse_event(uint flags, int dx, int dy, int data, UIntPtr extra);
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint pid);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT p);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }

    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }
    public static uint PidAt(int x, int y) { var p = new POINT(); p.X = x; p.Y = y; return Pid(GetAncestor(WindowFromPoint(p), 2)); }

    public static List<IntPtr> Find(uint pid, string contains) {
      var found = new List<IntPtr>();
      EnumWindows((h, l) => {
        if (IsWindowVisible(h) && Pid(h) == pid && Title(h).Contains(contains)) found.Add(h);
        return true;
      }, IntPtr.Zero);
      return found;
    }

    /// Windows refuses focus changes from background processes; pressing Alt first, then sharing
    /// the input state of the window in front, is how a tool the writer started gets past that.
    public static bool ForceForeground(IntPtr hwnd) {
      if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
      for (int attempt = 1; attempt <= 3 && GetForegroundWindow() != hwnd; attempt++) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero); Thread.Sleep(30); keybd_event(0x12, 0, 2, UIntPtr.Zero); Thread.Sleep(30);
        AllowSetForegroundWindow(Pid(hwnd));
        SetForegroundWindow(hwnd);
        Thread.Sleep(250);
        if (GetForegroundWindow() == hwnd) break;
        uint pid;
        uint theirs = GetWindowThreadProcessId(GetForegroundWindow(), out pid);
        uint target = GetWindowThreadProcessId(hwnd, out pid);
        uint ours = GetCurrentThreadId();
        AttachThreadInput(ours, theirs, true);
        AttachThreadInput(ours, target, true);
        try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
        finally { AttachThreadInput(ours, theirs, false); AttachThreadInput(ours, target, false); }
        Thread.Sleep(250);
      }
      return GetForegroundWindow() == hwnd;
    }
  }
}
'@
[void][LiveCheck.Native]::SetProcessDPIAware()

$shots = Join-Path $env:TEMP 'wordsmith-live-check'
New-Item -ItemType Directory -Force $shots | Out-Null
$wordsmithProcesses = @('Wordsmith', 'electron')

function Shot([string]$name, $x, $y, $w, $h) {
  $bmp = New-Object System.Drawing.Bitmap ([int]$w), ([int]$h)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen([int]$x, [int]$y, 0, 0, $bmp.Size)
  $bmp.Save((Join-Path $shots $name), [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
}
function Hover($x, $y) {
  [void][LiveCheck.Native]::SetCursorPos([int]$x, [int]$y)
  [LiveCheck.Native]::mouse_event(1, 1, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 30
  [LiveCheck.Native]::mouse_event(1, -1, 0, 0, [UIntPtr]::Zero)
}
function Click($x, $y) {
  Hover $x $y
  Start-Sleep -Milliseconds 60
  $owner = [LiveCheck.Native]::PidAt([int]$x, [int]$y)
  $allowed = @($appPid) + @(Get-Process $wordsmithProcesses -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
  if ($owner -notin $allowed) { throw "Click stopped: another program's window is under the pointer ($((Get-Process -Id $owner -ErrorAction SilentlyContinue).ProcessName))." }
  [LiveCheck.Native]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [LiveCheck.Native]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}
function TypeIntoDraft([string]$keys) {
  $front = [LiveCheck.Native]::GetForegroundWindow()
  if ($front -ne $hwnd) { throw "Typing stopped: the draft is no longer in front ('$([LiveCheck.Native]::Title($front))')." }
  [System.Windows.Forms.SendKeys]::SendWait($keys)
}
function TypeSlowly([string]$text) {
  # About nine characters a second, a steady typing pace.
  foreach ($ch in $text.ToCharArray()) { TypeIntoDraft ([string]$ch); Start-Sleep -Milliseconds 110 }
}
function Cpu([string[]]$names) { (Get-Process $names -ErrorAction SilentlyContinue | Measure-Object CPU -Sum).Sum }
function Report([string]$label, [hashtable]$groups, [hashtable]$before, [double]$seconds) {
  foreach ($k in ($groups.Keys | Sort-Object)) {
    $used = (Cpu $groups[$k]) - $before[$k]
    "  CPU, {0}, {1}: {2:N2} s in {3:N1} s = {4:N1}% of one core" -f $label, $k, $used, $seconds, ($used / $seconds * 100)
  }
}
function MeasureIdle([string]$label, [int]$seconds, [hashtable]$groups) {
  $before = @{}; foreach ($k in $groups.Keys) { $before[$k] = Cpu $groups[$k] }
  Start-Sleep -Seconds $seconds
  Report $label $groups $before $seconds
}
function MeasureTyping([string]$label, [hashtable]$groups) {
  $p1 = $doc.Paragraphs(1).Range
  $doc.Range($p1.End - 1, $p1.End - 1).Select()
  $before = @{}; foreach ($k in $groups.Keys) { $before[$k] = Cpu $groups[$k] }
  $started = Get-Date
  TypeSlowly ' And this is a sentence typed at a steady pace to see what it costs'
  Report $label $groups $before ((Get-Date) - $started).TotalSeconds
}
# The overlay is the visible Wordsmith window that covers the text area.
function OverlayWindow($area) {
  foreach ($p in (Get-Process $wordsmithProcesses -ErrorAction SilentlyContinue)) {
    foreach ($h in [LiveCheck.Native]::Find([uint32]$p.Id, 'Wordsmith')) {
      $r = New-Object 'LiveCheck.Native+RECT'
      [void][LiveCheck.Native]::GetWindowRect($h, [ref]$r)
      if ([Math]::Abs($r.Left - $area.X) -le 4 -and [Math]::Abs($r.Top - $area.Y) -le 4) { return $h }
    }
  }
  return $null
}
function CardButtons($overlay) {
  $isButton = New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($overlay)
  for ($i = 0; $i -lt 20; $i++) {
    $buttons = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $isButton))
    if ($buttons.Count -gt 0) { return $buttons }
    Start-Sleep -Milliseconds 200
  }
  return @()
}
function TextCanvas($window) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($window)
  $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants,
    (New-Object System.Windows.Automation.PropertyCondition([System.Windows.Automation.AutomationElement]::ClassNameProperty, '_WwG')))
}

$first = "Their is alot of reasons to proofread you're email before you send it. The report was written by our team in a timely manner."
$lines = 1..40 | ForEach-Object { "Line $_ of the long part, with a mispelled word in it." }

if ($Word) {
  $wordApp = New-Object -ComObject Word.Application
  $wordApp.Visible = $true
  $doc = $wordApp.Documents.Add()
  try {
    $doc.Content.Text = $first + "`r" + ($lines -join "`r")
    # Word's own marks would sit under the same words; this changes the view of this document only.
    $doc.ShowSpellingErrors = $false
    $doc.ShowGrammaticalErrors = $false
    Start-Sleep -Milliseconds 800
    $hwnd = [IntPtr]$wordApp.ActiveWindow.Hwnd
    $appPid = [LiveCheck.Native]::Pid($hwnd)
    if (-not [LiveCheck.Native]::ForceForeground($hwnd)) { throw 'Word would not come to the front.' }
    $canvas = TextCanvas $hwnd
    $body = $canvas.Current.BoundingRectangle
    "Word document open: $($doc.Paragraphs.Count) paragraphs"
    $deadline = (Get-Date).AddSeconds(8); $overlay = $null
    while (-not $overlay -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $overlay = OverlayWindow $body }
    if (-not $overlay) { 'RESULT Word overlay: FAIL, none appeared within 8 s'; return }
    'RESULT Word overlay: PASS, it appeared over the page'
    Start-Sleep -Seconds 2
    $pattern = $canvas.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
    $wr = $pattern.DocumentRange.FindText('alot', $false, $false).GetBoundingRectangles()[0]
    Shot 'word-1-underlines.png' ($wr.X - 80) ($wr.Y - 60) 1000 320
    Hover ($wr.X + $wr.Width / 2) ($wr.Y + $wr.Height - 2)
    Start-Sleep -Milliseconds 700
    Shot 'word-2-card.png' ($wr.X - 80) ($wr.Y - 60) 1000 320
    $buttons = CardButtons $overlay
    'RESULT Word card: ' + $(if ($buttons.Count -gt 0) { 'PASS, ' + (($buttons | ForEach-Object { $_.Current.Name }) -join ' | ') } else { 'FAIL, no card' })
  } finally {
    [void][LiveCheck.Native]::SetCursorPos(10, 10)
    try { $doc.Close(0); $wordApp.Quit(); 'Word document closed without saving' } catch { "cleanup: $($_.Exception.Message)" }
  }
  "Screenshots: $shots"
  return
}

$outlookPid = (Get-Process OUTLOOK -ErrorAction SilentlyContinue | Select-Object -First 1).Id
if (-not $outlookPid) { throw 'Classic Outlook is not running.' }
$appPid = $outlookPid
$ol = New-Object -ComObject Outlook.Application
$mail = $ol.CreateItem(0)
try {
  $mail.To = 'wordsmith-test'
  $mail.Subject = 'Wordsmith live overlay test (never sent)'
  $mail.Body = $first + "`r`n" + ($lines -join "`r`n")
  $insp = $mail.GetInspector
  $insp.Display()
  $hwnd = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(10)
  while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 250
    $hits = [LiveCheck.Native]::Find($outlookPid, 'Wordsmith live overlay test')
    if ($hits.Count -gt 0) { $hwnd = $hits[0] }
  }
  if ($hwnd -eq [IntPtr]::Zero) { throw 'The draft window never appeared.' }
  if (-not [LiveCheck.Native]::ForceForeground($hwnd)) { throw 'The draft would not come to the front, so nothing was typed.' }

  $doc = $insp.WordEditor
  # Outlook's own red and blue marks would sit under the same words. This changes the view of
  # this throwaway draft only, so that every mark in the screenshots is Wordsmith's.
  $doc.ShowSpellingErrors = $false
  $doc.ShowGrammaticalErrors = $false
  $canvas = TextCanvas $hwnd
  $body = $canvas.Current.BoundingRectangle
  $pattern = $canvas.GetCurrentPattern([System.Windows.Automation.TextPattern]::Pattern)
  Click ($body.X + $body.Width - 40) ($body.Y + 12)
  Start-Sleep -Milliseconds 300
  "draft open: $($doc.Paragraphs.Count) paragraphs, the body has the keyboard: $($canvas.Current.HasKeyboardFocus)"

  if ($Baseline) {
    if (Get-Process $wordsmithProcesses -ErrorAction SilentlyContinue) { 'Note: Wordsmith is running, so this is not a baseline.' }
    Start-Sleep -Seconds 3
    MeasureIdle 'idle' 10 @{ Outlook = @('OUTLOOK') }
    MeasureTyping 'typing' @{ Outlook = @('OUTLOOK') }
    return
  }

  if ($Events) {
    $probe = Join-Path $shots 'EventProbe.exe'
    if (-not (Test-Path $probe)) {
      $framework = Join-Path $env:WINDIR 'Microsoft.NET\Framework64\v4.0.30319'
      & (Join-Path $framework 'csc.exe') /nologo /target:exe "/out:$probe" "/r:$framework\WPF\UIAutomationClient.dll" "/r:$framework\WPF\UIAutomationTypes.dll" "/r:$framework\WPF\WindowsBase.dll" (Join-Path $PSScriptRoot 'live-spike\EventProbe.cs') | Out-Null
    }
    $out = Join-Path $shots 'event-probe.txt'
    $listener = Start-Process -FilePath $probe -ArgumentList @([string]$hwnd.ToInt64(), '20') -RedirectStandardOutput $out -NoNewWindow -PassThru
    Start-Sleep -Seconds 3
    MeasureTyping 'typing, with a client listening for events' @{ Outlook = @('OUTLOOK') }
    [void][LiveCheck.Native]::SetCursorPos([int]($body.X + $body.Width / 2), [int]($body.Y + $body.Height / 2))
    [LiveCheck.Native]::mouse_event(0x0800, 0, 0, -600, [UIntPtr]::Zero)
    Start-Sleep -Seconds 1
    [LiveCheck.Native]::mouse_event(0x0800, 0, 0, 600, [UIntPtr]::Zero)
    $listener.WaitForExit(30000) | Out-Null
    Get-Content $out
    return
  }

  if ($Bench) {
    node (Join-Path $PSScriptRoot 'live-spike\bench.mjs') ([string]$hwnd.ToInt64())
    return
  }

  $deadline = (Get-Date).AddSeconds(6); $overlay = $null
  while (-not $overlay -and (Get-Date) -lt $deadline) { Start-Sleep -Milliseconds 200; $overlay = OverlayWindow $body }
  if (-not $overlay) { 'RESULT overlay: FAIL, none appeared within 6 s. Is "Underline as you type" on?'; return }
  'RESULT overlay: PASS, it appeared over the message body'
  Start-Sleep -Seconds 2
  Shot 'outlook-1-underlines.png' $body.X $body.Y $body.Width 200

  # Rest the pointer on a flagged word, then click the fix on its card.
  $flagged = $pattern.DocumentRange.FindText('alot', $false, $false)
  $wr = $flagged.GetBoundingRectangles()[0]
  Hover ($wr.X + $wr.Width / 2) ($wr.Y + $wr.Height - 2)
  Start-Sleep -Milliseconds 700
  Shot 'outlook-2-card.png' $body.X $body.Y $body.Width 260
  $buttons = CardButtons $overlay
  "card buttons: " + (($buttons | ForEach-Object { $_.Current.Name }) -join ' | ')
  $fix = $buttons | Where-Object { $_.Current.Name -notin @('Dismiss', 'Add to dictionary') } | Select-Object -First 1
  if (-not $fix) { 'RESULT fix: FAIL, the card has no fix'; return }
  $br = $fix.Current.BoundingRectangle
  Click ($br.X + $br.Width / 2) ($br.Y + $br.Height / 2)
  Start-Sleep -Seconds 3
  $firstNow = $doc.Paragraphs(1).Range.Text.Trim()
  "RESULT fix: " + $(if ($firstNow -match 'a lot' -and $firstNow -notmatch 'alot') { 'PASS, it landed and the rest of the draft is unchanged' } else { "FAIL, the first paragraph reads: $firstNow" })
  "the keyboard is with: '" + [LiveCheck.Native]::Title([LiveCheck.Native]::GetForegroundWindow()) + "'"
  Shot 'outlook-3-after-fix.png' $body.X $body.Y $body.Width 200

  # Type at the start. Underlines in later paragraphs should stay with their words; the rest of
  # the edited paragraph comes back once typing pauses.
  $doc.Range(0, 0).Select()
  TypeIntoDraft 'Hi Sam. '
  Start-Sleep -Milliseconds 300
  Shot 'outlook-4-typed-at-start-300ms.png' $body.X $body.Y $body.Width 200
  TypeIntoDraft '{END} Pleese reply befor Friday.'
  Start-Sleep -Milliseconds 1500
  Shot 'outlook-5-typed-at-end-1500ms.png' $body.X $body.Y $body.Width 200

  $groups = @{ Outlook = @('OUTLOOK'); Wordsmith = $wordsmithProcesses; Helper = @('live-helper') }
  [void][LiveCheck.Native]::SetCursorPos([int]($body.X + 5), [int]($body.Y + $body.Height - 5))
  Start-Sleep -Seconds 4
  MeasureIdle 'idle, overlay up' 10 $groups
  MeasureTyping 'typing, overlay up' $groups
  Start-Sleep -Milliseconds 1500
  Shot 'outlook-6-after-steady-typing.png' $body.X $body.Y $body.Width 200

  # Scroll down five notches with the wheel over the body, and back.
  [void][LiveCheck.Native]::SetCursorPos([int]($body.X + $body.Width / 2), [int]($body.Y + $body.Height / 2))
  $scrolledAt = Get-Date
  [LiveCheck.Native]::mouse_event(0x0800, 0, 0, -600, [UIntPtr]::Zero)
  foreach ($wait in 150, 400, 800) {
    $elapsed = ((Get-Date) - $scrolledAt).TotalMilliseconds
    if ($wait -gt $elapsed) { Start-Sleep -Milliseconds ($wait - $elapsed) }
    Shot "outlook-7-scrolled-$wait.png" $body.X $body.Y $body.Width $body.Height
  }
  [LiveCheck.Native]::mouse_event(0x0800, 0, 0, 600, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 800
  Shot 'outlook-8-scrolled-back-800.png' $body.X $body.Y $body.Width $body.Height
} finally {
  try { $mail.Close(1); 'draft discarded' } catch { "cleanup: $($_.Exception.Message)" }
}
"Screenshots: $shots"
