using System.Runtime.InteropServices;
using System.Security;
using System.Text;
using DshDotnet;
using Windows.Data.Xml.Dom;
using Windows.UI.Notifications;

namespace DshDotnet.Notify;

/// <summary>
/// Toast sender for the desktop-notifications bundle, loaded by the .NET worker.
/// Registration, the toast XML, and the URI scheme all live here, so raising a
/// notification costs one bridge call and a click starts the same worker
/// executable in <c>--open</c> mode. No PowerShell involved.
/// </summary>
public sealed class NotifyPlugin : IDshPlugin
{
    private const string AppUserModelId = "DeepSeek.Harness.DesktopNotify";
    private const string Scheme = "dshnotify";
    private const string ShortcutFileName = "DeepSeek Harness Notify.lnk";
    private const string AppDisplayName = "DeepSeek Harness";

    private static readonly object Gate = new();
    private static bool _registered;

    public string Name => "desktop-notify";

    /// <summary>The bridge executable; a click starts it again with <c>--open</c>.</summary>
    private static string HostExecutable() =>
        Environment.ProcessPath ?? Path.Combine(AppContext.BaseDirectory, "DshDotnet.Host.exe");

    /// <summary>
    /// Raise one notification. Registration is idempotent and cheap after the
    /// first call, so the bridge never has to sequence it.
    /// </summary>
    [DshTool("desktop_toast", "Internal: raise a Windows notification and register its activation scheme.", Hidden = true)]
    public object Toast(
        string title,
        string body = "",
        string kind = "info",
        string session = "",
        string origin = "",
        string url = "",
        string token = "",
        string action = "打开会话",
        string app = "")
    {
        var result = new Dictionary<string, object?>
        {
            ["registered"] = false,
            ["shown"] = false,
        };

        try
        {
            result["registered"] = EnsureRegistered(app.Length > 0 ? app : HostExecutable());
        }
        catch (Exception error)
        {
            result["registrationError"] = $"{error.GetType().Name}: {error.Message}";
        }

        try
        {
            Show(title, body, kind, session, origin, url, token, action);
            result["shown"] = true;
        }
        catch (Exception error)
        {
            result["toastError"] = $"{error.GetType().Name}: {error.Message}";
        }

        return result;
    }

    // ------------------------------------------------------------------ toast

    private static void Show(string title, string body, string kind, string session, string origin, string url, string token, string action)
    {
        var target = BuildTarget(origin, url, session, token);
        var hasTarget = origin.Length > 0 && session.Length > 0;
        var attributes = hasTarget ? $"activationType=\"protocol\" launch=\"{Escape(target)}\"" : "activationType=\"protocol\"";

        if (kind is "attention" or "error")
        {
            attributes += " scenario=\"reminder\" duration=\"long\"";
        }

        var builder = new StringBuilder(1024);
        builder.Append("<toast ").Append(attributes).Append("><visual><binding template=\"ToastGeneric\">");
        builder.Append("<text>").Append(Escape(Clamp(title, 100))).Append("</text>");
        if (body.Length > 0)
        {
            builder.Append("<text>").Append(Escape(Clamp(body, 260))).Append("</text>");
        }

        builder.Append("<text placement=\"attribution\">").Append(Escape(AppDisplayName)).Append("</text>");
        builder.Append("</binding></visual>");

        if (hasTarget)
        {
            builder.Append("<actions><action content=\"").Append(Escape(Clamp(action, 40)))
                .Append("\" activationType=\"protocol\" arguments=\"").Append(Escape(target)).Append("\"/></actions>");
        }

        builder.Append("<audio src=\"ms-winsoundevent:Notification.Default\"/></toast>");

        var document = new XmlDocument();
        document.LoadXml(builder.ToString());

        var toast = new ToastNotification(document)
        {
            Tag = "dsh-" + StableTag(session.Length > 0 ? session : title),
            Group = "dsh",
        };

        ToastNotificationManager.CreateToastNotifier(AppUserModelId).Show(toast);
    }

    private static string BuildTarget(string origin, string url, string session, string token) =>
        $"{Scheme}:open?o={Uri.EscapeDataString(origin)}&u={Uri.EscapeDataString(url)}" +
        $"&s={Uri.EscapeDataString(session)}&t={Uri.EscapeDataString(token)}";

    // ----------------------------------------------------------- registration

    private static bool EnsureRegistered(string appPath)
    {
        lock (Gate)
        {
            if (_registered && IsRegistered())
            {
                return true;
            }

            RegisterShortcut(appPath);
            RegisterProtocol();
            _registered = true;
            return true;
        }
    }

