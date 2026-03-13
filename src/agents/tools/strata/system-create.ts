import { writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { validatePath, isValidCSharpIdentifier } from "../../../security/path-guard.js";
import type { ITool, ToolContext, ToolExecutionResult } from "../tool.interface.js";
import { STRADA_API } from "../../context/strada-api-reference.js";

export class SystemCreateTool implements ITool {
  readonly name = "strata_create_system";
  readonly description =
    "Create a new ECS System for Strada.Core. Systems process entities with specific component queries. " +
    "Supports SystemBase (standard), JobSystemBase (Burst-compiled), and BurstSystemBase (SIMD-accelerated).";

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
        enum: STRADA_API.baseClasses.systems,
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
        description: "Services to inject via [Inject] attribute (e.g., ['ICombatService', 'IConfigService'])",
      },
      system_order: {
        type: "number",
        description: "Execution order via [SystemOrder] attribute. Default: 0",
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
    const systemOrder = typeof input["system_order"] === "number" ? input["system_order"] : 0;

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

    const validBases = STRADA_API.baseClasses.systems;
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

    const code = generateSystemCode(name, namespace, baseClass, queryComponents, injectServices, systemOrder);

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
        `Next: Register in your ModuleConfig.`
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
  injectServices: string[],
  systemOrder: number
): string {
  const usings = [
    `using ${STRADA_API.namespaces.ecs};`,
    `using ${STRADA_API.namespaces.systems};`,
  ];

  if (baseClass === "JobSystemBase") {
    usings.push("using Unity.Burst;");
    usings.push("using Unity.Jobs;");
  }

  // [Inject] field injection
  const hasInjection = injectServices.length > 0;
  if (hasInjection) {
    usings.push(`using ${STRADA_API.namespaces.diAttributes};`);
  }

  const fields = injectServices
    .map((svc) => {
      const fieldName = svc.replace(/^I/, "").charAt(0).toLowerCase() + svc.replace(/^I/, "").slice(1);
      return `        [Inject] private readonly ${svc} _${fieldName};`;
    })
    .join("\n");

  // Query body using ForEach pattern
  let queryBody: string;
  if (queryComponents.length > 0) {
    const typeArgs = queryComponents.join(", ");
    const lambdaParams = queryComponents
      .map((c) => `ref ${c} ${c.charAt(0).toLowerCase() + c.slice(1)}`)
      .join(", ");
    queryBody = `            ForEach<${typeArgs}>((int entity, ${lambdaParams}) =>
            {
                // TODO: Process entity
            });`;
  } else {
    queryBody = `            // TODO: Implement system logic
            // ForEach<ComponentA, ComponentB>((int entity, ref ComponentA a, ref ComponentB b) =>
            // {
            //     // Process entity
            // });`;
  }

  return `${usings.join("\n")}

namespace ${namespace}
{
    [SystemOrder(${systemOrder})]
    public class ${name} : ${baseClass}
    {
${fields ? fields + "\n" : ""}
        protected override void OnInitialize() { }

        protected override void OnUpdate(float deltaTime)
        {
${queryBody}
        }

        protected override void OnDispose() { }
    }
}
`;
}
