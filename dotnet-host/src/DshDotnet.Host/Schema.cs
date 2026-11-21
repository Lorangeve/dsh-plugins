using System.Reflection;
using System.Text.Json.Nodes;

namespace DshDotnet.Host;

/// <summary>Derives a JSON Schema for a tool method's parameters.</summary>
internal static class Schema
{
    public static JsonObject Build(MethodInfo method)
    {
        var properties = new JsonObject();
        var required = new JsonArray();

        foreach (var parameter in method.GetParameters())
        {
            if (parameter.Name is null || parameter.ParameterType == typeof(CancellationToken))
            {
                continue;
            }

            properties[parameter.Name] = For(parameter.ParameterType);
            if (!parameter.HasDefaultValue)
            {
                required.Add(parameter.Name);
            }
        }

        var schema = new JsonObject
        {
            ["type"] = "object",
            ["properties"] = properties,
            ["additionalProperties"] = false,
        };

        if (required.Count > 0)
        {
            schema["required"] = required;
        }

        return schema;
    }

    private static JsonNode For(Type type)
    {
        if (type == typeof(string) || type == typeof(char))
        {
            return new JsonObject { ["type"] = "string" };
        }

        if (type == typeof(bool))
        {
            return new JsonObject { ["type"] = "boolean" };
        }

        if (type == typeof(int) || type == typeof(long) || type == typeof(short) || type == typeof(byte) || type == typeof(uint) || type == typeof(ulong))
        {
            return new JsonObject { ["type"] = "integer" };
        }

        if (type == typeof(double) || type == typeof(float) || type == typeof(decimal))
        {
            return new JsonObject { ["type"] = "number" };
        }

        if (type == typeof(DateTime) || type == typeof(DateTimeOffset))
        {
            return new JsonObject { ["type"] = "string", ["format"] = "date-time" };
        }

        if (type == typeof(Guid))
        {
            return new JsonObject { ["type"] = "string", ["format"] = "uuid" };
        }

        if (type.IsEnum)
        {
            var names = new JsonArray(Enum.GetNames(type).Select(name => (JsonNode)JsonValue.Create(name)!).ToArray());
            return new JsonObject { ["type"] = "string", ["enum"] = names };
        }

        if (type.IsArray)
        {
            return new JsonObject { ["type"] = "array", ["items"] = For(type.GetElementType() ?? typeof(object)) };
        }

        if (Nullable.GetUnderlyingType(type) is { } underlying)
        {
            return For(underlying);
        }

        return new JsonObject { ["type"] = "object" };
    }
}
