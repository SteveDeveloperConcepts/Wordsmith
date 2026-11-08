# Checks Wordsmith's Check Anywhere against real Outlook or Word on this computer.
#
#   powershell -File scripts/anywhere-office-check.ps1 -App Outlook   (classic Outlook must be running)
#   powershell -File scripts/anywhere-office-check.ps1 -App Word
#
# It opens a throwaway draft or document with a sentence of mistakes, selects it, presses
# Ctrl+Alt+W, then presses the quick window's "Fix" and "Replace in ..." buttons and reads the
# text back out of the app. The draft is discarded and the document closed without saving.
# Nothing is sent or saved. A screenshot of the quick window is written to the temp folder.
param(
  [ValidateSet('Outlook', 'Word')] [string] $App = 'Outlook',
  [switch] $NoReplace
)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName UIAutomationClient
Add-Type -AssemblyName UIAutomationTypes
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
namespace Win {
  public static class Native {
    [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
    [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
    [DllImport("user32.dll")] public static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
    [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr hWnd);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hWnd, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool AttachThreadInput(uint from, uint to, bool attach);
    [DllImport("user32.dll")] static extern bool AllowSetForegroundWindow(uint pid);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr lParam);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    delegate bool EnumProc(IntPtr hWnd, IntPtr lParam);
    [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }

    public static string Title(IntPtr h) { var sb = new StringBuilder(512); GetWindowText(h, sb, 512); return sb.ToString(); }
    public static uint Pid(IntPtr h) { uint pid; GetWindowThreadProcessId(h, out pid); return pid; }

    /// Visible top-level windows of a process whose title contains the text.
    public static List<IntPtr> Find(uint pid, string contains) {
      var found = new List<IntPtr>();
      EnumWindows((h, l) => {
        if (IsWindowVisible(h) && Pid(h) == pid && Title(h).Contains(contains)) found.Add(h);
        return true;
      }, IntPtr.Zero);
      return found;
    }

    /// Bring a window of another process to the front. Windows refuses this from background
    /// processes, so: press Alt (which unlocks the foreground for the input-injecting process),
    /// allow the target process, and share the input state of the window in front.
    public static string ForceForeground(IntPtr hwnd) {
      var log = new StringBuilder();
      if (IsIconic(hwnd)) ShowWindow(hwnd, 9);
      for (int attempt = 1; attempt <= 3 && GetForegroundWindow() != hwnd; attempt++) {
        keybd_event(0x12, 0, 0, UIntPtr.Zero); Thread.Sleep(30); keybd_event(0x12, 0, 2, UIntPtr.Zero); Thread.Sleep(30);
        AllowSetForegroundWindow(Pid(hwnd));
        SetForegroundWindow(hwnd);
        Thread.Sleep(250);
        if (GetForegroundWindow() == hwnd) { log.AppendFormat("attempt {0} worked", attempt); break; }
        IntPtr front = GetForegroundWindow();
        uint pid; uint theirs = GetWindowThreadProcessId(front, out pid);
        uint target = GetWindowThreadProcessId(hwnd, out pid);
        uint ours = GetCurrentThreadId();
        AttachThreadInput(ours, theirs, true);
        AttachThreadInput(ours, target, true);
        try { BringWindowToTop(hwnd); SetForegroundWindow(hwnd); }
        finally { AttachThreadInput(ours, theirs, false); AttachThreadInput(ours, target, false); }
        Thread.Sleep(250);
        log.AppendFormat("attempt {0} with shared input: front='{1}'; ", attempt, Title(GetForegroundWindow()));
      }
      return log.ToString();
    }
  }
}
'@
[void][Win.Native]::SetProcessDPIAware()

function Press([byte[]]$keys) {
  foreach ($k in $keys) { [Win.Native]::keybd_event($k, 0, 0, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
  [array]::Reverse($keys)
  foreach ($k in $keys) { [Win.Native]::keybd_event($k, 0, 2, [UIntPtr]::Zero); Start-Sleep -Milliseconds 40 }
}
function QuickWindow {
  Get-Process Wordsmith -ErrorAction SilentlyContinue |
    Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero -and [Win.Native]::IsWindowVisible($_.MainWindowHandle) } |
    Select-Object -First 1
}
function WaitQuick([bool]$visible, [int]$seconds) {
  $deadline = (Get-Date).AddSeconds($seconds)
  while ((Get-Date) -lt $deadline) { if ((QuickWindow) -ne $null -eq $visible) { return $true }; Start-Sleep -Milliseconds 150 }
  return $false
}
# The quick window's buttons, through UI Automation. Chromium builds its accessibility tree on the first ask.
function Buttons([IntPtr]$hwnd) {
  $root = [System.Windows.Automation.AutomationElement]::FromHandle($hwnd)
  $kind = New-Object System.Windows.Automation.PropertyCondition(
    [System.Windows.Automation.AutomationElement]::ControlTypeProperty, [System.Windows.Automation.ControlType]::Button)
  for ($i = 0; $i -lt 24; $i++) {
    $all = @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $kind))
    if (($all | Where-Object { $_.Current.Name -like 'Replace in *' })) { return $all }
    Start-Sleep -Milliseconds 250
  }
  return @($root.FindAll([System.Windows.Automation.TreeScope]::Descendants, $kind))
}
function Push($buttons, [string]$like) {
  $b = $buttons | Where-Object { $_.Current.Name -like $like } | Select-Object -First 1
  if (-not $b) { throw "The quick window has no button like '$like'." }
  $b.GetCurrentPattern([System.Windows.Automation.InvokePattern]::Pattern).Invoke()
  "pressed '$($b.Current.Name)'"
}

