// The accessibility helper behind the live overlay, for Windows.
//
// Wordsmith asks it about the message body or document the writer is typing in: one JSON
// line per question on stdin, one JSON line per answer on stdout. It does nothing on its
// own. There are no hooks and no events; it reads only when asked, only Word's text canvas
// (class _WwG, which is the body of a classic Outlook message and the page of a Word
// document), and only inside the window Wordsmith names. The text stays in Wordsmith.
//
// Questions:
//   {"id":1,"cmd":"foreground"}                     the window in front: {"hwnd":..,"process":"OUTLOOK"}
//   {"id":2,"cmd":"editor","hwnd":123456}           the text canvas in that window, with its text and rectangle
//   {"id":3,"cmd":"poll"}                           its text and rectangle now, and where its first visible character is
//   {"id":4,"cmd":"rects","ranges":[[0,5],[9,12]],"expect":123}
//                                                   screen rectangles of those character ranges, where they are on
//                                                   screen, if the text still has that fingerprint
//   {"id":5,"cmd":"select","start":9,"end":12}      selects that range, so that Wordsmith can paste over it
//
// Every question about the text is answered by Outlook or Word itself, in their own process,
// so the helper asks as few of them as it can: it measures only what is on screen, and walks
// forward from one range to the next instead of from the top of the document each time.
//
// Built by scripts/build-live-helper.mjs with the C# compiler that ships with the .NET
// Framework, which speaks C# 5: no string interpolation, no null-conditional operators.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using System.Windows;
using System.Windows.Automation;
using System.Windows.Automation.Text;

