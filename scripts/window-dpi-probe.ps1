param([Parameter(Mandatory = $true)][int]$WindowProcessId)
$ErrorActionPreference = 'Stop'
# Read-only native diagnostics. Never resize windows or change display settings.
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
public static class WindowDpiProbe {
    public delegate bool WindowCallback(IntPtr window, IntPtr data);
    [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] public struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] public static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] public static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] public static extern bool AreDpiAwarenessContextsEqual(IntPtr a, IntPtr b);
    [DllImport("user32.dll")] public static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] public static extern IntPtr MonitorFromWindow(IntPtr window, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] public static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("shcore.dll")] public static extern int GetScaleFactorForMonitor(IntPtr monitor, out int scale);
    [DllImport("shcore.dll")] public static extern int GetProcessDpiAwareness(IntPtr process, out int awareness);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, IntPtr data);
    [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, WindowCallback callback, IntPtr data);
    [DllImport("user32.dll", CharSet = CharSet.Auto)] private static extern int GetClassName(IntPtr window, StringBuilder name, int length);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
    public static IntPtr FindWindow(int processId) {
        IntPtr found = IntPtr.Zero; long largest = 0;
        EnumWindows(delegate(IntPtr window, IntPtr data) {
            uint owner; GetWindowThreadProcessId(window, out owner);
            if (owner != processId) return true;
            Rect bounds;
            if (GetClientRect(window, out bounds)) {
                long area = (long)(bounds.Right - bounds.Left) * (bounds.Bottom - bounds.Top);
                if (area > largest) { found = window; largest = area; }
            }
            return true;
        }, IntPtr.Zero);
        return found;
    }
    public static object[] Children(IntPtr parent) {
        var result = new List<object>();
        EnumChildWindows(parent, delegate(IntPtr child, IntPtr data) {
            var name = new StringBuilder(128); GetClassName(child, name, name.Capacity);
            Rect rect; GetWindowRect(child, out rect);
            result.Add(new { className = name.ToString(), left = rect.Left, top = rect.Top, width = rect.Right - rect.Left, height = rect.Bottom - rect.Top });
            return true;
        }, IntPtr.Zero);
        return result.ToArray();
    }
}
'@
$process = Get-Process -Id $WindowProcessId -ErrorAction Stop
$window = [WindowDpiProbe]::FindWindow($WindowProcessId)
if ($window -eq [IntPtr]::Zero) { throw 'Test process has no native window.' }
# Opt in for this diagnostic thread only so sizes are physical pixels.
$previous = [WindowDpiProbe]::SetThreadDpiAwarenessContext([IntPtr](-4))
try {
    $context = [WindowDpiProbe]::GetWindowDpiAwarenessContext($window)
    $rect = New-Object WindowDpiProbe+Rect
    $client = New-Object WindowDpiProbe+Rect
    if (-not [WindowDpiProbe]::GetWindowRect($window, [ref]$rect) -or -not [WindowDpiProbe]::GetClientRect($window, [ref]$client)) { throw 'Window size query failed.' }
    $monitor = [WindowDpiProbe]::MonitorFromWindow($window, 2)
    $info = New-Object WindowDpiProbe+MonitorInfo
    $info.Size = [Runtime.InteropServices.Marshal]::SizeOf($info)
    if (-not [WindowDpiProbe]::GetMonitorInfo($monitor, [ref]$info)) { throw 'Monitor query failed.' }
    $scale = 0; $awareness = 0
    if ([WindowDpiProbe]::GetScaleFactorForMonitor($monitor, [ref]$scale) -ne 0 -or [WindowDpiProbe]::GetProcessDpiAwareness($process.Handle, [ref]$awareness) -ne 0) { throw 'DPI query failed.' }
    [ordered]@{
        processId = $WindowProcessId
        awareness = $awareness
        perMonitorV2 = [WindowDpiProbe]::AreDpiAwarenessContextsEqual($context, [IntPtr](-4))
        dpi = [WindowDpiProbe]::GetDpiForWindow($window)
        monitorScalePercent = $scale
        width = $rect.Right - $rect.Left; height = $rect.Bottom - $rect.Top
        left = $rect.Left; top = $rect.Top
        clientWidth = $client.Right - $client.Left; clientHeight = $client.Bottom - $client.Top
        insideWorkArea = $rect.Left -ge $info.Work.Left -and $rect.Top -ge $info.Work.Top -and $rect.Right -le $info.Work.Right -and $rect.Bottom -le $info.Work.Bottom
        workArea = @{ width = $info.Work.Right - $info.Work.Left; height = $info.Work.Bottom - $info.Work.Top }
        children = [WindowDpiProbe]::Children($window)
    } | ConvertTo-Json -Depth 5
} finally { [WindowDpiProbe]::SetThreadDpiAwarenessContext($previous) | Out-Null }
