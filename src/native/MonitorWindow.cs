using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

[assembly: System.Runtime.Versioning.TargetFramework(".NETFramework,Version=v4.8")]

// The window hosts the authenticated local panel; no privileged JavaScript bridge.
internal static class MonitorWindow {
    [STAThread]
    private static int Main(string[] args) {
        // WinForms reads PerMonitorV2 from the adjacent exe.config here, before
        // WebView2 or any native window can lock the process to unaware scaling.
        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);
        try {
            if (args.Length < 1) throw new Exception("请从 Start-AutoCodex.cmd 启动 AutoCodex。");
            string path = Path.GetFullPath(args[0]);
            var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
            string origin = Convert.ToString(data["origin"]), token = Convert.ToString(data["token"]);
            if (!Regex.IsMatch(origin, @"^http://127\.0\.0\.1:[1-9]\d{0,4}$") || !Regex.IsMatch(token, "^[a-f0-9]{64}$")) throw new Exception("本机连接文件无效。");
            var uri = new Uri(origin);
            string version = CoreWebView2Environment.GetAvailableBrowserVersionString();
            if (args.Length > 1 && args[1] == "--check") { Console.WriteLine("WebView2 " + version); return 0; }
            string hash;
            using (var sha = SHA256.Create()) hash = BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(path.ToUpperInvariant()))).Replace("-", "");
            bool created;
            using (var mutex = new Mutex(true, "Local\\AutoCodex.Window." + hash, out created))
            using (var wake = new EventWaitHandle(false, EventResetMode.AutoReset, "Local\\AutoCodex.Wake." + hash)) {
                if (!created) { wake.Set(); return 0; }
                Application.Run(new Dashboard(path, origin, wake)); mutex.ReleaseMutex();
            }
            return 0;
        } catch (Exception error) {
            if (args.Length > 1 && args[1] == "--check") { Console.Error.WriteLine(error.Message); return 1; }
            MessageBox.Show("独立窗口未能打开：" + error.Message + "\n\n请安装 Microsoft Edge WebView2 Runtime，或使用 Start-AutoCodexBrowser.cmd 打开网页版。后台监测不受影响。", "AutoCodex", MessageBoxButtons.OK, MessageBoxIcon.Information);
            return 1;
        }
    }
}

internal sealed class Dashboard : Form {
    private readonly string path, origin;
    private readonly EventWaitHandle wake;
    private readonly WebView2 view = new WebView2();
    private readonly System.Windows.Forms.Timer timer = new System.Windows.Forms.Timer();
    private readonly ToolStripStatusLabel status = new ToolStripStatusLabel("正在连接本机监测服务…");
    public Dashboard(string connectionPath, string serviceOrigin, EventWaitHandle wakeEvent) {
        SuspendLayout();
        AutoScaleDimensions = new SizeF(96F, 96F);
        AutoScaleMode = AutoScaleMode.Dpi;
        path = connectionPath; origin = serviceOrigin; wake = wakeEvent;
        Text = "AutoCodex · 本机监护"; Width = 1360; Height = 920; MinimumSize = new Size(700, 540); StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(12, 17, 24);
        var toolbar = new ToolStrip { GripStyle = ToolStripGripStyle.Hidden, BackColor = Color.FromArgb(20, 29, 40), ForeColor = Color.White };
        var browser = new ToolStripButton("在浏览器打开"); browser.Click += delegate { OpenBrowser(); };
        var refresh = new ToolStripButton("刷新"); refresh.Click += delegate { if (view.CoreWebView2 != null) view.CoreWebView2.Reload(); };
        toolbar.Items.Add(browser); toolbar.Items.Add(refresh);
        var strip = new StatusStrip { BackColor = toolbar.BackColor, ForeColor = Color.LightGray }; strip.Items.Add(status);
        view.Dock = DockStyle.Fill; Controls.Add(view); Controls.Add(toolbar); Controls.Add(strip);
        timer.Interval = 300; timer.Tick += delegate { if (wake.WaitOne(0)) { Show(); WindowState = FormWindowState.Normal; Activate(); } }; timer.Start();
        Load += async delegate {
            try {
                var environment = await CoreWebView2Environment.CreateAsync(null, Path.Combine(Path.GetDirectoryName(path), "window-profile"));
                await view.EnsureCoreWebView2Async(environment);
                view.CoreWebView2.Settings.IsStatusBarEnabled = false;
                view.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
                await view.CoreWebView2.AddScriptToExecuteOnDocumentCreatedAsync("window.autocodexDesktop = true;");
                view.CoreWebView2.NavigationStarting += delegate(object sender, CoreWebView2NavigationStartingEventArgs e) {
                    Uri destination;
                    if (!Uri.TryCreate(e.Uri, UriKind.Absolute, out destination) || destination.GetLeftPart(UriPartial.Authority) != origin) e.Cancel = true;
                };
                view.CoreWebView2.NewWindowRequested += delegate(object sender, CoreWebView2NewWindowRequestedEventArgs e) { e.Handled = true; };
                view.CoreWebView2.WindowCloseRequested += delegate { Close(); };
                view.CoreWebView2.NavigationCompleted += delegate(object sender, CoreWebView2NavigationCompletedEventArgs e) {
                    status.Text = e.IsSuccess ? "关闭本窗口后，后台监测仍继续运行。" : "连接暂不可用；服务恢复后点击刷新。";
                };
                view.CoreWebView2.Navigate(LaunchUrl());
            } catch (Exception error) { status.Text = "窗口加载失败，可点击“在浏览器打开”：" + error.Message; }
        };
        // Clamp only after native placement and initial DPI layout have finished.
        Shown += delegate { BeginInvoke((Action)delegate { if (!IsDisposed) FitWorkingArea(true); }); };
        FormClosed += delegate { timer.Stop(); timer.Dispose(); view.Dispose(); };
        ResumeLayout(true);
    }
    protected override void OnDpiChanged(DpiChangedEventArgs e) {
        base.OnDpiChanged(e);
        // Let WinForms apply its new DPI bounds before clamping to the new screen.
        BeginInvoke((Action)delegate { if (!IsDisposed) FitWorkingArea(false); });
    }
    private void FitWorkingArea(bool center) {
        if (WindowState != FormWindowState.Normal) return;
        var area = Screen.FromControl(this).WorkingArea;
        MinimumSize = new Size(Math.Min(LogicalToDeviceUnits(700), area.Width), Math.Min(LogicalToDeviceUnits(540), area.Height));
        int width = Math.Min(Width, area.Width), height = Math.Min(Height, area.Height);
        int left = center ? area.Left + (area.Width - width) / 2 : Math.Max(area.Left, Math.Min(Left, area.Right - width));
        int top = center ? area.Top + (area.Height - height) / 2 : Math.Max(area.Top, Math.Min(Top, area.Bottom - height));
        SetBounds(left, top, width, height);
    }
    private string LaunchUrl() {
        var data = new JavaScriptSerializer().Deserialize<Dictionary<string, object>>(File.ReadAllText(path));
        if (Convert.ToString(data["origin"]) != origin || !Regex.IsMatch(Convert.ToString(data["token"]), "^[a-f0-9]{64}$")) throw new Exception("连接已变更，请重新启动窗口。");
        return origin + "/#token=" + Convert.ToString(data["token"]);
    }
    private void OpenBrowser() {
        try { Process.Start(new ProcessStartInfo(LaunchUrl()) { UseShellExecute = true }); }
        catch (Exception error) { MessageBox.Show(this, error.Message, "打开浏览器失败"); }
    }
}
