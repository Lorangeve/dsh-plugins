/**
 * The DeepSeek Harness .NET worker.
 *
 * One long-lived process starts once and then serves tool calls over newline
 * JSON frames on stdin/stdout. Frames:
 *
 *   worker -> host  {"type":"hello","protocol":1,...}
 *   host -> worker  {"type":"init","pluginsDirs":["...","..."]}
 *   worker -> host  {"type":"ready","tools":[...]}
 *   host -> worker  {"type":"call","id":12,"tool":"name","args":{...}}
 *   host -> worker  {"type":"cancel","id":12}
 *   worker -> host  {"type":"result","id":12,"ok":true,"value":...}
 *   worker -> host  {"type":"progress","id":12,"message":"...","percent":40}
 *   host -> worker  {"type":"event","name":"agent/status","data":{...}}
 *   worker -> host  {"type":"log","level":"info","message":"..."}
 *   host -> worker  {"type":"ping"}  ->  {"type":"pong"}
 *   host -> worker  {"type":"shutdown"}
 *
 * Calls run off the read loop, so a cancel frame is seen while the call is in
 * flight: methods that take a CancellationToken, or return Task, observe it.
 * Anything a plugin writes to Console is swallowed: stdout carries frames only.
 */

using System.Collections.Concurrent;
using System.Text;
using System.Text.Json;
using System.Text.Json.Nodes;
using System.Text.Json.Serialization;

namespace DshDotnet.Host;

internal static class Program
{
    private static TextWriter _protocol = TextWriter.Null;
    private static readonly object WriteGate = new();
    private static readonly ConcurrentDictionary<long, CancellationTokenSource> Calls = new();

    /// <summary>Call id of the tool invocation running on this async flow.</summary>
    internal static readonly AsyncLocal<long> CurrentCall = new();

    internal static readonly JsonSerializerOptions JsonOptions = new()
    {
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = JsonIgnoreCondition.WhenWritingNull,
        NumberHandling = JsonNumberHandling.AllowReadingFromString,
    };

    [STAThread]
    private static int Main(string[] args)
    {
        // A notification click starts this executable again with the URI; that
        // run is short-lived and never becomes a bridge worker.
        if (args.Length >= 2 && args[0] == "--open")
        {
            return Activation.Run(args[1]);
        }

        var directories = new List<string> { Path.Combine(AppContext.BaseDirectory, "plugins") };
        for (var index = 0; index + 1 < args.Length; index++)
        {
            if (args[index] == "--plugins")
            {
                directories = [args[index + 1]];
            }
        }

        var stdout = Console.Out;
        _protocol = stdout;

        // A plugin that logs with Console.WriteLine must not corrupt frames.
        Console.SetOut(TextWriter.Null);
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);

        DshCall.Sink = (message, percent) =>
        {
            var id = CurrentCall.Value;
            if (id > 0)
            {
                SendProgress(id, message, percent >= 0 ? percent : null);
            }
        };

        Send(new JsonObject
        {
            ["type"] = "hello",
            ["protocol"] = 2,
            ["runtime"] = Environment.Version.ToString(),
            ["arch"] = System.Runtime.InteropServices.RuntimeInformation.ProcessArchitecture.ToString().ToLowerInvariant(),
            ["os"] = Environment.OSVersion.VersionString,
            ["pid"] = Environment.ProcessId,
            ["pluginsDirs"] = new JsonArray(directories.Select(directory => (JsonNode)directory).ToArray()),
        });

        var registry = new PluginRegistry(SendLog);
        string? line;
        while ((line = Console.In.ReadLine()) is not null)
        {
            if (line.Trim().Length == 0)
            {
                continue;
            }

            if (!Dispatch(line, registry))
            {
                break;
            }
        }

        foreach (var call in Calls.Values)
        {
            try
            {
                call.Cancel();
            }
            catch
            {
                // Shutdown must not be blocked by a failing plugin.
            }
        }

        registry.Dispose();
        return 0;
    }

    private static bool Dispatch(string line, PluginRegistry registry)
    {
        JsonNode? parsed;
        try
        {
            parsed = JsonNode.Parse(line);
        }
        catch (JsonException error)
        {
            SendLog("warn", "unreadable frame: " + error.Message);
            return true;
        }

        if (parsed is not JsonObject frame)
        {
            return true;
        }

        switch ((string?)frame["type"])
        {
            case "init":
            {
                var directories = new List<string>();
                if (frame["pluginsDirs"] is JsonArray array)
                {
                    directories.AddRange(array.Select(node => node?.ToString() ?? string.Empty).Where(path => path.Length > 0));
                }

                if (directories.Count == 0)
                {
                    directories.Add((string?)frame["pluginsDir"] ?? Path.Combine(AppContext.BaseDirectory, "plugins"));
                }

                registry.Load(directories);
                Send(new JsonObject
                {
                    ["type"] = "ready",
                    ["tools"] = new JsonArray(registry.VisibleTools.Select(tool => (JsonNode)tool.Describe()).ToArray()),
                });
                return true;
            }

            case "call":
            {
                var id = frame["id"]?.GetValue<long>() ?? 0;
                var tool = (string?)frame["tool"] ?? string.Empty;
                var arguments = frame["args"] as JsonObject ?? new JsonObject();
                var cancellation = new CancellationTokenSource();
                Calls[id] = cancellation;
                _ = Task.Run(() => Invoke(registry, id, tool, arguments, cancellation));
                return true;
            }

            case "cancel":
            {
                var id = frame["id"]?.GetValue<long>() ?? 0;
                if (Calls.TryRemove(id, out var cancellation))
                {
                    try
                    {
                        cancellation.Cancel();
                    }
                    catch
                    {
                        // The call already settled.
                    }
                }

                return true;
            }

            case "event":
                registry.Publish((string?)frame["name"] ?? string.Empty, frame["data"]);
                return true;

            case "ping":
                Send(new JsonObject { ["type"] = "pong" });
                return true;

            case "shutdown":
                return false;

            default:
                SendLog("warn", $"unknown frame type '{frame["type"]}'");
                return true;
        }
    }

    private static void Invoke(PluginRegistry registry, long id, string tool, JsonObject arguments, CancellationTokenSource cancellation)
    {
        CurrentCall.Value = id;
        try
        {
            var value = registry.Invoke(tool, arguments, cancellation.Token);
            Send(new JsonObject { ["type"] = "result", ["id"] = id, ["ok"] = true, ["value"] = value });
        }
        catch (OperationCanceledException)
        {
            Send(new JsonObject { ["type"] = "result", ["id"] = id, ["ok"] = false, ["error"] = "cancelled", ["cancelled"] = true });
        }
        catch (Exception error)
        {
            Send(new JsonObject { ["type"] = "result", ["id"] = id, ["ok"] = false, ["error"] = error.Message });
        }
        finally
        {
            Calls.TryRemove(id, out _);
            cancellation.Dispose();
        }
    }

    /// <summary>Publish progress for one in-flight call; plugins call this through <see cref="IDshProgress"/>.</summary>
    internal static void SendProgress(long id, string message, int? percent) =>
        Send(new JsonObject
        {
            ["type"] = "progress",
            ["id"] = id,
            ["message"] = message,
            ["percent"] = percent is null ? null : JsonValue.Create(percent.Value),
        });

    internal static void Send(JsonObject frame)
    {
        var text = frame.ToJsonString(JsonOptions);
        lock (WriteGate)
        {
            _protocol.WriteLine(text);
            _protocol.Flush();
        }
    }

    internal static void SendLog(string level, string message) =>
        Send(new JsonObject { ["type"] = "log", ["level"] = level, ["message"] = message });
}
