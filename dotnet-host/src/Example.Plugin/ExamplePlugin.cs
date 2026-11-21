using System.Text.Json.Nodes;
using DshDotnet;

namespace Example.Plugin;

/// <summary>
/// Demonstrates the four things the worker exists for: exposing .NET code as
/// Harness tools, using Windows/.NET APIs that are painful in JS, reporting
/// progress, and observing cancellation.
/// </summary>
public sealed class ExamplePlugin : IDshPlugin, IDshEvents
{
    private int _eventCount;

    public string Name => "example";

    [DshTool("hello_dotnet", "Return a greeting built inside the .NET worker; a smoke test for the bridge.")]
    public object Greet(string name = "world") => new
    {
        message = $"hello {name}",
        runtime = Environment.Version.ToString(),
        processId = Environment.ProcessId,
        eventCount = _eventCount,
    };

    [DshTool("dotnet_sysinfo", "Report OS, CPU, memory and fixed drives, gathered with System.IO and the Windows/.NET APIs.")]
    public object SysInfo()
    {
        var drives = DriveInfo.GetDrives()
            .Where(drive => drive.DriveType == DriveType.Fixed && drive.IsReady)
            .Select(drive => new
            {
                name = drive.Name,
                label = drive.VolumeLabel,
                format = drive.DriveFormat,
                totalGb = Math.Round(drive.TotalSize / 1024d / 1024d / 1024d, 1),
                freeGb = Math.Round(drive.AvailableFreeSpace / 1024d / 1024d / 1024d, 1),
            })
            .ToArray();

        return new
        {
            os = Environment.OSVersion.VersionString,
            machine = Environment.MachineName,
            user = Environment.UserName,
            runtime = System.Runtime.InteropServices.RuntimeInformation.FrameworkDescription,
            processors = Environment.ProcessorCount,
            workingSetMb = Math.Round(Environment.WorkingSet / 1024d / 1024d, 1),
            uptimeHours = Math.Round(Environment.TickCount64 / 3_600_000d, 1),
            drives,
        };
    }

    [DshTool("dotnet_read_registry", "Read one HKCU or HKLM registry value; a read-only probe for Windows APIs.")]
    public object ReadRegistry(string path, string name)
    {
        var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(path) ?? Microsoft.Win32.Registry.LocalMachine.OpenSubKey(path);
        if (key is null)
        {
            return new { found = false, path, name };
        }

        using (key)
        {
            var value = key.GetValue(name);
            return new
            {
                found = value is not null,
                path,
                name,
                kind = key.GetValueKind(name).ToString(),
                value = value?.ToString(),
            };
        }
    }

    /// <summary>Progress + cancellation probe: an aborted call must report <c>cancelled</c>.</summary>
    [DshTool("dotnet_slow_work", "Report progress once per 200 ms for the requested duration; abort it to prove cancellation reaches the .NET side.")]
    public async Task<object> SlowWork(double seconds = 2, CancellationToken cancellation = default)
    {
        var total = Math.Max(0, seconds);
        var steps = (int)Math.Ceiling(total / 0.2);
        for (var step = 1; step <= steps; step++)
        {
            cancellation.ThrowIfCancellationRequested();
            await Task.Delay(200, cancellation);
            DshCall.Progress($"step {step}/{steps}", (int)Math.Round(step * 100d / steps));
        }

        return new { completed = true, seconds = total };
    }

    /// <summary>Diagnostic: report token shape and which writes this worker can perform.</summary>
    [DshTool("dotnet_env_probe", "Diagnostic: report the worker token (integrity, restricted SIDs) and whether it can write TEMP, HKCU and the Start Menu.")]
    public object EnvProbe()
    {
        var notes = new List<string>();
        void Try(string label, Action action)
        {
            try { action(); notes.Add(label + "=ok"); }
            catch (Exception error) { notes.Add(label + "=" + error.GetType().Name + ": " + error.Message); }
        }

        var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        Try("temp", () => File.WriteAllText(Path.Combine(Path.GetTempPath(), "dsh-worker-write.txt"), "x"));
        Try("hkcu-software", () => { using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\DshWorkerProbe"); key.SetValue("x", "y"); });
        Try("hkcu-classes", () => { using var key = Microsoft.Win32.Registry.CurrentUser.CreateSubKey(@"Software\Classes\DshWorkerProbe"); key.SetValue(null, "y"); });
        Try("startmenu", () =>
        {
            var dir = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), @"Microsoft\Windows\Start Menu\Programs");
            File.WriteAllText(Path.Combine(dir, "dsh-worker-probe.txt"), "x");
            File.Delete(Path.Combine(dir, "dsh-worker-probe.txt"));
        });

        return new
        {
            user = identity.Name,
            groups = identity.Groups.Count,
            integrity = IntegrityLevel(),
            restrictedSids = RestrictedSidCount(),
            processId = Environment.ProcessId,
            writes = notes,
        };
    }

    private static string IntegrityLevel()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var token = identity.Token;
        var size = 0;
        GetTokenInformation(token, 25, IntPtr.Zero, 0, out size);
        var buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
        try
        {
            if (!GetTokenInformation(token, 25, buffer, size, out _)) return "unknown";
            var level = System.Runtime.InteropServices.Marshal.ReadInt32(buffer, 8);
            return level switch
            {
                0x0000 => "untrusted",
                0x1000 => "low",
                0x2000 => "medium",
                0x2100 => "medium-plus",
                0x3000 => "high",
                _ => "0x" + level.ToString("x"),
            };
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer);
        }
    }

    private static int RestrictedSidCount()
    {
        using var identity = System.Security.Principal.WindowsIdentity.GetCurrent();
        var size = 0;
        GetTokenInformation(identity.Token, 12, IntPtr.Zero, 0, out size);
        if (size == 0) return 0;
        var buffer = System.Runtime.InteropServices.Marshal.AllocHGlobal(size);
        try
        {
            if (!GetTokenInformation(identity.Token, 12, buffer, size, out _)) return -1;
            return System.Runtime.InteropServices.Marshal.ReadInt32(buffer, 0);
        }
        finally
        {
            System.Runtime.InteropServices.Marshal.FreeHGlobal(buffer);
        }
    }

    [System.Runtime.InteropServices.DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(
        System.IntPtr token,
        int informationClass,
        System.IntPtr information,
        int length,
        out int returnLength);
    public void OnEvent(string name, JsonNode? data)
    {
        _eventCount++;
        if (name == "agent/status")
        {
            LogToConsole($"{data?["status"]} for {data?["agent"]?["id"]}");
        }
    }

    private static void LogToConsole(string message) => Console.WriteLine("[example] " + message);
}