static class LiveHelper
{
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);

    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = int.MaxValue };

    /// Word's text canvas, which is what a message body and a document page are made of.
    static readonly Condition WordCanvas = new AndCondition(
        new PropertyCondition(AutomationElement.ClassNameProperty, "_WwG"),
        new PropertyCondition(AutomationElement.IsTextPatternAvailableProperty, true));

    static AutomationElement editor;
    static TextPattern text;
    static IntPtr editorWindow;

    static int Main()
    {
        var input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
        var output = new StreamWriter(Console.OpenStandardOutput(), new UTF8Encoding(false));
        output.AutoFlush = true;
        string line;
        while ((line = input.ReadLine()) != null)
        {
            if (line.Trim().Length == 0) continue;
            object id = null;
            Dictionary<string, object> reply;
            try
            {
                var request = Json.Deserialize<Dictionary<string, object>>(line);
                request.TryGetValue("id", out id);
                reply = Answer(request);
            }
            catch (Exception error)
            {
                reply = new Dictionary<string, object>();
                reply["error"] = error.GetType().Name + ": " + error.Message;
            }
            reply["id"] = id;
            output.WriteLine(Json.Serialize(reply));
        }
        return 0;
    }

    static Dictionary<string, object> Answer(Dictionary<string, object> request)
    {
        var reply = new Dictionary<string, object>();
        var command = request["cmd"] as string;
        var watch = Stopwatch.StartNew();
        switch (command)
        {
            case "foreground":
            {
                IntPtr hwnd = GetForegroundWindow();
                uint pid;
                GetWindowThreadProcessId(hwnd, out pid);
                reply["hwnd"] = hwnd.ToInt64();
                reply["process"] = ProcessName(pid);
                break;
            }
            case "editor":
                FindEditor(new IntPtr(Convert.ToInt64(request["hwnd"])), reply);
                break;
            case "poll":
            {
                RequireEditor();
                double before = watch.Elapsed.TotalMilliseconds;
                Describe(reply);
                double between = watch.Elapsed.TotalMilliseconds;
                reply["probe"] = Probe();
                reply["timing"] = new object[] { Math.Round(between - before, 2), Math.Round(watch.Elapsed.TotalMilliseconds - between, 2) };
                break;
            }
            case "rects":
                RequireEditor();
                Measure(request, reply);
                break;
            case "select":
                RequireEditor();
                Range(Convert.ToInt32(request["start"]), Convert.ToInt32(request["end"])).Select();
                reply["ok"] = true;
                break;
            default:
                throw new ArgumentException("Unknown command: " + command);
        }
        reply["ms"] = watch.ElapsedMilliseconds;
        return reply;
    }

    static string ProcessName(uint pid)
    {
        try
        {
            return Process.GetProcessById((int)pid).ProcessName;
        }
        catch (Exception)
        {
            return null;
        }
    }

    /// The text canvas the writer is typing in: the one with keyboard focus, or the only one in the window.
    static void FindEditor(IntPtr hwnd, Dictionary<string, object> reply)
    {
        // The same window as last time, and its canvas is still there: no need to search again.
        if (editor != null && editorWindow == hwnd && StillThere(editor))
        {
            reply["found"] = true;
            reply["cached"] = true;
            Describe(reply);
            return;
        }
        editor = null;
        text = null;
        editorWindow = IntPtr.Zero;
        var window = AutomationElement.FromHandle(hwnd);
        var canvases = window.FindAll(TreeScope.Descendants, WordCanvas);
        AutomationElement found = null;
        foreach (AutomationElement canvas in canvases)
        {
            if (!canvas.Current.HasKeyboardFocus) continue;
            found = canvas;
            break;
        }
        if (found == null && canvases.Count == 1) found = canvases[0];
        reply["found"] = found != null;
        reply["canvases"] = canvases.Count;
        if (found == null) return;
        editor = found;
        text = (TextPattern)found.GetCurrentPattern(TextPattern.Pattern);
        editorWindow = hwnd;
        Describe(reply);
    }

    static bool StillThere(AutomationElement element)
    {
        try
        {
            var unused = element.Current.BoundingRectangle;
            return true;
        }
        catch (ElementNotAvailableException)
        {
            return false;
        }
    }

    static void RequireEditor()
    {
        if (editor == null) throw new InvalidOperationException("No editor yet. Ask for one with the editor command first.");
    }

    static void Describe(Dictionary<string, object> reply)
    {
        var watch = Stopwatch.StartNew();
        reply["text"] = text.DocumentRange.GetText(-1);
        double gotText = watch.Elapsed.TotalMilliseconds;
        reply["rect"] = Box(editor.Current.BoundingRectangle);
        double gotRect = watch.Elapsed.TotalMilliseconds;
        reply["focused"] = editor.Current.HasKeyboardFocus;
        reply["describeTiming"] = new object[] { Math.Round(gotText, 2), Math.Round(gotRect - gotText, 2), Math.Round(watch.Elapsed.TotalMilliseconds - gotRect, 2) };
    }

    static object Box(Rect rect)
    {
        if (rect.IsEmpty) return null;
        return new object[] { rect.X, rect.Y, rect.Width, rect.Height };
    }

    /// A range of the document by character offsets, counted the way the reported text counts them.
    static TextPatternRange Range(int start, int end)
    {
        var range = text.DocumentRange.Clone();
        range.MoveEndpointByRange(TextPatternRangeEndpoint.End, range, TextPatternRangeEndpoint.Start);
        range.MoveEndpointByUnit(TextPatternRangeEndpoint.Start, TextUnit.Character, start);
        range.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, end - start);
        return range;
    }

    /// The same 32-bit FNV-1a hash of UTF-16 code units that the overlay's page computes.
    static uint Fingerprint(string s)
    {
        uint hash = 2166136261;
        foreach (char c in s)
        {
            hash ^= c;
            hash = unchecked(hash * 16777619);
        }
        return hash;
    }

    /// The character offset of one end of a range, counted from the start of the document.
    static int OffsetOf(TextPatternRange range, TextPatternRangeEndpoint endpoint)
    {
        var before = text.DocumentRange.Clone();
        before.MoveEndpointByRange(TextPatternRangeEndpoint.End, range, endpoint);
        return before.GetText(-1).Length;
    }

    /// Where the first visible character is, and its offset. It changes when the text scrolls.
    static object Probe()
    {
        TextPatternRange[] visible;
        try
        {
            visible = text.GetVisibleRanges();
        }
        catch (Exception)
        {
            return null;
        }
        if (visible.Length == 0) return null;
        int offset = OffsetOf(visible[0], TextPatternRangeEndpoint.Start);
        var first = visible[0].Clone();
        first.MoveEndpointByRange(TextPatternRangeEndpoint.End, first, TextPatternRangeEndpoint.Start);
        first.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, 1);
        var rects = first.GetBoundingRectangles();
        if (rects.Length == 0) return new object[] { offset };
        return new object[] { offset, rects[0].X, rects[0].Y };
    }

    /// Screen rectangles for each range that is on screen, one per line it spans, with the text
    /// each range holds now. Ranges outside the visible part get no rectangles and cost nothing.
    /// If the writer typed while this ran, the answer says so, because some of it may not match.
    static void Measure(Dictionary<string, object> request, Dictionary<string, object> reply)
    {
        var ranges = (IList)request["ranges"];
        var clock = Stopwatch.StartNew();
        string all = text.DocumentRange.GetText(-1);
        double readText = clock.Elapsed.TotalMilliseconds;
        object expected;
        if (request.TryGetValue("expect", out expected) && expected != null && Fingerprint(all) != Convert.ToUInt32(expected))
        {
            // The offsets belong to text Wordsmith read earlier: the writer has typed since.
            reply["rects"] = new object[0];
            reply["changed"] = true;
            return;
        }
        int count = ranges.Count;
        var starts = new int[count];
        var ends = new int[count];
        var order = new int[count];
        for (int i = 0; i < count; i++)
        {
            var pair = (IList)ranges[i];
            starts[i] = Math.Max(0, Math.Min(Convert.ToInt32(pair[0]), all.Length));
            ends[i] = Math.Max(starts[i], Math.Min(Convert.ToInt32(pair[1]), all.Length));
            order[i] = i;
        }
        Array.Sort(order, (a, b) => starts[a].CompareTo(starts[b]));

        // A collapsed range at the first visible character, walked forward from one range to the next.
        int visibleStart = 0;
        int visibleEnd = all.Length;
        TextPatternRange cursor = null;
        try
        {
            var visible = text.GetVisibleRanges();
            if (visible.Length > 0)
            {
                visibleStart = OffsetOf(visible[0], TextPatternRangeEndpoint.Start);
                visibleEnd = OffsetOf(visible[visible.Length - 1], TextPatternRangeEndpoint.End);
                cursor = visible[0].Clone();
                cursor.MoveEndpointByRange(TextPatternRangeEndpoint.End, cursor, TextPatternRangeEndpoint.Start);
            }
        }
        catch (Exception)
        {
            cursor = null;
        }
        if (cursor == null)
        {
            visibleStart = 0;
            visibleEnd = all.Length;
            cursor = text.DocumentRange.Clone();
            cursor.MoveEndpointByRange(TextPatternRangeEndpoint.End, cursor, TextPatternRangeEndpoint.Start);
        }
        int at = visibleStart;
        double foundVisible = clock.Elapsed.TotalMilliseconds;

        var result = new object[count];
        foreach (int i in order)
        {
            var boxes = new List<object>();
            string held = all.Substring(starts[i], ends[i] - starts[i]);
            if (starts[i] >= at && starts[i] < visibleEnd && ends[i] > visibleStart)
            {
                if (starts[i] > at)
                {
                    cursor.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, starts[i] - at);
                    cursor.MoveEndpointByRange(TextPatternRangeEndpoint.Start, cursor, TextPatternRangeEndpoint.End);
                    at = starts[i];
                }
                var range = cursor.Clone();
                if (ends[i] > starts[i]) range.MoveEndpointByUnit(TextPatternRangeEndpoint.End, TextUnit.Character, ends[i] - starts[i]);
                foreach (Rect rect in range.GetBoundingRectangles()) boxes.Add(Box(rect));
                // What the range really covers, so that a mismatch between the two ways of counting
                // shows up as a missing underline, never a misplaced one.
                held = range.GetText(-1);
            }
            var entry = new Dictionary<string, object>();
            entry["rects"] = boxes;
            entry["text"] = held;
            result[i] = entry;
        }
        double measuredRanges = clock.Elapsed.TotalMilliseconds;
        reply["rects"] = result;
        reply["changed"] = text.DocumentRange.GetText(-1) != all;
        reply["timing"] = new object[] {
            Math.Round(readText, 2), Math.Round(foundVisible - readText, 2),
            Math.Round(measuredRanges - foundVisible, 2), Math.Round(clock.Elapsed.TotalMilliseconds - measuredRanges, 2) };
    }
}
