using System.Reflection;
using System.Runtime.Loader;
using System.Text.Json;
using System.Text.Json.Nodes;

namespace DshDotnet.Host;

/// <summary>One callable method discovered on a loaded plugin.</summary>
internal sealed class ToolEntry
{
    public required string Name { get; init; }

    public required string Description { get; init; }

    public required string Plugin { get; init; }

    public required JsonObject InputSchema { get; init; }

    public required MethodInfo Method { get; init; }

    public required object Instance { get; init; }

    public bool Hidden { get; init; }

    public JsonObject Describe() => new()
    {
        ["name"] = Name,
        ["description"] = Description,
        ["plugin"] = Plugin,
        ["inputSchema"] = InputSchema.DeepClone(),
    };
}

/// <summary>Loads plugin assemblies into collectible contexts and dispatches tool calls.</summary>
internal sealed class PluginRegistry : IDisposable
{
    private readonly List<ToolEntry> _tools = [];
    private readonly Dictionary<string, ToolEntry> _byName = new(StringComparer.Ordinal);
    private readonly List<PluginLoadContext> _contexts = [];
    private readonly List<object> _instances = [];
    private readonly Action<string, string> _log;

    public PluginRegistry(Action<string, string> log) => _log = log;

    /// <summary>Tools the model may see; hidden ones stay callable through the bridge.</summary>
    public IEnumerable<ToolEntry> VisibleTools => _tools.Where(tool => !tool.Hidden);

    public void Load(IEnumerable<string> directories)
    {
        foreach (var directory in directories)
        {
            if (!Directory.Exists(directory))
            {
                _log("warn", $"plugins directory does not exist: {directory}");
                continue;
            }

            foreach (var path in Directory.EnumerateFiles(directory, "*.dll").OrderBy(file => file, StringComparer.OrdinalIgnoreCase))
            {
                var fileName = Path.GetFileName(path);
                if (fileName.Equals("DshDotnet.Abstractions.dll", StringComparison.OrdinalIgnoreCase))
                {
                    continue;
                }

                try
                {
                    LoadAssembly(path, fileName);
                }
                catch (Exception error)
                {
                    _log("warn", $"{fileName}: {error.GetType().Name}: {error.Message}");
                }
            }
        }
    }

    private void LoadAssembly(string path, string fileName)
    {
        var context = new PluginLoadContext(path);
        var assembly = context.LoadFromAssemblyPath(Path.GetFullPath(path));
        _contexts.Add(context);

        var loaded = 0;
        foreach (var type in assembly.GetTypes())
        {
            if (!type.IsClass || type.IsAbstract || !typeof(IDshPlugin).IsAssignableFrom(type))
            {
                continue;
            }

            var instance = Activator.CreateInstance(type);
            if (instance is not IDshPlugin plugin)
            {
                continue;
            }

            _instances.Add(instance);
            foreach (var method in type.GetMethods(BindingFlags.Public | BindingFlags.Instance | BindingFlags.DeclaredOnly))
            {
                var attribute = method.GetCustomAttribute<DshToolAttribute>();
                if (attribute is null)
                {
                    continue;
                }

                if (_byName.ContainsKey(attribute.Name))
                {
                    _log("warn", $"{fileName}: tool '{attribute.Name}' is already registered; skipped");
                    continue;
                }

                var schema = attribute.Schema is null
                    ? Schema.Build(method)
                    : JsonNode.Parse(attribute.Schema) as JsonObject ?? Schema.Build(method);

                var tool = new ToolEntry
                {
                    Name = attribute.Name,
                    Description = attribute.Description,
                    Plugin = plugin.Name,
                    InputSchema = schema,
                    Method = method,
                    Instance = instance,
                    Hidden = attribute.Hidden,
                };

                _byName[tool.Name] = tool;
                _tools.Add(tool);
                loaded++;
            }
        }

        _log(loaded == 0 ? "info" : "info", loaded == 0
            ? $"{fileName}: no [DshTool] methods found"
            : $"{fileName}: registered {loaded} tool(s)");
    }

    public JsonNode? Invoke(string name, JsonObject arguments, CancellationToken cancellation)
    {
        if (!_byName.TryGetValue(name, out var tool))
        {
            throw new InvalidOperationException($"unknown tool '{name}'");
        }

        var parameters = tool.Method.GetParameters();
        var values = new object?[parameters.Length];
        for (var index = 0; index < parameters.Length; index++)
        {
            var parameter = parameters[index];
            if (parameter.ParameterType == typeof(CancellationToken))
            {
                values[index] = cancellation;
                continue;
            }

            var node = arguments[parameter.Name ?? string.Empty];
            if (node is null)
            {
                if (parameter.HasDefaultValue)
                {
                    values[index] = parameter.DefaultValue;
                    continue;
                }

                if (!parameter.ParameterType.IsValueType || Nullable.GetUnderlyingType(parameter.ParameterType) is not null)
                {
                    values[index] = null;
                    continue;
                }

                throw new InvalidOperationException($"missing argument '{parameter.Name}'");
            }

            values[index] = JsonSerializer.Deserialize(node.ToJsonString(), parameter.ParameterType, Program.JsonOptions);
        }

        cancellation.ThrowIfCancellationRequested();

        object? result;
        try
        {
            result = tool.Method.Invoke(tool.Instance, values);
        }
        catch (TargetInvocationException wrapped) when (wrapped.InnerException is not null)
        {
            throw wrapped.InnerException;
        }

        if (result is Task task)
        {
            try
            {
                task.Wait(cancellation);
            }
            catch (AggregateException aggregate) when (aggregate.InnerException is OperationCanceledException)
            {
                throw new OperationCanceledException(cancellation);
            }

            var property = task.GetType().GetProperty("Result");
            result = property is null ? null : property.GetValue(task);
        }

        cancellation.ThrowIfCancellationRequested();
        return result is null ? null : JsonSerializer.SerializeToNode(result, result.GetType(), Program.JsonOptions);
    }

    public void Publish(string name, JsonNode? data)
    {
        foreach (var sink in _instances.OfType<IDshEvents>())
        {
            try
            {
                sink.OnEvent(name, data);
            }
            catch (Exception error)
            {
                _log("warn", $"{sink.GetType().Name} failed on event '{name}': {error.Message}");
            }
        }
    }

    public void Dispose()
    {
        foreach (var instance in _instances)
        {
            if (instance is IDisposable disposable)
            {
                try
                {
                    disposable.Dispose();
                }
                catch
                {
                    // A failing plugin must not block shutdown.
                }
            }
        }

        _instances.Clear();
        foreach (var context in _contexts)
        {
            context.Unload();
        }

        _contexts.Clear();
        _tools.Clear();
        _byName.Clear();
    }
}

/// <summary>Loads one plugin assembly, keeping shared abstractions in the default context.</summary>
internal sealed class PluginLoadContext(string path) : AssemblyLoadContext(isCollectible: true)
{
    private readonly AssemblyDependencyResolver _resolver = new(path);

    protected override Assembly? Load(AssemblyName name)
    {
        // One type identity: the worker's own copy of the abstractions wins.
        if (string.Equals(name.Name, "DshDotnet.Abstractions", StringComparison.OrdinalIgnoreCase))
        {
            return null;
        }

        var resolved = _resolver.ResolveAssemblyToPath(name);
        return resolved is null ? null : LoadFromAssemblyPath(resolved);
    }
}
