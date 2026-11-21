using System.Diagnostics;
using System.Net.Http;
using System.Runtime.InteropServices;
using System.Text;

namespace DshDotnet.Host;

/// <summary>
/// Notification-click handler. Windows starts this executable with
/// <c>--open dshnotify:open?o=...&amp;u=...&amp;s=...&amp;t=...</c>; it asks the
/// running Harness to focus that session and falls back to opening the GUI in
/// the default browser when no GUI is connected.
/// </summary>
internal static class Activation
{
    private static readonly string LogPath = Path.Combine(
        Path.GetTempPath(), "DeepSeekHarness", "desktop-notify.log");

    public static int Run(string uri)
    {
        if (string.IsNullOrWhiteSpace(uri))
        {
            return 2;
        }

        var query = ParseQuery(uri);
        var origin = (query.GetValueOrDefault("o") ?? string.Empty).TrimEnd('/');
        var session = query.GetValueOrDefault("s") ?? string.Empty;
        var token = query.GetValueOrDefault("t") ?? string.Empty;
        var gui = query.GetValueOrDefault("u") ?? string.Empty;
        Note($"open: origin={origin} session={session}");

        if (origin.Length == 0 || session.Length == 0)
        {
            Note("open: nothing to open");
            return 3;
        }

        if (token.Length > 0 && AskHost(origin, session, token))
        {
            BringHarnessToFront();
            return 0;
        }

        var baseUrl = gui.Length > 0 ? gui : origin;
        var separator = baseUrl.Contains('?', StringComparison.Ordinal) ? '&' : '?';
        OpenInBrowser($"{baseUrl}{separator}session={Uri.EscapeDataString(session)}");
        return 0;
    }

    /// <summary>Ask the Host to focus the session; true when a live GUI accepted it.</summary>
    private static bool AskHost(string origin, string session, string token)
    {
        try
        {
            using var client = new HttpClient { Timeout = TimeSpan.FromMilliseconds(1500) };
            var url = $"{origin}/dsh-notify/open?session={Uri.EscapeDataString(session)}&token={Uri.EscapeDataString(token)}";
            using var response = client.GetAsync(url).GetAwaiter().GetResult();
            var body = response.Content.ReadAsStringAsync().GetAwaiter().GetResult();
            var delivered = body.Contains("\"delivered\":true", StringComparison.Ordinal);
            Note($"host: status={(int)response.StatusCode} delivered={delivered}");
            return delivered;
        }
        catch (Exception error)
        {
            Note($"host: unreachable ({error.GetType().Name})");
            return false;
        }
    }

    private static void OpenInBrowser(string url)
    {
        try
        {
            Process.Start(new ProcessStartInfo(url) { UseShellExecute = true });
            Note($"browser: {url}");
        }
        catch (Exception error)
        {
            Note($"browser: failed ({error.GetType().Name})");
        }
    }

    private static Dictionary<string, string> ParseQuery(string uri)
    {
        var result = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        var question = uri.IndexOf('?', StringComparison.Ordinal);
        if (question < 0 || question == uri.Length - 1)
        {
            return result;
        }

        foreach (var pair in uri[(question + 1)..].Split('&', StringSplitOptions.RemoveEmptyEntries))
        {
            var equals = pair.IndexOf('=', StringComparison.Ordinal);
            if (equals < 0)
            {
                result[Uri.UnescapeDataString(pair)] = string.Empty;
            }
            else
            {
                result[Uri.UnescapeDataString(pair[..equals])] = Uri.UnescapeDataString(pair[(equals + 1)..]);
            }
        }

        return result;
    }

