// Spike probe, not shipped: does the message body in Outlook or Word announce changes through UI Automation events?
// Built and run by scripts/live-outlook-check.ps1 -Events. Usage: EventProbe.exe <window handle> <seconds>
// Prints the patterns the body supports, then counts the events it raises while the test types and scrolls.
using System;
using System.Threading;
using System.Windows.Automation;

static class EventProbe
{
    static int textChanged;
    static int selectionChanged;
    static int scrollChanged;
    static int boundsChanged;

    static int Main(string[] args)
    {
        var hwnd = new IntPtr(long.Parse(args[0]));
        int seconds = int.Parse(args[1]);
        var window = AutomationElement.FromHandle(hwnd);
        var canvas = window.FindFirst(TreeScope.Descendants, new PropertyCondition(AutomationElement.ClassNameProperty, "_WwG"));
        if (canvas == null)
        {
            Console.WriteLine("no message body found");
            return 1;
        }
        Console.Write("patterns on the body:");
        foreach (var pattern in canvas.GetSupportedPatterns()) Console.Write(" " + Automation.PatternName(pattern));
        Console.WriteLine();

        Automation.AddAutomationEventHandler(TextPattern.TextChangedEvent, canvas, TreeScope.Element,
            (sender, e) => Interlocked.Increment(ref textChanged));
        Automation.AddAutomationEventHandler(TextPattern.TextSelectionChangedEvent, canvas, TreeScope.Element,
            (sender, e) => Interlocked.Increment(ref selectionChanged));
        Automation.AddAutomationPropertyChangedEventHandler(window, TreeScope.Subtree,
            (sender, e) => Interlocked.Increment(ref scrollChanged),
            ScrollPattern.VerticalScrollPercentProperty);
        Automation.AddAutomationPropertyChangedEventHandler(canvas, TreeScope.Element,
            (sender, e) => Interlocked.Increment(ref boundsChanged),
            AutomationElement.BoundingRectangleProperty);
        Console.WriteLine("listening for " + seconds + " s");
        Thread.Sleep(seconds * 1000);
        Console.WriteLine("text changed: " + textChanged + ", selection changed: " + selectionChanged
            + ", vertical scroll changed: " + scrollChanged + ", body bounds changed: " + boundsChanged);
        Automation.RemoveAllEventHandlers();
        return 0;
    }
}
