import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";

export class SystemCreateTool implements ITool {
  readonly name = "strata_create_system";
  readonly description =
    "Create a new ECS System for Strada.Core. Systems process entities with specific component queries. " +
    "Supports SystemBase (standard), JobSystemBase (Burst-compiled), and SystemGroup (ordering).";

  readonly inputSchema = {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "System class name (e.g., 'MovementSystem', 'DamageSystem')",
      },
      path: {
        type: "string",
        description: "Relative file path (e.g., 'Assets/Modules/Combat/Systems/DamageSystem.cs')",
      },
      namespace: {
        type: "string",
        description: "C# namespace (e.g., 'Game.Modules.Combat')",
      },
      base_class: {
        type: "string",
        enum: ["SystemBase", "JobSystemBase", "SystemGroup"],
        description: "Base class to inherit from. Default: SystemBase",
      },
      query_components: {
        type: "array",
        items: { type: "string" },
        description: "Component types this system queries (e.g., ['Health', 'Position'])",
      },
      inject_services: {
        type: "array",
        items: { type: "string" },
        description: "Services to inject via constructor DI (e.g., ['ICombatService', 'IConfigService'])",
      },
    },
    required: ["name", "path", "namespace"],
  };

  async execute(
    input: Record<string, unknown>,
    context: ToolContext
  ): Promise<ToolExecutionResult> {
    if (context.readOnly) {
      return {
        content: "Error: system creation is disabled in read-only mode",
        isError: true,
      };
    }

    const name = String(input["name"] ?? "");
    const relPath = String(input["path"] ?? "");
    const namespace = String(input["namespace"] ?? "");
    const baseClass = String(input["base_class"] ?? "SystemBase");
    const queryComponents = (input["query_components"] as string[]) ?? [];
    const injectServices = (input["inject_services"] as string[]) ?? [];

    if (!name || !relPath || !namespace) {
      return {
        content: "Error: name, path, and namespace are required",
        isError: true,
      };
    }

    // Validate identifiers
    if (!isValidCSharpIdentifier(name)) {
      return { content: "Error: invalid system name", isError: true };
    }
    if (!isValidCSharpIdentifier(namespace, true)) {
      return { content: "Error: invalid namespace", isError: true };
    }

    const validBases = ["SystemBase", "JobSystemBase", "SystemGroup"];
    if (!validBases.includes(baseClass)) {
      return {
        content: `Error: base_class must be one of: ${validBases.join(", ")}`,
        isError: true,
      };
    }

    for (const comp of queryComponents) {
      if (!isValidCSharpIdentifier(comp)) {
        return { content: `Error: invalid component name '${comp}'`, isError: true };
      }
    }
    for (const svc of injectServices) {
      if (!isValidCSharpIdentifier(svc)) {
        return { content: `Error: invalid service name '${svc}'`, isError: true };
      }
    }

    // Validate path
    const pathCheck = await validatePath(context.projectPath, relPath);
    if (!pathCheck.valid) {
      return { content: `Error: ${pathCheck.error}`, isError: true };
    }

    const code = generateSystemCode(name, namespace, baseClass, queryComponents, injectServices);

    try {
      await mkdir(dirname(pathCheck.fullPath), { recursive: true });
      await writeFile(pathCheck.fullPath, code, "utf-8");

      const lines = [
        `System '${name}' created at: ${relPath}`,
        `  Base: ${baseClass}`,
      ];
      if (queryComponents.length > 0) {
        lines.push(`  Query: <${queryComponents.join(", ")}>`);
      }
      if (injectServices.length > 0) {
        lines.push(`  Injected: ${injectServices.join(", ")}`);
      }
      lines.push(
        "",
        `Next: Register in your ModuleConfig or add to a SystemGroup.`
      );

      return { content: lines.join("\n") };
    } catch {
      return { content: "Error: could not create system", isError: true };
    }
  }
}

function generateSystemCode(
  name: string,
  namespace: string,
  baseClass: string,
  queryComponents: string[],
  injectServices: string[]
): string {
  const usings = [
    "using Strada.Core.ECS;",
    "using Strada.Core.ECS.Core;",
  ];

  if (baseClass === "JobSystemBase") {
    usings.push("using Unity.Burst;");
    usings.push("using Unity.Jobs;");
  }

  // Constructor DI
  const hasInjection = injectServices.length > 0;
  const fields = injectServices
    .map((svc) => `        private readonly ${svc} _${svc.replace(/^I/, "").charAt(0).toLowerCase() + svc.replace(/^I/, "").slice(1)};`)
    .join("\n");

  const ctorParams = injectServices
    .map((svc) => `${svc} ${svc.replace(/^I/, "").charAt(0).toLowerCase() + svc.replace(/^I/, "").slice(1)}`)
    .join(", ");

  const ctorAssigns = injectServices
    .map((svc) => {
      const fieldName = svc.replace(/^I/, "").charAt(0).toLowerCase() + svc.replace(/^I/, "").slice(1);
      return `            _${fieldName} = ${fieldName};`;
    })
    .join("\n");

  // Query body
  let queryBody: string;
  if (baseClass === "SystemGroup") {
    queryBody = `        // Systems in this group execute in order.
        // Add systems via [UpdateInGroup(typeof(${name}))] attribute.`;
  } else if (queryComponents.length > 0) {
    const typeArgs = queryComponents.join(", ");
    queryBody = `            var query = World.Query<${typeArgs}>();
            foreach (var entity in query)
            {
${queryComponents.map((c) => `                ref var ${c.charAt(0).toLowerCase() + c.slice(1)} = ref World.GetComponentRef<${c}>(entity);`).join("\n")}
                // TODO: Process entity
            }`;
  } else {
    queryBody = `            // TODO: Implement system logic
            // var query = World.Query<ComponentA, ComponentB>();
            // foreach (var entity in query) { ... }`;
  }

  // Build class
  if (baseClass === "SystemGroup") {
    return `${usings.join("\n")}

namespace ${namespace}
{
    public class ${name} : SystemGroup
    {
${queryBody}
    }
}
`;
  }

  const ctorBlock = hasInjection
    ? `
        public ${name}(${ctorParams})
        {
${ctorAssigns}
        }
`
    : "";

  return `${usings.join("\n")}

namespace ${namespace}
{
    public class ${name} : ${baseClass}
    {
${fields ? fields + "\n" : ""}${ctorBlock}
        public override void OnUpdate(float deltaTime)
        {
${queryBody}
        }
    }
}
`;
}