if (-not (Get-Process Wordsmith -ErrorAction SilentlyContinue)) { throw 'Wordsmith is not running.' }
if (QuickWindow) { throw 'A Wordsmith window is already visible; stopping.' }

$sentence = "Their is alot of reasons to proofread you're email before you send it."
$clipBefore = try { Get-Clipboard -Raw } catch { $null }
$cleanup = $null
try {
  if ($App -eq 'Outlook') {
    $outlookPid = (Get-Process OUTLOOK -ErrorAction SilentlyContinue | Select-Object -First 1).Id
    if (-not $outlookPid) { throw 'Classic Outlook is not running.' }
    $ol = New-Object -ComObject Outlook.Application
    $mail = $ol.CreateItem(0)
    $cleanup = { $mail.Close(1) }   # 1 = olDiscard
    $mail.To = 'wordsmith-test'     # with To and Subject filled, Outlook puts the cursor in the body
    $mail.Subject = 'Wordsmith test draft (never sent)'
    $mail.Body = $sentence
    $insp = $mail.GetInspector
    $insp.Display()
    $hwnd = [IntPtr]::Zero; $deadline = (Get-Date).AddSeconds(10)
    while ($hwnd -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
      Start-Sleep -Milliseconds 250
      $hits = [Win.Native]::Find($outlookPid, 'Wordsmith test draft')
      if ($hits.Count -gt 0) { $hwnd = $hits[0] }
    }
    if ($hwnd -eq [IntPtr]::Zero) { throw 'The draft window never appeared.' }
    $editor = $insp.WordEditor
    $select = { $editor.Range(0, $sentence.Length).Select() }
    $selected = { $editor.Application.Selection.Text }
    $text = { $editor.Content.Text }
    $font = { $r = $editor.Range(0, 5); "$($r.Font.Name) $($r.Font.Size)" }
  } else {
    $word = New-Object -ComObject Word.Application
    $word.Visible = $true
    $doc = $word.Documents.Add()
    $cleanup = { $doc.Close(0); $word.Quit() }   # 0 = wdDoNotSaveChanges
    $doc.Content.Text = $sentence
    Start-Sleep -Milliseconds 800
    $hwnd = [IntPtr] $word.ActiveWindow.Hwnd
    $select = { $doc.Range(0, $sentence.Length).Select() }
    $selected = { $word.Selection.Text }
    $text = { $doc.Content.Text }
    $font = { $r = $doc.Range(0, 5); "$($r.Font.Name) $($r.Font.Size)" }
  }
  "window: '" + [Win.Native]::Title($hwnd) + "'"
  "focus: " + [Win.Native]::ForceForeground($hwnd)
  if ([Win.Native]::GetForegroundWindow() -ne $hwnd) { throw "The $App window is not in front, so no keys were sent." }

  & $select
  Start-Sleep -Milliseconds 300
  "selected in ${App}: " + (& $selected).Trim()
  "font before: " + (& $font)

  $seqBefore = [Win.Native]::GetClipboardSequenceNumber()
  Press @(0x11, 0x12, 0x57)   # Ctrl, Alt, W
  if (-not (WaitQuick $true 8)) { throw 'The quick window did not appear within 8 s.' }
  $quick = QuickWindow
  Start-Sleep -Seconds 3   # let the engine check the text
  $rect = New-Object 'Win.Native+RECT'
  [void][Win.Native]::GetWindowRect($quick.MainWindowHandle, [ref]$rect)
  "quick window: visible, $($rect.Right - $rect.Left)x$($rect.Bottom - $rect.Top) at $($rect.Left),$($rect.Top)"
  "clipboard writes seen (the copy and the restore): $([Win.Native]::GetClipboardSequenceNumber() - $seqBefore)"
  $clipAfter = try { Get-Clipboard -Raw } catch { $null }
  "clipboard text put back as it was: $($clipBefore -eq $clipAfter)"

  $shot = Join-Path $env:TEMP "wordsmith-anywhere-$($App.ToLower()).png"
  $bmp = New-Object System.Drawing.Bitmap ($rect.Right - $rect.Left), ($rect.Bottom - $rect.Top)
  $g = [System.Drawing.Graphics]::FromImage($bmp)
  $g.CopyFromScreen($rect.Left, $rect.Top, 0, 0, $bmp.Size)
  $bmp.Save($shot, [System.Drawing.Imaging.ImageFormat]::Png); $g.Dispose(); $bmp.Dispose()
  "screenshot: $shot"

  if ($NoReplace) {
    Press @(0x1B)
    "quick window hidden after Esc: " + (WaitQuick $false 3)
    return
  }

  $buttons = Buttons $quick.MainWindowHandle
  "buttons: " + (($buttons | ForEach-Object { $_.Current.Name }) -join ' | ')
  Push $buttons 'Fix *'
  Start-Sleep -Milliseconds 1200
  $seqBefore = [Win.Native]::GetClipboardSequenceNumber()
  Push $buttons "Replace in $App"
  "quick window went away after Replace: " + (WaitQuick $false 8)
  Start-Sleep -Seconds 2
  $problem = $null
  if (QuickWindow) {
    $root = [System.Windows.Automation.AutomationElement]::FromHandle((QuickWindow).MainWindowHandle)
    $alert = $root.FindFirst([System.Windows.Automation.TreeScope]::Descendants, (New-Object System.Windows.Automation.PropertyCondition(
      [System.Windows.Automation.AutomationElement]::ClassNameProperty, 'quick__problem')))
    if ($alert) { $problem = $alert.Current.Name }
    "the quick window is still open" + $(if ($problem) { ": $problem" } else { '' })
    Press @(0x1B)
  }
  $now = (& $text).Trim()
  "text in $App now: $now"
  "font after: " + (& $font)
  "clipboard writes during Replace: $([Win.Native]::GetClipboardSequenceNumber() - $seqBefore)"
  $clipAfter = try { Get-Clipboard -Raw } catch { $null }
  "clipboard text put back as it was: $($clipBefore -eq $clipAfter)"
  $fixed = ($now -ne $sentence) -and ($now -notmatch 'alot') -and ($now -notmatch '^Their is')
  "RESULT: " + $(if ($fixed) { "PASS, $App took the corrected text" } else { "FAIL, $App still has the original text" })
  "front window now: '" + [Win.Native]::Title([Win.Native]::GetForegroundWindow()) + "'"
} finally {
  if ($cleanup) { try { & $cleanup; "$App test item discarded" } catch { "cleanup: $($_.Exception.Message)" } }
}
