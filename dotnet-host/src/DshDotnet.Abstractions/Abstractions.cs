using System.Text.Json.Nodes;

namespace DshDotnet;

/// <summary>A .NET plugin the worker can load and expose to DeepSeek Harness.</summary>
public interface IDshPlugin
{
    /// <summary>Short plugin name reported in tool metadata and logs.</summary>
    string Name { get; }
}

/// <summary>Marks one public instance method as a tool the Harness may call.</summary>
[AttributeUsage(AttributeTargets.Method, AllowMultiple = false)]
public sealed class DshToolAttribute : Attribute
{
    /// <summary>Describe one tool method.</summary>
    /// <param name="name">Tool name; keep it unique across plugins.</param>
    /// <param name="description">Sentence-case description shown to the model.</param>
    public DshToolAttribute(string name, string description)
    {
        Name = name;
        Description = description;
    }

    /// <summary>Tool name.</summary>
    public string Name { get; }

    /// <summary>Model-facing description.</summary>
    public string Description { get; }

    /// <summary>
    /// Optional JSON Schema for the parameters; omitted, the worker derives one
    /// from the method signature.
    /// </summary>
    public string? Schema { get; set; }

    /// <summary>
    /// Keep the method callable through the bridge service without appearing in
    /// the model's tool list. Use it for infrastructure the bridge exposes.
    /// </summary>
    public bool Hidden { get; set; }
}

/// <summary>Optional: receive Harness events the bridge forwards to the worker.</summary>
public interface IDshEvents
{
    /// <summary>Handle one forwarded event; throwing does not disturb other plugins.</summary>
    /// <param name="name">Event name, such as <c>agent/status</c>.</param>
    /// <param name="data">Event payload as forwarded JSON.</param>
    void OnEvent(string name, JsonNode? data);
}

/// <summary>Report progress for the tool call that is currently executing.</summary>
public static class DshCall
{
    /// <summary>Installed by the worker; plugins never set it.</summary>
    public static Action<string, int?>? Sink { get; set; }

    /// <summary>
    /// Report one progress line. The Harness logs it and, when the client owns
    /// the card, surfaces it there.
    /// </summary>
    /// <param name="message">Short human-readable line.</param>
    /// <param name="percent">Completion percentage, 0-100, when known.</param>
    public static void Progress(string message, int? percent = null) => Sink?.Invoke(message, percent ?? -1);
}
