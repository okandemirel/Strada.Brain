import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath, isValidCSharpIdentifier, isValidCSharpType } from "../../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";

export class MediatorCreateTool implements ITool {
  readonly name = "strata_create_mediator";
  readonly description =
    "Create a new EntityMediator that bridges ECS components to Unity Views. " +
    "Mediators sync ECS data to MonoBehaviour views using ComponentBindings.";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Mediator class name (e.g., 'EnemyMediator', 'PlayerMediator')",
      },
      view_type: {
        type: "string",
        description: "The View type this mediator works with (e.g., 'EnemyView', 'PlayerView')",
      },
      path: {
        type: "string",
        description: "Relative file path for the mediator",
      },
      namespace: {
        type: "string",
        description: "C# namespace",
      },
      bindings: {
        type: "array",
        items: {
          type: "object",
          properties: {
            component: { type: "string", description: "Component type name" },
            property: { type: "string", description: "Property to extract" },
            property_type: { type: "string", description: "C# type of the property" },
            view_method: { type: "string", description: "View method to call on change" },
          },
          required: ["component", "property", "property_type", "view_method"],
        },
        description: "Component-to-View bindings",
      },
    },
    required: ["name", "view_type", "path", "namespace"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: mediator creation is disabled in read-only mode",
        isError: true,
      };
    }

    const name = String(input["name"] ?? "");
    const viewType = String(input["view_type"] ?? "");
    const relPath = String(input["path"] ?? "");
    const namespace = String(input["namespace"] ?? "");
    const bindings = (input["bindings"] as Array<{
      component: string;
      property: string;
      property_type: string;
      view_method: string;
    }>) ?? [];

    if (!name || !viewType || !relPath || !namespace) {
      return {
        content: "Error: name, view_type, path, and namespace are required",
        isError: true,
      };
    }

    // Validate C# identifiers to prevent code injection
    if (!isValidCSharpIdentifier(name)) {
      return { content: "Error: invalid mediator name", isError: true };
    }
    if (!isValidCSharpIdentifier(viewType)) {
      return { content: "Error: invalid view type name", isError: true };
    }
    if (!isValidCSharpIdentifier(namespace, true)) {
      return { content: "Error: invalid namespace", isError: true };
    }
    for (const binding of bindings) {
      if (!isValidCSharpIdentifier(binding.component)) {
        return { content: `Error: invalid component name '${binding.component}'`, isError: true };
      }
      if (!isValidCSharpIdentifier(binding.property)) {
        return { content: `Error: invalid property name '${binding.property}'`, isError: true };
      }
      if (!isValidCSharpType(binding.property_type)) {
        return { content: `Error: invalid property type '${binding.property_type}'`, isError: true };
      }
      if (!isValidCSharpIdentifier(binding.view_method)) {
        return { content: `Error: invalid view method name '${binding.view_method}'`, isError: true };
      }
    }

    // Validate path with symlink resolution and sensitive file blocking
    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    // Generate binding code
    const bindingLines = bindings.map((b) =>
      `            Bind<${b.component}, ${b.property_type}>(\n` +
      `                c => c.${b.property},\n` +
      `                value => View.${b.view_method}(value));`
    ).join("\n\n");

    const code = `using Strada.Core.Sync;
using Strada.Core.ECS;

namespace ${namespace}
{
    public class ${name} : EntityMediator<${viewType}>
    {
        protected override void OnBind()
        {
${bindingLines || "            // TODO: Add component bindings\n            // Example:\n            // Bind<Health, float>(c => c.Current, value => View.UpdateHealthBar(value));"}
        }

        protected override void OnUnbind()
        {
            // Cleanup if needed
        }

        protected override void OnUpdate(float deltaTime)
        {
            // Optional per-frame logic
        }
    }
}
`;

    try {
      await mkdir(dirname(pathCheck.fullPath), { recursive: true });
      await writeFile(pathCheck.fullPath, code, "utf-8");

      return {
        content: [
          `Mediator '${name}' created at: ${relPath}`,
          `  View: ${viewType}`,
          `  Bindings: ${bindings.length}`,
          "",
          bindings.length > 0
            ? "Bindings:\n" +
              bindings
                .map(
                  (b) =>
                    `  ${b.component}.${b.property} -> View.${b.view_method}()`
                )
                .join("\n")
            : "No bindings configured. Add them in OnBind().",
        ].join("\n"),
      };
    } catch {
      return { content: "Error: could not create mediator", isError: true };
    }
  }
}