    private static void BringHarnessToFront()
    {
        try
        {
            var candidates = new List<(IntPtr Handle, bool Owned)>();
            EnumWindows((handle, _) =>
            {
                var length = GetWindowTextLength(handle);
                if (length <= 0)
                {
                    return true;
                }

                var title = new StringBuilder(length + 1);
                GetWindowText(handle, title, title.Capacity);
                if (title.ToString().Contains("DeepSeek Harness", StringComparison.OrdinalIgnoreCase))
                {
                    candidates.Add((handle, IsHarnessProcess(handle)));
                }

                return true;
            }, IntPtr.Zero);

            if (candidates.Count == 0)
            {
                Note("focus: no Harness window found");
                return;
            }

            // A browser tab titled "DeepSeek Harness" can match the same text,
            // so the product's own windows are attempted first.
            List<IntPtr> ordered =
            [
                .. candidates.Where(candidate => candidate.Owned).Select(candidate => candidate.Handle),
                .. candidates.Where(candidate => !candidate.Owned).Select(candidate => candidate.Handle),
            ];

            foreach (var handle in ordered)
            {
                if (!IsWindowVisible(handle))
                {
                    ShowWindow(handle, ShowWindowShow);
                }

                if (IsIconic(handle))
                {
                    ShowWindow(handle, ShowWindowRestore);
                }

                if (SetForegroundWindow(handle))
                {
                    Note("focus: raised the Harness window");
                    return;
                }

                if (ForceForeground(handle))
                {
                    Note("focus: forced the Harness window to the front");
                    return;
                }
            }

            Note($"focus: {ordered.Count} candidate(s) refused the foreground");
        }
        catch (Exception error)
        {
            Note($"focus: failed ({error.GetType().Name})");
        }
    }

    /// <summary>Whether a window belongs to the Harness process rather than a browser.</summary>
    private static bool IsHarnessProcess(IntPtr handle)
    {
        try
        {
            GetWindowThreadProcessId(handle, out var processId);
            if (processId == 0)
            {
                return false;
            }

            using var process = Process.GetProcessById((int)processId);
            return process.ProcessName.Contains("DeepSeek", StringComparison.OrdinalIgnoreCase);
        }
        catch
        {
            return false;
        }
    }

    /// <summary>
    /// Raise a window past the foreground lock Windows applies to a background
    /// process. Sharing the foreground thread's input queue is what makes
    /// <c>SetForegroundWindow</c> succeed; the shell activation path is the
    /// fallback when the queue is unavailable.
    /// </summary>
    private static bool ForceForeground(IntPtr handle)
    {
        var foreground = GetForegroundWindow();
        var foregroundThread = foreground == IntPtr.Zero ? 0 : (int)GetWindowThreadProcessId(foreground, out _);
        var currentThread = (int)GetCurrentThreadId();
        var attached = false;
        try
        {
            if (foregroundThread != 0 && foregroundThread != currentThread)
            {
                attached = AttachThreadInput(currentThread, foregroundThread, true);
            }

            BringWindowToTop(handle);
            SetActiveWindow(handle);
            SetFocus(handle);
            if (SetForegroundWindow(handle) || GetForegroundWindow() == handle)
            {
                return true;
            }

            SwitchToThisWindow(handle, true);
            return GetForegroundWindow() == handle;
        }
        finally
        {
            if (attached)
            {
                AttachThreadInput(currentThread, foregroundThread, false);
            }
        }
    }

    private static void Note(string message)
    {
        try
        {
            Directory.CreateDirectory(Path.GetDirectoryName(LogPath)!);
            File.AppendAllText(
                LogPath,
                $"{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff} {message}{Environment.NewLine}",
                Encoding.UTF8);
        }
        catch
        {
            // Diagnostics must never block the click.
        }
    }

    private const int ShowWindowShow = 5;
    private const int ShowWindowRestore = 9;

    private delegate bool EnumWindowsProc(IntPtr handle, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc callback, IntPtr parameter);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool IsIconic(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern int GetWindowTextLength(IntPtr handle);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr handle, StringBuilder text, int count);

    [DllImport("user32.dll")]
    private static extern bool SetForegroundWindow(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern bool ShowWindow(IntPtr handle, int command);

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    private static extern bool BringWindowToTop(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern IntPtr SetActiveWindow(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern IntPtr SetFocus(IntPtr handle);

    [DllImport("user32.dll")]
    private static extern void SwitchToThisWindow(IntPtr handle, bool altTab);

    [DllImport("user32.dll")]
    private static extern bool AttachThreadInput(int attach, int attachTo, bool join);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);

    [DllImport("kernel32.dll")]
    private static extern uint GetCurrentThreadId();
}
