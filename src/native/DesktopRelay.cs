using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;

internal static class DesktopRelay {
    private static async Task Pump(Stream source, Stream destination) {
        byte[] buffer = new byte[16384];
        int count;
        while ((count = await source.ReadAsync(buffer, 0, buffer.Length)) > 0) {
            await destination.WriteAsync(buffer, 0, count);
            await destination.FlushAsync();
        }
    }
    private static string Quote(string value) {
        var text = new StringBuilder("\"");
        int slashes = 0;
        foreach (char c in value) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') text.Append('\\', slashes * 2 + 1);
            else text.Append('\\', slashes);
            text.Append(c); slashes = 0;
        }
        return text.Append('\\', slashes * 2).Append('"').ToString();
    }
    public static int Main(string[] args) {
        try {
            string node = Environment.GetEnvironmentVariable("AUTOCODEX_RELAY_NODE");
            string script = Environment.GetEnvironmentVariable("AUTOCODEX_RELAY_SCRIPT");
            if (!File.Exists(node) || !File.Exists(script)) { Console.Error.WriteLine("AutoCodex relay runtime was not configured. Start Codex with Start-AutoCodexDesktop.ps1."); return 2; }
            var arguments = new StringBuilder(Quote(script));
            foreach (string arg in args) arguments.Append(' ').Append(Quote(arg));
            var start = new ProcessStartInfo(node, arguments.ToString()) {
                UseShellExecute = false, CreateNoWindow = true,
                RedirectStandardInput = true, RedirectStandardOutput = true, RedirectStandardError = true
            };
            using (var proc = Process.Start(start)) {
                Task input = Pump(Console.OpenStandardInput(), proc.StandardInput.BaseStream).ContinueWith(t => { try { proc.StandardInput.Close(); } catch { } });
                Task output = Pump(proc.StandardOutput.BaseStream, Console.OpenStandardOutput());
                Task error = Pump(proc.StandardError.BaseStream, Console.OpenStandardError());
                proc.WaitForExit(); Task.WaitAll(output, error); return proc.ExitCode;
            }
        } catch (Exception error) { Console.Error.WriteLine("AutoCodex relay: " + error.Message); return 1; }
    }
}