    private static string ShortcutPath() => Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData),
        @"Microsoft\Windows\Start Menu\Programs",
        ShortcutFileName);

    private static string ProtocolCommand() =>
        $"\"{HostExecutable()}\" --open \"%1\"";

    private static bool IsRegistered()
    {
        try
        {
            using var command = Microsoft.Win32.Registry.CurrentUser.OpenSubKey($@"Software\Classes\{Scheme}\shell\open\command");
            var registered = command?.GetValue(null) as string;
            if (registered is null || !registered.Contains(HostExecutable(), StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            using var appId = Microsoft.Win32.Registry.CurrentUser.OpenSubKey($@"Software\Classes\AppUserModelId\{AppUserModelId}");
            return appId?.GetValue("DisplayName") is not null && File.Exists(ShortcutPath());
        }
        catch
        {
            return false;
        }
    }

    private static void RegisterShortcut(string appPath)
    {
        var shortcut = ShortcutPath();
        Directory.CreateDirectory(Path.GetDirectoryName(shortcut)!);

        var link = (IShellLinkW)new ShellLink();
        link.SetPath(appPath);
        link.SetDescription(AppDisplayName);
        link.SetIconLocation(appPath, 0);

        var store = (IPropertyStore)link;
        var key = new PropertyKey
        {
            FormatId = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"),
            PropertyId = 5, // PKEY_AppUserModel_ID
        };
        var value = PropVariant.FromString(AppUserModelId);
        try
        {
            store.SetValue(ref key, ref value);
            store.Commit();
        }
        finally
        {
            value.Clear();
        }

        ((IPersistFile)link).Save(shortcut, true);

        using var appId = Microsoft.Win32.Registry.CurrentUser.CreateSubKey($@"Software\Classes\AppUserModelId\{AppUserModelId}");
        appId.SetValue("DisplayName", AppDisplayName);
        appId.SetValue("IconUri", appPath);
    }

    private static void RegisterProtocol()
    {
        using var root = Microsoft.Win32.Registry.CurrentUser.CreateSubKey($@"Software\Classes\{Scheme}");
        root.SetValue(null, "URL:DeepSeek Harness notification");
        root.SetValue("URL Protocol", string.Empty);
        using (var icon = root.CreateSubKey("DefaultIcon"))
        {
            icon.SetValue(null, $"{HostExecutable()},0");
        }

        using var command = root.CreateSubKey(@"shell\open\command");
        command.SetValue(null, ProtocolCommand());
    }

    // ---------------------------------------------------------------- helpers

    private static string Escape(string value) => SecurityElement.Escape(value) ?? string.Empty;

    private static string Clamp(string value, int limit) =>
        value.Length <= limit ? value : value[..(limit - 1)] + "…";

    /// <summary>Toast tags are limited to 16 characters.</summary>
    private static string StableTag(string value)
    {
        unchecked
        {
            var hash = 2166136261u;
            foreach (var character in value)
            {
                hash = (hash ^ character) * 16777619u;
            }

            return hash.ToString("x8");
        }
    }

    // ------------------------------------------------------------ COM interop

    [StructLayout(LayoutKind.Sequential)]
    private struct PropertyKey
    {
        public Guid FormatId;
        public int PropertyId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct PropVariant
    {
        public ushort VariantType;
        public ushort Reserved1;
        public ushort Reserved2;
        public ushort Reserved3;
        public IntPtr Pointer;
        public int Reserved4;

        public static PropVariant FromString(string value) => new()
        {
            VariantType = 31, // VT_LPWSTR
            Pointer = Marshal.StringToCoTaskMemUni(value),
        };

        public void Clear()
        {
            if (Pointer != IntPtr.Zero)
            {
                Marshal.FreeCoTaskMem(Pointer);
                Pointer = IntPtr.Zero;
            }
        }
    }

    [ComImport]
    [Guid("00021401-0000-0000-C000-000000000046")]
    [ClassInterface(ClassInterfaceType.None)]
    private class ShellLink
    {
    }

    [ComImport]
    [Guid("000214F9-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellLinkW
    {
        void GetPath([MarshalAs(UnmanagedType.LPWStr)] StringBuilder file, int maximum, IntPtr data, uint flags);

        void GetIDList(out IntPtr list);

        void SetIDList(IntPtr list);

        void GetDescription([MarshalAs(UnmanagedType.LPWStr)] StringBuilder name, int maximum);

        void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string name);

        void GetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] StringBuilder directory, int maximum);

        void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string directory);

        void GetArguments([MarshalAs(UnmanagedType.LPWStr)] StringBuilder arguments, int maximum);

        void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string arguments);

        void GetHotkey(out short hotkey);

        void SetHotkey(short hotkey);

        void GetShowCommand(out int command);

        void SetShowCommand(int command);

        void GetIconLocation([MarshalAs(UnmanagedType.LPWStr)] StringBuilder icon, int maximum, out int index);

        void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string icon, int index);

        void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string path, uint reserved);

        void Resolve(IntPtr handle, uint flags);

        void SetPath([MarshalAs(UnmanagedType.LPWStr)] string path);
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPropertyStore
    {
        void GetCount(out uint count);

        void GetAt(uint index, out PropertyKey key);

        void GetValue(ref PropertyKey key, out PropVariant value);

        void SetValue(ref PropertyKey key, ref PropVariant value);

        void Commit();
    }

    [ComImport]
    [Guid("0000010B-0000-0000-C000-000000000046")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IPersistFile
    {
        void GetClassId(out Guid classId);

        [PreserveSig]
        int IsDirty();

        void Load([MarshalAs(UnmanagedType.LPWStr)] string fileName, uint mode);

        void Save([MarshalAs(UnmanagedType.LPWStr)] string? fileName, [MarshalAs(UnmanagedType.Bool)] bool remember);

        void SaveCompleted([MarshalAs(UnmanagedType.LPWStr)] string fileName);

        void GetCurFile([MarshalAs(UnmanagedType.LPWStr)] out string fileName);
    }
}
