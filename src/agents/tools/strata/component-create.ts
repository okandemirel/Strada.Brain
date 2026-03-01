import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath, isValidCSharpIdentifier, isValidCSharpType } from "../../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";

export class ComponentCreateTool implements ITool {
  readonly name = "strata_create_component";
  readonly description =
    "Create a new ECS component (unmanaged struct implementing IComponent) for Strada.Core. " +
    "Components are data-only structs that can be attached to entities.";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description:
          "Component name (e.g., 'Health', 'Velocity', 'DamageDealer')",
      },
      path: {
        type: "string",
        description:
          "Relative file path (e.g., 'Assets/Modules/Combat/Components/Health.cs')",
      },
      namespace: {
        type: "string",
        description: "C# namespace (e.g., 'Game.Modules.Combat')",
      },
      fields: {
        type: "array",
        items: {
          type: "object",
          properties: {
            name: { type: "string", description: "Field name" },
            type: {
              type: "string",
              description: "C# type (e.g., 'float', 'int', 'float3', 'bool')",
            },
            default_value: {
              type: "string",
              description: "Optional default value",
            },
          },
          required: ["name", "type"],
        },
        description: "Component fields",
      },
    },
    required: ["name", "path", "namespace", "fields"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: component creation is disabled in read-only mode",
        isError: true,
      };
    }

    const name = String(input["name"] ?? "");
    const relPath = String(input["path"] ?? "");
    const namespace = String(input["namespace"] ?? "");
    const fields = (input["fields"] as Array<{
      name: string;
      type: string;
      default_value?: string;
    }>) ?? [];

    if (!name || !relPath || !namespace) {
      return {
        content: "Error: name, path, and namespace are required",
        isError: true,
      };
    }

    // Validate C# identifiers to prevent code injection
    if (!isValidCSharpIdentifier(name)) {
      return { content: "Error: invalid component name", isError: true };
    }
    if (!isValidCSharpIdentifier(namespace, true)) {
      return { content: "Error: invalid namespace", isError: true };
    }
    for (const field of fields) {
      if (!isValidCSharpIdentifier(field.name)) {
        return { content: `Error: invalid field name '${field.name}'`, isError: true };
      }
      if (!isValidCSharpType(field.type)) {
        return { content: `Error: invalid field type '${field.type}'`, isError: true };
      }
      if (field.default_value) {
        // Strict allowlist: only literal numbers, bools, simple identifiers, strings
        const SAFE_DEFAULT = /^-?\d+(\.\d+)?f?$|^true$|^false$|^"[^"\\]*"$|^'[^'\\]'$|^[\w.]+$/;
        if (!SAFE_DEFAULT.test(field.default_value)) {
          return { content: "Error: invalid default value", isError: true };
        }
      }
    }

    // Validate path with symlink resolution and sensitive file blocking
    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    // Determine if we need Unity.Mathematics
    const mathTypes = ["float2", "float3", "float4", "quaternion", "int2", "int3", "float4x4", "float3x3"];
    const needsMath = fields.some((f) =>
      mathTypes.includes(f.type.toLowerCase())
    );

    // Generate component code
    const fieldLines = fields
      .map((f) => {
        const defaultStr = f.default_value ? ` = ${f.default_value}` : "";
        return `        public ${f.type} ${f.name}${defaultStr};`;
      })
      .join("\n");

    const usings = [
      "using Strada.Core.ECS;",
    ];
    if (needsMath) {
      usings.push("using Unity.Mathematics;");
    }

    const code = `${usings.join("\n")}

namespace ${namespace}
{
    public struct ${name} : IComponent
    {
${fieldLines}
    }
}
`;

    try {
      await mkdir(dirname(pathCheck.fullPath), { recursive: true });
      await writeFile(pathCheck.fullPath, code, "utf-8");

      return {
        content: [
          `Component '${name}' created at: ${relPath}`,
          "",
          "Fields:",
          ...fields.map((f) => `  ${f.type} ${f.name}`),
          "",
          `Next: Add to entities via EntityManager.AddComponent<${name}>(entity, new ${name} { ... })`,
        ].join("\n"),
      };
    } catch {
      return { content: "Error: could not create component", isError: true };
    }
  }
}
